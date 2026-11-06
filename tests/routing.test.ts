import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { runHeadless } from '../src/headless.ts';
import { classify, parseRouting, type RoutingConfig } from '../src/routing.ts';
import { Runtime } from '../src/runtime.ts';
import { runCommand } from '../src/ui/commands.ts';
import { ZONE_MARKER } from '../src/zone.ts';
import { mockModel, tempDir, textTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const CONFIG: RoutingConfig = {
  easy: 'small',
  hard: 'big',
  default: 'easy',
  longChars: 1500,
  rules: [],
};
const NO_IMAGES = { hasImages: false, vision: { easy: false, hard: true } };
const route = (text: string, config = CONFIG, ctx = NO_IMAGES) => {
  const d = classify(text, config, ctx);
  return `${d.tier}: ${d.reason}`;
};

describe('routing: the rules', () => {
  test('first match wins, in order', () => {
    expect(route('!hard what is 2 + 2')).toBe('hard: you asked');
    expect(route('!EASY please refactor everything')).toBe('easy: you asked'); // the prefix beats the word
    expect(classify('!hard  fix it', CONFIG, NO_IMAGES).text).toBe('fix it'); // prefix stripped
    expect(
      route('what is in screenshot.png', CONFIG, {
        hasImages: true,
        vision: { easy: false, hard: true },
      }),
    ).toBe('hard: an image needs vision');
    expect(
      route('caption this', CONFIG, { hasImages: true, vision: { easy: true, hard: true } }),
    ).toBe('easy: default');
    expect(route('x'.repeat(1501))).toBe('hard: long (1,501 characters)');
    expect(route('please refactor the parser')).toBe('hard: "refactor"');
    expect(route('Why does this fail?')).toBe('hard: "why"');
    expect(route('whyever not; the planet is round')).toBe('easy: default'); // whole words only
    expect(route('rename the variable')).toBe('easy: default');
    expect(route('rename it', { ...CONFIG, default: 'hard' })).toBe('hard: default');
  });

  test('your own rules come before the built-ins: word lists and regexes', () => {
    const config = parseRouting({
      easy: 'small',
      hard: 'big',
      rules: [
        { match: ['commit message', 'typo'], use: 'easy' },
        { match: '\\bakkha\\b|अक्खा', use: 'hard' },
      ],
    });
    expect(route('review this typo', config)).toBe('easy: your rule: "typo"'); // beats the hard word
    expect(route('write a commit message', config)).toBe('easy: your rule: "commit message"');
    expect(route('Akkha spelling of आमा', config)).toBe('hard: your rule: /\\bakkha\\b|अक्खा/');
  });

  test('config validation', () => {
    expect(parseRouting({ easy: 'a', hard: 'b' })).toEqual({
      easy: 'a',
      hard: 'b',
      default: 'easy',
      longChars: 1500,
      rules: [],
    });
    for (const [bad, message] of [
      [[], /"routing" must be an object/],
      [{ easy: 'a' }, /"routing.hard" must be a profile name/],
      [{ easy: 'a', hard: 'b', default: 'medium' }, /"routing.default" must be "easy" or "hard"/],
      [{ easy: 'a', hard: 'b', longChars: -1 }, /"routing.longChars" must be a positive number/],
      [
        { easy: 'a', hard: 'b', rules: [{ match: '(', use: 'hard' }] },
        /"routing.rules\[0\].match" is not a valid regular expression/,
      ],
      [
        { easy: 'a', hard: 'b', rules: [{ match: 3, use: 'hard' }] },
        /must be a regular expression or a list of words/,
      ],
      [
        { easy: 'a', hard: 'b', rules: [{ match: 'x', use: 'big' }] },
        /"routing.rules\[0\].use" must be "easy" or "hard"/,
      ],
    ] as const) {
      expect(() => parseRouting(bad)).toThrow(message);
    }
  });
});

describe('routing: through the runtime', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  const small = {
    kind: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    model: 'small-model',
    pricing: { input: 0, output: 0 },
  };
  const big = {
    kind: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    model: 'big-model',
    pricing: { input: 3, output: 15 },
  };
  const writeConfig = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        defaultProvider: 'small',
        providers: { small, big },
        routing: { easy: 'small', hard: 'big' },
        ...extra,
      }),
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

  /** A runtime whose two profiles answer from separate mock models. */
  const make = (opts: { routing?: boolean; offline?: boolean; provider?: string } = {}) => {
    const models = {
      small: mockModel([textTurn('small 1'), textTurn('small 2'), textTurn('small 3')]),
      big: mockModel([textTurn('big 1'), textTurn('big 2'), textTurn('big 3')]),
    };
    const notices: string[] = [];
    const rt = new Runtime({
      cwd: project.dir,
      ...(opts.provider ? { provider: opts.provider } : {}),
      languageModel: models[(opts.provider as 'small' | 'big' | undefined) ?? 'small'],
      languageModelFor: (name) => models[name as 'small' | 'big'],
      ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
      ...(opts.offline ? { offline: true } : {}),
      ask: async () => 'no',
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    return { rt, models, notices };
  };
  const lastUserText = (model: ReturnType<typeof mockModel>, call = 0) => {
    const prompt = model.doStreamCalls[call]?.prompt ?? [];
    const user = [...prompt].reverse().find((m) => m.role === 'user');
    return (user?.content as Array<{ text?: string }>)?.map((p) => p.text).join('') ?? '';
  };
  const io = (out: string[]) => ({
    write: (s: string) => out.push(plain(s)),
    busy: <T>(r: (s: AbortSignal) => Promise<T>) => r(new AbortController().signal),
  });

  test('each message runs on its tier, says why, and the conversation carries over', async () => {
    const { rt, models, notices } = make();
    expect(rt.route.active).toBe(true);
    await rt.runTurn('rename foo to bar');
    await rt.runTurn('now refactor the module');
    await rt.runTurn('!easy thanks, commit it');
    expect(models.small.doStreamCalls).toHaveLength(2);
    expect(models.big.doStreamCalls).toHaveLength(1);
    expect(notices).toEqual([
      '→ small/small-model (easy: default)',
      '→ big/big-model (hard: "refactor")',
      '→ small/small-model (easy: you asked)',
    ]);
    // The prefix is stripped, and the big model saw the earlier turn.
    expect(lastUserText(models.small, 1)).toBe('thanks, commit it');
    const bigPrompt = models.big.doStreamCalls[0]?.prompt ?? [];
    expect(bigPrompt.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(rt.route.last).toMatchObject({ tier: 'easy', profile: 'small', reason: 'you asked' });
    await rt.close();
  });

  test('a manual model choice turns routing off; /route turns it back on, pins, and explains', async () => {
    const { rt, models, notices } = make();
    rt.switchModel('big');
    expect(rt.route.active).toBe(false);
    expect(notices.at(-1)).toBe(
      'Routing is off for this session, because you chose a model. /route on turns it back on.',
    );
    await rt.runTurn('rename foo'); // no routing: stays on big
    expect(models.big.doStreamCalls).toHaveLength(1);
    const out: string[] = [];
    await runCommand(rt, '/route easy', io(out));
    expect(out.join('')).toContain('routing: pinned to easy (/route on to route again)');
    await rt.runTurn('refactor everything'); // pinned: easy despite the hard word
    expect(models.small.doStreamCalls).toHaveLength(1);
    expect(notices.at(-1)).toBe('→ small/small-model (easy: pinned with /route)');
    out.length = 0;
    await runCommand(rt, '/route why', io(out));
    expect(out.join('')).toContain('last message: easy → small (pinned with /route)');
    expect(out.join('')).toContain('rules: !easy/!hard prefix · images → the tier with vision');
    out.length = 0;
    await runCommand(rt, '/route off', io(out));
    expect(out.join('')).toContain('routing: off');
    out.length = 0;
    await runCommand(rt, '/route nope', io(out));
    expect(out.join('')).toBe('usage: /route [on|off|easy|hard|why]\n\n');
    await rt.close();
  });

  test('-P or -m (routing: false) leaves routing off', async () => {
    const { rt, models } = make({ routing: false, provider: 'big' });
    expect(rt.route.active).toBe(false);
    await rt.runTurn('rename foo');
    expect(models.big.doStreamCalls).toHaveLength(1);
    expect(models.small.doStreamCalls).toHaveLength(0);
    await rt.close();
  });

  test('offline: a cloud tier is unavailable, and its messages go to the local one', async () => {
    writeFileSync(join(project.dir, ZONE_MARKER), '');
    const { rt, models, notices } = make();
    await rt.runTurn('refactor the module');
    await rt.runTurn('design the next part');
    expect(models.big.doStreamCalls).toHaveLength(0);
    expect(models.small.doStreamCalls).toHaveLength(2);
    expect(
      notices.filter((n) => n.startsWith('Offline mode: the hard profile (big) is not local')),
    ).toHaveLength(1);
    await rt.close();
  });

  test('an unknown profile turns routing off with a notice; a project config cannot set routing', async () => {
    writeConfig({ routing: { easy: 'small', hard: 'missing' } });
    const { rt, notices } = make();
    expect(rt.route.active).toBe(false);
    expect(notices[0]).toMatch(/^Routing is off: Unknown provider "missing"/);
    const out: string[] = [];
    await runCommand(rt, '/route on', io(out));
    expect(rt.route.active).toBe(false); // still refused
    await rt.close();

    writeFileSync(join(home.dir, 'config.json'), JSON.stringify({ providers: { small, big } }));
    mkdirSync(join(project.dir, '.mrig'));
    writeFileSync(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ routing: { easy: 'small', hard: 'big' } }),
    );
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.routing).toBeUndefined();
    expect(cfg.projectIgnored).toEqual(['routing.easy', 'routing.hard']);
  });

  test('without a routing block, /route says how to set it up', async () => {
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ defaultProvider: 'small', providers: { small, big } }),
    );
    const { rt } = make();
    const out: string[] = [];
    await runCommand(rt, '/route', io(out));
    expect(out.join('')).toMatch(/^Routing is not set up\. Add "routing"/);
    await rt.close();
  });

  test('headless mode routes too', async () => {
    const models = {
      small: mockModel([textTurn('s')]),
      big: mockModel([textTurn('Here is the plan.')]),
    };
    let stdout = '';
    await runHeadless(
      {
        cwd: project.dir,
        prompt: 'plan the migration',
        output: 'json',
        languageModel: models.small,
        languageModelFor: (name) => models[name as 'small' | 'big'],
      },
      { stdout: (s) => (stdout += s), stderr: () => {}, ask: async () => 'no' },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      text: 'Here is the plan.',
      provider: 'big',
      model: 'big-model',
    });
  });
});
