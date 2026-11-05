/**
 * Two-tier context compaction (L4), as pure functions; the Agent decides when to call them.
 *
 *   Tier (a): drop old tool calls/results and reasoning with the AI SDK's `pruneMessages`.
 *   Tier (b): replace everything but a short verbatim tail with a model-written summary.
 *
 * Both edit history, which invalidates the prompt cache (L0) from that point, so compaction only
 * runs past a threshold. Claude models with preserved thinking skip tier (a): editing turns ahead
 * of kept thinking blocks can be rejected, while a summary replaces the whole history.
 */
import { type ModelMessage, pruneMessages } from 'ai';
import type { ProviderProfile } from './config.ts';
import { truncateMiddle } from './util/text.ts';

/** Context window assumed for hosted models whose profile sets none. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/**
 * Context window assumed for local servers whose profile sets none and whose server did not
 * report one. Deliberately conservative: assuming 128k for a model loaded with 8k or 32k would
 * let the session overflow before compaction ever triggers.
 */
export const DEFAULT_LOCAL_CONTEXT_WINDOW = 32_768;
/** Tier (a) keeps tool activity in this many of the most recent messages. */
export const PRUNE_KEEP_MESSAGES = 10;
/** Longest tool result, in characters, quoted to the summarizer. */
const SUMMARY_TOOL_CHARS = 2000;
/** Longest tool-call input, in characters, quoted to the summarizer. */
const SUMMARY_INPUT_CHARS = 500;

export const SUMMARY_SYSTEM =
  "Summarize the conversation for your own future reference. Preserve: the user's goals, decisions made, files changed (with paths), commands run and their outcomes, open problems, and exact identifiers (names, paths, error strings). Omit pleasantries. Use compact prose and short lists. Under 1500 words.";

const SUMMARY_PREFIX = '[mrig] Context was compacted. Summary of the conversation so far:\n\n';
const ACK: ModelMessage = {
  role: 'assistant',
  content: 'Understood. I have the summary and will continue from here.',
};

/**
 * Claude models whose thinking blocks are bound to the conversation (preserved thinking).
 * Editing earlier turns ahead of kept thinking blocks can be rejected, so they skip tier (a).
 * Source: Anthropic's model notes as of November 2026; re-check when adding models.
 */
const PRESERVED_THINKING = /claude-(fable-5-1|mythos-5-1|opus-5-5|sonnet-5-5|haiku-5-5)/;

export function preferSummaryOnly(profile: ProviderProfile): boolean {
  return profile.kind === 'anthropic' && PRESERVED_THINKING.test(profile.model);
}

/** The profile's window, else what the server reported, else a per-kind default. */
export function contextWindowFor(profile: ProviderProfile, detected?: number): number {
  if (profile.contextWindow) return profile.contextWindow;
  if (detected) return detected;
  return profile.kind === 'openai-compatible'
    ? DEFAULT_LOCAL_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}

/** `threshold` is a fraction of the window when ≤ 1, otherwise an absolute token count. */
export function thresholdTokens(threshold: number, window: number): number {
  return threshold <= 1 ? Math.floor(window * threshold) : Math.floor(threshold);
}

function partChars(part: unknown): number {
  if (!part || typeof part !== 'object') return 0;
  const p = part as { type?: string; text?: unknown; input?: unknown; output?: unknown };
  switch (p.type) {
    case 'text':
    case 'reasoning':
      return typeof p.text === 'string' ? p.text.length : 0;
    case 'tool-call':
      return JSON.stringify(p.input ?? null).length + 20;
    case 'tool-result': {
      const out = p.output as { type?: string; value?: unknown } | undefined;
      if (out && typeof out.value === 'string') return out.value.length + 20;
      return JSON.stringify(out ?? null).length + 20;
    }
    default:
      // Files and images: a rough flat cost; mrig does not send them yet.
      return 4000;
  }
}

/** Rough token estimate (~4 characters per token) of a message list. */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += 16; // role and framing
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const part of m.content) chars += partChars(part);
  }
  return Math.ceil(chars / 4);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Where the verbatim tail starts: the last `keep` messages, moved forward past any tool results,
 * so the tail never opens with a result whose call is about to be summarized away.
 */
export function tailStart(messages: ModelMessage[], keep: number): number {
  let i = Math.max(0, messages.length - Math.max(0, keep));
  while (i < messages.length && messages[i]?.role === 'tool') i++;
  return i;
}

/** Tier (a): drop tool activity and reasoning outside the most recent messages. */
export function pruneOldToolActivity(
  messages: ModelMessage[],
  keepLast = PRUNE_KEEP_MESSAGES,
): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'before-last-message',
    toolCalls: `before-last-${keepLast}-messages` as `before-last-${number}-messages`,
    emptyMessages: 'remove',
  });
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)} … [${s.length - n} more]` : s;

function renderPart(part: unknown): string {
  if (!part || typeof part !== 'object') return '';
  const p = part as {
    type?: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    output?: { type?: string; value?: unknown };
  };
  switch (p.type) {
    case 'text':
      return p.text ?? '';
    case 'reasoning':
      return ''; // never quote reasoning: it is model-private and often bound to its model
    case 'tool-call':
      return `[tool call] ${p.toolName}(${clip(JSON.stringify(p.input ?? {}), SUMMARY_INPUT_CHARS)})`;
    case 'tool-result': {
      const v = p.output?.value;
      const text = typeof v === 'string' ? v : JSON.stringify(v ?? null);
      const label = p.output?.type === 'error-text' ? 'tool error' : 'tool result';
      return `[${label}] ${p.toolName}: ${clip(text, SUMMARY_TOOL_CHARS)}`;
    }
    default:
      return `[${p.type ?? 'attachment'}]`;
  }
}

/**
 * The transcript as plain text for the summarizer. Sending text rather than the raw messages
 * works with any summarizing model (a local model can summarize a Claude session), never replays
 * thinking blocks, and lets long tool output be clipped to fit.
 */
export function renderTranscript(messages: ModelMessage[], maxChars: number): string {
  const blocks: string[] = [];
  for (const m of messages) {
    const body =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map(renderPart)
            .filter((s) => s.length > 0)
            .join('\n');
    if (body.trim()) blocks.push(`## ${m.role}\n${body}`);
  }
  return truncateMiddle(blocks.join('\n\n'), maxChars);
}

export function summaryRequest(transcript: string): string {
  return `Conversation transcript to summarize:\n\n${transcript}\n\n[mrig] Write the summary now.`;
}

/** The new transcript: the summary, an acknowledgement when needed, then the verbatim tail. */
export function withSummary(summary: string, tail: ModelMessage[]): ModelMessage[] {
  const head: ModelMessage = { role: 'user', content: `${SUMMARY_PREFIX}${summary}` };
  // Keep roles alternating: the acknowledgement goes in unless the tail opens with the assistant.
  if (tail[0]?.role === 'assistant') return [head, ...tail];
  return [head, ACK, ...tail];
}
