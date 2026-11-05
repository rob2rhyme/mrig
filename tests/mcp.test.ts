import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import {
  formatMcpStatus,
  type McpClientLike,
  McpManager,
  mcpResultText,
  mcpToolName,
  parseMcpServers,
} from '../src/mcp.ts';
import { Runtime } from '../src/runtime.ts';
import { ZONE_MARKER } from '../src/zone.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'mcp-echo-server.ts');
const echoServer = (...args: string[]) => ({ command: process.execPath, args: [FIXTURE, ...args] });
const ctx = { cwd: '/tmp', maxOutputChars: 10_000 };

describe('mcp: pure helpers', () => {
  test('config validation', () => {
    expect(parseMcpServers(undefined)).toEqual({});
    expect(
      parseMcpServers({
        files: { command: 'npx', args: ['-y', 'server-files'], env: { ROOT: '/x' } },
        web: { url: 'https://mcp.example.com/mcp', transport: 'sse', headers: { A: 'b' } },
      }),
    ).toMatchObject({ files: { command: 'npx' }, web: { url: 'https://mcp.example.com/mcp' } });
    for (const [bad, message] of [
      [[], /must be an object/],
      [{ 'bad name': { command: 'x' } }, /names may use/],
      [{ a: { command: 'x', url: 'https://x' } }, /exactly one of "command" or "url"/],
      [{ a: {} }, /exactly one of/],
      [{ a: { command: 'x', args: 'nope' } }, /args must be a list/],
      [{ a: { command: 'x', env: { K: 1 } } }, /env must map/],
      [{ a: { url: 'not a url' } }, /not a valid URL/],
      [{ a: { url: 'https://x', transport: 'ws' } }, /transport must be/],
    ] as const) {
      expect(() => parseMcpServers(bad)).toThrow(message);
    }
  });

  test('tool names are prefixed, cleaned, capped at 64 and never collide', () => {
    const taken = new Set<string>();
    expect(mcpToolName('github', 'list_issues', taken)).toBe('mcp__github__list_issues');
    expect(mcpToolName('my srv', 'do.thing/now', taken)).toBe('mcp__my_srv__do_thing_now');
    const long = mcpToolName('s', 'x'.repeat(100), taken);
    expect(long.length).toBe(64);
    const again = mcpToolName('s', 'x'.repeat(100), taken);
    expect(again).not.toBe(long);
    expect(again.length).toBeLessThanOrEqual(64);
  });

  test('results become text; server errors are flagged', () => {
    expect(
      mcpResultText({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a', text: 'inline' } },
          { type: 'resource', resource: { uri: 'file:///b', blob: 'AAAA' } },
        ],
      }),
    ).toEqual({ text: 'one\n[image: image/png]\ninline\n[resource: file:///b]', isError: false });
    expect(mcpResultText({ content: [{ type: 'text', text: 'boom' }], isError: true })).toEqual({
      text: 'boom',
      isError: true,
    });
    expect(mcpResultText({ content: [], structuredContent: { n: 1 } }).text).toBe('{"n":1}');
    expect(mcpResultText(undefined)).toEqual({ text: '', isError: false });
  });

  test('/mcp lines', () => {
    expect(formatMcpStatus([])[0]).toMatch(/No MCP servers configured/);
    const lines = formatMcpStatus([
      { name: 'a', kind: 'stdio', target: 'bun a.ts', state: 'connected', tools: ['mcp__a__x'] },
      {
        name: 'b',
        kind: 'stdio',
        target: 'nope',
        state: 'failed',
        error: 'command not found',
        tools: [],
      },
      { name: 'c', kind: 'remote', target: 'https://c', state: 'offline', tools: [] },
      { name: 'd', kind: 'stdio', target: 'd', state: 'disabled', tools: [] },
    ]);
    expect(lines).toEqual([
      '● a (stdio: bun a.ts) · 1 tool',
      '    mcp__a__x',
      '✗ b (stdio: nope) · failed: command not found',
      '· c (remote: https://c) · skipped: offline mode',
      '· d (stdio: d) · disabled',
    ]);
  });
});

