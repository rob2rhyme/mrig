import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { parseEvalArgs } from '../scripts/eval/args.ts';
import {
  isLocalProfile,
  loadResults,
  type ProfileResult,
  runProfile,
  runTask,
  saveResult,
  summarize,
  type TaskResult,
} from '../scripts/eval/harness.ts';
import {
  MIN_RECOMMEND_PASS_RATE,
  rank,
  recommendLocal,
  renderMatrix,
  renderSummary,
} from '../scripts/eval/report.ts';
import { type EvalTask, selectTasks, TASK_SET_VERSION, TASKS } from '../scripts/eval/tasks.ts';
import { DEFAULT_CONFIG, type MrigConfig } from '../src/config.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

const CONFIG: MrigConfig = {
  ...DEFAULT_CONFIG,
  providers: {
    fake: {
      kind: 'openai-compatible',
      name: 'fake',
      baseURL: 'http://127.0.0.1:1/v1',
      model: 'fake-1',
    },
    big: {
      kind: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      model: 'big-1',
      pricing: { input: 1, output: 2 },
    },
  },
};

function task(id: string): EvalTask {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const base = { profile: 'fake', maxSteps: 6, timeoutMs: 30_000, config: CONFIG };

describe('eval tasks: fixtures and verifiers', () => {
  test('ten tasks, unique ids, every category covered', () => {
    expect(TASKS.length).toBe(10);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(10);
    expect(new Set(TASKS.map((t) => t.category))).toEqual(
      new Set(['read', 'edit', 'write', 'search', 'bash', 'fix']),
    );
    expect(selectTasks().length).toBe(10);
    expect(selectTasks(['edit-rename', 'fix-coupon']).map((t) => t.id)).toEqual([
      'edit-rename',
      'fix-coupon',
    ]);
    expect(() => selectTasks(['nope'])).toThrow(/Unknown task id\(s\): nope/);
  });

  for (const t of TASKS) {
    test(`${t.id}: the start state fails and the reference solution passes`, async () => {
      const w = tempDir('mrig-evalws-');
      try {
        writeFiles(w.dir, t.files);
        const before = await t.verify({ dir: w.dir, answer: '', toolsUsed: {} });
        expect(before.pass).toBe(false);
        writeFiles(w.dir, t.reference.files ?? {});
        const after = await t.verify({
          dir: w.dir,
          answer: t.reference.answer ?? '',
          toolsUsed: { bash: 1 },
        });
        expect(after.reason).toBeTruthy();
        expect(after.pass).toBe(true);
      } finally {
        w.cleanup();
      }
    });
  }

  /** Apply `mutate` to a fresh workspace, then run the verifier. */
  async function verdict(
    id: string,
    opts: { files?: Record<string, string>; answer?: string },
  ): Promise<{ pass: boolean; reason: string }> {
    const t = task(id);
    const w = tempDir('mrig-evalws-');
    try {
      writeFiles(w.dir, t.files);
      writeFiles(w.dir, opts.files ?? {});
      return await t.verify({ dir: w.dir, answer: opts.answer ?? '', toolsUsed: { bash: 1 } });
    } finally {
      w.cleanup();
    }
  }

  test('verifiers reject near-misses', async () => {
    expect((await verdict('read-discount', { answer: 'addTax adds 20% tax.' })).pass).toBe(false);
    expect(
      (await verdict('read-config', { answer: 'Port 8421 in main.ts; legacy.ts uses 3000.' })).pass,
    ).toBe(false);
    expect((await verdict('search-tests', { answer: '5' })).pass).toBe(false);
    expect((await verdict('search-tests', { answer: 'There are 4 files out of 7.' })).pass).toBe(
      false,
    );
    expect((await verdict('search-tests', { answer: 'four' })).pass).toBe(false);

    const callers = 'src/pages/home.ts\nsrc/pages/about.ts\nsrc/jobs/sync.ts';
    expect(
      (await verdict('search-callers', { answer: `${callers}\nsrc/http/client.ts` })).pass,
    ).toBe(false);
    expect(
      (await verdict('search-callers', { answer: `${callers}\nsrc/pages/contact.ts` })).pass,
    ).toBe(false);
    expect(
      (await verdict('search-callers', { answer: 'src/pages/home.ts\nsrc/pages/about.ts' })).pass,
    ).toBe(false);

    const net = task('edit-constant').reference.files?.['src/net.ts'] ?? '';
    const extra = await verdict('edit-constant', {
      files: { 'src/net.ts': net.replace('TIMEOUT_MS = 5000', 'TIMEOUT_MS = 9000') },
    });
    expect(extra.pass).toBe(false);
    expect(extra.reason).toMatch(/does not match/);

    const slug = await verdict('write-slugify', {
      files: {
        'src/slug.ts':
          'export const slugify = (s: string) => s.toLowerCase().replace(/\\W+/g, "-");\n',
      },
    });
    expect(slug.pass).toBe(false);
    expect(slug.reason).toMatch(/slugify\(/);
    const broken = await verdict('write-slugify', {
      files: { 'src/slug.ts': 'export const = ;\n' },
    });
    expect(broken.pass).toBe(false);
    expect(broken.reason).toMatch(/does not load/);

    const wrongSum = await verdict('bash-run', { files: { 'answer.txt': '12345\n' } });
    expect(wrongSum.pass).toBe(false);
    expect(wrongSum.reason).toMatch(/expected \d+/);
  });

  test('fix tasks fail when the test file is edited, even if the tests then pass', async () => {
    const t = task('fix-average');
    const fixed = t.reference.files?.['src/stats.ts'] ?? '';
    const original = t.files['src/stats.test.ts'] ?? '';
    const tampered = await verdict('fix-average', {
      files: { 'src/stats.ts': fixed, 'src/stats.test.ts': `${original}\n// weakened\n` },
    });
    expect(tampered.pass).toBe(false);
    expect(tampered.reason).toMatch(/test file|modified/);
    const partial = await verdict('fix-coupon', {
      files: { 'src/cart.ts': task('fix-coupon').files['src/cart.ts'] ?? '' },
    });
    expect(partial.pass).toBe(false);
    expect(partial.reason).toMatch(/tests still fail/);
  });
});

describe('eval harness: runTask with scripted models', () => {
  let home: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const edit = JSON.stringify({
    path: 'src/net.ts',
    old_string: 'MAX_RETRIES = 3',
    new_string: 'MAX_RETRIES = 5',
  });

  test('read → edit → answer passes; counters, tokens and cost are recorded', async () => {
    const turns = [
      toolTurn('read', '{"path":"src/net.ts"}', 'c1', { input: 100, output: 10 }),
      toolTurn('edit', edit, 'c2', { input: 150, output: 20 }),
      textTurn('Done.', { input: 160, output: 5 }),
    ];
    const r = await runTask(task('edit-constant'), { ...base, modelFor: () => mockModel(turns) });
    expect(r.pass).toBe(true);
    expect(r.stop).toBe('done');
    expect(r.steps).toBe(3);
    expect(r.toolCalls).toBe(2);
    expect(r.invalidCalls).toBe(0);
    expect(r.repairedCalls).toBe(0);
    expect(r.inputTokens).toBe(410);
    expect(r.outputTokens).toBe(35);
    expect(r.cost).toBe(0); // local profiles are free
    expect(r.ms).toBeGreaterThanOrEqual(0);
    // Sessions are in memory only: nothing is written under MRIG_HOME.
    expect(existsSync(join(home.dir, 'sessions'))).toBe(false);

    const priced = await runTask(task('edit-constant'), {
      ...base,
      profile: 'big',
      modelFor: () => mockModel(turns),
    });
    expect(priced.pass).toBe(true);
    expect(priced.cost).toBeCloseTo((410 * 1 + 35 * 2) / 1_000_000, 10);
  });

  test('a wrong result is a failed task with the verifier’s reason', async () => {
    const r = await runTask(task('edit-constant'), {
      ...base,
      modelFor: () => mockModel([textTurn('I changed it, trust me.')]),
    });
    expect(r.pass).toBe(false);
    expect(r.stop).toBe('done');
    expect(r.reason).toMatch(/does not match/);
  });

  test('read tasks are judged on the final answer; no tools needed', async () => {
    const ok = await runTask(task('read-discount'), {
      ...base,
      modelFor: () => mockModel([textTurn('applyBulkDiscount gives 15% off.')]),
    });
    expect(ok.pass).toBe(true);
    expect(ok.toolCalls).toBe(0);
  });

  test('the bash task fails without a bash call and passes with one', async () => {
    const answer = task('bash-run').reference.files?.['answer.txt'] ?? '';
    const write = (id: string) =>
      toolTurn('write', JSON.stringify({ path: 'answer.txt', content: answer }), id);
    const noShell = await runTask(task('bash-run'), {
      ...base,
      modelFor: () => mockModel([write('c1'), textTurn('Saved.')]),
    });
    expect(noShell.pass).toBe(false);
    expect(noShell.reason).toMatch(/required tool: bash/);

    // `echo hi` is valid in bash, sh and PowerShell alike.
    const withShell = await runTask(task('bash-run'), {
      ...base,
      modelFor: () =>
        mockModel([
          toolTurn('bash', '{"command":"echo hi"}', 'c0'),
          write('c1'),
          textTurn('Saved.'),
        ]),
    });
    expect(withShell.reason).toBeTruthy();
    expect(withShell.pass).toBe(true);
  });

  test('malformed tool JSON is repaired and counted', async () => {
    const fenced = `\`\`\`json\n${edit.replace('}', ',}')}\n\`\`\``;
    const r = await runTask(task('edit-constant'), {
      ...base,
      modelFor: () => mockModel([toolTurn('edit', fenced, 'c1'), textTurn('Done.')]),
    });
    expect(r.repairedCalls).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.invalidCalls).toBe(0);
  });

  test('empty, unknown-tool and badly-typed calls all count as invalid', async () => {
    const r = await runTask(task('search-tests'), {
      ...base,
      modelFor: () =>
        mockModel([
          toolTurn('read', '{}', 'c1'),
          toolTurn('nosuch', '{"x":1}', 'c2'),
          toolTurn('read', '{"nope":1}', 'c3'),
          textTurn('4'),
        ]),
    });
    expect(r.toolCalls).toBe(3);
    expect(r.invalidCalls).toBe(3);
    expect(r.pass).toBe(true); // validity and success are tracked separately
    expect(summarize(profileOf([r])).validRate).toBe(0);
  });

  test('a model error is a failed task, not a crash', async () => {
    const boom = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('boom: the server fell over');
      },
    });
    const r = await runTask(task('read-config'), { ...base, modelFor: () => boom });
    expect(r.pass).toBe(false);
    expect(r.stop).toBe('error');
    expect(r.error).toContain('boom');
    expect(r.reason).toMatch(/^error: /);
  });

  test('a hung model is cut off at the timeout', async () => {
    const hung = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            abortSignal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
      }),
    });
    const r = await runTask(task('read-config'), { ...base, timeoutMs: 80, modelFor: () => hung });
    expect(r.pass).toBe(false);
    expect(r.stop).toBe('timeout');
    expect(r.reason).toMatch(/timed out after/);
  });

  test('an unknown profile fails the task up front', async () => {
    const r = await runTask(task('read-config'), { ...base, profile: 'nope' });
    expect(r.pass).toBe(false);
    expect(r.stop).toBe('error');
    expect(r.reason).toMatch(/could not start: Unknown provider "nope"/);
  });

  test('runProfile runs tasks in order, reports progress, and describes the profile', async () => {
    const seen: string[] = [];
    const answers: Record<string, string> = {
      'read-discount': 'applyBulkDiscount gives 15% off.',
      'search-tests': '5',
    };
    const result = await runProfile({
      ...base,
      tasks: selectTasks(['read-discount', 'search-tests']),
      modelFor: (t) => mockModel([textTurn(answers[t.id] ?? '')]),
      onTask: (r, i, n) => seen.push(`${i + 1}/${n} ${r.id} ${r.pass ? 'pass' : 'fail'}`),
    });
    expect(seen).toEqual(['1/2 read-discount pass', '2/2 search-tests fail']);
    expect(result).toMatchObject({
      schema: 1,
      taskSet: TASK_SET_VERSION,
      profile: 'fake',
      kind: 'openai-compatible',
      model: 'fake-1',
      toolMode: 'full',
      local: true,
    });
    expect(summarize(result)).toMatchObject({ passed: 1, total: 2, passRate: 0.5 });

    const remote = await runProfile({
      ...base,
      profile: 'big',
      tasks: selectTasks(['read-discount']),
      modelFor: () => mockModel([textTurn('applyBulkDiscount 15%')]),
    });
    expect(remote.local).toBe(false);
  });
});

