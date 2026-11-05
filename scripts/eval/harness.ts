/**
 * The eval harness (L3): run the task set against a provider profile and collect metrics.
 *
 * Each task gets a fresh temp workspace and a fresh in-memory Runtime, the same wiring `mrig -p
 * --yolo` uses, so the numbers describe the real agent loop. The only differences are that the
 * session is never written to disk and the harness can see the agent's counters.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LanguageModel } from 'ai';
import {
  loadConfig,
  type MrigConfig,
  type ProviderKind,
  resolveProfile,
  type ToolMode,
} from '../../src/config.ts';
import { formatModelError } from '../../src/providers.ts';
import { Runtime } from '../../src/runtime.ts';
import { VERSION } from '../../src/version.ts';
import { isLocalProfile } from '../../src/zone.ts';
import { type Category, type EvalTask, TASK_SET_VERSION, type Verdict } from './tasks.ts';

export interface TaskResult {
  id: string;
  category: Category;
  pass: boolean;
  reason: string;
  stop: 'done' | 'max-steps' | 'aborted' | 'error' | 'timeout';
  steps: number;
  /** Wall-clock for the whole task, including tool execution. */
  ms: number;
  toolCalls: number;
  invalidCalls: number;
  repairedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Output tokens and ms measured after the first token (decode speed); see AgentStats. */
  decodeTokens: number;
  decodeMs: number;
  responseMs: number;
  /** Estimated USD; absent when the model's pricing is unknown. */
  cost?: number;
  error?: string;
}

export interface ProfileResult {
  schema: 1;
  taskSet: number;
  mrigVersion: string;
  startedAt: string;
  profile: string;
  kind: ProviderKind;
  model: string;
  toolMode: ToolMode;
  /** The profile talks to a loopback server (Ollama, LM Studio, llama.cpp on this machine). */
  local: boolean;
  tasks: TaskResult[];
}

export interface RunOptions {
  /** Profile name from the config. */
  profile: string;
  model?: string;
  maxSteps: number;
  timeoutMs: number;
  /** The config to resolve profiles from (default: load from the current directory). */
  config?: MrigConfig;
  /** Test seam: a scripted model per task instead of the profile's real provider. */
  modelFor?: (task: EvalTask) => LanguageModel;
}

/** Shared with the offline guarantee (L5): one definition of "on this machine". */
export { isLocalProfile };

