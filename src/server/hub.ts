/**
 * The app server's state (Track 4, U1): one `Runtime` per open conversation, the clients
 * watching each one, the turn in progress and its permission questions. No transport here:
 * `serve.ts` feeds it parsed messages and gives it a way to send, so it is tested directly.
 *
 * Like `TuiController`, it only translates: business logic stays in the runtime and the
 * shared slash commands.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { AgentEvents } from '../agent.ts';
import { VARIETIES } from '../lang/tables.ts';
import { isModeName, MODE_NAMES } from '../modes.ts';
import type { Answer, AskRequest } from '../permissions.ts';
import { formatModelError } from '../providers.ts';
import { Runtime, type RuntimeOptions } from '../runtime.ts';
import { Session } from '../session.ts';
import { runCommand, startupChecks } from '../ui/commands.ts';
import { runtimeStatus } from '../ui/status.ts';
import { truncateMiddle } from '../util/text.ts';
import { findZone, zoneSessionsDir } from '../zone.ts';
import {
  type ClientMessage,
  type MediaRef,
  type PendingAsk,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionSummary,
} from './protocol.ts';
import { insideMediaFolders, type MediaSigner } from './security.ts';
import { ITEM_OUTPUT_CHARS, transcriptItems } from './transcript.ts';

export interface HubClient {
  readonly id: string;
  /** Another device, through Tailscale (U3): Allow once and Deny only, and no `/yolo`. */
  readonly remote?: boolean;
  send(message: ServerMessage): void;
}

/** What another device is told when it tries something only the Mac may do. */
export const MAC_ONLY = {
  always:
    "Always allow works only on the Mac, so a lost phone can't widen what mrig may do. Allow once, or add the rule on the Mac.",
  yolo: '/yolo works only on the Mac.',
};

export type RuntimeDefaults = Omit<RuntimeOptions, 'cwd' | 'resume' | 'ask' | 'events'>;

export interface HubOptions {
  /**
   * Shared by every conversation: provider, model, yolo, offline. A function gets the folder,
   * so tests can give each conversation its own scripted model.
   */
  runtime: RuntimeDefaults | ((cwd: string) => RuntimeDefaults);
  signer: MediaSigner;
  version: string;
  /** How long a permission question waits for an answer before it counts as deny. */
  askTimeoutMs?: number;
  /** Run the startup checks (a model-list request) on each new conversation. Default true. */
  checks?: boolean;
}

