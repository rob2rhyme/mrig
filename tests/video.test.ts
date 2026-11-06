import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockVideoModelV4 } from 'ai/test';
import { loadConfig, type VideoConfig } from '../src/config.ts';
import { Runtime } from '../src/runtime.ts';
import { createVideoTool, overBudget, videoCost } from '../src/tools/video.ts';
import { runCommand } from '../src/ui/commands.ts';
import { ctx, mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The first bytes of an MP4 ("ftyp" box), enough to stand in for a clip. */
const MP4 = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0,
]);
const response = { timestamp: new Date(0), modelId: 'mock-video', headers: undefined };

type Final =
  | {
      status: 'completed';
      video: { type: 'binary'; data: Uint8Array } | { type: 'url'; url: string };
    }
  | { status: 'error'; error: string };

/** A mock job: `pending` status checks, then the final state (or pending forever). */
function mockVideo(opts: { pending?: number; final?: Final; startError?: string } = {}) {
  const started: Array<{ prompt?: string; duration?: number; aspectRatio?: string }> = [];
  let checks = 0;
  const model = new MockVideoModelV4({
    modelId: 'mock-video',
    maxVideosPerCall: 1,
    doStart: async (o) => {
      if (opts.startError) throw new Error(opts.startError);
      started.push({ prompt: o.prompt, duration: o.duration, aspectRatio: o.aspectRatio });
      return { operation: { jobId: 'job-1' }, warnings: [], response };
    },
    doStatus: async () => {
      checks++;
      const final = opts.final ?? { status: 'completed', video: { type: 'binary', data: MP4 } };
      // pending: how many checks stay pending first; -1 means the job never finishes.
      if (opts.pending !== undefined && (opts.pending < 0 || checks <= opts.pending)) {
        return { status: 'pending' as const, response };
      }
      if (final.status === 'error')
        return { status: 'error' as const, error: final.error, response };
      const video =
        final.video.type === 'binary'
          ? { type: 'binary' as const, data: final.video.data, mediaType: 'video/mp4' }
          : { type: 'url' as const, url: final.video.url, mediaType: 'video/mp4' };
      return { status: 'completed' as const, videos: [video], warnings: [], response };
    },
  });
  return { model, started, checks: () => checks };
}

const CONFIG: VideoConfig = {
  model: 'mock-video',
  apiKeyEnv: 'AI_GATEWAY_API_KEY',
  duration: 5,
  aspectRatio: '16:9',
  pricePerSecond: 0.15,
  maxCostPerJob: 2,
  pollSeconds: 10,
  timeoutMinutes: 20,
  dir: 'videos',
};

