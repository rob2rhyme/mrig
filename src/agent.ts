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
import { type AnyTool, type ToolContext, toAiTools, toolRegistry } from './tools/index.ts';
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

export class Agent {
  messages: ModelMessage[];
  usage: UsageTotals = emptyUsage();
  readonly opts: AgentOptions;
  private readonly registry: Map<string, AnyTool>;
  private readonly aiTools;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.messages = opts.messages ?? [];
    this.registry = toolRegistry(opts.tools);
    this.aiTools = toAiTools(opts.tools);
  }

  /** Estimated USD spent this session, or undefined when pricing is unknown. */
  cost(): number | undefined {
    return estimateCost(this.usage, pricingFor(this.opts.profile), this.cacheTtl());
  }

  cacheTtl(): CacheTtl {
    return this.opts.cacheTtl ?? '5m';
  }

  clear(): void {
    this.messages = [];
    this.usage = emptyUsage();
  }

  async run(userText: string, signal?: AbortSignal): Promise<RunResult> {
    this.messages.push({ role: 'user', content: userText });
    let steps = 0;
    for (let step = 1; step <= this.opts.maxSteps; step++) {
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
    let text = '';
    // The SDK validates tool names/inputs itself and, on failure, emits a tool-error part and
    // appends an error tool-result to responseMessages so the model can self-correct.
    let sdkToolErrors = 0;

    // L0: for Anthropic, request-level automatic caching plus one explicit breakpoint on the
    // system block. Tools render before system, so that breakpoint keeps tools + system cached
    // for the whole session; the automatic one follows the growing conversation.
    const cache = cacheProviderOptions(this.opts.profile, this.cacheTtl());
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
        return fixed ? { ...toolCall, input: fixed } : null;
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
        events.onNotice?.(`Invalid tool call from model (${err.message}); asked it to retry.`);
        return { kind: 'continue', text };
      }
      throw err;
    }

    this.messages.push(...(await result.responseMessages));
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
    const tool = this.registry.get(call.toolName);
    if (!tool) {
      return { ...base, output: { type: 'error-text', value: `Unknown tool "${call.toolName}".` } };
    }
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
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

  /** Replace the transcript with a model-written summary to free context. */
  async compact(signal?: AbortSignal): Promise<string> {
    if (this.messages.length === 0) return 'Nothing to compact.';
    const cache = cacheProviderOptions(this.opts.profile, this.cacheTtl());
    const { text, usage } = await generateText({
      model: this.opts.model,
      ...(cache ? { providerOptions: cache } : {}),
      system:
        "Summarize the conversation for your own future reference. Preserve: the user's goals, decisions made, files changed (with paths), commands run and their outcomes, open problems, and exact identifiers (names, paths, error strings). Omit pleasantries. Use compact prose and short lists. Under 1500 words.",
      messages: [...this.messages, { role: 'user', content: '[mrig] Write the summary now.' }],
      abortSignal: signal,
    });
    this.usage = addUsage(this.usage, usage);
    this.messages = [
      {
        role: 'user',
        content: `[mrig] Context was compacted. Summary of the conversation so far:\n\n${text}`,
      },
      { role: 'assistant', content: 'Understood. I have the summary and will continue from here.' },
    ];
    return text;
  }
}