/** Ten minutes: a question nobody answers is a deny. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const ANSI = /\x1b\[[0-9;]*m/g;

interface Ask {
  pending: PendingAsk;
  settle: (answer: Answer) => void;
}

class Conversation {
  readonly clients = new Set<HubClient>();
  readonly asks = new Map<string, Ask>();
  running: AbortController | null = null;
  live = '';
  // Set right after construction: the runtime needs this conversation's events and ask.
  rt!: Runtime;
  constructor(readonly id: string) {}

  broadcast(message: ServerMessage): void {
    for (const client of this.clients) client.send(message);
  }
}

export class Hub {
  private readonly conversations = new Map<string, Conversation>();
  private nextConversation = 1;
  private nextAsk = 1;

  constructor(private readonly opts: HubOptions) {}

  /** Signs and checks the media links this hub hands out. */
  get signer(): MediaSigner {
    return this.opts.signer;
  }

  /** Handle one validated message from a client. Never throws: failures become `error`. */
  async handle(client: HubClient, msg: ClientMessage): Promise<void> {
    try {
      await this.dispatch(client, msg);
    } catch (err) {
      client.send({
        type: 'error',
        message: (err as Error).message,
        ...('conversation' in msg ? { conversation: msg.conversation } : {}),
      });
    }
  }

  private async dispatch(client: HubClient, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'hello':
        if (msg.protocol !== PROTOCOL_VERSION) {
          throw new Error(
            `This mrig speaks protocol ${PROTOCOL_VERSION}; the app sent ${msg.protocol}. Update the one that is older.`,
          );
        }
        client.send({
          type: 'hello.ok',
          protocol: PROTOCOL_VERSION,
          version: this.opts.version,
          ...(client.remote ? { remote: true } : {}),
        });
        return;
      case 'projects.list':
        client.send({ type: 'projects', projects: listProjects() });
        return;
      case 'sessions.list':
        client.send({ type: 'sessions', cwd: msg.cwd, sessions: listSessions(checkDir(msg.cwd)) });
        return;
      case 'session.open':
        await this.open(client, msg.cwd, msg.resume);
        return;
      case 'turn.send':
        await this.turn(this.joined(client, msg.conversation), msg.text);
        return;
      case 'turn.abort':
        this.abort(this.joined(client, msg.conversation));
        return;
      case 'ask.answer':
        this.answer(client, msg.askId, msg.answer);
        return;
      case 'command.run':
        if (client.remote && /^\/yolo\b/i.test(msg.text.trim())) throw new Error(MAC_ONLY.yolo);
        await this.command(this.joined(client, msg.conversation), msg.text);
        return;
      case 'model.set': {
        const conv = this.idle(this.joined(client, msg.conversation));
        conv.rt.switchModel(msg.provider, msg.model);
        this.sendStatus(conv);
        return;
      }
      case 'mode.set': {
        const conv = this.idle(this.joined(client, msg.conversation));
        if (!isModeName(msg.mode)) throw new Error(`Unknown mode "${msg.mode}".`);
        conv.rt.setMode(msg.mode, msg.variety);
        this.sendSnapshotToAll(conv);
        return;
      }
      case 'session.close':
        await this.leave(client, msg.conversation);
        return;
    }
  }

  // ---- conversations ----

  private async open(client: HubClient, cwd: string, resume?: string): Promise<void> {
    const dir = checkDir(cwd);
    if (resume && resume !== 'latest') {
      for (const conv of this.conversations.values()) {
        if (conv.rt.session.meta.id === resume) {
          conv.clients.add(client);
          client.send(this.snapshot(conv));
          return;
        }
      }
    }
    const conv = new Conversation(`c${this.nextConversation++}`);
    const defaults =
      typeof this.opts.runtime === 'function' ? this.opts.runtime(dir) : this.opts.runtime;
    conv.rt = new Runtime({
      ...defaults,
      cwd: dir,
      ...(resume ? { resume } : {}),
      ask: (req) => this.ask(conv, req),
      events: this.events(conv),
    });
    await conv.rt.startMcp();
    this.conversations.set(conv.id, conv);
    conv.clients.add(client);
    client.send(this.snapshot(conv));
    if (this.opts.checks !== false) {
      startupChecks(
        conv.rt,
        (text) => conv.broadcast({ type: 'notice', conversation: conv.id, text }),
        () => this.conversations.has(conv.id),
      );
    }
  }

  /** The conversation, if this client opened it. */
  private joined(client: HubClient, id: string): Conversation {
    const conv = this.conversations.get(id);
    if (!conv?.clients.has(client)) {
      throw new Error(`No open conversation "${id}". Open it with session.open first.`);
    }
    return conv;
  }

  private idle(conv: Conversation): Conversation {
    if (conv.running) throw new Error('A turn is running; stop it or wait for it to finish.');
    return conv;
  }

  private async leave(client: HubClient, id: string): Promise<void> {
    const conv = this.joined(client, id);
    conv.clients.delete(client);
    if (conv.clients.size === 0 && !conv.running) await this.closeConversation(conv);
  }

  /** A client went away: it stops receiving. Its conversations keep running for a reconnect. */
  detach(client: HubClient): void {
    for (const conv of this.conversations.values()) conv.clients.delete(client);
  }

  private async closeConversation(conv: Conversation): Promise<void> {
    this.conversations.delete(conv.id);
    conv.rt.save();
    await conv.rt.close();
  }

  // ---- turns ----

  private async turn(conv: Conversation, text: string): Promise<void> {
    this.idle(conv);
    const controller = new AbortController();
    conv.running = controller;
    conv.live = '';
    conv.broadcast({ type: 'turn.start', conversation: conv.id, text });
    try {
      await conv.rt.runTurn(text, controller.signal);
      // A stopped turn can end quietly rather than throw; the signal says which it was.
      conv.broadcast({
        type: 'turn.end',
        conversation: conv.id,
        result: controller.signal.aborted ? 'aborted' : 'ok',
      });
    } catch (err) {
      if (controller.signal.aborted) {
        conv.broadcast({ type: 'turn.end', conversation: conv.id, result: 'aborted' });
      } else {
        conv.broadcast({
          type: 'turn.end',
          conversation: conv.id,
          result: 'error',
          error: formatModelError(err, conv.rt.profile),
        });
      }
    } finally {
      conv.running = null;
      conv.live = '';
      conv.rt.save();
      this.sendStatus(conv);
      conv.broadcast({ type: 'info', conversation: conv.id, info: this.info(conv) });
    }
  }

  /** The Stop button: deny any open question, then abort the turn. */
  private abort(conv: Conversation): void {
    for (const ask of [...conv.asks.values()]) ask.settle('no');
    conv.running?.abort();
  }

  private async command(conv: Conversation, text: string): Promise<void> {
    this.idle(conv);
    const out: string[] = [];
    const exit = await runCommand(conv.rt, text.trim(), {
      write: (s) => out.push(s.replace(ANSI, '')),
      busy: async (run) => {
        const controller = new AbortController();
        conv.running = controller;
        try {
          return await run(controller.signal);
        } finally {
          conv.running = null;
        }
      },
    });
    if (exit) out.push('Close the app to end the conversation; /exit does nothing here.\n');
    conv.rt.save();
    conv.broadcast({ type: 'command.output', conversation: conv.id, text: out.join('') });
    // A command can change the transcript, the session, the model or the mode.
    this.sendSnapshotToAll(conv);
  }

  // ---- permission questions ----

  private ask(conv: Conversation, req: AskRequest): Promise<Answer> {
    return new Promise((resolve) => {
      const askId = `a${this.nextAsk++}`;
      const pending: PendingAsk = {
        askId,
        summary: req.summary,
        ...(req.preview ? { preview: req.preview } : {}),
        alwaysRule: req.alwaysRule,
      };
      const timer = setTimeout(() => settle('no'), this.opts.askTimeoutMs ?? ASK_TIMEOUT_MS);
      const settle = (answer: Answer) => {
        if (!conv.asks.delete(askId)) return; // already answered: the first answer wins
        clearTimeout(timer);
        conv.broadcast({ type: 'ask.closed', conversation: conv.id, askId, answer });
        resolve(answer);
      };
      conv.asks.set(askId, { pending, settle });
      conv.broadcast({ type: 'ask', conversation: conv.id, ...pending });
    });
  }

  private answer(client: HubClient, askId: string, answer: Answer): void {
    if (client.remote && answer === 'always') throw new Error(MAC_ONLY.always);
    for (const conv of this.conversations.values()) {
      const ask = conv.asks.get(askId);
      if (ask && conv.clients.has(client)) {
        ask.settle(answer);
        return;
      }
    }
    throw new Error(`Question ${askId} is not open (already answered, timed out or stopped).`);
  }

  // ---- events ----

  private events(conv: Conversation): AgentEvents {
    const id = conv.id;
    return {
      onText: (delta) => {
        conv.live += delta;
        conv.broadcast({ type: 'text.delta', conversation: id, delta });
      },
      onReasoning: (delta) => {
        if (conv.rt?.verbose && delta) {
          conv.broadcast({ type: 'reasoning.delta', conversation: id, delta });
        }
      },
      onToolStart: (call) => {
        conv.broadcast({
          type: 'tool.start',
          conversation: id,
          id: call.id,
          name: call.name,
          summary: call.summary,
          ...(call.display ? { display: call.display } : {}),
        });
      },
      onToolEnd: (call, outcome) => {
        const media = this.mediaRefs(conv, outcome.files ?? []);
        conv.broadcast({
          type: 'tool.end',
          conversation: id,
          id: call.id,
          status: outcome.status,
          output: truncateMiddle(outcome.text, ITEM_OUTPUT_CHARS),
          ms: outcome.ms,
          ...(media.length ? { media } : {}),
        });
      },
      onStepEnd: () => {
        conv.live = '';
        this.sendStatus(conv);
      },
      onNotice: (text) => conv.broadcast({ type: 'notice', conversation: id, text }),
    };
  }

  private sendStatus(conv: Conversation): void {
    conv.broadcast({ type: 'status', conversation: conv.id, status: runtimeStatus(conv.rt) });
  }

  // ---- snapshots and media ----

  private info(conv: Conversation) {
    return {
      conversation: conv.id,
      sessionId: conv.rt.session.meta.id,
      cwd: conv.rt.cwd,
      title: conv.rt.session.meta.title,
    };
  }

  private snapshot(conv: Conversation): ServerMessage {
    const rt = conv.rt;
    return {
      type: 'snapshot',
      info: this.info(conv),
      items: transcriptItems(rt.agent.messages, rt.currentTools()),
      running: conv.running !== null,
      live: conv.live,
      asks: [...conv.asks.values()].map((a) => a.pending),
      status: runtimeStatus(rt),
      options: {
        providers: Object.keys(rt.config.providers).sort(),
        modes: [...MODE_NAMES],
        varieties: Object.keys(VARIETIES),
      },
    };
  }

  private sendSnapshotToAll(conv: Conversation): void {
    const snap = this.snapshot(conv);
    conv.broadcast(snap);
  }

  /** The folders whose files this conversation may serve: its media folders, nothing else. */
  private mediaFolders(conv: Conversation): string[] {
    const { cwd, config } = conv.rt;
    return [
      resolve(cwd, config.image?.dir ?? 'images'),
      resolve(cwd, config.speech?.dir ?? 'audio'),
      resolve(cwd, config.video?.dir ?? 'videos'),
    ];
  }

  private mediaRefs(conv: Conversation, files: Array<{ path: string; kind: MediaRef['kind'] }>) {
    return files
      .filter((f) => insideMediaFolders(f.path, this.mediaFolders(conv)))
      .map((f) => ({
        kind: f.kind,
        name: basename(f.path),
        url: this.opts.signer.url(conv.id, f.path),
      }));
  }

  /** True when this conversation may serve the file (the media route checks the link too). */
  mediaAllowed(conversation: string, path: string): boolean {
    const conv = this.conversations.get(conversation);
    return conv !== undefined && insideMediaFolders(path, this.mediaFolders(conv));
  }

  /** Stop everything: deny open questions, abort turns, save and close every runtime. */
  async close(): Promise<void> {
    for (const conv of [...this.conversations.values()]) {
      this.abort(conv);
      await this.closeConversation(conv);
    }
  }
}

/** An absolute path to an existing folder, or an error. */
function checkDir(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error(`The project folder must be an absolute path: ${cwd}`);
  const dir = resolve(cwd);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`No such folder: ${dir}`);
  }
  return dir;
}

/** Folders with saved sessions, newest first (sessions inside offline zones stay out). */
function listProjects(): Array<{ cwd: string; updatedAt: string }> {
  const seen = new Map<string, string>();
  for (const s of Session.list()) if (!seen.has(s.cwd)) seen.set(s.cwd, s.updatedAt);
  return [...seen].map(([cwd, updatedAt]) => ({ cwd, updatedAt }));
}

/** The saved sessions for one folder, from the zone's own list inside an offline zone. */
function listSessions(cwd: string): SessionSummary[] {
  const zone = findZone(cwd);
  return Session.list(zone ? zoneSessionsDir(zone) : undefined)
    .filter((s) => s.cwd === cwd)
    .map((s) => ({ id: s.id, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, model: s.model }));
}
