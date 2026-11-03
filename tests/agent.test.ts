import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Agent, type AgentEvents, repairJson } from '../src/agent.ts';
import type { CacheTtl, ProviderProfile } from '../src/config.ts';
import { PermissionManager } from '../src/permissions.ts';
import { DEFAULT_TOOLS } from '../src/tools/index.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

function makeAgent(
  turns: Parameters<typeof mockModel>[0],
  cwd: string,
  opts: {
    yolo?: boolean;
    answer?: 'yes' | 'no' | 'always';
    events?: Partial<AgentEvents>;
    profile?: ProviderProfile;
    cacheTtl?: CacheTtl;
  } = {},
) {
  const text: string[] = [];
  const toolLog: string[] = [];
  const notices: string[] = [];
  const model = mockModel(turns);
  const agent = new Agent({
    model,
    modelLabel: 'mock/mock',
    profile: opts.profile ?? { kind: 'openai-compatible', model: 'mock', baseURL: 'http://x' },
    cacheTtl: opts.cacheTtl,
    tools: DEFAULT_TOOLS,
    permissions: new PermissionManager({
      yolo: opts.yolo ?? true,
      allow: [],
      cwd,
      ask: async () => opts.answer ?? 'no',
    }),
    cwd,
    systemPrompt: 'test',
    maxSteps: 5,
    maxToolOutputChars: 10_000,
    events: {
      onText: (d) => text.push(d),
      onToolStart: (c) => toolLog.push(`start:${c.name}`),
      onToolEnd: (c, o) => toolLog.push(`end:${c.name}:${o.status}`),
      onNotice: (m) => notices.push(m),
      ...opts.events,
    },
  });
  return { agent, model, text, toolLog, notices };
}

const CLAUDE: ProviderProfile = { kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'test' };
const ephemeral = (ttl: CacheTtl) => ({ anthropic: { cacheControl: { type: 'ephemeral', ttl } } });

describe('Agent loop', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    t = tempDir();
    await Bun.write(join(t.dir, 'notes.txt'), 'hello from notes\n');
  });
  afterEach(() => t.cleanup());

  test('tool call → execute → result fed back → final answer', async () => {
    const { agent, text, toolLog } = makeAgent(
      [toolTurn('read', '{"path":"notes.txt"}'), textTurn('The file says hello.')],
      t.dir,
    );
    const result = await agent.run('what does notes.txt say?');
    expect(result.stop).toBe('done');
    expect(result.steps).toBe(2);
    expect(text.join('')).toBe('The file says hello.');
    expect(toolLog).toEqual(['start:read', 'end:read:ok']);

    // Transcript: user, assistant(tool-call), tool(result), assistant(text)
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolMsg = agent.messages[2];
    if (toolMsg?.role !== 'tool') throw new Error('expected tool message');
    const part = toolMsg.content[0];
    expect(part?.type).toBe('tool-result');
    if (part?.type === 'tool-result') {
      expect(part.toolCallId).toBe('call-1');
      expect(part.output.type).toBe('text');
      if (part.output.type === 'text') expect(part.output.value).toContain('1\thello from notes');
    }
    expect(agent.usage.requests).toBe(2);
    expect(agent.usage.inputTokens).toBe(20);
    expect(agent.usage.outputTokens).toBe(10);
    expect(agent.cost()).toBe(0);
  });

  test('denied permission returns an error-text result and the model is told', async () => {
    const { agent, toolLog } = makeAgent(
      [
        toolTurn('write', '{"path":"out.txt","content":"x"}'),
        textTurn('Okay, I will not write it.'),
      ],
      t.dir,
      { yolo: false, answer: 'no' },
    );
    const result = await agent.run('write out.txt');
    expect(result.stop).toBe('done');
    expect(toolLog).toEqual(['start:write', 'end:write:denied']);
    expect(await Bun.file(join(t.dir, 'out.txt')).exists()).toBe(false);
    const toolMsg = agent.messages[2];
    if (toolMsg?.role !== 'tool') throw new Error('expected tool message');
    const part = toolMsg.content[0];
    if (part?.type === 'tool-result') {
      expect(part.output.type).toBe('error-text');
      if (part.output.type === 'error-text') expect(part.output.value).toMatch(/denied/);
    }
  });

  test('invalid tool input becomes an error-text result, not a crash', async () => {
    const { agent, toolLog } = makeAgent(
      [toolTurn('read', '{"nope":1}'), textTurn('Sorry, retrying with the right arguments.')],
      t.dir,
    );
    const result = await agent.run('read something');
    expect(result.stop).toBe('done');
    expect(result.steps).toBe(2); // the model got a second turn to correct itself
    expect(toolLog).toEqual([]); // rejected before onToolStart
    const toolMsg = agent.messages[2];
    if (toolMsg?.role !== 'tool') throw new Error('expected tool message');
    const part = toolMsg.content[0];
    if (part?.type === 'tool-result' && part.output.type === 'error-text') {
      expect(part.output.value).toMatch(/Invalid input/);
    } else throw new Error('expected error-text');
  });

  test('unknown tool name is reported back to the model and the run continues', async () => {
    const { agent, text, notices } = makeAgent(
      [toolTurn('teleport', '{}'), textTurn('ok, no teleporting')],
      t.dir,
    );
    const result = await agent.run('go');
    expect(result.stop).toBe('done');
    expect(result.steps).toBe(2);
    expect(text.join('')).toBe('ok, no teleporting');
    expect(notices[0]).toMatch(/invalid tool call \(teleport\)/);
    const toolMsg = agent.messages[2];
    if (toolMsg?.role !== 'tool') throw new Error('expected tool message');
    const part = toolMsg.content[0];
    if (part?.type === 'tool-result' && part.output.type === 'error-text') {
      expect(part.output.value).toMatch(/teleport/);
    } else throw new Error('expected error-text');
  });

  test('stops at maxSteps with a notice', async () => {
    const turns = Array.from({ length: 6 }, (_, i) =>
      toolTurn('read', '{"path":"notes.txt"}', `c${i}`),
    );
    const { agent, notices } = makeAgent(turns, t.dir);
    const result = await agent.run('loop forever');
    expect(result.stop).toBe('max-steps');
    expect(result.steps).toBe(5);
    expect(notices[0]).toMatch(/Stopped after 5 steps/);
  });

  test('abort signal stops the run', async () => {
    const ac = new AbortController();
    const { agent } = makeAgent(
      [toolTurn('read', '{"path":"notes.txt"}'), textTurn('done')],
      t.dir,
      {
        events: {
          onToolStart: () => ac.abort(),
        },
      },
    );
    const result = await agent.run('read it', ac.signal);
    expect(result.stop).toBe('aborted');
  });

  test('clear resets transcript and usage', async () => {
    const { agent } = makeAgent([textTurn('hi')], t.dir);
    await agent.run('hello');
    expect(agent.messages.length).toBe(2);
    agent.clear();
    expect(agent.messages.length).toBe(0);
    expect(agent.usage.requests).toBe(0);
  });
});