// ---- aggregation, storage, reporting (pure) ------------------------------------------------

function mkTask(over: Partial<TaskResult> = {}): TaskResult {
  return {
    id: 'read-discount',
    category: 'read',
    pass: true,
    reason: 'ok',
    stop: 'done',
    steps: 2,
    ms: 1000,
    toolCalls: 0,
    invalidCalls: 0,
    repairedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    decodeTokens: 0,
    decodeMs: 0,
    responseMs: 0,
    ...over,
  };
}

function profileOf(tasks: TaskResult[], over: Partial<ProfileResult> = {}): ProfileResult {
  return {
    schema: 1,
    taskSet: TASK_SET_VERSION,
    mrigVersion: '0.0.0',
    startedAt: '2026-11-03T10:00:00.000Z',
    profile: 'p',
    kind: 'openai-compatible',
    model: 'm',
    toolMode: 'full',
    local: true,
    tasks,
    ...over,
  };
}

/** A profile that ran the first `total` tasks and passed the first `passes` of them. */
function mkProfile(name: string, passes: number, over: Partial<ProfileResult> = {}, total = 10) {
  return profileOf(
    TASKS.slice(0, total).map((t, i) =>
      mkTask({
        id: t.id,
        category: t.category,
        pass: i < passes,
        reason: i < passes ? 'ok' : `failed ${t.id}`,
        toolCalls: 10,
        invalidCalls: 1,
        decodeTokens: 100,
        decodeMs: 2000,
      }),
    ),
    { profile: name, ...over },
  );
}

