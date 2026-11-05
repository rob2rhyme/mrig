/**
 * Language memory (Track 2, A3): per-variety notes in `lang/*.md` that go into the system prompt.
 *
 * Where: ~/.mrig/lang/ (global), then `.mrig/lang/` in each folder from the git root down to the
 * working directory, nearest last. Names: `<tag>.md` or `<tag>-<topic>.md`, where the tag is a
 * variety (mgp, mrd, kgj, kip, kif, kjl, kzq) or `shared`. Each file is labelled with its variety
 * in the prompt, so varieties are never pooled silently. Conventions: docs/LANGUAGE.md.
 *
 * The files are read once, when the session starts (and on `/lang reload`). The block is then
 * fixed for the session, so it stays inside the cached prompt prefix even if a file changes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { estimateTextTokens } from '../compaction.ts';
import { mrigHome } from '../config.ts';
import { VARIETIES, type Variety } from './tables.ts';

/** About 8,000 tokens. Files that would pass it are not loaded (never cut in half). */
export const MAX_LANG_CHARS = 32_000;

const TAGS = ['shared', ...Object.keys(VARIETIES)] as const;
export type LangTag = 'shared' | Variety;
const NAME = new RegExp(`^(${TAGS.join('|')})(?:-([a-z0-9][a-z0-9-]*))?\\.md$`);

export interface LangFile {
  path: string;
  tag: LangTag;
  topic?: string;
  /** NFC-normalized content, as it goes into the prompt. */
  text: string;
  tokens: number;
  /** The file on disk was not NFC; the prompt uses the normalized text. */
  normalized: boolean;
}

export interface LangSkipped {
  path: string;
  reason: string;
}

export interface LangMemory {
  files: LangFile[];
  skipped: LangSkipped[];
  /** The system prompt block; '' when no files loaded. */
  block: string;
  tokens: number;
}

export const EMPTY_LANG: LangMemory = { files: [], skipped: [], block: '', tokens: 0 };

/** The lang/ folders to read, global first, then from the git root down to cwd. */
export function langDirs(cwd: string): string[] {
  const project: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    project.push(join(dir, '.mrig', 'lang'));
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const dirs = [join(mrigHome(), 'lang'), ...project.reverse()];
  // Running in the home folder, <home>/.mrig/lang is the global folder: read it once.
  return [...new Set(dirs.map((d) => resolve(d)))].filter(
    (d) => existsSync(d) && statSync(d).isDirectory(),
  );
}

const order = (tag: LangTag) => TAGS.indexOf(tag);

export function loadLangMemory(cwd: string, maxChars = MAX_LANG_CHARS): LangMemory {
  const files: LangFile[] = [];
  const skipped: LangSkipped[] = [];
  let used = 0;
  for (const dir of langDirs(cwd)) {
    const found: Array<{ path: string; tag: LangTag; topic?: string }> = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const path = join(dir, name);
      const m = NAME.exec(name);
      if (!m) {
        skipped.push({
          path,
          reason: `the name must be <tag>.md or <tag>-<topic>.md, with tag one of ${TAGS.join(', ')}`,
        });
        continue;
      }
      found.push({ path, tag: m[1] as LangTag, ...(m[2] ? { topic: m[2] } : {}) });
    }
    found.sort(
      (a, b) => order(a.tag) - order(b.tag) || (a.topic ?? '').localeCompare(b.topic ?? ''),
    );
    for (const f of found) {
      const raw = readFileSync(f.path, 'utf8').trim();
      const text = raw.normalize('NFC');
      if (!text) {
        skipped.push({ path: f.path, reason: 'empty' });
        continue;
      }
      if (used + text.length > maxChars) {
        skipped.push({
          path: f.path,
          reason: `over the ${maxChars.toLocaleString()}-character limit for language memory`,
        });
        continue;
      }
      used += text.length;
      files.push({ ...f, text, tokens: estimateTextTokens(text), normalized: raw !== text });
    }
  }
  const block = files.length > 0 ? formatBlock(files, cwd) : '';
  return { files, skipped, block, tokens: estimateTextTokens(block) };
}

export function tagLabel(tag: LangTag): string {
  return tag === 'shared' ? 'all varieties' : `${VARIETIES[tag]} (${tag})`;
}

/** Where a file lives, short: ~/.mrig/lang/… or relative to cwd. */
export function displayLangPath(path: string, cwd: string): string {
  const home = resolve(mrigHome());
  if (path.startsWith(home)) return `~/.mrig${path.slice(home.length).replaceAll('\\', '/')}`;
  return relative(cwd, path).replaceAll('\\', '/') || path;
}

function formatBlock(files: LangFile[], cwd: string): string {
  const parts = [
    '## Language memory (lang/*.md, by variety: keep varieties apart and say which one you mean; Devanagari is canonical, and Akkha and romanization come from the translit tool)',
  ];
  for (const f of files) {
    parts.push(`### ${tagLabel(f.tag)} · ${displayLangPath(f.path, cwd)}\n${f.text}`);
  }
  return parts.join('\n\n');
}

/** Lines for `/lang`. */
export function langReport(mem: LangMemory, cwd: string): string[] {
  const lines: string[] = [];
  if (mem.files.length === 0) {
    lines.push(
      'No language memory loaded. Add files such as ~/.mrig/lang/mgp.md or .mrig/lang/shared.md (naming: docs/LANGUAGE.md), then /lang reload.',
    );
  } else {
    lines.push(
      `language memory: ${mem.files.length} file${mem.files.length === 1 ? '' : 's'} · ~${mem.tokens.toLocaleString()} tokens, in the cached system prompt`,
    );
    for (const f of mem.files) {
      lines.push(
        `  ${f.tag.padEnd(6)} ${displayLangPath(f.path, cwd)} · ~${f.tokens.toLocaleString()} tokens · ${tagLabel(f.tag)}${f.normalized ? ' · not NFC on disk (normalized here)' : ''}`,
      );
    }
  }
  for (const s of mem.skipped) {
    lines.push(`  not loaded: ${displayLangPath(s.path, cwd)}: ${s.reason}`);
  }
  return lines;
}
