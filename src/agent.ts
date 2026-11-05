/**
 * The agent loop.
 *
 * Each step: stream one model response with the tool definitions attached (no `execute`),
 * collect the tool calls it made, run them through the permission gate, execute, append the
 * results as a `tool` message, and go again — until the model answers without tool calls
 * or maxSteps is reached.
 */
import {
  generateText,
  InvalidToolInputError,
  type LanguageModel,
  type ModelMessage,
  NoSuchToolError,
  streamText,
  type ToolResultPart,
} from 'ai';
import { z } from 'zod';
import {
  contextWindowFor,
  estimateMessagesTokens,
  estimateTextTokens,
  preferSummaryOnly,
  pruneOldToolActivity,
  renderTranscript,
  SUMMARY_SYSTEM,
  summaryRequest,
  tailStart,
  thresholdTokens,
  withSummary,
} from './compaction.ts';
import type { CacheTtl, ProviderProfile } from './config.ts';
import type { PermissionManager } from './permissions.ts';
import {
  addUsage,
  cacheProviderOptions,
  emptyUsage,
  estimateCost,
  pricingFor,
  type UsageTotals,
} from './providers.ts';
import {
  type AnyTool,
  describeInputs,
  type ToolContext,
  toAiTools,
  toolRegistry,
} from './tools/index.ts';
import { firstLines } from './util/text.ts';

export interface ToolCallInfo {
  id: string;
  name: string;
  summary: string;
}

export interface ToolCallOutcome {
  status: 'ok' | 'error' | 'denied';
  text: string;
  ms: number;
}

export interface AgentEvents {
  onText(delta: string): void;
  onReasoning?(delta: string): void;
  onToolStart?(call: ToolCallInfo): void;
  onToolEnd?(call: ToolCallInfo, outcome: ToolCallOutcome): void;
  onStepEnd?(step: number, usage: UsageTotals): void;
  onNotice?(message: string): void;
}

export interface AgentOptions {
  model: LanguageModel;
  modelLabel: string;
  profile: ProviderProfile;
  tools: AnyTool[];
  permissions: PermissionManager;
  cwd: string;
  systemPrompt: string;
  maxSteps: number;
  maxToolOutputChars: number;
  events: AgentEvents;
  /** Resume with an existing transcript. */
  messages?: ModelMessage[];
  /** Prompt-cache TTL for Anthropic profiles (default 5m). Ignored for other providers. */
  cacheTtl?: CacheTtl;
  /** Automatic compaction (L4). Off when absent. */
  compaction?: CompactionOptions;
}

export interface CompactionOptions {
  enabled: boolean;
  /** Fraction of the context window (0–1], or an absolute token count (> 1). */
  threshold: number;
  /** Messages kept verbatim after a summary. */
  keep: number;
  /** A separate summarizer (config `compaction.compactModel`); default the main model. */
  model?: LanguageModel;
  profile?: ProviderProfile;
}

export type StopReason = 'done' | 'max-steps' | 'aborted';

export interface RunResult {
  stop: StopReason;
  steps: number;
  /** Text of the final assistant message (empty if it ended on tool calls). */
  text: string;
}

const DENIED_TEXT =
  'The user denied this tool call. Do not retry the same call; explain what you wanted to do and ask how to proceed, or take a different approach.';

/** Try to salvage tool-call JSON that local models often mangle. */
export function repairJson(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + 1);
  s = s.replace(/,\s*([}\]])/g, '$1'); // trailing commas
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

/** `{}`, `""`, null or undefined: the model named a tool but gave it nothing. */
export function isEmptyInput(input: unknown): boolean {
  if (input === undefined || input === null || input === '') return true;
  return typeof input === 'object' && Object.keys(input as object).length === 0;
}

/**
 * For a call the SDK marked invalid, the SDK already appended its own error tool-result. The
 * loop answers every call itself (one result per id), so drop the SDK's copy.
 */
function withoutSdkResults(messages: ModelMessage[], invalidIds: Set<string>): ModelMessage[] {
  if (invalidIds.size === 0) return messages;
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') {
      out.push(m);
      continue;
    }
    const content = m.content.filter(
      (p) => !(p.type === 'tool-result' && invalidIds.has(p.toolCallId)),
    );
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
}