describe('eval: summarize', () => {
  test('pass rate, valid-call rate, repairs, steps, tok/s and cost', () => {
    const r = profileOf([
      mkTask({
        toolCalls: 4,
        invalidCalls: 1,
        repairedCalls: 1,
        steps: 3,
        decodeTokens: 100,
        decodeMs: 2000,
        outputTokens: 100,
        responseMs: 3000,
        cost: 0.01,
      }),
      mkTask({
        pass: false,
        toolCalls: 1,
        steps: 5,
        decodeTokens: 50,
        decodeMs: 1000,
        outputTokens: 50,
        responseMs: 1500,
        cost: 0.02,
      }),
    ]);
    const s = summarize(r);
    expect(s.passed).toBe(1);
    expect(s.passRate).toBe(0.5);
    expect(s.validRate).toBeCloseTo(0.8, 10);
    expect(s.repairedCalls).toBe(1);
    expect(s.avgSteps).toBe(4);
    expect(s.tokensPerSecond).toBeCloseTo(50, 10); // 150 tokens over 3 s of decoding
    expect(s.cost).toBeCloseTo(0.03, 10);
    expect(s.totalMs).toBe(2000);
  });

  test('falls back to effective tok/s, and leaves unknowns undefined', () => {
    const s = summarize(
      profileOf([
        mkTask({ outputTokens: 60, responseMs: 2000 }),
        mkTask({ outputTokens: 40, responseMs: 2000, cost: 0.5 }),
      ]),
    );
    expect(s.tokensPerSecond).toBeCloseTo(25, 10); // 100 tokens over 4 s
    expect(s.cost).toBeUndefined(); // one task has no pricing
    expect(s.validRate).toBeUndefined(); // no tool calls at all
    const empty = summarize(profileOf([]));
    expect(empty).toMatchObject({ total: 0, passRate: 0, avgSteps: 0 });
    expect(empty.tokensPerSecond).toBeUndefined();
    expect(empty.cost).toBeUndefined();
  });

  test('isLocalProfile: loopback openai-compatible only', () => {
    const oc = (baseURL?: string) => ({ kind: 'openai-compatible' as const, model: 'm', baseURL });
    expect(isLocalProfile(oc('http://localhost:11434/v1'))).toBe(true);
    expect(isLocalProfile(oc('http://127.0.0.1:8080/v1'))).toBe(true);
    expect(isLocalProfile(oc('http://[::1]:8080/v1'))).toBe(true);
    expect(isLocalProfile(oc('http://10.0.0.5:8000/v1'))).toBe(false);
    expect(isLocalProfile(oc('https://openrouter.ai/api/v1'))).toBe(false);
    expect(isLocalProfile(oc(undefined))).toBe(false);
    expect(isLocalProfile(oc('not a url'))).toBe(false);
    expect(isLocalProfile({ kind: 'anthropic', model: 'm', baseURL: 'http://localhost:1' })).toBe(
      false,
    );
  });
});