function writeFixture(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

async function safeVerify(
  task: EvalTask,
  ctx: Parameters<EvalTask['verify']>[0],
): Promise<Verdict> {
  try {
    return await task.verify(ctx);
  } catch (err) {
    return {
      pass: false,
      reason: `verifier crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const clip = (s: string, n = 200) =>
  (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ');

/** Run one task in a fresh workspace. Never throws; failures become a failed TaskResult. */
export async function runTask(task: EvalTask, opts: RunOptions): Promise<TaskResult> {
  const dir = mkdtempSync(join(tmpdir(), `mrig-eval-${task.id}-`));
  const started = performance.now();
  const result: TaskResult = {
    id: task.id,
    category: task.category,
    pass: false,
    reason: '',
    stop: 'error',
    steps: 0,
    ms: 0,
    toolCalls: 0,
    invalidCalls: 0,
    repairedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    decodeTokens: 0,
    decodeMs: 0,
    responseMs: 0,
  };
  const finish = (verdict: Verdict, stop: TaskResult['stop'], error?: string): TaskResult => {
    result.pass = verdict.pass;
    result.reason = clip(verdict.reason);
    result.stop = stop;
    if (error !== undefined) result.error = clip(error, 400);
    result.ms = Math.round(performance.now() - started);
    return result;
  };
  try {
    writeFixture(dir, task.files);
    let runtime: Runtime;
    try {
      runtime = new Runtime({
        cwd: dir,
        provider: opts.profile,
        model: opts.model,
        config: opts.config,
        yolo: true,
        maxSteps: opts.maxSteps,
        ephemeral: true,
        languageModel: opts.modelFor?.(task),
        ask: async () => 'no',
        events: { onText: () => {} },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return finish({ pass: false, reason: `could not start: ${message}` }, 'error', message);
    }

    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, opts.timeoutMs);
    let run: Awaited<ReturnType<Runtime['agent']['run']>> | undefined;
    let error: string | undefined;
    try {
      run = await runtime.agent.run(task.prompt, ac.signal);
    } catch (err) {
      error = formatModelError(err, runtime.profile);
    } finally {
      clearTimeout(timer);
    }

    const { stats, usage } = runtime.agent;
    result.steps = run?.steps ?? 0;
    result.toolCalls = stats.toolCalls;
    result.invalidCalls = stats.invalidCalls;
    result.repairedCalls = stats.repairedCalls;
    result.inputTokens = usage.inputTokens;
    result.outputTokens = usage.outputTokens;
    result.cacheReadTokens = usage.cacheReadTokens;
    result.decodeTokens = stats.decodeTokens;
    result.decodeMs = Math.round(stats.decodeMs);
    result.responseMs = Math.round(stats.responseMs);
    const cost = runtime.agent.cost();
    if (cost !== undefined) result.cost = cost;

    if (error !== undefined)
      return finish({ pass: false, reason: `error: ${error}` }, 'error', error);
    if (timedOut || !run) {
      return finish(
        { pass: false, reason: `timed out after ${Math.round(opts.timeoutMs / 1000)}s` },
        'timeout',
      );
    }
    const missing = (task.requireTools ?? []).filter((t) => (stats.toolsUsed[t] ?? 0) === 0);
    if (missing.length > 0) {
      return finish(
        { pass: false, reason: `did not use required tool: ${missing.join(', ')}` },
        run.stop,
      );
    }
    const verdict = await safeVerify(task, { dir, answer: run.text, toolsUsed: stats.toolsUsed });
    return finish(verdict, run.stop);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ProfileRunOptions extends RunOptions {
  tasks: EvalTask[];
  onTask?: (result: TaskResult, index: number, total: number) => void;
}

/** Run every task against one profile, sequentially (local GPUs do one thing at a time). */
export async function runProfile(opts: ProfileRunOptions): Promise<ProfileResult> {
  const config = opts.config ?? loadConfig({ cwd: process.cwd() });
  const { name, profile } = resolveProfile(config, opts.profile, opts.model);
  const startedAt = new Date().toISOString();
  const tasks: TaskResult[] = [];
  for (const [i, task] of opts.tasks.entries()) {
    const r = await runTask(task, { ...opts, config });
    tasks.push(r);
    opts.onTask?.(r, i, opts.tasks.length);
  }
  return {
    schema: 1,
    taskSet: TASK_SET_VERSION,
    mrigVersion: VERSION,
    startedAt,
    profile: name,
    kind: profile.kind,
    model: profile.model,
    toolMode: profile.toolMode ?? 'full',
    local: isLocalProfile(profile),
    tasks,
  };
}

// ---- aggregation ---------------------------------------------------------------------------

export interface Summary {
  passed: number;
  total: number;
  passRate: number;
  toolCalls: number;
  invalidCalls: number;
  /** Share of tool calls that were valid on the first try; undefined when no tool was called. */
  validRate?: number;
  repairedCalls: number;
  avgSteps: number;
  /** Decode tokens/s when the provider reports it, else effective output tokens/s. */
  tokensPerSecond?: number;
  /** Total estimated USD; undefined when any task's pricing is unknown. */
  cost?: number;
  totalMs: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function summarize(r: ProfileResult): Summary {
  const t = r.tasks;
  const toolCalls = sum(t.map((x) => x.toolCalls));
  const invalidCalls = sum(t.map((x) => x.invalidCalls));
  const decodeMs = sum(t.map((x) => x.decodeMs));
  const responseMs = sum(t.map((x) => x.responseMs));
  let tokensPerSecond: number | undefined;
  if (decodeMs > 0) tokensPerSecond = sum(t.map((x) => x.decodeTokens)) / (decodeMs / 1000);
  else if (responseMs > 0)
    tokensPerSecond = sum(t.map((x) => x.outputTokens)) / (responseMs / 1000);
  const costs = t.map((x) => x.cost);
  const known = costs.length > 0 && costs.every((c) => c !== undefined);
  return {
    passed: t.filter((x) => x.pass).length,
    total: t.length,
    passRate: t.length > 0 ? t.filter((x) => x.pass).length / t.length : 0,
    toolCalls,
    invalidCalls,
    validRate: toolCalls > 0 ? (toolCalls - invalidCalls) / toolCalls : undefined,
    repairedCalls: sum(t.map((x) => x.repairedCalls)),
    avgSteps: t.length > 0 ? sum(t.map((x) => x.steps)) / t.length : 0,
    tokensPerSecond,
    cost: known ? sum(costs.map((c) => c ?? 0)) : undefined,
    totalMs: sum(t.map((x) => x.ms)),
  };
}

// ---- results on disk -----------------------------------------------------------------------

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export function saveResult(dir: string, r: ProfileResult): string {
  mkdirSync(dir, { recursive: true });
  const stamp = r.startedAt.replace(/[:.]/g, '-');
  const file = join(dir, `${safeName(r.profile)}__${safeName(r.model)}__${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  return file;
}

function isProfileResult(x: unknown): x is ProfileResult {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<ProfileResult>;
  return (
    r.schema === 1 &&
    typeof r.profile === 'string' &&
    typeof r.model === 'string' &&
    typeof r.startedAt === 'string' &&
    Array.isArray(r.tasks)
  );
}

/**
 * Load saved results, keeping only the newest run per profile + model + tool mode, and only
 * runs of the current task set (older task sets are not comparable).
 */
export function loadResults(dir: string): ProfileResult[] {
  if (!existsSync(dir)) return [];
  const latest = new Map<string, ProfileResult>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!isProfileResult(parsed) || parsed.taskSet !== TASK_SET_VERSION) continue;
    const key = `${parsed.profile}\u0000${parsed.model}\u0000${parsed.toolMode}`;
    const prev = latest.get(key);
    if (!prev || prev.startedAt < parsed.startedAt) latest.set(key, parsed);
  }
  return [...latest.values()];
}
