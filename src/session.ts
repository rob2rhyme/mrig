/**
 * Sessions are JSONL files in ~/.mrig/sessions/<id>.jsonl:
 *   line 1: {"type":"meta", ...}   padded with spaces to META_WIDTH bytes
 *   line n: {"type":"message","message":{...ModelMessage}}
 *
 * New messages are appended. The meta line is rewritten in place (same byte width) so
 * `updatedAt` and `title` stay fresh on long transcripts without rewriting the whole file.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { mrigHome } from './config.ts';

export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  title: string;
  /** The offline zone this session belongs to (L5); absent outside zones. */
  zone?: string;
  /** The mode (T1), when not default; `-c` and `/resume` restore it. */
  mode?: string;
  /** The tutor mode's variety (T8). */
  variety?: string;
}

type Line = { type: 'meta' } & SessionMeta;
type MessageLine = { type: 'message'; message: ModelMessage };

/** Reserved byte width of the meta line, so it can be rewritten in place. */
export const META_WIDTH = 1024;

function padHead(head: string, width: number): string {
  const len = Buffer.byteLength(head);
  return len >= width ? head : head + ' '.repeat(width - len);
}

/** Where sessions live: `dir` when given (an offline zone's folder), else ~/.mrig/sessions. */
export function sessionsDir(dir?: string): string {
  dir ??= join(mrigHome(), 'sessions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function newId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

function firstUserText(messages: ModelMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join(' ');
    const t = text.replace(/\s+/g, ' ').trim();
    if (t && !t.startsWith('[mrig]')) return t.length > 72 ? `${t.slice(0, 72)}…` : t;
  }
  return '';
}

export class Session {
  meta: SessionMeta;
  messages: ModelMessage[];
  private savedCount: number;
  /** Byte width of the meta line as it sits on disk (without the newline). */
  private headWidth: number;
  /** False for in-memory sessions (the eval harness): nothing is ever written to disk. */
  private persist = true;
  /** The sessions folder (an offline zone's), or undefined for ~/.mrig/sessions. */
  private readonly dir: string | undefined;

  private constructor(
    meta: SessionMeta,
    messages: ModelMessage[],
    savedCount: number,
    headWidth: number,
    dir?: string,
  ) {
    this.dir = dir;
    this.meta = meta;
    this.messages = messages;
    this.savedCount = savedCount;
    this.headWidth = headWidth;
  }

  get filePath(): string {
    return join(sessionsDir(this.dir), `${this.meta.id}.jsonl`);
  }

  static create(opts: {
    cwd: string;
    provider: string;
    model: string;
    /** Keep the session in memory only; nothing touches ~/.mrig/sessions. */
    ephemeral?: boolean;
    /** Sessions folder (an offline zone's); default ~/.mrig/sessions. */
    dir?: string;
    /** The offline zone the session belongs to. */
    zone?: string;
  }): Session {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: newId(),
      cwd: opts.cwd,
      createdAt: now,
      updatedAt: now,
      provider: opts.provider,
      model: opts.model,
      title: '',
      ...(opts.zone ? { zone: opts.zone } : {}),
    };
    const s = new Session(meta, [], 0, 0, opts.dir);
    if (opts.ephemeral) s.persist = false;
    s.writeAll();
    return s;
  }

  static load(id: string, dir?: string): Session {
    const path = join(sessionsDir(dir), `${id}.jsonl`);
    if (!existsSync(path)) throw new Error(`No session with id "${id}".`);
    const content = readFileSync(path, 'utf8');
    const firstBreak = content.indexOf('\n');
    const headWidth = Buffer.byteLength(firstBreak === -1 ? content : content.slice(0, firstBreak));
    const lines = content.split('\n').filter((l) => l.trim());
    let meta: SessionMeta | undefined;
    const messages: ModelMessage[] = [];
    for (const raw of lines) {
      const line = JSON.parse(raw) as Line | MessageLine;
      if (line.type === 'meta') {
        const { type: _t, ...rest } = line;
        meta = rest;
      } else if (line.type === 'message') messages.push(line.message);
    }
    if (!meta) throw new Error(`Session file ${path} has no meta line.`);
    return new Session(meta, messages, messages.length, headWidth, dir);
  }

  static list(where?: string): SessionMeta[] {
    const dir = sessionsDir(where);
    const metas: SessionMeta[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const first = readFileSync(join(dir, name), 'utf8').split('\n', 1)[0] ?? '';
        const line = JSON.parse(first) as Line;
        if (line.type === 'meta') {
          const { type: _t, ...rest } = line;
          metas.push(rest);
        }
      } catch {
        // skip corrupt files
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  static latest(cwd?: string, dir?: string): SessionMeta | undefined {
    const all = Session.list(dir);
    return cwd ? all.find((m) => m.cwd === cwd) : all[0];
  }

  /** Persist whatever is new in `messages` (append), or rewrite after a compaction/clear. */
  sync(messages: ModelMessage[], opts: { rewrite?: boolean; titleHint?: string } = {}): void {
    this.messages = messages;
    this.meta.updatedAt = new Date().toISOString();
    if (!this.meta.title) this.meta.title = firstUserText(messages);
    // Compaction can summarize the first prompt away before the first save; fall back to it.
    if (!this.meta.title && opts.titleHint) {
      this.meta.title = firstUserText([{ role: 'user', content: opts.titleHint }]);
    }
    if (!this.persist) return;
    // Rewrite when earlier history changed (compaction, clear), not only when it shrank.
    if (opts.rewrite || messages.length < this.savedCount || this.savedCount === 0) {
      this.writeAll();
      return;
    }
    const fresh = messages.slice(this.savedCount);
    if (fresh.length > 0) {
      const lines = fresh.map((m) =>
        JSON.stringify({ type: 'message', message: m } satisfies MessageLine),
      );
      appendFileSync(this.filePath, `${lines.join('\n')}\n`);
    }
    this.savedCount = messages.length;
    this.writeMeta();
  }

  setModel(provider: string, model: string): void {
    this.meta.provider = provider;
    this.meta.model = model;
    this.writeAll();
  }

  setMode(mode: string, variety?: string): void {
    if (mode === 'default') delete this.meta.mode;
    else this.meta.mode = mode;
    if (variety) this.meta.variety = variety;
    else delete this.meta.variety;
    this.writeAll();
  }

  private headLine(): string {
    return JSON.stringify({ type: 'meta', ...this.meta } satisfies Line);
  }

  /** Rewrite only the meta line, in place, when it fits the reserved width; else everything. */
  private writeMeta(): void {
    const head = this.headLine();
    if (Buffer.byteLength(head) > this.headWidth) {
      this.writeAll();
      return;
    }
    const fd = openSync(this.filePath, 'r+');
    try {
      writeSync(fd, padHead(head, this.headWidth), 0, 'utf8');
    } finally {
      closeSync(fd);
    }
  }

  private writeAll(): void {
    if (!this.persist) return;
    const head = padHead(this.headLine(), META_WIDTH);
    const body = this.messages.map((m) =>
      JSON.stringify({ type: 'message', message: m } satisfies MessageLine),
    );
    writeFileSync(this.filePath, `${[head, ...body].join('\n')}\n`);
    this.savedCount = this.messages.length;
    this.headWidth = Buffer.byteLength(head);
  }
}