describe('prompt caching (L0)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    t = tempDir();
    await Bun.write(join(t.dir, 'notes.txt'), 'hello\n');
  });
  afterEach(() => t.cleanup());

  test('anthropic: request-level automatic caching + system breakpoint, 5m by default', async () => {
    const { agent, model } = makeAgent([textTurn('hi')], t.dir, { profile: CLAUDE });
    await agent.run('hello');
    const call = model.doStreamCalls[0];
    if (!call) throw new Error('model was not called');
    expect(call.providerOptions).toEqual(ephemeral('5m'));
    const system = call.prompt[0];
    expect(system?.role).toBe('system');
    expect(system?.providerOptions).toEqual(ephemeral('5m'));
    // Only one explicit breakpoint: the user turn carries none.
    const user = call.prompt[1];
    expect(user?.role).toBe('user');
    expect(user?.providerOptions).toBeUndefined();
  });

  test('cacheTtl 1h is forwarded on every step, including after tool calls', async () => {
    const { agent, model } = makeAgent(
      [toolTurn('read', '{"path":"notes.txt"}'), textTurn('done')],
      t.dir,
      { profile: CLAUDE, cacheTtl: '1h' },
    );
    await agent.run('read notes');
    expect(model.doStreamCalls.length).toBe(2);
    for (const call of model.doStreamCalls) {
      expect(call.providerOptions).toEqual(ephemeral('1h'));
      expect(call.prompt[0]?.providerOptions).toEqual(ephemeral('1h'));
    }
  });

  test('local and openai profiles get no cache options at all', async () => {
    for (const profile of [
      { kind: 'openai-compatible', model: 'qwen', baseURL: 'http://x' } as ProviderProfile,
      { kind: 'openai', model: 'gpt-x', apiKey: 'k' } as ProviderProfile,
    ]) {
      const { agent, model } = makeAgent([textTurn('hi')], t.dir, { profile, cacheTtl: '1h' });
      await agent.run('hello');
      const call = model.doStreamCalls[0];
      expect(call?.providerOptions?.anthropic).toBeUndefined();
      expect(call?.prompt[0]?.role).toBe('system');
      expect(call?.prompt[0]?.providerOptions).toBeUndefined();
    }
  });

  test('usage tracks cache writes and reads; cost applies the write premium', async () => {
    // Step 1 writes an 800-token prefix, step 2 reads it back. claude-sonnet-5: $2 in / $10 out.
    const { agent } = makeAgent(
      [
        toolTurn('read', '{"path":"notes.txt"}', 'c1', {
          input: 1000,
          output: 10,
          cacheWrite: 800,
        }),
        textTurn('done', { input: 1000, output: 10, cacheRead: 800 }),
      ],
      t.dir,
      { profile: CLAUDE },
    );
    await agent.run('read notes');
    expect(agent.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 800,
      requests: 2,
    });
    // 400 uncached × $2 + 800 read × $0.2 + 800 write × $2.5 (1.25×) + 20 out × $10 = $3,160 / 1M
    expect(agent.cost()).toBeCloseTo(0.00316, 8);
  });

  test('1h TTL doubles the write price', async () => {
    const { agent } = makeAgent(
      [textTurn('hi', { input: 1000, output: 0, cacheWrite: 1000 })],
      t.dir,
      { profile: CLAUDE, cacheTtl: '1h' },
    );
    await agent.run('hello');
    // 1000 write × $4 (2×) = $4,000 / 1M
    expect(agent.cost()).toBeCloseTo(0.004, 8);
  });
});

describe('repairJson', () => {
  test('fixes fences and trailing commas, rejects garbage', () => {
    expect(repairJson('```json\n{"a":1,}\n```')).toBe('{"a":1}');
    expect(repairJson('Sure! {"path": "x.ts", "limit": 5,} thanks')).toBe(
      '{"path": "x.ts", "limit": 5}',
    );
    expect(repairJson('not json at all')).toBeNull();
    expect(repairJson('{"unterminated": ')).toBeNull();
  });
});
