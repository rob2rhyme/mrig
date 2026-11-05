import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { type ModelMessage, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Agent, type CompactionOptions } from '../src/agent.ts';
import {
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  estimateMessagesTokens,
  preferSummaryOnly,
  pruneOldToolActivity,
  renderTranscript,
  tailStart,
  thresholdTokens,
  withSummary,
} from '../src/compaction.ts';
import { loadConfig, type ProviderProfile } from '../src/config.ts';
import { PermissionManager } from '../src/permissions.ts';
import { Runtime } from '../src/runtime.ts';
import { Session } from '../src/session.ts';
import { DEFAULT_TOOLS } from '../src/tools/index.ts';
import { tempDir, textTurn, toolTurn } from './helpers.ts';

// ---- helpers ----------------------------------------------------------------------------------

const generated = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  },
  warnings: [],
});

/** A model that streams scripted turns and answers summary requests (non-streaming) with `summary`. */
function scripted(turns: LanguageModelV4StreamPart[][], summary = 'SUMMARY: read notes.txt.') {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = turns[i] ?? textTurn('(no more scripted turns)');
      i++;
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async () => generated(summary),
  });
}

function summarizer(summary = 'SUMMARY from the separate summarizer.') {
  return new MockLanguageModelV4({ doGenerate: async () => generated(summary) });
}

const LOCAL = (contextWindow: number): ProviderProfile => ({
  kind: 'openai-compatible',
  model: 'local-test',
  baseURL: 'http://127.0.0.1:1/v1',
  contextWindow,
});
const FABLE = (contextWindow: number): ProviderProfile => ({
  kind: 'anthropic',
  model: 'claude-fable-5-1',
  apiKey: 'test',
  contextWindow,
});

function makeAgent(opts: {
  model: MockLanguageModelV4;
  profile: ProviderProfile;
  cwd: string;
  compaction?: CompactionOptions;
  maxSteps?: number;
  messages?: ModelMessage[];
}) {
  const notices: string[] = [];
  const agent = new Agent({
    model: opts.model,
    modelLabel: 'test',
    profile: opts.profile,
    tools: DEFAULT_TOOLS,
    permissions: new PermissionManager({
      yolo: true,
      allow: [],
      cwd: opts.cwd,
      ask: async () => 'no',
    }),
    cwd: opts.cwd,
    systemPrompt: 'You are a test agent.',
    maxSteps: opts.maxSteps ?? 40,
    maxToolOutputChars: 4000,
    compaction: opts.compaction,
    messages: opts.messages,
    events: { onText: () => {}, onNotice: (m) => notices.push(m) },
  });
  return { agent, notices };
}

/** Every tool result follows its call, every call has a result, and the user speaks first. */
function expectValidTranscript(messages: ModelMessage[]): void {
  expect(messages[0]?.role).toBe('user');
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type === 'tool-call') calls.add(p.toolCallId);
      if (p.type === 'tool-result') {
        expect(calls.has(p.toolCallId)).toBe(true);
        results.add(p.toolCallId);
      }
    }
  }
  for (const id of calls) expect(results.has(id)).toBe(true);
}

/** A transcript of `n` read calls and their results, as the agent would have built it. */
function readPairs(n: number, body = 'x'.repeat(1000)): ModelMessage[] {
  const out: ModelMessage[] = [{ role: 'user', content: 'read notes.txt many times' }];
  for (let i = 0; i < n; i++) {
    out.push({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: `thinking ${i}` },
        { type: 'tool-call', toolCallId: `p${i}`, toolName: 'read', input: { path: 'notes.txt' } },
      ],
    });
    out.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `p${i}`,
          toolName: 'read',
          output: { type: 'text', value: `${i}: ${body}` },
        },
      ],
    });
  }
  return out;
}

const NOTES = `${Array.from({ length: 30 }, (_, i) => `line ${i} of the notes file, padded to a typical width.`).join('\n')}\n`;
const readTurns = (n: number) =>
  Array.from({ length: n }, (_, i) => toolTurn('read', '{"path":"notes.txt"}', `c${i}`));

