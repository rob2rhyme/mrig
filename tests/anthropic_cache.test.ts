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
function sseReply(usage: { input: number; cacheWrite: number; cacheRead: number }): string {
  const u = JSON.stringify({
    input_tokens: usage.input,
    output_tokens: 1,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
  });
  const events: Array<[string, string]> = [
    [
      'message_start',
      `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":${u}}}`,
    ],
    [
      'content_block_start',
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    ],
    [
      'content_block_delta',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    ],
    ['content_block_stop', '{"type":"content_block_stop","index":0}'],
    [
      'message_delta',
      `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":${u}}`,
    ],
    ['message_stop', '{"type":"message_stop"}'],
  ];
  return `${events.map(([e, d]) => `event: ${e}\ndata: ${d}`).join('\n\n')}\n\n`;
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
});