describe('eval: saved results', () => {
  let out: ReturnType<typeof tempDir>;
  beforeEach(() => {
    out = tempDir('mrig-evalout-');
  });
  afterEach(() => out.cleanup());

  test('round-trips, keeps the newest run per profile + model + tool mode, ignores junk', () => {
    const a1 = mkProfile('ollama', 4, { model: 'qwen', startedAt: '2026-11-03T09:00:00.000Z' });
    const a2 = mkProfile('ollama', 8, { model: 'qwen', startedAt: '2026-11-03T11:00:00.000Z' });
    const other = mkProfile('ollama', 6, {
      model: 'gemma/12b:q4',
      startedAt: '2026-11-03T10:00:00.000Z',
    });
    const mini = mkProfile('ollama', 3, { model: 'qwen', toolMode: 'minimal' });
    for (const r of [a2, a1, other, mini]) saveResult(out.dir, r);
    writeFileSync(join(out.dir, 'junk.json'), '{ nope');
    writeFileSync(join(out.dir, 'wrong.json'), JSON.stringify({ hello: 'world' }));
    writeFileSync(
      join(out.dir, 'old.json'),
      JSON.stringify({ ...a2, taskSet: TASK_SET_VERSION - 1 }),
    );
    writeFileSync(join(out.dir, 'notes.txt'), 'ignored');

    const loaded = loadResults(out.dir);
    expect(loaded.length).toBe(3);
    const qwen = loaded.find((r) => r.model === 'qwen' && r.toolMode === 'full');
    expect(qwen?.startedAt).toBe('2026-11-03T11:00:00.000Z');
    expect(summarize(qwen as ProfileResult).passed).toBe(8);
    expect(loaded.some((r) => r.toolMode === 'minimal')).toBe(true);
    // File names are safe on every OS even for model ids like "gemma/12b:q4".
    for (const f of readdirSync(out.dir)) expect(f).not.toMatch(/[/:\\]/);
    expect(loadResults(join(out.dir, 'missing'))).toEqual([]);
    const first = readdirSync(out.dir).find((f) => f.startsWith('ollama__')) ?? '';
    expect(JSON.parse(readFileSync(join(out.dir, first), 'utf8')).schema).toBe(1);
  });
});

