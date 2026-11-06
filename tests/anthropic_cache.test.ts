/**
 * L0 contract test against the real @ai-sdk/anthropic provider, with the network replaced by
 * a fake fetch: the request body must carry request-level automatic caching plus exactly one
 * explicit breakpoint (the system block), and cache usage must flow back into Agent.usage.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Agent } from '../src/agent.ts';
import type { ProviderProfile } from '../src/config.ts';
import { PermissionManager } from '../src/permissions.ts';
import { DEFAULT_TOOLS } from '../src/tools/index.ts';
import { tempDir } from './helpers.ts';

const PROFILE: ProviderProfile = { kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'test' };

/** A minimal Anthropic SSE reply: one text block, with cache usage in the counters. */
function sseReply(
  usage: { input: number; cacheWrite: number; cacheRead: number },
  opts: { model?: string; thinkingSignature?: string } = {},
): string {
  const u = JSON.stringify({
    input_tokens: usage.input,
    output_tokens: 1,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
  });
  const model = opts.model ?? 'claude-sonnet-5';
  // Under the default display ("omitted") a thinking block arrives with empty text and a signature.
  const thinking: Array<[string, string]> = opts.thinkingSignature
    ? [
        [
          'content_block_start',
          '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
        ],
        [
          'content_block_delta',
          `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${opts.thinkingSignature}"}}`,
        ],
        ['content_block_stop', '{"type":"content_block_stop","index":0}'],
      ]
    : [];
  const text = thinking.length ? 1 : 0;
  const events: Array<[string, string]> = [
    [
      'message_start',
      `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":${u}}}`,
    ],
    ...thinking,
    [
      'content_block_start',
      `{"type":"content_block_start","index":${text},"content_block":{"type":"text","text":""}}`,
    ],
    [
      'content_block_delta',
      `{"type":"content_block_delta","index":${text},"delta":{"type":"text_delta","text":"ok"}}`,
    ],
    ['content_block_stop', `{"type":"content_block_stop","index":${text}}`],
    [
      'message_delta',
      `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":${u}}`,
    ],
    ['message_stop', '{"type":"message_stop"}'],
  ];
  return `${events.map(([e, d]) => `event: ${e}\ndata: ${d}`).join('\n\n')}\n\n`;
}

type Captured = { body: Record<string, unknown>; beta: string };

/** A real Anthropic provider whose fetch records each request and answers from `replies`. */
function fakeAnthropic(replies: string[], captured: Captured[]) {
  return createAnthropic({
    apiKey: 'test',
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        beta: new Headers(init?.headers).get('anthropic-beta') ?? '',
      });
      const body = replies.shift();
      if (!body) throw new Error('unexpected extra request');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  });
}

describe('Anthropic prompt caching over the wire (fake fetch, no network)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  test('request body: top-level cache_control + one system breakpoint; usage flows back', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const replies = [
      sseReply({ input: 10, cacheWrite: 800, cacheRead: 0 }),
      sseReply({ input: 10, cacheWrite: 0, cacheRead: 800 }),
    ];
    const anthropic = createAnthropic({
      apiKey: 'test',
      // Bun's `typeof fetch` also declares `preconnect`; the SDK only ever calls the function.
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const body = replies.shift();
        if (!body) throw new Error('unexpected extra request');
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as unknown as typeof fetch,
    });
    const agent = new Agent({
      model: anthropic(PROFILE.model),
      modelLabel: 'claude/claude-sonnet-5',
      profile: PROFILE,
      cacheTtl: '1h',
      tools: DEFAULT_TOOLS,
      permissions: new PermissionManager({
        yolo: true,
        allow: [],
        cwd: t.dir,
        ask: async () => 'no',
      }),
      cwd: t.dir,
      systemPrompt: 'SYS',
      maxSteps: 3,
      maxToolOutputChars: 10_000,
      events: { onText: () => {} },
    });

    await agent.run('first');
    await agent.run('second');
    expect(bodies.length).toBe(2);

    const ttl = { type: 'ephemeral', ttl: '1h' };
    for (const body of bodies) {
      expect(body.cache_control).toEqual(ttl);
      expect(body.system).toEqual([{ type: 'text', text: 'SYS', cache_control: ttl }]);
      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools.length).toBe(DEFAULT_TOOLS.length);
      for (const tool of tools) expect(tool.cache_control).toBeUndefined();
      expect(JSON.stringify(body.messages)).not.toContain('cache_control');
    }

    expect(agent.usage).toEqual({
      inputTokens: 1620, // (10 + 800) × 2: the provider total includes cache reads and writes
      outputTokens: 2,
      cacheReadTokens: 800,
      cacheWriteTokens: 800,
      requests: 2,
    });
    // 20 uncached × $2 + 800 read × $0.2 + 800 write × $4 (1h = 2×) + 2 out × $10 = $3,420 / 1M
    expect(agent.cost()).toBeCloseTo(0.00342, 8);
  });

  const agentFor = (
    profile: ProviderProfile,
    model: ReturnType<ReturnType<typeof fakeAnthropic>>,
  ) =>
    new Agent({
      model,
      modelLabel: `claude/${profile.model}`,
      profile,
      tools: DEFAULT_TOOLS,
      permissions: new PermissionManager({
        yolo: true,
        allow: [],
        cwd: t.dir,
        ask: async () => 'no',
      }),
      cwd: t.dir,
      systemPrompt: 'SYS',
      maxSteps: 3,
      maxToolOutputChars: 10_000,
      events: { onText: () => {} },
    });

  test('preserved thinking: a changed system prompt drops old thinking blocks instead of failing', async () => {
    const profile: ProviderProfile = {
      kind: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'test',
    };
    const captured: Captured[] = [];
    const usage = { input: 10, cacheWrite: 0, cacheRead: 0 };
    const anthropic = fakeAnthropic(
      [
        sseReply(usage, { model: profile.model, thinkingSignature: 'sig-1' }),
        sseReply(usage, { model: profile.model }),
      ],
      captured,
    );
    const agent = agentFor(profile, anthropic(profile.model));
    await agent.run('first');
    agent.opts.systemPrompt = 'SYS, now in teach mode'; // what /mode, /lang reload and a model switch do
    await agent.run('second');
    expect(captured.length).toBe(2);

    // The thinking block from the first turn is sent back as is: dropping it is the API's call.
    expect(JSON.stringify(captured[1]?.body.messages)).toContain('"signature":"sig-1"');
    for (const { body, beta } of captured) {
      expect(body.thinking).toEqual({
        type: 'adaptive',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      });
      expect(beta.split(',')).toContain('thinking-binding-controls-2026-08-01');
      // Nothing these models reject: no sampling settings, no forced tool choice.
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.top_k).toBeUndefined();
      expect(['any', 'tool']).not.toContain((body.tool_choice as { type?: string })?.type);
      // Caching is unchanged: request-level, plus the one system breakpoint.
      expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
      expect((body.system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({
        type: 'ephemeral',
        ttl: '5m',
      });
    }
  });

  test('models without preserved thinking get no thinking setting and no extra beta header', async () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']) {
      const profile: ProviderProfile = { kind: 'anthropic', model, apiKey: 'test' };
      const captured: Captured[] = [];
      const anthropic = fakeAnthropic(
        [sseReply({ input: 10, cacheWrite: 0, cacheRead: 0 }, { model })],
        captured,
      );
      await agentFor(profile, anthropic(model)).run('hi');
      expect(captured[0]?.body.thinking).toBeUndefined();
      expect(captured[0]?.beta).not.toContain('thinking-binding-controls');
    }
  });
});