/** Tool definitions go out as JSON schemas with every request; estimate what they cost. */
function estimateToolTokens(tools: AnyTool[]): number {
  let chars = 0;
  for (const t of tools) {
    chars += t.name.length + t.description.length + 40;
    try {
      chars += JSON.stringify(z.toJSONSchema(t.inputSchema)).length;
    } catch {
      chars += 600; // a typical schema, if one cannot be converted
    }
  }
  return Math.ceil(chars / 4);
}

function previewFor(tool: AnyTool, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  if (tool.name === 'write' && typeof i.content === 'string') return firstLines(i.content, 20);
  if (
    tool.name === 'edit' &&
    typeof i.old_string === 'string' &&
    typeof i.new_string === 'string'
  ) {
    const minus = firstLines(i.old_string, 12)
      .split('\n')
      .map((l) => `- ${l}`)
      .join('\n');
    const plus = firstLines(i.new_string, 12)
      .split('\n')
      .map((l) => `+ ${l}`)
      .join('\n');
    return `${minus}\n${plus}`;
  }
  return undefined;
}

/** Per-session counters read by the eval harness (and handy for debugging). Reset by clear(). */
export interface AgentStats {
  /** Tool calls the model made, valid or not. */
  toolCalls: number;
  /** Calls refused before running: unknown tool, schema failure, or empty arguments. */
  invalidCalls: number;
  /** Calls whose malformed JSON `repairJson` salvaged. */
  repairedCalls: number;
  /** Calls that actually ran (past the permission gate), by tool name. */
  toolsUsed: Record<string, number>;
  /** Output tokens and milliseconds measured after the first token: decode speed. */
  decodeTokens: number;
  decodeMs: number;
  /** Total time waiting on the model; the fallback for an effective tokens/s. */
  responseMs: number;
}

export function emptyStats(): AgentStats {
  return {
    toolCalls: 0,
    invalidCalls: 0,
    repairedCalls: 0,
    toolsUsed: {},
    decodeTokens: 0,
    decodeMs: 0,
    responseMs: 0,
  };
}

