import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Agent, type AgentEvents, emptyStats, isEmptyInput, repairJson } from '../src/agent.ts';
import { PermissionManager } from '../src/permissions.ts';
import { DEFAULT_TOOLS, toolsForMode } from '../src/tools/index.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

function makeAgent(
  turns: Parameters<typeof mockModel>[0],
  cwd: string,
  opts: { yolo?: boolean; answer?: 'yes' | 'no' | 'always'; events?: Partial<AgentEvents> } = {},
) {
  const text: string[] = [];
  const toolLog: string[] = [];
  const notices: string[] = [];
  const agent = new Agent({
    model: mockModel(turns),
    modelLabel: 'mock/mock',
    profile: { kind: 'openai-compatible', model: 'mock', baseURL: 'http://x' },
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
  return { agent, text, toolLog, notices };
}

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
    // Exactly one tool-result per call id: the SDK's own error result is dropped.
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
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
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
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

describe('local-model hardening (L2)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    t = tempDir();
    await Bun.write(join(t.dir, 'notes.txt'), 'hello from notes\n');
  });
  afterEach(() => t.cleanup());

  test('isEmptyInput', () => {
    for (const v of [undefined, null, '', {}]) expect(isEmptyInput(v)).toBe(true);
    for (const v of [{ path: 'x' }, 'x', 0, [1]]) expect(isEmptyInput(v)).toBe(false);
  });

  test('empty arguments: one guided retry listing the fields, then the call succeeds', async () => {
    const { agent, text, notices, toolLog } = makeAgent(
      [
        toolTurn('read', '{}', 'c1'),
        toolTurn('read', '{"path":"notes.txt"}', 'c2'),
        textTurn('It says hello.'),
      ],
      t.dir,
    );
    const result = await agent.run('read notes');
    expect(result.stop).toBe('done');
    expect(result.steps).toBe(3);
    expect(text.join('')).toBe('It says hello.');
    expect(notices).toContain('Model called read with no arguments; asked it to retry.');
    expect(toolLog).toEqual(['start:read', 'end:read:ok']); // only the real call reached the tool
    const roles = agent.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    const retry = agent.messages[2];
    if (retry?.role !== 'tool' || retry.content[0]?.type !== 'tool-result')
      throw new Error('expected tool result');
    const out = retry.content[0].output;
    expect(out.type).toBe('error-text');
    if (out.type === 'error-text') {
      expect(out.value).toContain('had no arguments');
      expect(out.value).toContain('path (string, required)');
      expect(out.value).toContain('offset (number, optional)');
    }
    expect(retry.content.length).toBe(1); // no duplicate result from the SDK
  });

  test('a second empty call in a row gets the plain validation error, not another guide', async () => {
    const { agent, notices } = makeAgent(
      [toolTurn('read', '', 'c1'), toolTurn('read', '{}', 'c2'), textTurn('giving up')],
      t.dir,
    );
    await agent.run('read notes');
    expect(notices.filter((n) => n.includes('no arguments')).length).toBe(1);
    const second = agent.messages[4];
    if (second?.role !== 'tool' || second.content[0]?.type !== 'tool-result')
      throw new Error('expected tool result');
    const out = second.content[0].output;
    if (out.type === 'error-text') expect(out.value).toMatch(/^Invalid input: path/);
    else throw new Error('expected error-text');
  });

  test('minimal tool mode exposes bash only; setTools swaps the registry live', async () => {
    expect(toolsForMode('minimal').map((x) => x.name)).toEqual(['bash']);
    expect(toolsForMode('full')).toBe(DEFAULT_TOOLS);
    expect(toolsForMode()).toBe(DEFAULT_TOOLS);
    const { agent, text } = makeAgent(
      [toolTurn('read', '{"path":"notes.txt"}', 'c1'), textTurn('no read tool here')],
      t.dir,
    );
    agent.setTools(toolsForMode('minimal'));
    await agent.run('read notes');
    const toolMsg = agent.messages[2];
    if (toolMsg?.role !== 'tool' || toolMsg.content[0]?.type !== 'tool-result')
      throw new Error('expected tool result');
    const out = toolMsg.content[0].output;
    if (out.type === 'error-text') expect(out.value).toMatch(/Unknown tool "read"/);
    else throw new Error('expected error-text');
    expect(text.join('')).toBe('no read tool here');
    agent.setTools(DEFAULT_TOOLS);
    expect(agent.opts.tools.length).toBe(6);
  });
});

describe('agent stats (L3)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    t = tempDir();
    await Bun.write(join(t.dir, 'notes.txt'), 'hello from notes\n');
  });
  afterEach(() => t.cleanup());

  test('counts calls, invalid calls, repairs and the tools that ran', async () => {
    const fenced = '```json\n{"path":"notes.txt",}\n```';
    const { agent } = makeAgent(
      [
        toolTurn('read', '{"path":"notes.txt"}', 'c1'),
        toolTurn('read', '{"nope":1}', 'c2'),
        toolTurn('teleport', '{}', 'c3'),
        toolTurn('read', fenced, 'c4'),
        textTurn('done'),
      ],
      t.dir,
    );
    await agent.run('go');
    expect(agent.stats.toolCalls).toBe(4);
    expect(agent.stats.invalidCalls).toBe(2);
    expect(agent.stats.repairedCalls).toBe(1);
    expect(agent.stats.toolsUsed).toEqual({ read: 2 });
    agent.clear();
    expect(agent.stats).toEqual(emptyStats());
  });

  test('a denied call is counted as made but not as run', async () => {
    const { agent } = makeAgent(
      [toolTurn('write', '{"path":"x.txt","content":"x"}'), textTurn('ok')],
      t.dir,
      { yolo: false, answer: 'no' },
    );
    await agent.run('write it');
    expect(agent.stats.toolCalls).toBe(1);
    expect(agent.stats.invalidCalls).toBe(0);
    expect(agent.stats.toolsUsed).toEqual({});
  });

  test('records time waiting on the model from the SDK performance data', async () => {
    const slow = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: textTurn('hello there', { input: 10, output: 20 }),
          initialDelayInMs: 20,
          chunkDelayInMs: 20,
        }),
      }),
    });
    const { agent } = makeAgent([], t.dir);
    agent.opts.model = slow;
    await agent.run('hi');
    expect(agent.stats.responseMs).toBeGreaterThan(20);
    if (agent.stats.decodeMs > 0) expect(agent.stats.decodeTokens).toBe(20);
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
