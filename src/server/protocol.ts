/**
 * The app protocol, version 1 (Track 4, U1): JSON over one WebSocket at `/ws`. The server and
 * every front end import these types, so they cannot drift. Messages from a client are
 * validated with zod on arrival; anything that does not parse is refused.
 *
 * Plan and security rules: docs/decisions/2026-11-06-app-front-ends.md.
 */
import { z } from 'zod';
import type { MediaKind, ToolDisplay } from '../tools/types.ts';
import type { StatusInfo } from '../ui/status.ts';

export const PROTOCOL_VERSION = 1;
/** The WebSocket subprotocol both sides agree on. */
export const SUBPROTOCOL = 'mrig.v1';
/** A launch token travels as a second subprotocol: `mrig.token.<hex>`. */
export const TOKEN_PROTOCOL_PREFIX = 'mrig.token.';

const id = z.string().min(1).max(100);
const text = z.string().max(200_000);

/** Messages a front end sends. */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int() }),
  z.object({ type: z.literal('projects.list') }),
  z.object({ type: z.literal('sessions.list'), cwd: z.string().max(4096) }),
  z.object({
    type: z.literal('session.open'),
    cwd: z.string().max(4096),
    /** A saved session id, or "latest" for the most recent one in `cwd`. Omit for a new one. */
    resume: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal('turn.send'), conversation: id, text: text.min(1) }),
  z.object({ type: z.literal('turn.abort'), conversation: id }),
  z.object({
    type: z.literal('ask.answer'),
    askId: id,
    answer: z.enum(['yes', 'no', 'always']),
  }),
  z.object({ type: z.literal('command.run'), conversation: id, text: text.min(1) }),
  z.object({
    type: z.literal('model.set'),
    conversation: id,
    provider: z.string().max(100),
    model: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('mode.set'),
    conversation: id,
    mode: z.string().max(50),
    variety: z.string().max(20).optional(),
  }),
  z.object({ type: z.literal('session.close'), conversation: id }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** One finished entry in a conversation, as a front end draws it. */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      display?: ToolDisplay;
      status?: 'ok' | 'error' | 'denied';
      output?: string;
    };

export interface MediaRef {
  kind: MediaKind;
  /** The file's name, for a caption. */
  name: string;
  /** A signed link to fetch it from this server (expires; see `security.ts`). */
  url: string;
}

export interface PendingAsk {
  askId: string;
  summary: string;
  preview?: string;
  alwaysRule: string;
}

export interface ConversationInfo {
  conversation: string;
  /** The saved session id (changes after `/resume` or `/clear`). */
  sessionId: string;
  cwd: string;
  title: string;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  model: string;
}

/** Messages the server sends. */
export type ServerMessage =
  | { type: 'hello.ok'; protocol: number; version: string }
  | { type: 'projects'; projects: Array<{ cwd: string; updatedAt: string }> }
  | { type: 'sessions'; cwd: string; sessions: SessionSummary[] }
  | {
      type: 'snapshot';
      info: ConversationInfo;
      items: TranscriptItem[];
      /** True while a turn runs; `live` is the reply streamed so far. */
      running: boolean;
      live: string;
      asks: PendingAsk[];
      status: StatusInfo;
      /** What the header pickers offer: configured profiles, modes, the tutor's varieties. */
      options: { providers: string[]; modes: string[]; varieties: string[] };
    }
  | { type: 'turn.start'; conversation: string; text: string }
  | { type: 'text.delta'; conversation: string; delta: string }
  | { type: 'reasoning.delta'; conversation: string; delta: string }
  | {
      type: 'tool.start';
      conversation: string;
      id: string;
      name: string;
      summary: string;
      display?: ToolDisplay;
    }
  | {
      type: 'tool.end';
      conversation: string;
      id: string;
      status: 'ok' | 'error' | 'denied';
      output: string;
      ms: number;
      media?: MediaRef[];
    }
  | ({ type: 'ask'; conversation: string } & PendingAsk)
  | { type: 'ask.closed'; conversation: string; askId: string; answer: 'yes' | 'no' | 'always' }
  | { type: 'notice'; conversation: string; text: string }
  /** The session's title or id changed (after the first turn, `/resume`, `/clear`). */
  | { type: 'info'; conversation: string; info: ConversationInfo }
  | { type: 'status'; conversation: string; status: StatusInfo }
  | {
      type: 'turn.end';
      conversation: string;
      result: 'ok' | 'error' | 'aborted';
      error?: string;
    }
  | { type: 'command.output'; conversation: string; text: string }
  | { type: 'error'; message: string; conversation?: string };
