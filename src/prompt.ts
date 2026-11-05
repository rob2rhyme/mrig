/**
 * System prompt: short, specific, and loaded with the project's AGENTS.md memory.
 * Target: under ~1,000 tokens before memory files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { mrigHome, type ToolMode } from './config.ts';
import { MODES, type ModeName } from './modes.ts';
import { detectShell } from './util/shell.ts';

const MEMORY_FILES = ['AGENTS.md', 'MRIG.md'];
const MAX_MEMORY_CHARS = 24_000;

/** Find memory files from cwd up to the filesystem/git root, nearest last (so it wins). */
export function findMemoryFiles(cwd: string): string[] {
  const found: string[] = [];
  let dir = cwd;
  for (;;) {
    for (const name of MEMORY_FILES) {
      const p = join(dir, name);
      if (existsSync(p)) found.push(p);
    }
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found.reverse();
}

export function loadMemory(cwd: string): string {
  const parts: string[] = [];
  const global = join(mrigHome(), 'AGENTS.md');
  if (existsSync(global)) parts.push(`# ~/.mrig/AGENTS.md\n${readFileSync(global, 'utf8').trim()}`);
  for (const file of findMemoryFiles(cwd)) {
    parts.push(`# ${file}\n${readFileSync(file, 'utf8').trim()}`);
  }
  const text = parts.join('\n\n');
  return text.length > MAX_MEMORY_CHARS
    ? `${text.slice(0, MAX_MEMORY_CHARS)}\n… [memory truncated]`
    : text;
}

function gitBranch(cwd: string): string | undefined {
  try {
    let dir = cwd;
    for (;;) {
      const head = join(dir, '.git', 'HEAD');
      if (existsSync(head)) {
        const ref = readFileSync(head, 'utf8').trim();
        return ref.startsWith('ref: refs/heads/')
          ? ref.slice('ref: refs/heads/'.length)
          : ref.slice(0, 8);
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

export interface PromptOptions {
  cwd: string;
  modelLabel: string;
  now?: Date;
  /** `minimal` describes the bash-only workflow instead of the file tools. */
  toolMode?: ToolMode;
  /** The language memory block (A3), read once per session by the Runtime. */
  lang?: string;
  /** The mode (T1); its text follows "How to work". */
  mode?: ModeName;
}

export function buildSystemPrompt(opts: PromptOptions): string {
  const shell = detectShell();
  const branch = gitBranch(opts.cwd);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const memory = loadMemory(opts.cwd);

  const lines = [
    "You are mrig, a personal general-purpose agent running in the user's terminal on their own machine. You write and modify software, run commands, work with files, and answer any question directly.",
    '',
    '## Environment',
    `- Working directory: ${opts.cwd}${branch ? ` (git branch: ${branch})` : ''}`,
    `- OS: ${platform()} ${release()} · shell for the bash tool: ${shell.name}`,
    `- Date: ${date} · model: ${opts.modelLabel}`,
    '',
    '## How to work',
    ...(opts.toolMode === 'minimal'
      ? [
          "- Only the bash tool is available. Locate code with grep -rn (or rg) and find; read files with cat -n or sed -n; create files with a quoted heredoc (cat > path <<'EOF'); change files with small, exact edits (sed, or a short python/node one-liner). Read a file before changing it.",
          '- Verify after changing code: run the tests, linter, or build when the project has them. Never run interactive commands. Never run destructive git commands (reset --hard, push --force, clean -f) unless the user explicitly asks.',
        ]
      : [
          '- Understand before changing: use glob and grep to locate code, read files before editing them.',
          '- Prefer edit (exact string replacement) over write for existing files. Keep old_string unique.',
          '- After changing code, verify: run the tests, linter, or build with bash when the project has them.',
          '- Use bash for git, package managers, tests, and anything the other tools do not cover. Never run interactive commands. Never run destructive git commands (reset --hard, push --force, clean -f) unless the user explicitly asks.',
          '- Use fetch to read a web page or API when the answer depends on something online.',
        ]),
    '- Do not invent file contents or command output. If a tool fails, say so and adapt.',
    '- Be concise. Lead with the answer or the change; skip preamble. Use plain prose; use code blocks for code.',
    '- For ordinary questions with no file work needed, just answer.',
    '- When a task is ambiguous or risky (deleting data, changing shared config), ask one short question first.',
  ];
  const mode = MODES[opts.mode ?? 'default'];
  if (mode.prompt.length > 0) lines.push('', ...mode.prompt);
  if (memory) {
    lines.push('', '## Project memory (from AGENTS.md files — follow these instructions)', memory);
  }
  if (opts.lang) lines.push('', opts.lang);
  return lines.join('\n');
}
