import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/args.ts';
import { devaToAkkha } from '../src/lang/translit.ts';
import { learnerSummary, loadLearner, recordResult, saveLearner } from '../src/learner.ts';
import { Runtime } from '../src/runtime.ts';
import { Session } from '../src/session.ts';
import { bannerLines, runCommand } from '../src/ui/commands.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const FIXTURE = join(import.meta.dir, 'fixtures', 'cldf-wordlist');

describe('tutor (T8)', () => {
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
      JSON.stringify({ providers: { local }, corpus: FIXTURE, ...extra }),
    );
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
    writeConfig();
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const make = (
    turns: Parameters<typeof mockModel>[0],
    extra: { mode?: 'tutor' | 'learn'; variety?: string; resume?: string } = {},
  ) => {
    const asked: string[] = [];
    const notices: string[] = [];
    const model = mockModel(turns);
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'local',
      languageModel: model,
      ...extra,
      ask: async (r) => {
        asked.push(r.summary);
        return 'no';
      },
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    return { rt, model, asked, notices };
  };
  const io = (out: string[]) => ({
    write: (s: string) => out.push(plain(s)),
    busy: <T>(r: (s: AbortSignal) => Promise<T>) => r(new AbortController().signal),
  });
  const systemOf = (model: ReturnType<typeof mockModel>, call: number) =>
    String(model.doStreamCalls[call]?.prompt.find((m) => m.role === 'system')?.content ?? '');
  const toolResults = (rt: Runtime) =>
    rt.agent.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .map((p) =>
        p.type === 'tool-result'
          ? p.output.type === 'text' || p.output.type === 'error-text'
            ? p.output.value
            : JSON.stringify(p.output)
          : '',
      );

  test('a variety is required: refused without one, or with an unknown one', async () => {
    expect(() => make([], { mode: 'tutor' })).toThrow(
      'The tutor mode works on one variety, so varieties are never pooled. Choose one: mgp, mrd, kgj, kip, kif, kjl, kzq (for example /mode tutor mgp).',
    );
    expect(() => make([], { mode: 'tutor', variety: 'xx' })).toThrow('Unknown variety "xx".');
    const { rt } = make([]);
    const out: string[] = [];
    await runCommand(rt, '/mode tutor', io(out));
    expect(out.join('')).toContain('works on one variety, so varieties are never pooled');
    expect(rt.mode).toBe('default'); // nothing changed
    expect(parseArgs(['--mode', 'tutor', '--variety', 'kgj'])).toMatchObject({
      mode: 'tutor',
      variety: 'kgj',
    });
    await rt.close();
  });

  test('the prompt names the variety and the rules; read-only tools plus learned', async () => {
    const { rt, model } = make([textTurn('First question.')], { mode: 'tutor', variety: 'mgp' });
    await rt.agent.run('teach me some words');
    const system = systemOf(model, 0);
    expect(system).toContain('## Mode: tutor (Eastern Magar (Magar Dhut), mgp)');
    expect(system).toContain('Never invent a word or a form');
    expect(system).toContain('Get the Akkha form and the romanization from the translit tool');
    expect(system.length).toBeLessThan(4000);
    expect((model.doStreamCalls[0]?.tools ?? []).map((t) => t.name)).toEqual([
      'read',
      'glob',
      'grep',
      'translit',
      'corpus',
      'learned',
    ]);
    expect(bannerLines(rt).map(plain)[0]).toContain('· tutor (mgp) mode');
    await rt.close();
  });

  test('a tutor turn: corpus in the variety, Akkha through translit, the result recorded in the variety', async () => {
    const { rt, asked } = make(
      [
        toolTurn('corpus', '{"query":"mother"}', 'c1'),
        toolTurn('translit', '{"text":"आमा","to":"akkha","variety":"mgp"}', 'c2'),
        toolTurn('learned', '{"topic":"आमा (mother)","result":"right"}', 'c3'),
        toolTurn('learned', '{"topic":"घर (house)","variety":"kgj","result":"right"}', 'c4'),
        textTurn('Well done.'),
      ],
      { mode: 'tutor', variety: 'mgp' },
    );
    await rt.agent.run('quiz me');
    expect(asked).toEqual([]);
    const [corpus, translit, learned, refused] = toolResults(rt);
    // The search defaulted to mgp: only the Eastern Magar form is listed, the others are counted.
    expect(corpus).toContain('    forms: mgp आमा (forms.csv:2)');
    expect(corpus).not.toContain('kgj आमा');
    expect(corpus).toContain('(2 forms in other varieties not shown)');
    expect(translit?.split('\n')[0]).toBe(devaToAkkha('आमा').text);
    expect(learned).toBe(
      `Recorded: आमा (mother) (mgp) is practising, 1/1 right, next review ${learned?.slice(-11)}`,
    );
    expect(refused).toContain('This tutor session is for mgp; record kgj topics in a kgj session');
    const saved = loadLearner(join(home.dir, 'learner.json'));
    expect(saved.topics.map((t) => [t.topic, t.variety])).toEqual([['आमा (mother)', 'mgp']]);
    await rt.close();
  });

  test("the learner summary lists only the tutor's variety", async () => {
    const f = { version: 1, topics: [] };
    recordResult(f, { topic: 'counting', variety: 'mgp', result: 'missed' }, '2026-11-01');
    recordResult(f, { topic: 'greetings', variety: 'kgj', result: 'missed' }, '2026-11-01');
    recordResult(f, { topic: 'git rebase', result: 'missed' }, '2026-11-01');
    saveLearner(join(home.dir, 'learner.json'), f);
    expect(learnerSummary(f, '2026-11-06', 'mgp')).not.toContain('greetings');
    const { rt, model } = make([textTurn('ok')], { mode: 'tutor', variety: 'mgp' });
    await rt.agent.run('quiz me');
    const system = systemOf(model, 0);
    expect(system).toContain('- counting: practising, 0/1 right');
    expect(system).not.toContain('greetings');
    expect(system).not.toContain('git rebase');
    await rt.close();
  });

  test('mode and variety are saved and survive -c and /resume; /mode switches variety', async () => {
    const first = make([textTurn('ok')], { mode: 'tutor', variety: 'kzq' });
    await first.rt.agent.run('hi');
    first.rt.save();
    const id = first.rt.session.meta.id;
    expect(Session.load(id).meta).toMatchObject({ mode: 'tutor', variety: 'kzq' });
    await first.rt.close();

    const again = make([], { resume: 'latest' });
    expect([again.rt.mode, again.rt.variety]).toEqual(['tutor', 'kzq']);
    const out: string[] = [];
    await runCommand(again.rt, '/mode tutor mrd', io(out));
    expect(out.join('')).toContain('now in tutor (mrd) mode');
    expect(again.rt.agent.opts.systemPrompt).toContain(
      '## Mode: tutor (Western Magar (Magar Dhut), mrd)',
    );
    expect(Session.load(id).meta.variety).toBe('mrd');
    await runCommand(again.rt, '/mode learn', io([]));
    expect(again.rt.variety).toBeUndefined();
    expect(Session.load(id).meta.variety).toBeUndefined();
    await again.rt.close();

    const other = make([], { mode: 'tutor', variety: 'kgj' });
    const otherId = other.rt.session.meta.id;
    await other.rt.close();
    const back = make([]);
    back.rt.resume(otherId);
    expect([back.rt.mode, back.rt.variety]).toEqual(['tutor', 'kgj']);
    await back.rt.close();
  });

  test('without a corpus the tutor says so once, at the start', async () => {
    writeConfig({ corpus: undefined });
    writeFileSync(join(home.dir, 'config.json'), JSON.stringify({ providers: { local } }));
    const { rt, notices } = make([], { mode: 'tutor', variety: 'mgp' });
    expect(
      notices.filter((n) =>
        n.startsWith('No corpus found, so the tutor can only ask from language memory'),
      ),
    ).toHaveLength(1);
    await rt.close();
  });
});
