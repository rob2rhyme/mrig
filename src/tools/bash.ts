import { z } from 'zod';
import { resolvePath } from '../util/paths.ts';
import { detectShell } from '../util/shell.ts';
import { truncateMiddle } from '../util/text.ts';
import { defineTool, ToolError } from './types.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const schema = z.object({
  command: z.string().describe('Shell command to run'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
  cwd: z.string().optional().describe('Working directory for this command (default: current)'),
});

export interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** Run a command in the platform shell, capturing merged output. */
export async function runShell(
  command: string,
  opts: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
  },
): Promise<RunResult> {
  const shell = detectShell();
  const proc = Bun.spawn([...shell.argv, command], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, MRIG: '1', GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => {
    aborted = true;
    proc.kill();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    let output = stdout;
    if (stderr.trim()) output += (output && !output.endsWith('\n') ? '\n' : '') + stderr;
    return { output, exitCode, timedOut, aborted };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export const bashTool = defineTool<z.infer<typeof schema>>({
  name: 'bash',
  description: `Run a shell command (${detectShell().name}) and return its output. Use for git, tests, builds, package managers, and anything the other tools do not cover. Avoid interactive commands. Quote paths with spaces.`,
  inputSchema: schema,
  readOnly: false,
  summarize: (i) => `$ ${i.command.length > 200 ? `${i.command.slice(0, 200)}…` : i.command}`,
  async execute(input, ctx) {
    const cwd = input.cwd ? resolvePath(ctx.cwd, input.cwd) : ctx.cwd;
    const res = await runShell(input.command, {
      cwd,
      timeoutMs: input.timeout_ms,
      signal: ctx.signal,
    });
    if (res.aborted) throw new ToolError('Command aborted by user.');
    let out = truncateMiddle(res.output.replace(/\r\n/g, '\n').trimEnd(), ctx.maxOutputChars);
    if (res.timedOut)
      out += `\n\n[timed out after ${(input.timeout_ms ?? DEFAULT_TIMEOUT_MS) / 1000}s and was killed]`;
    else if (res.exitCode !== 0) out += `\n\n[exit code ${res.exitCode}]`;
    return out.trim() === ''
      ? `(no output)${res.exitCode ? ` [exit code ${res.exitCode}]` : ''}`
      : out;
  },
});