describe('eval: report', () => {
  test('rank orders by pass rate, then valid calls, then speed, then name', () => {
    const slow = mkProfile('slow', 9, { profile: 'slow' });
    const fast = mkProfile('fast', 9, { profile: 'fast' });
    for (const t of fast.tasks) t.decodeMs = 1000; // twice the speed of `slow`
    const best = mkProfile('best', 10);
    const worst = mkProfile('worst', 2);
    expect(rank([worst, slow, best, fast]).map((r) => r.profile)).toEqual([
      'best',
      'fast',
      'slow',
      'worst',
    ]);
    // A perfect score on a subset of tasks ranks below a full run, whatever its rate.
    const subset = mkProfile('subset', 3, {}, 3);
    expect(rank([subset, worst]).map((r) => r.profile)).toEqual(['worst', 'subset']);
  });

  test('recommendLocal needs a local profile that ran everything and passed 70%', () => {
    expect(MIN_RECOMMEND_PASS_RATE).toBe(0.7);
    const cloud = mkProfile('cloud', 10, { local: false });
    const good = mkProfile('good', 9);
    const weak = mkProfile('weak', 5);
    const partial = mkProfile('partial', 3, {}, 3); // 3/3 but only a subset ran
    const edge = mkProfile('edge', 7);
    expect(recommendLocal([cloud, weak, partial, good])?.profile).toBe('good');
    expect(recommendLocal([cloud, weak, partial])).toBeUndefined();
    expect(recommendLocal([weak, edge])?.profile).toBe('edge'); // exactly 70% qualifies
    expect(recommendLocal([])).toBeUndefined();
  });

  test('the matrix has ranked rows, a per-task grid, failures and the recommendation', () => {
    const md = renderMatrix(
      [
        mkProfile('good', 9),
        mkProfile('cloud', 10, { local: false }),
        mkProfile('partial', 3, {}, 3),
      ],
      new Date('2026-11-03T12:00:00Z'),
    );
    expect(md).toContain('# Compatibility matrix');
    expect(md).toContain('2026-11-03');
    expect(md.indexOf('| cloud |')).toBeLessThan(md.indexOf('| good |'));
    expect(md).toContain('| cloud | m | remote | full | 10/10 |');
    expect(md).toContain('| good | m | local | full | 9/10 |');
    expect(md).toContain('| partial | m | local | full | 3/3 † |');
    expect(md).toContain('† a subset of the tasks was run.');
    expect(md).toContain('| Task | Category | cloud | good | partial |');
    expect(md).toContain('| read-discount | read | ✓ | ✓ | ✓ |');
    expect(md).toContain('| fix-coupon | fix | ✓ | ✗ | — |');
    expect(md).toContain(`- **good** · fix-coupon: failed fix-coupon`);
    expect(md).toContain('## Recommended `local` profile');
    expect(md).toContain('**`good`**');
    expect(md).toContain('90% valid tool calls');
    expect(md).toContain('50.0 tok/s');
  });

  test('empty and no-winner cases say so plainly', () => {
    expect(renderMatrix([])).toContain('_No results yet._');
    expect(renderMatrix([mkProfile('cloud', 10, { local: false })])).toContain(
      'No local profile has been run yet.',
    );
    expect(renderMatrix([mkProfile('weak', 4)])).toContain(
      'has passed 70% of the full task set yet',
    );
    expect(renderSummary([mkProfile('free', 10)])).toContain('free'); // cost of a local model
    expect(renderSummary([mkProfile('free', 10)])).not.toContain('†');
  });
});

