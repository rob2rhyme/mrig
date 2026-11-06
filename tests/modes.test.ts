import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/args.ts';
import { MODE_NAMES, modePrompt, parseMode } from '../src/modes.ts';
import { buildSystemPrompt } from '../src/prompt.ts';
import { Runtime } from '../src/runtime.ts';
import { Session } from '../src/session.ts';
import { bannerLines, runCommand } from '../src/ui/commands.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('modes: definitions and the prompt', () => {
  test('each mode adds its own text; default adds none; all stay under ~1k tokens', () => {
    const base = buildSystemPrompt({ cwd: '/tmp', modelLabel: 'm', now: new Date(0) });
    expect(
      buildSystemPrompt({ cwd: '/tmp', modelLabel: 'm', now: new Date(0), mode: 'default' }),
    ).toBe(base);
    for (const name of MODE_NAMES) {
      const prompt = buildSystemPrompt({
        cwd: '/tmp',
        modelLabel: 'm',
        now: new Date(0),
        mode: name,
        ...(name === 'tutor' ? { variety: 'mgp' as const } : {}),
      });
      expect(prompt.length).toBeLessThan(4000); // ≈ under 1,000 tokens before memory
      for (const other of MODE_NAMES) {
        const heading = modePrompt(other, 'mgp')[0];
        if (heading) expect(prompt.includes(heading)).toBe(other === name);
      }
    }
    const teach = buildSystemPrompt({
      cwd: '/tmp',
      modelLabel: 'm',
      now: new Date(0),
      mode: 'teach',
    });
    expect(teach).toContain('ask the user to try it first');
    // The mode text comes after "How to work" and before project memory.
    expect(teach.indexOf('## Mode: teach')).toBeGreaterThan(teach.indexOf('## How to work'));
  });

  test('names: --mode validates; unknown names list the choices', () => {
    expect(parseArgs(['--mode', 'teach']).mode).toBe('teach');
    expect(parseArgs([]).mode).toBeUndefined();
    expect(() => parseArgs(['--mode', 'quiz'])).toThrow(
      'Unknown mode "quiz". Modes: default, teach, learn, tutor.',
    );
    expect(parseMode('learn')).toBe('learn');
  });
});

