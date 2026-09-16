/**
 * Sessions are JSONL files in ~/.mrig/sessions/<id>.jsonl:
 *   line 1: {"type":"meta", ...}
 *   line n: {"type":"message","message":{...ModelMessage}}
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
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
}

type Line = { type: 'meta' } & SessionMeta;
type MessageLine = { type: 'message'; message: ModelMessage };

export function sessionsDir(): string {
  const dir = join(mrigHome(), 'sessions');
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

  private constructor(meta: SessionMeta, messages: ModelMessage[], savedCount: number) {
    this.meta = meta;
    this.messages = messages;
    this.savedCount = savedCount;
  }

  get filePath(): string {
    return join(sessionsDir(), `${this.meta.id}.jsonl`);
  }

  static create(opts: { cwd: string; provider: string; model: string }): Session {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: newId(),
      cwd: opts.cwd,
      createdAt: now,
      updatedAt: now,
      provider: opts.provider,
      model: opts.model,
      title: '',
    };
    const s = new Session(meta, [], 0);
    s.writeAll();
    return s;
  }

  static load(id: string): Session {
    const path = join(sessionsDir(), `${id}.jsonl`);
    if (!existsSync(path)) throw new Error(`No session with id "${id}".`);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
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
    return new Session(meta, messages, messages.length);
  }

  static list(): SessionMeta[] {
    const dir = sessionsDir();
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

  static latest(cwd?: string): SessionMeta | undefined {
    const all = Session.list();
    return cwd ? all.find((m) => m.cwd === cwd) : all[0];
  }

  /** Persist whatever is new in `messages` (append), or rewrite after a compaction/clear. */
  sync(messages: ModelMessage[]): void {
    this.messages = messages;
    this.meta.updatedAt = new Date().toISOString();
    if (!this.meta.title) this.meta.title = firstUserText(messages);
    if (messages.length < this.savedCount || this.savedCount === 0) {
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
    // Keep meta (updatedAt/title) fresh without rewriting messages: rewrite only when cheap.
    if (messages.length <= 4) this.writeAll();
  }

  setModel(provider: string, model: string): void {
    this.meta.provider = provider;
    this.meta.model = model;
    this.writeAll();
  }

  private writeAll(): void {
    const head = JSON.stringify({ type: 'meta', ...this.meta } satisfies Line);
    const body = this.messages.map((m) =>
      JSON.stringify({ type: 'message', message: m } satisfies MessageLine),
    );
    writeFileSync(this.filePath, `${[head, ...body].join('\n')}\n`);
    this.savedCount = this.messages.length;
  }
}
