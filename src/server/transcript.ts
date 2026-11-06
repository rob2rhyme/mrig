/**
 * Turn a saved transcript (AI SDK messages) into the items a front end draws (U1). Used for
 * the snapshot a client gets when it opens or reconnects to a conversation.
 */
import type { ModelMessage } from 'ai';
import { DENIED_TEXT } from '../agent.ts';
import type { AnyTool } from '../tools/index.ts';
import { truncateMiddle } from '../util/text.ts';
import type { TranscriptItem } from './protocol.ts';

/** Longest tool output carried to a front end. The model saw the full (capped) output. */
export const ITEM_OUTPUT_CHARS = 4000;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p: { type?: string; text?: unknown }) =>
      p.type === 'text' && typeof p.text === 'string' ? p.text : '',
    )
    .join('');
}

function outputText(output: unknown): { text: string; error: boolean } {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (!o) return { text: '', error: false };
  const error = o.type === 'error-text' || o.type === 'error-json';
  const text = typeof o.value === 'string' ? o.value : JSON.stringify(o.value ?? '');
  return { text, error };
}

export function transcriptItems(messages: ModelMessage[], tools: AnyTool[]): TranscriptItem[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const items: TranscriptItem[] = [];
  const toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  for (const m of messages) {
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (text) items.push({ kind: 'user', text });
    } else if (m.role === 'assistant') {
      const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      let text = '';
      for (const part of parts as Array<Record<string, unknown>>) {
        if (part.type === 'text' && typeof part.text === 'string') {
          text += part.text;
        } else if (part.type === 'tool-call') {
          if (text.trim()) items.push({ kind: 'assistant', text });
          text = '';
          const name = String(part.toolName);
          const tool = byName.get(name);
          let summary = name;
          let display: ReturnType<NonNullable<AnyTool['display']>> | undefined;
          const parsed = tool?.inputSchema.safeParse(part.input);
          if (tool && parsed?.success) {
            summary = tool.summarize(parsed.data);
            display = tool.display?.(parsed.data);
          }
          const item: Extract<TranscriptItem, { kind: 'tool' }> = {
            kind: 'tool',
            id: String(part.toolCallId),
            name,
            summary,
            ...(display ? { display } : {}),
          };
          items.push(item);
          toolItems.set(item.id, item);
        }
      }
      if (text.trim()) items.push({ kind: 'assistant', text });
    } else if (m.role === 'tool') {
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (part.type !== 'tool-result') continue;
        const item = toolItems.get(String(part.toolCallId));
        if (!item) continue;
        const { text, error } = outputText(part.output);
        item.status = text === DENIED_TEXT ? 'denied' : error ? 'error' : 'ok';
        item.output = truncateMiddle(text, ITEM_OUTPUT_CHARS);
      }
    }
  }
  return items;
}
