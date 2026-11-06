import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockImageModelV4 } from 'ai/test';
import { loadConfig } from '../src/config.ts';
import { runHeadless } from '../src/headless.ts';
import { Runtime } from '../src/runtime.ts';
import { createImageTool, defaultImageName, imagePrice } from '../src/tools/image.ts';
import { runCommand } from '../src/ui/commands.ts';
import { ctx, mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A real 1×1 PNG, as an image API returns it (base64). */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A mock image model; `calls` records what each request asked for. */
function mockImages(opts: { fail?: string; warn?: boolean } = {}) {
  const calls: Array<{ prompt: unknown; n: number; size: unknown }> = [];
  const model = new MockImageModelV4({
    modelId: 'mock-image',
    doGenerate: async (o) => {
      calls.push({ prompt: o.prompt, n: o.n, size: o.size });
      if (opts.fail) throw new Error(opts.fail);
      return {
        images: Array.from({ length: o.n }, () => PNG_B64),
        warnings: opts.warn
          ? [{ type: 'unsupported' as const, feature: 'size', details: 'used 1024x1024' }]
          : [],
        response: { timestamp: new Date(0), modelId: 'mock-image', headers: undefined },
      };
    },
  });
  return { model, calls };
}

const CONFIG = { profile: 'openai', model: 'mock-image', dir: 'images', pricePerImage: 0.04 };
const NOW = () => new Date('2026-11-06T09:15:00Z');

describe('image: the tool', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('mrig-image-');
  });
  afterEach(() => t.cleanup());

  test('price math and file names', () => {
    expect(imagePrice(CONFIG, 1)).toBe(0.04);
    expect(imagePrice(CONFIG, 3)).toBeCloseTo(0.12, 10);
    expect(imagePrice({ ...CONFIG, pricePerImage: undefined }, 2)).toBeUndefined();
    expect(defaultImageName('A red fox, in the snow!', NOW(), '.png')).toBe(
      '20261106-091500-a-red-fox-in-the-snow.png',
    );
    expect(defaultImageName('???', NOW(), '.jpg')).toBe('20261106-091500.jpg');
    expect(defaultImageName('x'.repeat(80), NOW(), '.png')).toBe(
      `20261106-091500-${'x'.repeat(40)}.png`,
    );
  });

  test('generates, saves to disk, returns the paths, records the cost', async () => {
    const { model, calls } = mockImages();
    const tool = createImageTool({ config: CONFIG, model, remote: true, now: NOW });
    expect(tool.readOnly).toBe(false); // always behind the permission gate
    expect(tool.remote).toBe(true);
    expect(tool.summarize({ prompt: 'a red fox', n: 2, size: '512x512' })).toBe(
      'image "a red fox" (2 × 512x512, ~$0.08)',
    );
    const media: Array<[string, number, number | undefined]> = [];
    const out = await tool.execute(
      { prompt: 'a red fox', n: 2, size: '512x512' },
      ctx(t.dir, { recordMedia: (k, n, usd) => media.push([k, n, usd]) }),
    );
    // The mock makes one image per call, so the SDK splits n: 2 into two requests.
    expect(calls).toEqual([
      { prompt: 'a red fox', n: 1, size: '512x512' },
      { prompt: 'a red fox', n: 1, size: '512x512' },
    ]);
    expect(out).toBe(
      [
        'Saved 2 images (mock-image, 512x512, ~$0.08):',
        '- images/20261106-091500-a-red-fox.png',
        '- images/20261106-091500-a-red-fox-2.png',
      ].join('\n'),
    );
    expect(
      readFileSync(join(t.dir, 'images', '20261106-091500-a-red-fox.png')).equals(
        Buffer.from(PNG_B64, 'base64'),
      ),
    ).toBe(true);
    expect(media).toEqual([['image', 2, expect.closeTo(0.08, 10)]]);
  });

  test('a chosen path is used; existing files are never overwritten', async () => {
    const { model } = mockImages();
    const tool = createImageTool({ config: CONFIG, model, remote: true, now: NOW });
    mkdirSync(join(t.dir, 'art'));
    writeFileSync(join(t.dir, 'art', 'fox.png'), 'keep me');
    const out = await tool.execute({ prompt: 'fox', path: 'art/fox.png' }, ctx(t.dir));
    expect(out).toContain('- art/fox-2.png');
    expect(readFileSync(join(t.dir, 'art', 'fox.png'), 'utf8')).toBe('keep me');
  });

  test('without a price, it says so; provider warnings are passed on; failures are tool errors', async () => {
    // The SDK also logs provider warnings to the console; keep this deliberate one out of the
    // test output. The tool reports it in its result, which is what is checked here.
    const previous = globalThis.AI_SDK_LOG_WARNINGS;
    globalThis.AI_SDK_LOG_WARNINGS = false;
    const warned = mockImages({ warn: true });
    const unpriced = createImageTool({
      config: { ...CONFIG, pricePerImage: undefined },
      model: warned.model,
      remote: true,
      now: NOW,
    });
    expect(unpriced.summarize({ prompt: 'x' })).toBe('image "x" (1 × default size, price unknown)');
    const out = await unpriced.execute({ prompt: 'x' }, ctx(t.dir));
    expect(out.split('\n')[0]).toBe('Saved 1 image (mock-image, price unknown):');
    expect(out).toContain('warning: unsupported: size (used 1024x1024)');
    globalThis.AI_SDK_LOG_WARNINGS = previous;
    const failing = createImageTool({
      config: CONFIG,
      model: mockImages({ fail: 'quota exceeded' }).model,
      remote: true,
    });
    await expect(failing.execute({ prompt: 'x' }, ctx(t.dir))).rejects.toThrow(
      'Image generation failed: quota exceeded',
    );
    await expect(failing.execute({ prompt: '  ' }, ctx(t.dir))).rejects.toThrow('Empty prompt.');
    expect(existsSync(join(t.dir, 'images'))).toBe(true); // only the successful call wrote
  });
});

