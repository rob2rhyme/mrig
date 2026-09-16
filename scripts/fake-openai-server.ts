#!/usr/bin/env bun
/**
 * A tiny fake OpenAI-compatible chat server for end-to-end smoke tests without a real model.
 *
 * Behavior: on the first request it "calls" the `read` tool on the file named in the user
 * prompt (or README.md); once it sees a tool result it answers with text quoting the first line.
 *
 *   bun run scripts/fake-openai-server.ts            # listens on :8089
 *   mrig -P fake -p "what is in README.md"           # with a profile pointing at it
 */
const port = Number(process.env.PORT ?? 8089);

interface Msg {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finish: string | null, usage?: unknown) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

const usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 };

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'fake' }] });
    if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
    const body = (await req.json()) as { messages: Msg[]; stream?: boolean };
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const userText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : (lastUser?.content?.map((p) => p.text ?? '').join(' ') ?? '');
    const file = userText.match(/[\w./-]+\.\w+/)?.[0] ?? 'README.md';
    // "run <command>" → call the bash tool instead (exercises the permission prompt).
    const runCmd = userText.match(/^run (.+)$/m)?.[1];

    const parts: string[] = [];
    if (!hasToolResult) {
      parts.push(
        sse(chunk({ role: 'assistant', content: null }, null)),
        sse(
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_fake_1',
                  type: 'function',
                  function: runCmd
                    ? { name: 'bash', arguments: JSON.stringify({ command: runCmd }) }
                    : { name: 'read', arguments: JSON.stringify({ path: file, limit: 3 }) },
                },
              ],
            },
            null,
          ),
        ),
        sse(chunk({}, 'tool_calls', usage)),
      );
    } else {
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      const content = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
      const firstLine = content.split('\n')[0]?.replace(/^\s*\d+\t/, '') ?? '';
      const answer = runCmd
        ? `FAKE-MODEL: the command said: ${firstLine}`
        : `FAKE-MODEL: the first line of ${file} is: ${firstLine}`;
      for (const word of answer.split(' ')) parts.push(sse(chunk({ content: `${word} ` }, null)));
      parts.push(sse(chunk({}, 'stop', usage)));
    }
    parts.push('data: [DONE]\n\n');

    const stream = new ReadableStream({
      async start(controller) {
        for (const p of parts) {
          controller.enqueue(new TextEncoder().encode(p));
          await Bun.sleep(5);
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  },
});

console.log(`fake OpenAI-compatible server on http://localhost:${port}/v1`);