/** A fake clock that only moves when the tool sleeps. */
function fakeTime(startMs = Date.parse('2026-11-06T09:15:00Z')) {
  let t = startMs;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe('video: cost and the per-job cap', () => {
  test('cost is seconds × price; over the cap is refused with the numbers', () => {
    expect(videoCost(CONFIG, 5)).toBeCloseTo(0.75, 10);
    expect(overBudget(CONFIG, 13)).toBeUndefined(); // $1.95 ≤ $2.00
    expect(overBudget(CONFIG, 14)).toBe(
      'This 14-second clip would cost ~$2.10, over the per-job cap of $2.00 (video.maxCostPerJob). Nothing was started. Ask for a shorter clip, or raise the cap in the config.',
    );
  });
});

describe('video: the tool', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('mrig-video-');
  });
  afterEach(() => t.cleanup());

  test('starts the job, polls until done, saves the clip and records the cost', async () => {
    const job = mockVideo({ pending: 2 });
    const time = fakeTime();
    const tool = createVideoTool({
      config: CONFIG,
      model: job.model,
      now: time.now,
      sleep: time.sleep,
    });
    expect(tool.readOnly).toBe(false);
    expect(tool.remote).toBe(true);
    expect(tool.summarize({ prompt: 'a fox runs through snow' })).toBe(
      'video "a fox runs through snow" (5 s, 16:9, ~$0.75; cap $2.00)',
    );
    const media: Array<[string, number, number | undefined]> = [];
    const out = await tool.execute(
      { prompt: 'a fox runs through snow' },
      ctx(t.dir, { recordMedia: (k, n, usd) => media.push([k, n, usd]) }),
    );
    expect(job.started).toEqual([
      { prompt: 'a fox runs through snow', duration: 5, aspectRatio: '16:9' },
    ]);
    expect(job.checks()).toBe(3); // pending, pending, completed
    expect(time.waits).toEqual([10_000, 10_000]);
    expect(out).toBe(
      'Saved videos/20261106-091520-a-fox-runs-through-snow.mp4 (mock-video, 5 s, ~$0.75, the job took 20s)',
    );
    expect(
      readFileSync(join(t.dir, 'videos', '20261106-091520-a-fox-runs-through-snow.mp4')),
    ).toEqual(Buffer.from(MP4));
    expect(media).toEqual([['video', 1, expect.closeTo(0.75, 10)]]);
  });

  test('an over-budget job never starts', async () => {
    const job = mockVideo();
    const tool = createVideoTool({ config: CONFIG, model: job.model, ...fakeTime() });
    expect(tool.summarize({ prompt: 'epic', duration: 30 })).toBe(
      'video "epic" (30 s, 16:9, ~$4.50; cap $2.00, over the cap)',
    );
    await expect(tool.execute({ prompt: 'epic', duration: 30 }, ctx(t.dir))).rejects.toThrow(
      /would cost ~\$4\.50, over the per-job cap of \$2\.00 .* Nothing was started/,
    );
    expect(job.started).toEqual([]);
    expect(existsSync(join(t.dir, 'videos'))).toBe(false);
  });

  test('a clip delivered as a URL is downloaded', async () => {
    const job = mockVideo({
      final: { status: 'completed', video: { type: 'url', url: 'https://cdn.example/clip.mp4' } },
    });
    const fetched: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response(MP4, { status: 200 });
    }) as typeof fetch;
    const tool = createVideoTool({
      config: CONFIG,
      model: job.model,
      fetch: fakeFetch,
      ...fakeTime(),
    });
    const out = await tool.execute({ prompt: 'clouds', path: 'clips/sky.mp4' }, ctx(t.dir));
    expect(fetched).toEqual(['https://cdn.example/clip.mp4']);
    expect(out).toStartWith('Saved clips/sky.mp4 ');
    expect(readFileSync(join(t.dir, 'clips', 'sky.mp4'))).toEqual(Buffer.from(MP4));
  });

  test('a failed job, a start error and a failed download are tool errors; nothing is billed', async () => {
    const media: unknown[] = [];
    const c = () => ctx(t.dir, { recordMedia: (...a) => media.push(a) });
    const failed = createVideoTool({
      config: CONFIG,
      model: mockVideo({ final: { status: 'error', error: 'content policy' } }).model,
      ...fakeTime(),
    });
    await expect(failed.execute({ prompt: 'x' }, c())).rejects.toThrow(
      'The video job failed: content policy',
    );
    const noStart = createVideoTool({
      config: CONFIG,
      model: mockVideo({ startError: 'quota exceeded' }).model,
      ...fakeTime(),
    });
    await expect(noStart.execute({ prompt: 'x' }, c())).rejects.toThrow(
      'Could not start the video job: quota exceeded',
    );
    const badUrl = createVideoTool({
      config: CONFIG,
      model: mockVideo({
        final: { status: 'completed', video: { type: 'url', url: 'https://cdn.example/x' } },
      }).model,
      fetch: (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch,
      ...fakeTime(),
    });
    await expect(badUrl.execute({ prompt: 'x' }, c())).rejects.toThrow(
      'downloading it failed: HTTP 404',
    );
    expect(media).toEqual([]);
  });

  test('a job that never finishes stops at the timeout and says the provider may still bill', async () => {
    const job = mockVideo({ pending: -1 });
    const time = fakeTime();
    const tool = createVideoTool({
      config: { ...CONFIG, timeoutMinutes: 1 },
      model: job.model,
      now: time.now,
      sleep: time.sleep,
    });
    await expect(tool.execute({ prompt: 'slow' }, ctx(t.dir))).rejects.toThrow(
      'The video job is still running after 1 minutes, so mrig stopped waiting. The provider may still finish it, and bill for it.',
    );
    // Checks at 0, 10, … 60 s: six waits, then the check at 60 s gives up.
    expect(time.waits).toEqual(Array(6).fill(10_000));
  });

  test('Ctrl+C while waiting stops the wait', async () => {
    const ac = new AbortController();
    const job = mockVideo({ pending: -1 });
    const tool = createVideoTool({
      config: CONFIG,
      model: job.model,
      now: () => 0,
      sleep: async () => {
        ac.abort();
        throw new Error('aborted');
      },
    });
    await expect(tool.execute({ prompt: 'x' }, ctx(t.dir, { signal: ac.signal }))).rejects.toThrow(
      /^Stopped\./,
    );
  });
});

