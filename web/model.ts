/**
 * The web app's state (Track 4, U2), with no React and no DOM in it: `reduce` turns protocol
 * messages and local actions into the state the screen draws. Like `TuiController` for the
 * terminal, it is tested without a browser (tests/web_model.test.ts).
 */
import type {
  MediaRef,
  PendingAsk,
  ServerMessage,
  SessionSummary,
  TranscriptItem,
} from '../src/server/protocol.ts';
import type { ToolDisplay } from '../src/tools/types.ts';
import type { StatusInfo } from '../src/ui/status.ts';

export interface ToolCard {
  id: string;
  name: string;
  summary: string;
  display?: ToolDisplay;
  status: 'running' | 'ok' | 'error' | 'denied';
  output?: string;
  ms?: number;
  media?: MediaRef[];
}

export type Entry =
  | {
      kind: 'user' | 'assistant' | 'reasoning' | 'notice' | 'command' | 'error';
      id: number;
      text: string;
    }
  | { kind: 'tool'; id: number; card: ToolCard };

export interface ConversationView {
  conversation: string;
  sessionId: string;
  cwd: string;
  title: string;
  entries: Entry[];
  /** The reply streaming in now, and (with /verbose) its reasoning. */
  live: string;
  reasoning: string;
  running: boolean;
  asks: PendingAsk[];
  status: StatusInfo;
  options: { providers: string[]; modes: string[]; varieties: string[] };
}

export type Connection = 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

export interface AppState {
  connection: Connection;
  projects: Array<{ cwd: string; updatedAt: string }>;
  sessions: Record<string, SessionSummary[]>;
  conversations: Record<string, ConversationView>;
  /** Open conversations, in the order they were opened (tabs). */
  order: string[];
  active?: string;
  /** Select the next conversation the server opens. */
  focusNext: boolean;
  /** After a reconnect: select the conversation for this session when it comes back. */
  focusSession?: string;
  /** An error that belongs to no conversation. */
  error?: string;
  nextId: number;
}

export type LocalAction =
  | { type: 'local.connection'; connection: Connection }
  | { type: 'local.opening' }
  | { type: 'local.select'; conversation: string }
  | { type: 'local.close'; conversation: string }
  | { type: 'local.dismissError' }
  /** The connection came back: drop the stale views; the app reopens each session. */
  | { type: 'local.reset'; focusSession?: string };

export const INITIAL_STATE: AppState = {
  connection: 'connecting',
  projects: [],
  sessions: {},
  conversations: {},
  order: [],
  focusNext: true,
  nextId: 1,
};

function itemsToEntries(
  items: TranscriptItem[],
  start: number,
): { entries: Entry[]; next: number } {
  let next = start;
  const entries: Entry[] = items.map((item) => {
    if (item.kind === 'tool') {
      return {
        kind: 'tool',
        id: next++,
        card: {
          id: item.id,
          name: item.name,
          summary: item.summary,
          ...(item.display ? { display: item.display } : {}),
          status: item.status ?? 'running',
          ...(item.output !== undefined ? { output: item.output } : {}),
        },
      };
    }
    return { kind: item.kind, id: next++, text: item.text };
  });
  return { entries, next };
}

/** Move streamed reasoning and text into finished entries. */
function flush(
  state: AppState,
  conv: ConversationView,
): { conv: ConversationView; nextId: number } {
  let nextId = state.nextId;
  const entries = [...conv.entries];
  if (conv.reasoning.trim())
    entries.push({ kind: 'reasoning', id: nextId++, text: conv.reasoning });
  if (conv.live.trim()) entries.push({ kind: 'assistant', id: nextId++, text: conv.live });
  return { conv: { ...conv, entries, live: '', reasoning: '' }, nextId };
}

function withConversation(
  state: AppState,
  id: string,
  change: (conv: ConversationView, state: AppState) => { conv: ConversationView; nextId?: number },
): AppState {
  const conv = state.conversations[id];
  if (!conv) return state;
  const out = change(conv, state);
  return {
    ...state,
    conversations: { ...state.conversations, [id]: out.conv },
    nextId: out.nextId ?? state.nextId,
  };
}

/** An entry before it has an id (Omit spread over each member of the union). */
type NewEntry = Entry extends unknown
  ? Entry extends infer E
    ? E extends unknown
      ? Omit<E, 'id'>
      : never
    : never
  : never;

function push(state: AppState, conv: ConversationView, entry: NewEntry) {
  return {
    conv: { ...conv, entries: [...conv.entries, { ...entry, id: state.nextId } as Entry] },
    nextId: state.nextId + 1,
  };
}

function updateCard(conv: ConversationView, id: string, change: (c: ToolCard) => ToolCard) {
  let found = false;
  const entries = conv.entries.map((e) => {
    if (e.kind !== 'tool' || e.card.id !== id) return e;
    found = true;
    return { ...e, card: change(e.card) };
  });
  return { entries, found };
}