describe('mcp: the manager', () => {
  test('a real stdio server: tools listed, called, and errors surfaced', async () => {
    const m = new McpManager({ echo: echoServer() });
    await m.start();
    try {
      expect(m.status()[0]).toMatchObject({ name: 'echo', kind: 'stdio', state: 'connected' });
      const names = m.tools().map((t) => t.name);
      expect(names).toEqual([
        'mcp__echo__echo',
        'mcp__echo__add',
        'mcp__echo__fail',
        'mcp__echo__ping',
      ]);
      const tool = (n: string) => {
        const t = m.tools().find((x) => x.name === `mcp__echo__${n}`);
        if (!t) throw new Error(`no ${n}`);
        return t;
      };
      expect(tool('echo').readOnly).toBe(false); // always behind the permission gate
      expect(tool('echo').remote).toBe(false);
      expect(tool('echo').parameters?.required).toEqual(['text']);
      expect(tool('echo').description).toContain('[MCP server "echo"]');
      expect(await tool('echo').execute({ text: 'hello' }, ctx)).toBe('hello');
      expect(await tool('add').execute({ a: 2, b: 40 }, ctx)).toBe('42');
      expect(await tool('ping').execute({}, ctx)).toBe('pong');
      await expect(tool('fail').execute({}, ctx)).rejects.toThrow(
        'the fail tool failed, as designed',
      );
      expect(tool('echo').summarize({ text: 'hi' })).toBe('echo · echo {"text":"hi"}');
    } finally {
      await m.close();
    }
  }, 20000);

  test('servers that fail to start become notices, never crashes', async () => {
    const notices: string[] = [];
    const m = new McpManager(
      {
        good: echoServer(),
        crash: echoServer('crash'),
        hang: echoServer('hang'),
        missing: { command: join(import.meta.dir, 'no-such-binary') },
        off: { ...echoServer(), disabled: true },
      },
      { connectTimeoutMs: 800, onNotice: (n) => notices.push(n) },
    );
    await m.start();
    try {
      const state = Object.fromEntries(m.status().map((s) => [s.name, s.state]));
      expect(state).toEqual({
        good: 'connected',
        crash: 'failed',
        hang: 'failed',
        missing: 'failed',
        off: 'disabled',
      });
      expect(m.tools().every((t) => t.name.startsWith('mcp__good__'))).toBe(true);
      expect(notices.length).toBe(3);
      expect(notices.find((n) => n.includes('"crash"'))).toMatch(/exited during startup/);
      expect(notices.find((n) => n.includes('"hang"'))).toMatch(/timed out/);
      // Windows reports a missing executable as the process closing, not as ENOENT.
      expect(notices.find((n) => n.includes('"missing"'))).toMatch(
        process.platform === 'win32'
          ? /command not found|ENOENT|exited during startup/
          : /command not found|ENOENT/,
      );
    } finally {
      await m.close();
    }
  }, 20000);

  test('offline: remote servers are skipped, local ones still start', async () => {
    let remoteContacted = false;
    const fake: McpClientLike = {
      listTools: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const m = new McpManager(
      { web: { url: 'https://mcp.example.com/mcp' }, local: echoServer() },
      {
        offline: true,
        connect: async (_name, config) => {
          if ('url' in config) remoteContacted = true;
          return fake;
        },
      },
    );
    await m.start();
    expect(remoteContacted).toBe(false);
    expect(m.status().find((s) => s.name === 'web')?.state).toBe('offline');
    expect(m.status().find((s) => s.name === 'local')?.state).toBe('connected');
    await m.close();
  });

  test('pagination, remote flag and close, with an in-process client', async () => {
    let closed = 0;
    const pages: Record<
      string,
      { tools: Array<{ name: string; inputSchema: Record<string, unknown> }>; nextCursor?: string }
    > = {
      first: { tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'p2' },
      p2: {
        tools: [
          { name: 'b', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
        ],
      },
    };
    const client: McpClientLike = {
      listTools: async (o) => pages[o?.params?.cursor ?? 'first'] ?? { tools: [] },
      callTool: async ({ name }) => ({ content: [{ type: 'text', text: `called ${name}` }] }),
      close: async () => {
        closed++;
      },
    };
    const m = new McpManager(
      { web: { url: 'https://mcp.example.com/mcp' } },
      { connect: async () => client },
    );
    await m.start();
    expect(m.tools().map((t) => t.name)).toEqual(['mcp__web__a', 'mcp__web__b']);
    expect(m.tools().every((t) => t.remote === true)).toBe(true); // dropped in offline mode
    expect(m.tools()[0]?.parameters).toEqual({ type: 'object', properties: {} }); // normalised
    expect(await m.tools()[1]?.execute({ q: 'x' }, ctx)).toBe('called b');
    await m.close();
    await m.close();
    expect(closed).toBe(1);
  });
});

describe('mcp: shutdown', () => {
  test('close() never hangs on a server that does not close', async () => {
    const stuck: McpClientLike = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: () => new Promise<void>(() => {}), // never resolves
    };
    const m = new McpManager(
      { s: { command: 'x' } },
      { connect: async () => stuck, closeTimeoutMs: 50 },
    );
    await m.start();
    const t0 = Date.now();
    await m.close();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('mcp: through the runtime and the agent', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const fake = {
    kind: 'openai-compatible',
    name: 'fake',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'fake',
  };
  const writeGlobal = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ providers: { fake }, mcpServers: { echo: echoServer() }, ...extra }),
    );

  test('the model calls an MCP tool behind the permission gate, with the server schema', async () => {
    writeGlobal();
    const asked: string[] = [];
    const model = mockModel([
      toolTurn('mcp__echo__echo', '{"text":"from the model"}', 'c1'),
      toolTurn('mcp__echo__ping', '{}', 'c2'),
      textTurn('done'),
    ]);
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      languageModel: model,
      ask: async (r) => {
        asked.push(r.summary);
        return 'yes';
      },
      events: { onText: () => {} },
    });
    try {
      await rt.startMcp();
      expect(rt.agent.opts.tools.map((t) => t.name)).toContain('mcp__echo__echo');
      await rt.agent.run('use the echo server');
      expect(asked).toEqual(['echo · echo {"text":"from the model"}', 'echo · ping']);
      const results = rt.agent.messages
        .filter((m) => m.role === 'tool')
        .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
        .map((p) =>
          p.type === 'tool-result' && p.output.type === 'text' ? p.output.value : 'other',
        );
      expect(results).toEqual(['from the model', 'pong']); // `{}` is fine for a tool without required args
      const sent = model.doStreamCalls[0]?.tools?.find((t) => t.name === 'mcp__echo__echo');
      expect(JSON.stringify(sent)).toContain('"required":["text"]');
      expect(rt.mcpReport()[0]).toBe(`● echo (stdio: ${process.execPath} ${FIXTURE}) · 4 tools`);
    } finally {
      await rt.close();
    }
  }, 20000);

  test('allow rules work unchanged for MCP tools', async () => {
    writeGlobal({ permissions: { allow: ['mcp__echo__echo:*'] } });
    let asked = 0;
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      languageModel: mockModel([toolTurn('mcp__echo__echo', '{"text":"x"}'), textTurn('ok')]),
      ask: async () => {
        asked++;
        return 'no';
      },
      events: { onText: () => {} },
    });
    try {
      await rt.startMcp();
      await rt.agent.run('go');
      expect(asked).toBe(0);
    } finally {
      await rt.close();
    }
  }, 20000);

  test("a project's config cannot start servers; it is told why", async () => {
    writeFileSync(join(home.dir, 'config.json'), JSON.stringify({ providers: { fake } }));
    mkdirSync(join(project.dir, '.mrig'));
    writeFileSync(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ mcpServers: { evil: { command: 'curl', args: ['https://evil.example'] } } }),
    );
    expect(loadConfig({ cwd: project.dir, env: {} }).projectMcpIgnored).toEqual(['evil']);
    expect(loadConfig({ cwd: project.dir, env: {} }).mcpServers).toEqual({});
    const notices: string[] = [];
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      ask: async () => 'no',
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    await rt.startMcp();
    expect(notices[0]).toMatch(/Ignored MCP server "evil" from this project's .mrig\/config.json/);
    expect(rt.mcpStatus()).toEqual([]);
    await rt.close();
  });

  test('bash-only tool mode leaves MCP tools out; offline mode drops remote ones', async () => {
    writeGlobal({
      providers: { fake, mini: { ...fake, toolMode: 'minimal' } },
      mcpServers: { echo: echoServer(), web: { url: 'https://mcp.example.com/mcp' } },
    });
    writeFileSync(join(project.dir, ZONE_MARKER), '');
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    try {
      await rt.startMcp();
      expect(rt.mcpStatus().map((s) => `${s.name}:${s.state}`)).toEqual([
        'echo:connected',
        'web:offline',
      ]);
      expect(rt.agent.opts.tools.some((t) => t.name === 'mcp__echo__echo')).toBe(true);
      rt.switchModel('mini');
      expect(rt.agent.opts.tools.map((t) => t.name)).toEqual(['bash']);
      rt.switchModel('fake');
      expect(rt.agent.opts.tools.some((t) => t.name === 'mcp__echo__echo')).toBe(true);
    } finally {
      await rt.close();
    }
  }, 20000);
});
