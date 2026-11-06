import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import {
  forget,
  type LearnerFile,
  learnerPath,
  learnerReport,
  learnerSummary,
  loadLearner,
  MAX_NOTE_CHARS,
  recordResult,
  saveLearner,
} from '../src/learner.ts';
import { Runtime } from '../src/runtime.ts';
import { createLearnedTool } from '../src/tools/learned.ts';
import { runCommand } from '../src/ui/commands.ts';
import { ZONE_MARKER } from '../src/zone.ts';
import { ctx, mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const fresh = (): LearnerFile => ({ version: 1, topics: [] });
const DAY = '2026-11-06';

describe('learner: recording results', () => {
  test('the Leitner boxes: right moves up (1, 2, 4, 8, 16 days), missed goes back to box 1', () => {
    const f = fresh();
    const t = recordResult(
      f,
      { topic: 'Magar numerals 1–10', variety: 'mgp', result: 'introduced' },
      DAY,
    );
    expect(t).toMatchObject({
      status: 'introduced',
      asked: 0,
      right: 0,
      box: 1,
      due: '2026-11-07',
      lastSeen: DAY,
    });
    const dues = [1, 2, 3, 4].map(
      () =>
        recordResult(f, { topic: 'Magar numerals 1–10', variety: 'mgp', result: 'right' }, DAY).due,
    );
    expect(dues).toEqual(['2026-11-08', '2026-11-10', '2026-11-14', '2026-11-22']); // boxes 2, 3, 4, 5
    expect(f.topics[0]).toMatchObject({ status: 'known', asked: 4, right: 4, box: 5 });
    recordResult(f, { topic: 'Magar numerals 1–10', variety: 'mgp', result: 'right' }, DAY);
    expect(f.topics[0]?.box).toBe(5); // box 5 is the top
    const missed = recordResult(
      f,
      { topic: 'Magar numerals 1–10', variety: 'mgp', result: 'missed' },
      DAY,
    );
    expect(missed).toMatchObject({
      status: 'practising',
      asked: 6,
      right: 5,
      box: 1,
      due: '2026-11-07',
    });
  });

  test('labels are normalized into one topic; varieties stay separate', () => {
    const f = fresh();
    recordResult(f, { topic: '  Git   rebase ', result: 'right' }, DAY);
    recordResult(f, { topic: 'git rebase', result: 'missed' }, DAY);
    expect(f.topics).toHaveLength(1);
    expect(f.topics[0]).toMatchObject({ topic: 'Git rebase', asked: 2, right: 1 });
    recordResult(f, { topic: 'numbers', variety: 'mgp', result: 'right' }, DAY);
    recordResult(f, { topic: 'numbers', variety: 'kgj', result: 'missed' }, DAY);
    expect(f.topics.filter((t) => t.topic === 'numbers').map((t) => [t.variety, t.right])).toEqual([
      ['mgp', 1],
      ['kgj', 0],
    ]);
  });

  test('notes are capped, cleared by an empty note; bad input is refused', () => {
    const f = fresh();
    recordResult(
      f,
      { topic: 'letters', variety: 'mgp', result: 'missed', note: 'x'.repeat(300) },
      DAY,
    );
    expect(f.topics[0]?.note).toHaveLength(MAX_NOTE_CHARS);
    expect(f.topics[0]?.note?.endsWith('…')).toBe(true);
    recordResult(f, { topic: 'letters', variety: 'mgp', result: 'right', note: '' }, DAY);
    expect(f.topics[0]?.note).toBeUndefined();
    expect(() => recordResult(f, { topic: '   ', result: 'right' }, DAY)).toThrow('Empty topic.');
    expect(() => recordResult(f, { topic: 'x', variety: 'xx', result: 'right' }, DAY)).toThrow(
      /Unknown variety "xx"/,
    );
  });

  test('forget: one topic, one variety, or all', () => {
    const f = fresh();
    for (const [topic, variety] of [
      ['a', 'mgp'],
      ['b', 'mgp'],
      ['a', 'kgj'],
      ['c', undefined],
    ] as const) {
      recordResult(f, { topic, ...(variety ? { variety } : {}), result: 'right' }, DAY);
    }
    expect(forget(f, { topic: 'A', variety: 'kgj' })).toBe(1);
    expect(forget(f, { variety: 'mgp' })).toBe(2);
    expect(f.topics.map((t) => t.topic)).toEqual(['c']);
    expect(forget(f, { all: true })).toBe(1);
    expect(f.topics).toEqual([]);
  });
});

describe('learner: the file', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('mrig-learner-');
  });
  afterEach(() => t.cleanup());

  test('save and load round-trip; a missing file is empty', () => {
    const path = join(t.dir, 'learner.json');
    expect(loadLearner(path)).toEqual(fresh());
    const f = fresh();
    recordResult(f, { topic: 'आमा', variety: 'mgp', result: 'right' }, DAY);
    saveLearner(path, f);
    expect(loadLearner(path)).toEqual(f);
    expect(readFileSync(path, 'utf8')).toContain('"version": 1');
  });

  test('a failed write leaves the old file whole', () => {
    const path = join(t.dir, 'learner.json');
    const f = fresh();
    recordResult(f, { topic: 'kept', result: 'right' }, DAY);
    saveLearner(path, f);
    const before = readFileSync(path, 'utf8');
    mkdirSync(`${path}.tmp-${process.pid}`); // the temporary file can't be written now
    recordResult(f, { topic: 'lost', result: 'right' }, DAY);
    expect(() => saveLearner(path, f)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('a file mrig cannot read is reported, never overwritten', () => {
    const path = join(t.dir, 'learner.json');
    writeFileSync(path, '{ broken');
    expect(() => loadLearner(path)).toThrow(/is not valid JSON .* fix or delete it/);
    writeFileSync(path, JSON.stringify({ version: 9, topics: [] }));
    expect(() => loadLearner(path)).toThrow(/version 9, newer than this mrig understands/);
    writeFileSync(path, '{}');
    expect(() => loadLearner(path)).toThrow(/has no "topics" list/);
  });

  test('inside a zone the file lives in the zone, out of git', () => {
    const zone = join(t.dir, 'zone');
    const path = learnerPath(zone);
    expect(path).toBe(join(zone, '.mrig', 'learner', 'learner.json'));
    saveLearner(path, fresh());
    expect(readFileSync(join(zone, '.mrig', 'learner', '.gitignore'), 'utf8')).toContain('*');
  });
});

describe('learner: the summary and the report', () => {
  test('due topics first, then the weakest, grouped by variety; empty when there is nothing', () => {
    expect(learnerSummary(fresh(), DAY)).toBe('');
    const f = fresh();
    recordResult(f, { topic: 'counting', variety: 'kgj', result: 'missed' }, '2026-11-01'); // due 11-02
    recordResult(f, { topic: 'greetings', variety: 'mgp', result: 'right' }, '2026-11-05'); // due 11-07
    recordResult(f, { topic: 'git rebase', result: 'missed', note: 'forgets --onto' }, DAY); // due 11-07
    const s = learnerSummary(f, DAY);
    expect(s.split('\n')[0]).toStartWith(
      '## Learner memory (what the user has practised before; today is 2026-11-06.',
    );
    expect(s).toContain(
      '### general\n- git rebase: practising, 0/1 right, due 2026-11-07 (forgets --onto)',
    );
    expect(s).toContain(
      '### Eastern Magar (Magar Dhut) (mgp)\n- greetings: practising, 1/1 right, due 2026-11-07',
    );
    expect(s).toContain('### Kham: Gamal (kgj)\n- counting: practising, 0/1 right, due 2026-11-02');
  });

  test('at most 30 topics, with a count of the rest', () => {
    const f = fresh();
    for (let i = 0; i < 40; i++) recordResult(f, { topic: `topic ${i}`, result: 'missed' }, DAY);
    const s = learnerSummary(f, DAY);
    expect(s.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(30);
    expect(s).toContain('(10 more topics not listed; /learned shows all)');
  });

  test('/learned report: all, due, and a search', () => {
    const f = fresh();
    expect(learnerReport(f, DAY)[0]).toMatch(/^No learner memory yet/);
    recordResult(f, { topic: 'counting', variety: 'kgj', result: 'missed' }, '2026-11-01');
    recordResult(f, { topic: 'git rebase', result: 'right' }, DAY);
    expect(learnerReport(f, DAY)).toEqual([
      'general:',
      '  git rebase: practising, 1/1 right, due 2026-11-08',
      'Kham: Gamal (kgj):',
      '  counting: practising, 0/1 right, due 2026-11-02',
    ]);
    expect(learnerReport(f, DAY, 'due')).toEqual([
      'Kham: Gamal (kgj):',
      '  counting: practising, 0/1 right, due 2026-11-02',
    ]);
    expect(learnerReport(f, DAY, 'rebase')).toHaveLength(2);
    expect(learnerReport(f, DAY, 'nothing')).toEqual(['No topics match "nothing".']);
  });
});

describe('learner: through the runtime', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  const local = {
    kind: 'openai-compatible',
    baseURL: 'http://localhost:8000/v1',
    model: 'm',
    pricing: { input: 0, output: 0 },
  };
  const writeConfig = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ providers: { local }, ...extra }),
    );
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
    writeConfig();
    // Some memory from an earlier session.
    const f = fresh();
    recordResult(f, { topic: 'counting', variety: 'mgp', result: 'missed' }, '2026-11-01');
    saveLearner(join(home.dir, 'learner.json'), f);
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const make = (
    provider: string,
    turns: Parameters<typeof mockModel>[0],
    mode?: 'learn' | 'teach' | 'default',
    offline?: boolean,
  ) => {
    const asked: string[] = [];
    const notices: string[] = [];
    const model = mockModel(turns);
    const rt = new Runtime({
      cwd: project.dir,
      provider,
      languageModel: model,
      ...(mode ? { mode } : {}),
      ...(offline ? { offline } : {}),
      ask: async (r) => {
        asked.push(r.summary);
        return 'no';
      },
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    return { rt, model, asked, notices };
  };
  const systemOf = (model: ReturnType<typeof mockModel>, call: number) =>
    String(model.doStreamCalls[call]?.prompt.find((m) => m.role === 'system')?.content ?? '');
  const io = (out: string[]) => ({
    write: (s: string) => out.push(plain(s)),
    busy: <T>(r: (s: AbortSignal) => Promise<T>) => r(new AbortController().signal),
  });

  test('learn mode, local model: the summary is in the prompt, and stays byte-identical after a write', async () => {
    const { rt, model, asked } = make(
      'local',
      [
        toolTurn('learned', '{"topic":"counting","variety":"mgp","result":"right"}', 'c1'),
        textTurn('Next question.'),
        textTurn('Another.'),
      ],
      'learn',
    );
    expect(rt.agent.opts.tools.map((t) => t.name)).toContain('learned');
    await rt.agent.run('quiz me');
    await rt.agent.run('again');
    expect(asked).toEqual([]); // recording never asks
    const first = systemOf(model, 0);
    expect(first).toContain('## Learner memory');
    expect(first).toContain('- counting: practising, 0/1 right, due 2026-11-02');
    expect(systemOf(model, 2)).toBe(first); // the cached prefix doesn't change mid-session
    const saved = loadLearner(join(home.dir, 'learner.json'));
    expect(saved.topics[0]).toMatchObject({
      topic: 'counting',
      variety: 'mgp',
      asked: 2,
      right: 1,
    });
    await rt.close();
  });

  test('a cloud model gets no summary by default, says so once, and still records locally', async () => {
    const { rt, model, notices } = make(
      'claude',
      [toolTurn('learned', '{"topic":"rebase","result":"missed"}'), textTurn('ok')],
      'learn',
    );
    await rt.agent.run('quiz me');
    expect(systemOf(model, 0)).not.toContain('Learner memory');
    expect(
      notices.filter((n) => n.startsWith("Learner memory isn't sent to cloud models")),
    ).toHaveLength(1);
    expect(loadLearner(join(home.dir, 'learner.json')).topics.map((t) => t.topic)).toEqual([
      'counting',
      'rebase',
    ]);
    await rt.close();
  });

  test('shareWithCloud in the global config sends it; a project config cannot set it', async () => {
    writeConfig({ learner: { shareWithCloud: true } });
    const { rt, model } = make('claude', [textTurn('ok')], 'learn');
    await rt.agent.run('quiz me');
    expect(systemOf(model, 0)).toContain('## Learner memory');
    await rt.close();
    writeConfig();
    mkdirSync(join(project.dir, '.mrig'));
    writeFileSync(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ learner: { shareWithCloud: true } }),
    );
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.learner).toBeUndefined();
    expect(cfg.projectIgnored).toEqual(['learner.shareWithCloud']);
  });

  test('default mode: no summary and no learned tool; teach mode records introduced topics', async () => {
    const plainRun = make('local', [textTurn('hi')]);
    await plainRun.rt.agent.run('hello');
    expect(systemOf(plainRun.model, 0)).not.toContain('Learner memory');
    expect(plainRun.rt.agent.opts.tools.map((t) => t.name)).not.toContain('learned');
    await plainRun.rt.close();
    const teach = make(
      'local',
      [toolTurn('learned', '{"topic":"stash","result":"introduced"}'), textTurn('ok')],
      'teach',
    );
    await teach.rt.agent.run('teach me git stash');
    expect(teach.asked).toEqual([]); // teach asks before changes, but recording is not a change
    expect(
      loadLearner(join(home.dir, 'learner.json')).topics.find((t) => t.topic === 'stash')?.status,
    ).toBe('introduced');
    await teach.rt.close();
  });

  test('inside an offline zone the zone file is used, and the global one is untouched', async () => {
    writeFileSync(join(project.dir, ZONE_MARKER), '');
    const before = readFileSync(join(home.dir, 'learner.json'), 'utf8');
    const { rt, model } = make(
      'local',
      [
        toolTurn('learned', '{"topic":"secret word","variety":"kzq","result":"right"}'),
        textTurn('ok'),
      ],
      'learn',
    );
    await rt.agent.run('quiz me');
    expect(systemOf(model, 0)).not.toContain('counting'); // the global memory stays outside
    expect(readFileSync(join(home.dir, 'learner.json'), 'utf8')).toBe(before);
    const zoneFile = join(project.dir, '.mrig', 'learner', 'learner.json');
    expect(loadLearner(zoneFile).topics.map((t) => t.topic)).toEqual(['secret word']);
    expect(rt.learnerFile).toBe(zoneFile);
    await rt.close();
  });

  test('/learned and /forget', async () => {
    const { rt } = make('local', [], 'learn');
    const out: string[] = [];
    await runCommand(rt, '/learned', io(out));
    expect(out.join('')).toContain(
      'Eastern Magar (Magar Dhut) (mgp):\n  counting: practising, 0/1 right, due 2026-11-02',
    );
    out.length = 0;
    await runCommand(rt, '/learned where', io(out));
    expect(out.join('').trim()).toBe(join(home.dir, 'learner.json'));
    out.length = 0;
    await runCommand(rt, '/forget nothing', io(out));
    expect(out.join('')).toContain('No topic named "nothing".');
    out.length = 0;
    await runCommand(rt, '/forget all', io(out));
    expect(out.join('')).toContain('This deletes all 1 topic in');
    expect(existsSync(join(home.dir, 'learner.json'))).toBe(true); // nothing deleted yet
    out.length = 0;
    await runCommand(rt, '/forget all --yes', io(out));
    expect(out.join('')).toContain('Deleted learner memory (1 topic).');
    expect(out.join('')).toContain(
      'Session transcripts and your own backups of ~/.mrig still hold what was said',
    );
    expect(existsSync(join(home.dir, 'learner.json'))).toBe(false);
    out.length = 0;
    await runCommand(rt, '/learned', io(out));
    expect(out.join('')).toMatch(/^No learner memory yet/);
    await rt.close();
  });

  test('/forget one topic and one variety', async () => {
    const f = loadLearner(join(home.dir, 'learner.json'));
    recordResult(f, { topic: 'greetings', variety: 'kgj', result: 'right' }, DAY);
    recordResult(f, { topic: 'family', variety: 'kgj', result: 'right' }, DAY);
    saveLearner(join(home.dir, 'learner.json'), f);
    const { rt } = make('local', [], 'learn');
    const out: string[] = [];
    await runCommand(rt, '/forget counting', io(out));
    expect(out.join('')).toContain('Forgot 1 topic.');
    out.length = 0;
    await runCommand(rt, '/forget --variety kgj', io(out));
    expect(out.join('')).toContain('Forgot 2 topics.');
    expect(loadLearner(join(home.dir, 'learner.json')).topics).toEqual([]);
    await rt.close();
  });
});

describe('learner: the tool', () => {
  test('read-only and local; refuses a broken file instead of overwriting it', async () => {
    const t = tempDir('mrig-learned-');
    try {
      const path = join(t.dir, 'learner.json');
      const tool = createLearnedTool({ path, now: () => new Date(2026, 10, 6) });
      expect(tool.readOnly).toBe(true);
      expect(tool.remote).toBeUndefined();
      expect(tool.summarize({ topic: 'counting', variety: 'mgp', result: 'right' })).toBe(
        'learned "counting" (mgp) right',
      );
      expect(
        await tool.execute({ topic: 'counting', variety: 'mgp', result: 'right' }, ctx(t.dir)),
      ).toBe('Recorded: counting (mgp) is practising, 1/1 right, next review 2026-11-08.');
      writeFileSync(path, 'not json');
      await expect(tool.execute({ topic: 'x', result: 'right' }, ctx(t.dir))).rejects.toThrow(
        /is not valid JSON/,
      );
      expect(readFileSync(path, 'utf8')).toBe('not json');
    } finally {
      t.cleanup();
    }
  });
});