// ---- pure functions ---------------------------------------------------------------------------

describe('compaction: pure functions', () => {
  test('context window: profile, then detected, then a per-kind default', () => {
    expect(contextWindowFor(LOCAL(8192))).toBe(8192);
    expect(contextWindowFor({ ...LOCAL(1), contextWindow: undefined }, 65536)).toBe(65536);
    expect(contextWindowFor({ ...LOCAL(1), contextWindow: undefined })).toBe(
      DEFAULT_LOCAL_CONTEXT_WINDOW,
    );
    expect(contextWindowFor({ kind: 'openai', model: 'gpt-x' })).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(thresholdTokens(0.7, 10_000)).toBe(7000);
    expect(thresholdTokens(1, 10_000)).toBe(10_000);
    expect(thresholdTokens(90_000, 10_000)).toBe(90_000);
  });

  test('only Claude models with preserved thinking skip pruning', () => {
    expect(preferSummaryOnly(FABLE(1))).toBe(true);
    expect(preferSummaryOnly({ kind: 'anthropic', model: 'claude-opus-5-5' })).toBe(true);
    expect(preferSummaryOnly({ kind: 'anthropic', model: 'claude-sonnet-5' })).toBe(false);
    expect(preferSummaryOnly({ kind: 'anthropic', model: 'claude-opus-5' })).toBe(false);
    expect(preferSummaryOnly(LOCAL(1))).toBe(false);
  });

  test('the tail never starts with a tool result', () => {
    const m = readPairs(3); // user, (assistant, tool) × 3
    expect(tailStart(m, 4)).toBe(3); // last 4 starts at a tool result (index 2) → moved to 3
    expect(tailStart(m, 3)).toBe(5); // index 4 is a tool result → 5
    expect(m[tailStart(m, 4)]?.role).toBe('assistant');
    expect(tailStart(m, 0)).toBe(m.length);
    expect(tailStart(m, 100)).toBe(0);
  });

  test('the summary splice keeps roles alternating', () => {
    const user: ModelMessage = { role: 'user', content: 'u' };
    const assistant: ModelMessage = { role: 'assistant', content: 'a' };
    expect(withSummary('S', []).map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(withSummary('S', [user, assistant]).map((x) => x.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(withSummary('S', [assistant]).map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(withSummary('S', [])[0]?.content).toMatch(/^\[mrig\] Context was compacted/);
  });

  test('pruning drops old tool pairs and reasoning together, and keeps the recent ones', () => {
    const before = readPairs(10);
    const after = pruneOldToolActivity(before, 4);
    expectValidTranscript(after);
    expect(estimateMessagesTokens(after)).toBeLessThan(estimateMessagesTokens(before));
    const ids = after.flatMap((m) =>
      typeof m.content === 'string'
        ? []
        : m.content.flatMap((p) => (p.type === 'tool-call' ? [p.toolCallId] : [])),
    );
    expect(ids).toEqual(['p8', 'p9']); // the last 4 messages hold two pairs
    expect(after[0]).toEqual(before[0]); // the user message survives
    expect(JSON.stringify(after)).not.toContain('thinking 0');
  });

  test('the transcript for the summarizer drops reasoning and clips long output', () => {
    const text = renderTranscript(readPairs(2, 'y'.repeat(5000)), 100_000);
    expect(text).toContain('## user');
    expect(text).toContain('[tool call] read({"path":"notes.txt"})');
    expect(text).toContain('[tool result] read: 0: yyy');
    expect(text).toMatch(/\[\d+ more\]/);
    expect(text).not.toContain('thinking 0');
    expect(renderTranscript(readPairs(50), 2000).length).toBeLessThan(2500);
  });
});

// ---- the agent ---------------------------------------------------------------------------------

describe('compaction in the agent loop', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    t = tempDir();
    await Bun.write(join(t.dir, 'notes.txt'), NOTES);
  });
  afterEach(() => t.cleanup());

  const on = (over: Partial<CompactionOptions> = {}): CompactionOptions => ({
    enabled: true,
    threshold: 0.7,
    keep: 4,
    ...over,
  });

  test('below the threshold nothing happens', async () => {
    const model = scripted([...readTurns(2), textTurn('done')]);
    const { agent, notices } = makeAgent({
      model,
      profile: LOCAL(100_000),
      cwd: t.dir,
      compaction: on(),
    });
    await agent.run('read it twice');
    expect(model.doGenerateCalls.length).toBe(0);
    expect(agent.messages.length).toBe(6);
    expect(notices.some((n) => n.includes('Context'))).toBe(false);
    expect(agent.contextReport()).toMatchObject({ window: 100_000, threshold: 70_000 });
  });

  test('tier (a): pruning old tool output is enough, so no summary is written', async () => {
    const model = scripted([...readTurns(12), textTurn('done')]);
    const { agent, notices } = makeAgent({
      model,
      profile: LOCAL(6000),
      cwd: t.dir,
      compaction: on(),
    });
    const result = await agent.run('read it a dozen times');
    expect(result.stop).toBe('done');
    expect(notices.some((n) => n.includes('dropped old tool output'))).toBe(true);
    expect(model.doGenerateCalls.length).toBe(0);
    expectValidTranscript(agent.messages);
    expect(agent.messages[0]).toEqual({ role: 'user', content: 'read it a dozen times' });
    expect(agent.takeHistoryEdited()).toBe(true);
    expect(agent.takeHistoryEdited()).toBe(false); // reported once
  });

  test('a cramped window warns once that compaction will run often', async () => {
    const model = scripted([...readTurns(6), textTurn('done')]);
    const { agent, notices } = makeAgent({
      model,
      profile: FABLE(3000),
      cwd: t.dir,
      compaction: on(),
      messages: readPairs(12, 'z'.repeat(1200)),
    });
    await agent.run('keep reading');
    expect(notices.filter((n) => n.includes('summarized')).length).toBeGreaterThan(1);
    const warnings = notices.filter((n) => n.startsWith('Little room left'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('num_ctx');
  });

  test('a roomy window gets no low-headroom warning', async () => {
    const model = scripted([textTurn('done')]);
    const { notices } = await (async () => {
      const made = makeAgent({
        model,
        profile: FABLE(40_000),
        cwd: t.dir,
        compaction: on({ threshold: 0.2 }),
        messages: readPairs(40, 'z'.repeat(1200)),
      });
      await made.agent.run('go on');
      return made;
    })();
    expect(notices.some((n) => n.includes('summarized'))).toBe(true);
    expect(notices.some((n) => n.startsWith('Little room left'))).toBe(false);
  });

  test('tier (b) for Fable 5.1: straight to a summary, with the recent tail kept verbatim', async () => {
    const history = readPairs(12, 'z'.repeat(1200));
    const model = scripted([textTurn('done')], 'SUMMARY: twelve reads of notes.txt.');
    const { agent, notices } = makeAgent({
      model,
      profile: FABLE(6000),
      cwd: t.dir,
      compaction: on(),
      messages: [...history],
    });
    await agent.run('and now?');
    expect(model.doGenerateCalls.length).toBe(1);
    expect(notices.some((n) => n.includes('dropped old tool output'))).toBe(false);
    expect(notices.some((n) => /summarized \d+ earlier messages/.test(n))).toBe(true);
    const all = [...history, { role: 'user', content: 'and now?' } as ModelMessage];
    const tail = all.slice(tailStart(all, 4));
    expect(agent.messages[0]?.content).toContain('SUMMARY: twelve reads of notes.txt.');
    expect(agent.messages.slice(1, 1 + tail.length)).toEqual(tail); // verbatim, then the reply
    expect(agent.messages.at(-1)?.role).toBe('assistant');
    expectValidTranscript(agent.messages);
    // The summarizer saw text, not the raw messages, and no reasoning.
    const sent = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(sent).toContain('Conversation transcript to summarize');
    expect(sent).not.toContain('thinking 0');
    expect(model.doGenerateCalls[0]?.providerOptions?.anthropic).toBeUndefined(); // no cache write
  });

  test('a separate summarizer does the summary and is left out of the bill', async () => {
    const main = scripted([textTurn('done')]);
    const small = summarizer();
    const { agent } = makeAgent({
      model: main,
      profile: LOCAL(6000),
      cwd: t.dir,
      compaction: on({ model: small, profile: LOCAL(32_768), threshold: 0.3 }),
      messages: readPairs(14, 'z'.repeat(1200)),
    });
    await agent.run('go on');
    expect(main.doGenerateCalls.length).toBe(0);
    expect(small.doGenerateCalls.length).toBe(1);
    expect(agent.messages[0]?.content).toContain('separate summarizer');
    expect(agent.usage.requests).toBe(1); // only the main model's streamed step
  });

  test('a failed summary is reported and the run carries on', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({ chunks: textTurn('still here') }),
      }),
      doGenerate: async () => {
        throw new Error('summarizer offline');
      },
    });
    const { agent, notices } = makeAgent({
      model,
      profile: FABLE(6000),
      cwd: t.dir,
      compaction: on(),
      messages: readPairs(12, 'z'.repeat(1200)),
    });
    const result = await agent.run('continue');
    expect(result.stop).toBe('done');
    expect(notices.some((n) => n.includes('Compaction failed (summarizer offline)'))).toBe(true);
  });

  test('the provider-reported prompt size counts when it is larger than the estimate', async () => {
    const model = scripted([
      toolTurn('read', '{"path":"notes.txt"}', 'c1', { input: 50_000, output: 5 }),
      textTurn('done'),
    ]);
    const { agent, notices } = makeAgent({
      model,
      profile: LOCAL(60_000),
      cwd: t.dir,
      compaction: on(),
    });
    await agent.run('read it');
    // 50k reported plus the result read since is over 70% of 60k, so the check fired before step 2.
    // The transcript is too short to shrink, so the user is told once, not on every step.
    const fired = notices.filter((n) => /~50,\d{3} of 60,000 tokens/.test(n));
    expect(fired.length).toBe(1);
    expect(fired[0]).toContain('nothing older to summarize');
  });

  test('manual /compact still replaces everything with the summary', async () => {
    const model = scripted([textTurn('hi')], 'SUMMARY: said hi.');
    const { agent } = makeAgent({ model, profile: LOCAL(100_000), cwd: t.dir });
    expect(await agent.compact()).toBe('Nothing to compact.');
    await agent.run('hello');
    expect(await agent.compact()).toBe('SUMMARY: said hi.');
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(agent.contextReport().threshold).toBeUndefined(); // no compaction options: off
  });

  test('acceptance: a 100-step local session never overflows, and round-trips through Session', async () => {
    const home = tempDir('mrig-home-');
    const prevHome = process.env.MRIG_HOME;
    process.env.MRIG_HOME = home.dir;
    try {
      const WINDOW = 4000;
      const model = scripted([...readTurns(99), textTurn('done after 99 reads')]);
      const { agent, notices } = makeAgent({
        model,
        profile: LOCAL(WINDOW),
        cwd: t.dir,
        compaction: on(),
        maxSteps: 100,
      });
      const result = await agent.run('read notes.txt 99 times');
      expect(result).toMatchObject({ stop: 'done', steps: 100 });
      expect(model.doStreamCalls.length).toBe(100);

      // What was actually sent each step, measured independently of mrig's estimator.
      const sizes = model.doStreamCalls.map((c) =>
        Math.ceil(JSON.stringify({ prompt: c.prompt, tools: c.tools }).length / 4),
      );
      expect(Math.max(...sizes)).toBeLessThan(WINDOW);
      expect(notices.filter((n) => n.startsWith('Context reached')).length).toBeGreaterThan(5);
      expect(notices.some((n) => n.includes('summarized'))).toBe(true);
      // Never repeated, however often compaction runs.
      expect(notices.filter((n) => n.startsWith('Little room left')).length).toBeLessThanOrEqual(1);
      expectValidTranscript(agent.messages);

      const session = Session.create({ cwd: t.dir, provider: 'local', model: 'local-test' });
      session.sync(agent.messages, {
        rewrite: agent.takeHistoryEdited(),
        titleHint: agent.firstPrompt,
      });
      const loaded = Session.load(session.meta.id);
      expect(loaded.messages).toEqual(agent.messages);
      // The first prompt was summarized away, but the session still gets its title.
      expect(loaded.meta.title).toBe('read notes.txt 99 times');
    } finally {
      home.cleanup();
      if (prevHome === undefined) delete process.env.MRIG_HOME;
      else process.env.MRIG_HOME = prevHome;
    }
  });
});