export class Agent {
  messages: ModelMessage[];
  usage: UsageTotals = emptyUsage();
  stats: AgentStats = emptyStats();
  readonly opts: AgentOptions;
  private registry: Map<string, AnyTool>;
  private aiTools: ReturnType<typeof toAiTools>;
  /** Estimated tokens of the tool definitions sent with every request (their JSON schemas). */
  private toolTokens: number;
  /** Consecutive tool calls with no arguments; the first one in a row gets a guided retry. */
  private emptyArgStreak = 0;
  /** Input tokens the provider reported for the last request, and the transcript length then. */
  private lastRequestTokens: number | undefined;
  private messagesAtLastRequest = 0;
  private detectedContextWindow: number | undefined;
  private historyEdited = false;
  /** Set once the user has been told there is nothing left to compact, until history changes. */
  private toldNothingToCompact = false;
  /** Set once the user has been warned that the window leaves little room after compacting. */
  private warnedLowHeadroom = false;
  /** The first prompt this agent ran, kept for the session title after compaction removes it. */
  firstPrompt: string | undefined;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.messages = opts.messages ?? [];
    this.registry = toolRegistry(opts.tools);
    this.aiTools = toAiTools(opts.tools);
    this.toolTokens = estimateToolTokens(opts.tools);
  }

  /** Swap the tool set (e.g. after /model to a profile with another toolMode). */
  setTools(tools: AnyTool[]): void {
    this.opts.tools = tools;
    this.registry = toolRegistry(tools);
    this.aiTools = toAiTools(tools);
    this.toolTokens = estimateToolTokens(tools);
  }

  /** Estimated USD spent this session, or undefined when pricing is unknown. */
  cost(): number | undefined {
    return estimateCost(this.usage, pricingFor(this.opts.profile), this.cacheTtl());
  }

  cacheTtl(): CacheTtl {
    return this.opts.cacheTtl ?? '5m';
  }

  clear(): void {
    this.replaceHistory([]);
    this.usage = emptyUsage();
    this.stats = emptyStats();
  }

  private recordPerformance(
    outputTokens: number | undefined,
    perf: { outputTokensPerSecond: number | undefined; responseTimeMs: number },
  ): void {
    const out = outputTokens ?? 0;
    const rate = perf.outputTokensPerSecond;
    if (out > 0 && rate !== undefined && Number.isFinite(rate) && rate > 0) {
      this.stats.decodeTokens += out;
      this.stats.decodeMs += (out / rate) * 1000;
    }
    if (Number.isFinite(perf.responseTimeMs)) this.stats.responseMs += perf.responseTimeMs;
  }

  async run(userText: string, signal?: AbortSignal): Promise<RunResult> {
    if (this.firstPrompt === undefined) this.firstPrompt = userText;
    this.messages.push({ role: 'user', content: userText });
    this.emptyArgStreak = 0;
    let steps = 0;
    for (let step = 1; step <= this.opts.maxSteps; step++) {
      if (signal?.aborted) return { stop: 'aborted', steps, text: '' };
      await this.maybeCompact(signal);
      if (signal?.aborted) return { stop: 'aborted', steps, text: '' };
      steps = step;
      const outcome = await this.step(signal);
      if (outcome.kind === 'aborted') return { stop: 'aborted', steps, text: outcome.text };
      if (outcome.kind === 'final') return { stop: 'done', steps, text: outcome.text };
      // outcome.kind === 'continue' → loop
    }
    this.opts.events.onNotice?.(
      `Stopped after ${this.opts.maxSteps} steps. Say "continue" to keep going, or raise maxSteps in config.`,
    );
    return { stop: 'max-steps', steps, text: '' };
  }

  private async step(
    signal?: AbortSignal,
  ): Promise<{ kind: 'final' | 'continue' | 'aborted'; text: string }> {
    const { events } = this.opts;
    const calls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
    const invalidIds = new Set<string>();
    let text = '';
    // The SDK validates tool names/inputs itself and, on failure, emits a tool-error part and
    // appends an error tool-result to responseMessages so the model can self-correct.
    let sdkToolErrors = 0;

    // L0: for Anthropic, request-level automatic caching plus one explicit breakpoint on the
    // system block. Tools render before system, so that breakpoint keeps tools + system cached
    // for the whole session; the automatic one follows the growing conversation.
    const cache = cacheProviderOptions(this.opts.profile, this.cacheTtl());
    this.messagesAtLastRequest = this.messages.length;
    const result = streamText({
      model: this.opts.model,
      system: cache
        ? { role: 'system', content: this.opts.systemPrompt, providerOptions: cache }
        : this.opts.systemPrompt,
      messages: this.messages,
      tools: this.aiTools,
      ...(cache ? { providerOptions: cache } : {}),
      abortSignal: signal,
      maxRetries: 2,
      // Errors surface as an 'error' stream part below; suppress the SDK's default console.error.
      onError: () => {},
      repairToolCall: async ({ toolCall, error }) => {
        if (NoSuchToolError.isInstance(error)) return null;
        const fixed = repairJson(toolCall.input);
        if (!fixed) return null;
        // repairJson also returns JSON that was already valid (the call failed the schema, not
        // the syntax). Only a changed string counts as a repair.
        if (fixed !== toolCall.input.trim()) this.stats.repairedCalls++;
        return { ...toolCall, input: fixed };
      },
    });

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text;
            events.onText(part.text);
            break;
          case 'reasoning-delta':
            events.onReasoning?.(part.text);
            break;
          case 'tool-call':
            if (part.invalid) invalidIds.add(part.toolCallId);
            calls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
            break;
          case 'tool-error':
            sdkToolErrors++;
            events.onNotice?.(
              `Model made an invalid tool call (${part.toolName}); asked it to retry.`,
            );
            break;
          case 'finish-step':
            this.usage = addUsage(this.usage, part.usage);
            this.lastRequestTokens = part.usage.inputTokens;
            this.recordPerformance(part.usage.outputTokens, part.performance);
            break;
          case 'error':
            throw part.error;
          default:
            break;
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        // Keep whatever text streamed so the transcript stays coherent.
        if (text) this.messages.push({ role: 'assistant', content: text });
        return { kind: 'aborted', text };
      }
      if (InvalidToolInputError.isInstance(err) || NoSuchToolError.isInstance(err)) {
        // Give the model a chance to fix itself instead of crashing the session.
        if (text) this.messages.push({ role: 'assistant', content: text });
        this.messages.push({
          role: 'user',
          content: `[mrig] Your last tool call was invalid: ${err.message}. Available tools: ${[...this.registry.keys()].join(', ')}. Retry with a valid call, or answer without tools.`,
        });
        this.stats.toolCalls++;
        this.stats.invalidCalls++;
        events.onNotice?.(`Invalid tool call from model (${err.message}); asked it to retry.`);
        return { kind: 'continue', text };
      }
      throw err;
    }

    this.messages.push(...withoutSdkResults(await result.responseMessages, invalidIds));
    events.onStepEnd?.(this.messages.length, this.usage);

    if (calls.length === 0) return { kind: sdkToolErrors > 0 ? 'continue' : 'final', text };

    const results: ToolResultPart[] = [];
    for (const call of calls) {
      results.push(await this.executeCall(call, signal));
      if (signal?.aborted) break;
    }
    this.messages.push({ role: 'tool', content: results });
    if (signal?.aborted) return { kind: 'aborted', text };
    return { kind: 'continue', text };
  }

  private async executeCall(
    call: { toolCallId: string; toolName: string; input: unknown },
    signal?: AbortSignal,
  ): Promise<ToolResultPart> {
    const { events } = this.opts;
    const base = {
      type: 'tool-result' as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
    };
    this.stats.toolCalls++;
    const tool = this.registry.get(call.toolName);
    if (!tool) {
      this.stats.invalidCalls++;
      return { ...base, output: { type: 'error-text', value: `Unknown tool "${call.toolName}".` } };
    }
    // Weak local models often emit `{}` on a first attempt. Guide one retry with the field list;
    // a second empty call in a row falls through to the plain validation error.
    if (isEmptyInput(call.input)) {
      this.emptyArgStreak++;
      if (this.emptyArgStreak === 1) {
        this.stats.invalidCalls++;
        events.onNotice?.(`Model called ${tool.name} with no arguments; asked it to retry.`);
        return {
          ...base,
          output: {
            type: 'error-text',
            value: `[mrig] Your call to "${tool.name}" had no arguments. Call it again with: ${describeInputs(tool.inputSchema)}`,
          },
        };
      }
    } else {
      this.emptyArgStreak = 0;
    }
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      this.stats.invalidCalls++;
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      );
      return {
        ...base,
        output: { type: 'error-text', value: `Invalid input: ${issues.join('; ')}` },
      };
    }
    const info: ToolCallInfo = {
      id: call.toolCallId,
      name: tool.name,
      summary: tool.summarize(parsed.data),
    };
    events.onToolStart?.(info);
    const started = Date.now();

    const decision = await this.opts.permissions.check(
      tool,
      parsed.data,
      previewFor(tool, parsed.data),
    );
    if (decision === 'deny') {
      events.onToolEnd?.(info, { status: 'denied', text: 'denied', ms: Date.now() - started });
      return { ...base, output: { type: 'error-text', value: DENIED_TEXT } };
    }

    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      signal,
      maxOutputChars: this.opts.maxToolOutputChars,
    };
    this.stats.toolsUsed[tool.name] = (this.stats.toolsUsed[tool.name] ?? 0) + 1;
    try {
      const value = await tool.execute(parsed.data, ctx);
      events.onToolEnd?.(info, { status: 'ok', text: value, ms: Date.now() - started });
      return { ...base, output: { type: 'text', value } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      events.onToolEnd?.(info, { status: 'error', text: message, ms: Date.now() - started });
      return { ...base, output: { type: 'error-text', value: message } };
    }
  }

  /** Replace the transcript with a model-written summary to free context (`/compact`). */
  async compact(signal?: AbortSignal): Promise<string> {
    if (this.messages.length === 0) return 'Nothing to compact.';
    const { text } = await this.summarize(0, signal);
    return text;
  }

  /** Swap in another transcript (resuming a session); counts as a history edit. */
  loadTranscript(messages: ModelMessage[]): void {
    this.replaceHistory(messages);
  }

  /** The context window in use: the profile's, else what the server reported, else a default. */
  contextWindow(): number {
    return contextWindowFor(this.opts.profile, this.detectedContextWindow);
  }

  /** Record the context length a local server reported (Ollama's num_ctx), or clear it. */
  setDetectedContextWindow(tokens: number | undefined): void {
    this.detectedContextWindow = tokens;
    this.warnedLowHeadroom = false;
  }

  /** True once after compaction or clear rewrote earlier history, so the session file is rewritten. */
  takeHistoryEdited(): boolean {
    const edited = this.historyEdited;
    this.historyEdited = false;
    return edited;
  }

  /**
   * Estimated size of the next request: system prompt, tool definitions and transcript, at about
   * four characters per token. When the provider reported the last request's input tokens, that
   * figure plus an estimate of what was added since is used if it is larger.
   */
  estimateNextRequestTokens(): number {
    const fixed = estimateTextTokens(this.opts.systemPrompt) + this.toolTokens;
    const estimate = fixed + estimateMessagesTokens(this.messages);
    if (this.lastRequestTokens === undefined || this.messagesAtLastRequest > this.messages.length) {
      return estimate;
    }
    const since = estimateMessagesTokens(this.messages.slice(this.messagesAtLastRequest));
    return Math.max(estimate, this.lastRequestTokens + since);
  }

  /** For `/context`: the current estimate, the window, and where compaction kicks in. */
  contextReport(): { estimate: number; window: number; threshold?: number } {
    const window = this.contextWindow();
    const c = this.opts.compaction;
    return {
      estimate: this.estimateNextRequestTokens(),
      window,
      ...(c?.enabled ? { threshold: thresholdTokens(c.threshold, window) } : {}),
    };
  }

  private replaceHistory(messages: ModelMessage[]): void {
    this.messages = messages;
    this.lastRequestTokens = undefined;
    this.messagesAtLastRequest = 0;
    this.historyEdited = true;
    this.toldNothingToCompact = false;
  }

  /** L4: run before each step. Tier (a) first where allowed, then tier (b) if still too large. */
  private async maybeCompact(signal?: AbortSignal): Promise<void> {
    const c = this.opts.compaction;
    if (!c?.enabled) return;
    const window = this.contextWindow();
    const limit = thresholdTokens(c.threshold, window);
    const before = this.estimateNextRequestTokens();
    if (before <= limit) return;
    const { events } = this.opts;
    const fmt = (n: number) => n.toLocaleString();

    if (!preferSummaryOnly(this.opts.profile)) {
      const pruned = pruneOldToolActivity(this.messages);
      if (estimateMessagesTokens(pruned) < estimateMessagesTokens(this.messages)) {
        this.replaceHistory(pruned);
        const after = this.estimateNextRequestTokens();
        if (after <= limit) {
          events.onNotice?.(
            `Context reached ~${fmt(before)} of ${fmt(window)} tokens; dropped old tool output (now ~${fmt(after)}).`,
          );
          return;
        }
      }
    }

    try {
      const { replaced } = await this.summarize(c.keep, signal);
      if (replaced === 0) {
        if (this.toldNothingToCompact) return;
        this.toldNothingToCompact = true;
        events.onNotice?.(
          `Context is ~${fmt(before)} of ${fmt(window)} tokens, but only recent messages remain; nothing older to summarize.`,
        );
        return;
      }
      const after = this.estimateNextRequestTokens();
      events.onNotice?.(
        `Context reached ~${fmt(before)} of ${fmt(window)} tokens; summarized ${replaced} earlier messages (now ~${fmt(after)}).`,
      );
      // Compaction should be rare (each one invalidates the prompt cache). If the system prompt,
      // tools and the kept tail already fill most of the allowance, it will run on almost every
      // step; say so once, with the fix.
      if (!this.warnedLowHeadroom && after > limit * 0.8) {
        this.warnedLowHeadroom = true;
        events.onNotice?.(
          `Little room left after compacting (~${fmt(after)} of ${fmt(limit)} tokens allowed), so compaction will run often. Give the model a larger context (Ollama: num_ctx), or lower compaction.keep.`,
        );
      }
    } catch (err) {
      if (signal?.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      events.onNotice?.(`Compaction failed (${message}); continuing with the full context.`);
    }
  }

  /**
   * Tier (b): summarize everything before the last `keep` messages and splice the summary in.
   * Returns how many messages were replaced (0 when there is nothing older than the tail).
   */
  private async summarize(
    keep: number,
    signal?: AbortSignal,
  ): Promise<{ replaced: number; text: string }> {
    const start = tailStart(this.messages, keep);
    if (start === 0) return { replaced: 0, text: '' };
    const separate = this.opts.compaction?.model !== undefined;
    const model = this.opts.compaction?.model ?? this.opts.model;
    const profile = this.opts.compaction?.profile ?? this.opts.profile;
    const window = separate ? contextWindowFor(profile) : this.contextWindow();
    // Quote at most ~60% of the summarizer's window, leaving room for its instructions and reply.
    const transcript = renderTranscript(
      this.messages.slice(0, start),
      Math.floor(window * 4 * 0.6),
    );
    // No prompt caching here: a summary request is a one-off, so a cache write would only cost more.
    const { text, usage } = await generateText({
      model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: summaryRequest(transcript) }],
      abortSignal: signal,
    });
    // Usage is priced with the main profile, so a separate summarizer is left out of the total.
    if (!separate) this.usage = addUsage(this.usage, usage);
    this.replaceHistory(withSummary(text, this.messages.slice(start)));
    return { replaced: start, text };
  }
}
