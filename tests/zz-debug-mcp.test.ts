// TEMPORARY Windows diagnostics. Never merge.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { type McpClientLike, McpManager } from '../src/mcp.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'mcp-echo-server.ts');
const LOG = join(tmpdir(), `mcpdbg-${process.pid}.log`);
const log = (...a: unknown[]) => {
  const line = `${Date.now()} cli ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  writeFileSync(LOG, line, { flag: 'a' });
};

class LoggingTransport extends StdioMCPTransport {
  override send(message: Parameters<StdioMCPTransport['send']>[0]) {
    log('send', JSON.stringify(message).slice(0, 120));
    const p = super.send(message);
    p.then(() => log('send resolved', (message as { id?: unknown }).id));
    return p;
  }
  // biome-ignore lint/suspicious/noExplicitAny: debug
  override set onmessage(fn: any) {
    // biome-ignore lint/suspicious/noExplicitAny: debug
    (this as any)._onmessage = fn;
  }
  // biome-ignore lint/suspicious/noExplicitAny: debug
  override get onmessage(): any {
    // biome-ignore lint/suspicious/noExplicitAny: debug
    const fn = (this as any)._onmessage;
    if (!fn) return fn;
    // biome-ignore lint/suspicious/noExplicitAny: debug
    return (m: any) => {
      log('recv', JSON.stringify(m).slice(0, 120));
      return fn(m);
    };
  }
}

const ctx = { cwd: '/tmp', maxOutputChars: 10_000 };

async function run(label: string, order: string[], callTimeoutMs?: number) {
  writeFileSync(LOG, '');
  log('=====', label);
  const m = new McpManager(
    { echo: { command: process.execPath, args: [FIXTURE], env: { MCP_ECHO_LOG: LOG } } },
    {
      callTimeoutMs: callTimeoutMs ?? 5000,
      connect: async (_n, config, timeoutMs) => {
        if (!('command' in config)) throw new Error('x');
        const transport = new LoggingTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          stderr: 'ignore',
        });
        return createMCPClient({
          transport,
          clientName: 'mrig',
          initializationOptions: { timeout: timeoutMs },
          onUncaughtError: (e) => log('uncaught', String(e)),
        }) as Promise<McpClientLike>;
      },
    },
  );
  await m.start();
  for (const n of order) {
    const t = m.tools().find((x) => x.name === `mcp__echo__${n}`);
    const t0 = Date.now();
    try {
      const out = await t?.execute(
        n === 'echo' ? { text: 'hello' } : n === 'add' ? { a: 2, b: 40 } : {},
        ctx,
      );
      log('call', n, 'ok', out, `${Date.now() - t0}ms`);
    } catch (e) {
      log('call', n, 'ERR', (e as Error).message, `${Date.now() - t0}ms`);
    }
  }
  await m.close();
  await new Promise((r) => setTimeout(r, 200));
  for (const line of readFileSync(LOG, 'utf8').split('\n')) if (line) console.log(`[mcpdbg] ${line}`);
}

test('replica of the real test', async () => {
  await run('replica', ['echo', 'add', 'ping', 'fail', 'echo']);
  expect(true).toBe(true);
}, 150_000);

test('fail first', async () => {
  await run('fail-first', ['fail', 'echo', 'fail', 'ping', 'fail']);
  expect(true).toBe(true);
}, 150_000);

test('default timeout', async () => {
  await run('default-timeout', ['echo', 'add', 'ping', 'fail', 'echo'], 120_000);
  expect(true).toBe(true);
}, 150_000);