// ---- config, session, runtime -----------------------------------------------------------------

describe('compaction: config, session and runtime', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const writeConfig = (obj: unknown) =>
    Bun.write(join(home.dir, 'config.json'), JSON.stringify(obj));

  test('defaults, layering, and validation', async () => {
    expect(loadConfig({ cwd: project.dir, env: {} }).compaction).toEqual({
      enabled: true,
      threshold: 0.7,
      keep: 4,
    });
    await writeConfig({ compaction: { threshold: 90_000, compactModel: 'ollama' } });
    mkdirSync(join(project.dir, '.mrig'));
    await Bun.write(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ compaction: { keep: 6 } }),
    );
    expect(loadConfig({ cwd: project.dir, env: {} }).compaction).toEqual({
      enabled: true,
      threshold: 90_000,
      keep: 6,
      compactModel: 'ollama',
    });
    for (const [bad, message] of [
      [{ threshold: 0 }, /compaction.threshold/],
      [{ threshold: 'high' }, /compaction.threshold/],
      [{ keep: -1 }, /compaction.keep/],
      [{ keep: 2.5 }, /compaction.keep/],
      [{ enabled: 'yes' }, /compaction.enabled/],
      [{ compactModel: 3 }, /compactModel/],
    ] as const) {
      await writeConfig({ compaction: bad });
      expect(() => loadConfig({ cwd: '/nonexistent', env: {} })).toThrow(message);
    }
  });

  test('a session rewrites its file when history was edited in place', () => {
    const s = Session.create({ cwd: '/p', provider: 'p', model: 'm' });
    const a: ModelMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ];
    s.sync(a);
    const edited: ModelMessage[] = [
      { role: 'user', content: 'ONE (edited)' },
      { role: 'assistant', content: 'two' },
    ];
    s.sync(edited); // same length, no flag: the file still holds the old first message
    expect(Session.load(s.meta.id).messages[0]?.content).toBe('one');
    s.sync(edited, { rewrite: true });
    expect(Session.load(s.meta.id).messages).toEqual(edited);
  });

  test('runtime: compactModel is resolved from the profiles, and a typo is a clear error', async () => {
    const profiles = {
      main: { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'big' },
      small: { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'small-1' },
    };
    await writeConfig({ providers: profiles, compaction: { compactModel: 'small' } });
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'main',
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    expect(rt.agent.opts.compaction?.profile?.model).toBe('small-1');
    expect(rt.agent.opts.compaction?.model).toBeDefined();
    await writeConfig({ providers: profiles, compaction: { compactModel: 'nope' } });
    expect(
      () =>
        new Runtime({
          cwd: project.dir,
          provider: 'main',
          ask: async () => 'no',
          events: { onText: () => {} },
        }),
    ).toThrow(/compaction.compactModel.*Unknown provider "nope"/);
  });

  test("runtime: Ollama's reported context length becomes the window when the profile sets none", async () => {
    await writeConfig({
      providers: {
        ollama: {
          kind: 'openai-compatible',
          name: 'ollama',
          baseURL: 'http://localhost:11434/v1',
          model: 'qwen',
        },
      },
    });
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'ollama',
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    expect(rt.agent.contextWindow()).toBe(DEFAULT_LOCAL_CONTEXT_WINDOW);
    const fakeFetch = (async () =>
      Response.json({ parameters: 'num_ctx 65536' })) as unknown as typeof fetch;
    const check = await rt.checkContext({ fetch: fakeFetch });
    expect(check.contextLength).toBe(65536);
    expect(rt.agent.contextWindow()).toBe(65536);
  });
});