describe('modes: behaviour through the runtime', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: {
          fake: { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake' },
        },
        permissions: { allow: ['write:**', 'bash:echo'] },
      }),
    );
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const make = (
    turns: Parameters<typeof mockModel>[0],
    extra: { mode?: 'default' | 'teach' | 'learn'; yolo?: boolean; resume?: string } = {},
  ) => {
    const asked: string[] = [];
    const model = mockModel(turns);
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      languageModel: model,
      ...extra,
      ask: async (r) => {
        asked.push(`${r.summary} [${r.alwaysRule}]`);
        return 'always';
      },
      events: { onText: () => {} },
    });
    return { rt, model, asked };
  };
  const io = (out: string[]) => ({
    write: (s: string) => out.push(plain(s)),
    busy: <T>(run: (s: AbortSignal) => Promise<T>) => run(new AbortController().signal),
  });
  const offered = (model: ReturnType<typeof mockModel>, call: number) =>
    (model.doStreamCalls[call]?.tools ?? []).map((t) => t.name);

  test('default: allow rules apply, as today', async () => {
    const { rt, asked } = make([
      toolTurn('write', '{"path":"a.txt","content":"x"}'),
      textTurn('ok'),
    ]);
    await rt.agent.run('write it');
    expect(asked).toEqual([]); // write:** allowed it
    await rt.close();
  });

  test('teach: every change asks, despite yolo and allow rules; "always" means once', async () => {
    const { rt, asked, model } = make(
      [
        toolTurn('write', '{"path":"a.txt","content":"x"}', 'c1'),
        toolTurn('write', '{"path":"b.txt","content":"y"}', 'c2'),
        toolTurn('read', '{"path":"a.txt"}', 'c3'),
        textTurn('ok'),
      ],
      { mode: 'teach', yolo: true },
    );
    await rt.agent.run('write two files');
    expect(asked).toEqual([
      'write a.txt (1 line) [once (teach mode asks every time)]',
      'write b.txt (1 line) [once (teach mode asks every time)]',
    ]); // read-only read did not ask
    expect(rt.permissions.learned).toEqual([]);
    expect(rt.permissions.promptsSkipped).toBe(false);
    const system = String(model.doStreamCalls[0]?.prompt.find((m) => m.role === 'system')?.content);
    expect(system).toContain('## Mode: teach');
    const out: string[] = [];
    await runCommand(rt, '/yolo', io(out)); // it started with yolo on: turning it off is fine
    expect(out.join('')).toContain('yolo off');
    out.length = 0;
    await runCommand(rt, '/yolo', io(out)); // turning it back on is refused in teach mode
    expect(out.join('')).toContain('teach mode asks before every change; /mode default first');
    await rt.close();
  });

  test('learn: only read-only tools are offered, and others are refused', async () => {
    const { rt, model, asked } = make([textTurn('Question 1: what does ls do?')], {
      mode: 'learn',
    });
    await rt.agent.run('quiz me on the shell');
    expect(offered(model, 0)).toEqual(['read', 'glob', 'grep', 'translit', 'corpus', 'learned']);
    expect(asked).toEqual([]);
    const write = rt.agent.opts.tools.find((t) => t.name === 'write');
    expect(write).toBeUndefined();
    // Defence in depth: the gate itself refuses a non-read-only tool in learn mode.
    const { DEFAULT_TOOLS } = await import('../src/tools/index.ts');
    const bash = DEFAULT_TOOLS.find((t) => t.name === 'bash');
    if (!bash) throw new Error('no bash');
    expect(await rt.permissions.check(bash, { command: 'echo hi' })).toBe('deny');
    await rt.close();
  });

  test('/mode switches prompt, tools and policy, and saves the mode; -c restores it', async () => {
    const { rt, model } = make([textTurn('one'), textTurn('two')]);
    await rt.agent.run('hi');
    const out: string[] = [];
    await runCommand(rt, '/mode learn', io(out));
    expect(out.join('')).toContain(
      'now in learn mode: quizzes you and tracks what you have covered',
    );
    await rt.agent.run('quiz me');
    expect(offered(model, 0)).toContain('write');
    expect(offered(model, 1)).not.toContain('write');
    expect(
      String(model.doStreamCalls[1]?.prompt.find((m) => m.role === 'system')?.content),
    ).toContain('## Mode: learn');
    rt.save();
    const id = rt.session.meta.id;
    expect(Session.load(id).meta.mode).toBe('learn');
    expect(bannerLines(rt).map(plain)[0]).toContain('· learn mode');
    await rt.close();

    // -c: the resumed session comes back in learn mode.
    const again = make([], { resume: 'latest' });
    expect(again.rt.session.meta.id).toBe(id);
    expect(again.rt.mode).toBe('learn');
    expect(again.rt.permissions.policy).toBe('read-only');
    await again.rt.close();

    // An explicit --mode wins over the saved one, and is saved in turn.
    const teach = make([], { resume: 'latest', mode: 'teach' });
    expect(teach.rt.mode).toBe('teach');
    expect(Session.load(id).meta.mode).toBe('teach');
    await runCommand(teach.rt, '/mode default', io([]));
    expect(Session.load(id).meta.mode).toBeUndefined();
    await teach.rt.close();
  });

  test('/mode lists the modes; a bad name is an error message, not a switch', async () => {
    const { rt } = make([]);
    const out: string[] = [];
    await runCommand(rt, '/mode', io(out));
    expect(out.join('').split('\n').slice(0, 4)).toEqual([
      '● default  does the work, asking before changes as usual',
      '○ teach    explains before acting, one small step at a time; you try each next step first',
      '○ learn    quizzes you and tracks what you have covered; read-only tools only',
      '○ tutor    the Akkha language tutor for one variety: /mode tutor <variety>',
    ]);
    out.length = 0;
    await runCommand(rt, '/mode quiz', io(out));
    expect(out.join('')).toContain('Unknown mode "quiz". Modes: default, teach, learn, tutor.');
    expect(rt.mode).toBe('default');
    await rt.close();
  });

  test("/resume adopts the resumed session's mode", async () => {
    const first = make([], { mode: 'teach' });
    const teachId = first.rt.session.meta.id;
    await first.rt.close();
    const { rt } = make([]);
    expect(rt.mode).toBe('default');
    rt.resume(teachId);
    expect(rt.mode).toBe('teach');
    expect(rt.agent.opts.systemPrompt).toContain('## Mode: teach');
    await rt.close();
  });
});
