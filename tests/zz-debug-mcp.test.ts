// TEMPORARY diagnostic for the Windows MCP hang. Not for merging.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { McpManager } from '../src/mcp.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'mcp-echo-server.ts');
const log = (...a: unknown[]) =>
  console.log('[mcpdbg]', new Date().toISOString().slice(11, 23), ...a);

test('raw stdio exchange with the fixture', async () => {
  const p = Bun.spawn([process.execPath, FIXTURE], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readLine = async (ms: number) => {
    const end = Date.now() + ms;
    while (!buf.includes('\n')) {
      const r = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, end - Date.now())).then(() => 'timeout' as const),
      ]);
      if (r === 'timeout') return 'TIMEOUT';
      if (r.done) return 'EOF';
      log('chunk', JSON.stringify(dec.decode(r.value)));
      buf += dec.decode(r.value);
    }
    const i = buf.indexOf('\n');
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    return line;
  };
  const send = (o: unknown) => {
    p.stdin.write(`${JSON.stringify(o)}\n`);
    p.stdin.flush();
  };
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dbg', version: '1' },
    },
  });
  log('init ->', await readLine(5000));
  for (const [id, name, args] of [
    [2, 'echo', { text: 'a' }],
    [3, 'add', { a: 1, b: 2 }],
    [4, 'ping', {}],
    [5, 'fail', {}],
    [6, 'echo', { text: 'after' }],
  ] as const) {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    log(name, '->', await readLine(5000));
  }
  p.stdin.end();
  log('stderr:', await new Response(p.stderr).text());
  p.kill();
  expect(true).toBe(true);
}, 60_000);

test('SDK path with a logging connect', async () => {
  const m = new McpManager(
    { echo: { command: process.execPath, args: [FIXTURE] } },
    { callTimeoutMs: 8000 },
  );
  await m.start();
  for (const n of ['echo', 'add', 'ping', 'fail', 'echo']) {
    const t = m.tools().find((x) => x.name === `mcp__echo__${n}`);
    const t0 = Date.now();
    try {
      const out = await t?.execute(
        n === 'echo' ? { text: 'x' } : n === 'add' ? { a: 1, b: 2 } : {},
        { cwd: '/tmp', maxOutputChars: 1000 },
      );
      log('sdk', n, 'ok', JSON.stringify(out), `${Date.now() - t0}ms`);
    } catch (e) {
      log(
        'sdk',
        n,
        'ERR',
        (e as Error).constructor.name,
        (e as Error).message,
        `${Date.now() - t0}ms`,
      );
    }
  }
  await m.close();
  expect(true).toBe(true);
}, 90_000);