describe('video: config, permissions and the runtime', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  const prevKey = process.env.AI_GATEWAY_API_KEY;
  const local = {
    kind: 'openai-compatible',
    baseURL: 'http://localhost:8000/v1',
    model: 'chat',
    pricing: { input: 0, output: 0 },
  };
  const VIDEO = { model: 'google/veo-3.1-fast-generate-001', pricePerSecond: 0.15 };
  const writeConfig = (extra: Record<string, unknown>) =>
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ providers: { local }, ...extra }),
    );
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
    delete process.env.AI_GATEWAY_API_KEY;
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
    if (prevKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = prevKey;
  });

  test('config: defaults, validation, the required price; a project cannot set it', () => {
    writeConfig({ video: VIDEO });
    expect(loadConfig({ cwd: project.dir, env: {} }).video).toEqual({
      model: 'google/veo-3.1-fast-generate-001',
      apiKeyEnv: 'AI_GATEWAY_API_KEY',
      duration: 5,
      pricePerSecond: 0.15,
      maxCostPerJob: 2,
      pollSeconds: 10,
      timeoutMinutes: 20,
      dir: 'videos',
    });
    for (const [bad, message] of [
      [
        { video: { model: 'm' } },
        /"video.pricePerSecond" is required: the per-job cost cap needs it/,
      ],
      [
        { video: { ...VIDEO, maxCostPerJob: 0 } },
        /"video.maxCostPerJob" must be a positive number/,
      ],
      [{ video: { ...VIDEO, aspectRatio: 'wide' } }, /Invalid "video.aspectRatio"/],
      [{ video: { ...VIDEO, resolution: '720p' } }, /Invalid "video.resolution"/],
    ] as const) {
      writeConfig(bad);
      expect(() => loadConfig({ cwd: project.dir, env: {} })).toThrow(message);
    }
    writeConfig({});
    mkdirSync(join(project.dir, '.mrig'));
    writeFileSync(join(project.dir, '.mrig', 'config.json'), JSON.stringify({ video: VIDEO }));
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.video).toBeUndefined();
    expect(cfg.projectIgnored).toEqual(['video.model', 'video.pricePerSecond']);
  });

  test('no gateway key: a notice, no tool', async () => {
    writeConfig({ video: VIDEO });
    const notices: string[] = [];
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'local',
      languageModel: mockModel([]),
      ask: async () => 'no',
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    expect(rt.agent.opts.tools.some((t) => t.name === 'video')).toBe(false);
    expect(notices).toEqual([
      'The video tool is off: No key for the AI Gateway. Set AI_GATEWAY_API_KEY, or "video.apiKeyEnv" to the variable that holds it.',
    ]);
    await rt.close();
  });

  test('a key makes the tool; offline mode drops it', async () => {
    writeConfig({ video: VIDEO });
    process.env.AI_GATEWAY_API_KEY = 'test-key';
    const online = new Runtime({
      cwd: project.dir,
      provider: 'local',
      languageModel: mockModel([]),
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    expect(online.agent.opts.tools.some((t) => t.name === 'video')).toBe(true);
    await online.close();
    const offline = new Runtime({
      cwd: project.dir,
      provider: 'local',
      offline: true,
      languageModel: mockModel([]),
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    expect(offline.agent.opts.tools.some((t) => t.name === 'video')).toBe(false);
    await offline.close();
  });

  test('it asks with the price and cap; a denial starts nothing; video:* skips the prompt; /cost lists it', async () => {
    writeConfig({ video: { ...VIDEO, pollSeconds: 0.001 } });
    const run = async (allow: string[], answer: 'yes' | 'no') => {
      writeConfig({ video: { ...VIDEO, pollSeconds: 0.001 }, permissions: { allow } });
      const asked: string[] = [];
      const job = mockVideo({ pending: 1 });
      const rt = new Runtime({
        cwd: project.dir,
        provider: 'local',
        languageModel: mockModel([
          toolTurn('video', '{"prompt":"a fox","duration":4}'),
          textTurn('ok'),
        ]),
        videoModel: job.model,
        ask: async (r) => {
          asked.push(r.summary);
          return answer;
        },
        events: { onText: () => {} },
      });
      await rt.agent.run('make a clip');
      return { rt, asked, job };
    };
    const denied = await run([], 'no');
    expect(denied.asked).toEqual(['video "a fox" (4 s, ~$0.60; cap $2.00)']);
    expect(denied.job.started).toEqual([]);
    await denied.rt.close();

    const allowed = await run(['video:*'], 'no');
    expect(allowed.asked).toEqual([]);
    expect(allowed.job.started).toHaveLength(1);
    const out: string[] = [];
    await runCommand(allowed.rt, '/cost', {
      write: (s) => out.push(plain(s)),
      busy: (r) => r(new AbortController().signal),
    });
    expect(out.join('')).toContain('videos: 1 · ~$0.6000');
    await allowed.rt.close();
  });
});