describe('eval: arguments', () => {
  test('defaults and every flag', () => {
    expect(parseEvalArgs([])).toEqual({
      maxSteps: 20,
      timeoutSec: 300,
      out: 'evals/results',
      report: false,
      noCheck: false,
      list: false,
      help: false,
    });
    const a = parseEvalArgs([
      '-P',
      'ollama, claude',
      '--tasks',
      'edit-rename,fix-coupon',
      '--max-steps',
      '8',
      '--timeout',
      '60',
      '--out',
      'tmp/r',
      '--matrix',
      'docs/COMPATIBILITY.md',
      '--no-check',
      '--report',
      '--list',
      '-h',
    ]);
    expect(a).toMatchObject({
      profiles: ['ollama', 'claude'],
      tasks: ['edit-rename', 'fix-coupon'],
      maxSteps: 8,
      timeoutSec: 60,
      out: 'tmp/r',
      matrix: 'docs/COMPATIBILITY.md',
      noCheck: true,
      report: true,
      list: true,
      help: true,
    });
  });

  test('rejects bad input', () => {
    expect(() => parseEvalArgs(['--wat'])).toThrow(/Unknown option/);
    expect(() => parseEvalArgs(['--profiles'])).toThrow(/Missing value/);
    expect(() => parseEvalArgs(['--max-steps', '0'])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(['--timeout', 'x'])).toThrow(/positive integer/);
  });
});
