import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { displayPath, resolvePath } from '../util/paths.ts';
import { looksBinary, truncateMiddle } from '../util/text.ts';
import { defineTool, ToolError } from './types.ts';

const MAX_MATCHES = 300;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

const schema = z.object({
  pattern: z.string().describe('Regular expression to search for (ripgrep syntax)'),
  path: z.string().optional().describe('File or directory to search (default: working directory)'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts"'),
  ignore_case: z.boolean().optional().describe('Case-insensitive search'),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Lines of context around each match'),
});

type Input = z.infer<typeof schema>;

export function ripgrepPath(): string | null {
  return Bun.which('rg');
}

export async function grepWithRipgrep(
  rg: string,
  input: Input,
  base: string,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    rg,
    '--no-heading',
    '--line-number',
    '--color',
    'never',
    '--max-count',
    '200',
    '--max-columns',
    '400',
  ];
  for (const dir of SKIP_DIRS) args.push('--glob', `!${dir}`);
  if (input.ignore_case) args.push('-i');
  if (input.glob) args.push('--glob', input.glob);
  if (input.context) args.push('-C', String(input.context));
  args.push('-e', input.pattern, '--', base);
  const proc = Bun.spawn(args, { cwd: base, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const onAbort = () => proc.kill();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code === 2) throw new ToolError(`ripgrep error: ${stderr.trim() || 'unknown'}`);
    if (code === 1 || !stdout.trim()) return 'No matches.';
    // Make paths relative to base for readability.
    const lines = stdout.trimEnd().split('\n');
    const rel = lines.map((l) =>
      l.startsWith(base) ? l.slice(base.length).replace(/^[\\/]/, '') : l,
    );
    return rel.slice(0, MAX_MATCHES * 3).join('\n');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.git')) continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && st.size < 2_000_000) yield full;
  }
}

export async function grepWithJs(input: Input, base: string): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
  } catch (err) {
    throw new ToolError(`Invalid regex: ${(err as Error).message}`);
  }
  const globFilter = input.glob ? new Bun.Glob(input.glob) : undefined;
  const isFile = statSync(base).isFile();
  const files = isFile ? [base] : Array.from(walk(base));
  const out: string[] = [];
  const ctxN = input.context ?? 0;
  for (const file of files) {
    const rel = isFile ? base : relative(base, file).split('\\').join('/');
    if (globFilter && !globFilter.match(rel) && !globFilter.match(rel.split('/').pop() ?? rel))
      continue;
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    if (looksBinary(bytes)) continue;
    const lines = new TextDecoder().decode(bytes).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!re.test(line)) continue;
      const from = Math.max(0, i - ctxN);
      const to = Math.min(lines.length - 1, i + ctxN);
      for (let j = from; j <= to; j++) {
        const sep = j === i ? ':' : '-';
        out.push(`${rel}${sep}${j + 1}${sep}${(lines[j] ?? '').slice(0, 400)}`);
      }
      if (ctxN > 0) out.push('--');
      if (out.length >= MAX_MATCHES)
        return `${out.join('\n')}\n\n[stopped after ${MAX_MATCHES} matches]`;
    }
  }
  return out.length ? out.join('\n') : 'No matches.';
}

export const grepTool = defineTool<Input>({
  name: 'grep',
  description:
    'Search file contents with a regular expression (uses ripgrep when available). Returns "path:line:text". Use glob to restrict file types, e.g. "*.ts". Skips node_modules, .git and build folders.',
  inputSchema: schema,
  readOnly: true,
  summarize: (i) =>
    `grep /${i.pattern}/${i.glob ? ` in ${i.glob}` : ''}${i.path ? ` under ${i.path}` : ''}`,
  async execute(input, ctx) {
    const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    try {
      statSync(base);
    } catch {
      throw new ToolError(`Path not found: ${displayPath(ctx.cwd, base)}`);
    }
    const rg = ripgrepPath();
    const result = rg
      ? await grepWithRipgrep(rg, input, base, ctx.signal)
      : await grepWithJs(input, base);
    return truncateMiddle(result, ctx.maxOutputChars);
  },
});
