#!/usr/bin/env bun
/**
 * A minimal MCP server over stdio for tests: newline-delimited JSON-RPC on stdin/stdout.
 * Tools: echo { text }, add { a, b }, fail {}, ping {} (takes no arguments).
 *
 *   bun tests/fixtures/mcp-echo-server.ts            normal
 *   bun tests/fixtures/mcp-echo-server.ts crash      exits before answering
 *   bun tests/fixtures/mcp-echo-server.ts hang       never answers
 */
export {}; // a module, so its names stay out of the global scope

const mode = process.argv[2] ?? 'normal';
if (mode === 'crash') process.exit(3);

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ping', description: 'Takes no arguments.', inputSchema: { type: 'object' } },
];

type Msg = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};
const send = (m: unknown): void => {
  process.stdout.write(`${JSON.stringify(m)}\n`);
};
const result = (id: Msg['id'], r: unknown) => send({ jsonrpc: '2.0', id, result: r });
const text = (t: string, isError = false) => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError } : {}),
});

function handle(m: Msg) {
  if (mode === 'hang' || m.id === undefined) return; // notifications need no answer
  const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
  switch (m.method) {
    case 'initialize':
      return result(m.id, {
        protocolVersion: (m.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-echo', version: '1.0.0' },
      });
    case 'ping':
      return result(m.id, {});
    case 'tools/list':
      return result(m.id, { tools });
    case 'tools/call':
      switch (m.params?.name) {
        case 'echo':
          return result(m.id, text(String(args.text)));
        case 'add':
          return result(m.id, text(String(Number(args.a) + Number(args.b))));
        case 'fail':
          return result(m.id, text('the fail tool failed, as designed', true));
        case 'ping':
          return result(m.id, text('pong'));
        default:
          return send({
            jsonrpc: '2.0',
            id: m.id,
            error: { code: -32602, message: 'Unknown tool' },
          });
      }
    default:
      return send({
        jsonrpc: '2.0',
        id: m.id,
        error: { code: -32601, message: `Method not found: ${m.method}` },
      });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(JSON.parse(line) as Msg);
    nl = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