export function reduce(state: AppState, msg: ServerMessage | LocalAction): AppState {
  switch (msg.type) {
    case 'local.connection':
      return { ...state, connection: msg.connection };
    case 'local.opening':
      return { ...state, focusNext: true };
    case 'local.select':
      return state.conversations[msg.conversation] ? { ...state, active: msg.conversation } : state;
    case 'local.close': {
      const { [msg.conversation]: _gone, ...rest } = state.conversations;
      const order = state.order.filter((c) => c !== msg.conversation);
      return {
        ...state,
        conversations: rest,
        order,
        active: state.active === msg.conversation ? order[order.length - 1] : state.active,
      };
    }
    case 'local.reset': {
      const { focusSession: _f, active: _a, ...rest } = state;
      return {
        ...rest,
        conversations: {},
        order: [],
        focusNext: msg.focusSession === undefined,
        ...(msg.focusSession ? { focusSession: msg.focusSession } : {}),
      };
    }
    case 'local.dismissError': {
      const { error: _e, ...rest } = state;
      return rest;
    }
    case 'hello.ok':
      return { ...state, connection: 'open' };
    case 'projects':
      return { ...state, projects: msg.projects };
    case 'sessions':
      return { ...state, sessions: { ...state.sessions, [msg.cwd]: msg.sessions } };
    case 'snapshot': {
      const id = msg.info.conversation;
      const { entries, next } = itemsToEntries(msg.items, state.nextId);
      const conv: ConversationView = {
        conversation: id,
        sessionId: msg.info.sessionId,
        cwd: msg.info.cwd,
        title: msg.info.title,
        entries,
        live: msg.live,
        reasoning: '',
        running: msg.running,
        asks: msg.asks,
        status: msg.status,
        options: msg.options,
      };
      return {
        ...state,
        conversations: { ...state.conversations, [id]: conv },
        order: state.order.includes(id) ? state.order : [...state.order, id],
        active:
          state.focusSession === msg.info.sessionId || state.focusNext || !state.active
            ? id
            : state.active,
        focusNext: false,
        ...(state.focusSession === msg.info.sessionId ? { focusSession: undefined } : {}),
        nextId: next,
      };
    }
    case 'turn.start':
      return withConversation(state, msg.conversation, (conv, s) =>
        push(
          s,
          { ...conv, running: true, live: '', reasoning: '' },
          { kind: 'user', text: msg.text },
        ),
      );
    case 'text.delta':
      return withConversation(state, msg.conversation, (conv) => ({
        conv: { ...conv, live: conv.live + msg.delta },
      }));
    case 'reasoning.delta':
      return withConversation(state, msg.conversation, (conv) => ({
        conv: { ...conv, reasoning: conv.reasoning + msg.delta },
      }));
    case 'tool.start':
      return withConversation(state, msg.conversation, (conv, s) => {
        const flushed = flush(s, conv);
        const card: ToolCard = {
          id: msg.id,
          name: msg.name,
          summary: msg.summary,
          ...(msg.display ? { display: msg.display } : {}),
          status: 'running',
        };
        return push({ ...s, nextId: flushed.nextId }, flushed.conv, { kind: 'tool', card });
      });
    case 'tool.end':
      return withConversation(state, msg.conversation, (conv, s) => {
        const done = (c: ToolCard): ToolCard => ({
          ...c,
          status: msg.status,
          output: msg.output,
          ms: msg.ms,
          ...(msg.media ? { media: msg.media } : {}),
        });
        const { entries, found } = updateCard(conv, msg.id, done);
        if (found) return { conv: { ...conv, entries } };
        // A client that reconnected mid-call never saw the start.
        const card = done({ id: msg.id, name: '', summary: 'tool call', status: 'running' });
        return push(s, conv, { kind: 'tool', card });
      });
    case 'ask':
      return withConversation(state, msg.conversation, (conv) => {
        if (conv.asks.some((a) => a.askId === msg.askId)) return { conv };
        const { type: _t, conversation: _c, ...ask } = msg;
        return { conv: { ...conv, asks: [...conv.asks, ask] } };
      });
    case 'ask.closed':
      return withConversation(state, msg.conversation, (conv) => ({
        conv: { ...conv, asks: conv.asks.filter((a) => a.askId !== msg.askId) },
      }));
    case 'notice':
      return withConversation(state, msg.conversation, (conv, s) =>
        push(s, conv, { kind: 'notice', text: msg.text }),
      );
    case 'info':
      return withConversation(state, msg.conversation, (conv) => ({
        conv: { ...conv, title: msg.info.title, sessionId: msg.info.sessionId },
      }));
    case 'status':
      return withConversation(state, msg.conversation, (conv) => ({
        conv: { ...conv, status: msg.status },
      }));
    case 'turn.end':
      return withConversation(state, msg.conversation, (conv, s) => {
        const flushed = flush(s, { ...conv, running: false, asks: [] });
        const next = { ...s, nextId: flushed.nextId };
        if (msg.result === 'error') {
          return push(next, flushed.conv, { kind: 'error', text: msg.error ?? 'The turn failed.' });
        }
        if (msg.result === 'aborted')
          return push(next, flushed.conv, { kind: 'notice', text: 'Stopped.' });
        return { conv: flushed.conv, nextId: flushed.nextId };
      });
    case 'command.output':
      return withConversation(state, msg.conversation, (conv, s) =>
        msg.text.trim() ? push(s, conv, { kind: 'command', text: msg.text.trimEnd() }) : { conv },
      );
    case 'error':
      if (msg.conversation && state.conversations[msg.conversation]) {
        return withConversation(state, msg.conversation, (conv, s) =>
          push(s, conv, { kind: 'error', text: msg.message }),
        );
      }
      return { ...state, error: msg.message };
  }
}

/** Whether anything in the app needs the user: a question waiting in any conversation. */
export function waitingAsks(state: AppState): number {
  return Object.values(state.conversations).reduce((n, c) => n + c.asks.length, 0);
}