describe('image: config, permission gate and cost through the runtime', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  const fake = {
    kind: 'openai-compatible',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'fake',
    pricing: { input: 0, output: 0 },
  };
  const writeConfig = (extra: Record<string, unknown>) =>
    writeFileSync(join(home.dir, 'config.json'), JSON.stringify({ providers: { fake }, ...extra }));
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const make = (
    turns: Parameters<typeof mockModel>[0],
    answer: 'yes' | 'no' = 'yes',
    extra: { offline?: boolean } = {},
  ) => {
    const asked: string[] = [];
    const notices: string[] = [];
    const images = mockImages();
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      languageModel: mockModel(turns),
      imageModel: images.model,
      ...extra,
      ask: async (r) => {
        asked.push(`${r.summary} [${r.alwaysRule}]`);
        return answer;
      },
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    return { rt, asked, notices, images };
  };

  test('config validation; a project config cannot set it', () => {
    writeConfig({ image: { model: 'gpt-image-1', size: '1024x1024', pricePerImage: 0.04 } });
    expect(loadConfig({ cwd: project.dir, env: {} }).image).toEqual({
      profile: 'openai',
      model: 'gpt-image-1',
      size: '1024x1024',
      pricePerImage: 0.04,
      dir: 'images',
    });
    for (const [bad, message] of [
      [{ image: [] }, /"image" must be an object/],
      [{ image: {} }, /"image.model" must be an image model id/],
      [{ image: { model: 'm', size: 'big' } }, /Invalid "image.size"/],
      [{ image: { model: 'm', pricePerImage: -1 } }, /"image.pricePerImage" must be a number/],
    ] as const) {
      writeConfig(bad);
      expect(() => loadConfig({ cwd: project.dir, env: {} })).toThrow(message);
    }
    writeConfig({});
    mkdirSync(join(project.dir, '.mrig'));
    writeFileSync(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ image: { model: 'm' } }),
    );
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.image).toBeUndefined(); // spending money is the user's decision, not a repo's
    expect(cfg.projectIgnored).toEqual(['image.model']);
  });

  test('no image config, no image tool', async () => {
    writeConfig({});
    const { rt } = make([]);
    expect(rt.agent.opts.tools.some((t) => t.name === 'image')).toBe(false);
    await rt.close();
  });

  test('it asks, with the price; a denial writes nothing; an image:* rule skips the prompt', async () => {
    writeConfig({ image: { profile: 'fake', model: 'mock-image', pricePerImage: 0.04 } });
    const denied = make([toolTurn('image', '{"prompt":"a red fox"}'), textTurn('ok')], 'no');
    await denied.rt.agent.run('draw a fox');
    expect(denied.asked).toEqual(['image "a red fox" (1 × default size, ~$0.04) [image:*]']);
    expect(denied.images.calls).toEqual([]);
    expect(existsSync(join(project.dir, 'images'))).toBe(false);
    await denied.rt.close();

    writeConfig({
      image: { profile: 'fake', model: 'mock-image', pricePerImage: 0.04 },
      permissions: { allow: ['image:*'] },
    });
    const allowed = make([toolTurn('image', '{"prompt":"a red fox"}'), textTurn('ok')]);
    await allowed.rt.agent.run('draw a fox');
    expect(allowed.asked).toEqual([]);
    expect(allowed.images.calls).toHaveLength(1);
    await allowed.rt.close();
  });

  test('the cost reaches /cost and the headless JSON', async () => {
    writeConfig({
      image: { profile: 'fake', model: 'mock-image', pricePerImage: 0.04 },
      permissions: { allow: ['image:*'] },
    });
    const { rt } = make([toolTurn('image', '{"prompt":"fox","n":3}'), textTurn('done')]);
    await rt.agent.run('three foxes');
    expect(rt.agent.media).toEqual({
      image: { count: 3, usd: expect.closeTo(0.12, 10), unpriced: 0 },
    });
    expect(rt.agent.cost()).toBeCloseTo(0.12, 10); // tokens are free on this profile
    const out: string[] = [];
    await runCommand(rt, '/cost', {
      write: (s) => out.push(plain(s)),
      busy: (run) => run(new AbortController().signal),
    });
    expect(out.join('')).toContain('images: 3 · ~$0.1200');
    await rt.close();

    let stdout = '';
    const images = mockImages();
    await runHeadless(
      {
        cwd: project.dir,
        provider: 'fake',
        languageModel: mockModel([toolTurn('image', '{"prompt":"fox"}'), textTurn('done')]),
        imageModel: images.model,
        prompt: 'a fox',
        output: 'json',
      },
      { stdout: (s) => (stdout += s), stderr: () => {}, ask: async () => 'yes' },
    );
    const json = JSON.parse(stdout);
    expect(json.media).toEqual({ image: { count: 1, usd: 0.04, unpriced: 0 } });
    expect(json.cost).toBeCloseTo(0.04, 10);
  });

  test('offline: a remote generator is dropped; a local one stays', async () => {
    writeConfig({ image: { profile: 'openai', model: 'gpt-image-1' } });
    const remote = make([], 'yes', { offline: true });
    expect(remote.rt.agent.opts.tools.some((t) => t.name === 'image')).toBe(false);
    await remote.rt.close();
    writeConfig({
      providers: {
        fake,
        sd: { kind: 'openai-compatible', baseURL: 'http://localhost:7860/v1', model: 'sd' },
      },
      image: { profile: 'sd', model: 'sd-turbo' },
    });
    const local = make([], 'yes', { offline: true });
    expect(local.rt.agent.opts.tools.some((t) => t.name === 'image')).toBe(true);
    await local.rt.close();
  });

  test('a provider that cannot make images is a notice, not a crash', async () => {
    writeConfig({ image: { profile: 'claude', model: 'x' } });
    const notices: string[] = [];
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      languageModel: mockModel([]),
      ask: async () => 'no',
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    expect(rt.agent.opts.tools.some((t) => t.name === 'image')).toBe(false);
    expect(notices).toEqual([
      'The image tool is off: Anthropic models do not generate images. Point "image.profile" at an openai or openai-compatible profile.',
    ]);
    await rt.close();
  });
});
