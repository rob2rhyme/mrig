import { describe, expect, test } from 'bun:test';
import { Agent } from '../src/agent.ts';
import { PermissionManager } from '../src/permissions.ts';
import {
  createFetchTool,
  decodeEntities,
  FETCH_MAX_BYTES,
  htmlToText,
  isBlockedAddress,
  type Lookup,
} from '../src/tools/fetch.ts';
import { DEFAULT_TOOLS } from '../src/tools/index.ts';
import { mockModel, textTurn, toolTurn } from './helpers.ts';

const ctx = (over: { maxOutputChars?: number; signal?: AbortSignal } = {}) => ({
  cwd: '/tmp',
  maxOutputChars: 30_000,
  ...over,
});

/** A fake web: maps URL → response factory. Records every request; never touches the network. */
function fakeWeb(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}) {
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const route = routes[url];
    if (!route)
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return route();
  }) as unknown as typeof fetch;
  const lookup: Lookup = async (host) => {
    const answer = dns[host] ?? ['93.184.216.34'];
    if (answer.length === 0) throw new Error('ENOTFOUND');
    return answer;
  };
  return { requests, tool: createFetchTool({ fetch: fetchFn, lookup }) };
}

const html =
  (body: string, extra: Record<string, string> = {}) =>
  () =>
    new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });

describe('fetch: addresses', () => {
  test('public addresses pass, everything else is refused', () => {
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700:4700::1111',
      '2a00:1450:4001:82a::200e',
    ]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.1',
      '::1',
      '::',
      '[::1]',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      'ff02::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:5',
      '2002:c0a8:0101::1',
      'not-an-ip',
      '',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress('172.32.0.1')).toBe(false); // just outside 172.16/12
  });
});

describe('fetch: HTML to text', () => {
  test('title, headings, paragraphs, lists, links, code; scripts and navigation dropped', async () => {
    const page = `<!doctype html><html><head><title>Docs &amp; Guides</title><style>p{}</style>
      <script>alert('x')</script></head><body><nav><a href="/">Home</a></nav>
      <h1>Install</h1><p>Run   the <code>setup</code> script. See <a href="/guide?a=1&amp;b=2">the guide</a>.</p>
      <ul><li>One</li><li>Two &lt;three&gt;</li></ul><pre>line 1
  line 2</pre><img src="x.png" alt="Diagram"><footer>© 2026</footer></body></html>`;
    const text = await htmlToText(page, 'https://docs.example.com/start/');
    expect(text.startsWith('# Docs & Guides')).toBe(true);
    expect(text).toContain('# Install');
    expect(text).toContain(
      'Run the `setup` script. See [the guide](https://docs.example.com/guide?a=1&b=2).',
    );
    expect(text).toContain('- One');
    expect(text).toContain('- Two <three>');
    expect(text).toContain('```\nline 1\n  line 2\n```');
    expect(text).toContain('[image: Diagram]');
    for (const gone of ['alert', 'p{}', 'Home', '© 2026']) expect(text).not.toContain(gone);
  });

  test('entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#233; &#x1F600; &nbsp;&bogus;')).toBe(
      'a & b <c> é 😀  &bogus;',
    );
  });
});

describe('fetch: the tool', () => {
  test('reads a page: status line, converted text, the final URL', async () => {
    const web = fakeWeb({
      'https://example.com/': html('<title>Example</title><p>Hello <b>web</b></p>'),
    });
    const out = await web.tool.execute({ url: 'https://example.com/' }, ctx());
    expect(out).toContain('URL: https://example.com/\nStatus: 200\nContent-Type: text/html');
    expect(out).toContain('# Example');
    expect(out).toContain('Hello web');
    const raw = await web.tool.execute({ url: 'https://example.com/', raw: true }, ctx());
    expect(raw).toContain('<p>Hello <b>web</b></p>');
  });

  test('JSON and plain text pass through; other charsets are decoded', async () => {
    const web = fakeWeb({
      'https://api.example.com/v1': () => Response.json({ ok: true }),
      'https://example.com/latin1': () =>
        new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
          headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
        }),
    });
    expect(await web.tool.execute({ url: 'https://api.example.com/v1' }, ctx())).toContain(
      '{"ok":true}',
    );
    expect(await web.tool.execute({ url: 'https://example.com/latin1' }, ctx())).toContain('café');
  });

  test('refuses private and local targets before any request is made', async () => {
    const web = fakeWeb(
      {},
      { 'internal.corp': ['10.1.2.3'], 'sneaky.example': ['93.184.216.34', '127.0.0.1'] },
    );
    for (const [url, message] of [
      ['http://127.0.0.1:8080/', /Refused: 127\.0\.0\.1 is a private, loopback/],
      ['http://169.254.169.254/latest/meta-data/', /169\.254\.169\.254/],
      ['http://[::1]/', /::1/],
      ['http://[::ffff:127.0.0.1]/', /non-public/],
      ['http://internal.corp/', /internal\.corp resolves to 10\.1\.2\.3, which is a private/],
      ['http://sneaky.example/', /resolves to 127\.0\.0\.1/], // one bad answer is enough
      ['file:///etc/passwd', /Only http and https/],
      ['ftp://example.com/x', /Only http and https/],
      ['https://user:pass@example.com/', /username or password/],
      ['not a url', /Not a valid URL/],
    ] as const) {
      expect(web.tool.execute({ url }, ctx())).rejects.toThrow(message);
    }
    expect(web.requests).toEqual([]);
  });

  test('redirects are followed, re-checked at every hop, and capped', async () => {
    const web = fakeWeb({
      'https://example.com/old': () =>
        new Response(null, { status: 301, headers: { location: '/new' } }),
      'https://example.com/new': html('<p>moved here</p>'),
      'https://example.com/trap': () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
      'https://example.com/loop': () =>
        new Response(null, { status: 302, headers: { location: '/loop' } }),
    });
    const out = await web.tool.execute({ url: 'https://example.com/old' }, ctx());
    expect(out).toContain('URL: https://example.com/new');
    expect(out).toContain('moved here');
    expect(web.tool.execute({ url: 'https://example.com/trap' }, ctx())).rejects.toThrow(
      /169\.254\.169\.254/,
    );
    expect(web.requests).not.toContain('http://169.254.169.254/latest/meta-data/');
    expect(web.tool.execute({ url: 'https://example.com/loop' }, ctx())).rejects.toThrow(
      /Too many redirects/,
    );
  });

  test('errors, binary content and DNS failures are tool errors the model can read', async () => {
    const web = fakeWeb(
      {
        'https://example.com/img': () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
      },
      { 'nowhere.example': [] },
    );
    expect(web.tool.execute({ url: 'https://example.com/missing' }, ctx())).rejects.toThrow(
      /Status: 404[\s\S]*HTTP 404/,
    );
    expect(web.tool.execute({ url: 'https://example.com/img' }, ctx())).rejects.toThrow(
      /Not text \(image\/png\)/,
    );
    expect(web.tool.execute({ url: 'https://nowhere.example/' }, ctx())).rejects.toThrow(
      /Cannot resolve nowhere\.example/,
    );
  });

  test('a slow server times out', async () => {
    const hang = (async (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const tool = createFetchTool({
      fetch: hang,
      lookup: async () => ['93.184.216.34'],
      timeoutMs: 50,
    });
    expect(tool.execute({ url: 'https://slow.example/' }, ctx())).rejects.toThrow(
      /Timed out after 0s/,
    );
  });

  test('output is capped by the tool limit and the session cap; downloads stop at 2 MB', async () => {
    const big = 'x'.repeat(150_000);
    const huge = new Uint8Array(FETCH_MAX_BYTES + 500_000).fill(0x61);
    const web = fakeWeb({
      'https://example.com/big': () =>
        new Response(big, { headers: { 'content-type': 'text/plain' } }),
      'https://example.com/huge': () =>
        new Response(huge, { headers: { 'content-type': 'text/plain' } }),
    });
    const capped = await web.tool.execute(
      { url: 'https://example.com/big' },
      ctx({ maxOutputChars: 1_000_000 }),
    );
    expect(capped).toContain('[truncated: 50,000 more characters not shown]');
    const session = await web.tool.execute(
      { url: 'https://example.com/big' },
      ctx({ maxOutputChars: 2000 }),
    );
    expect(session).toContain('[truncated: 148,000 more characters not shown]');
    const stopped = await web.tool.execute({ url: 'https://example.com/huge' }, ctx());
    expect(stopped).toContain('[download stopped at 2 MB]');
  });

  test('it is a default tool, asks before running, is remote, and fetch: rules match hosts', async () => {
    const tool = DEFAULT_TOOLS.find((t) => t.name === 'fetch');
    expect(tool?.readOnly).toBe(false);
    expect(tool?.remote).toBe(true);
    if (!tool) throw new Error('fetch missing');
    let asked = 0;
    const pm = new PermissionManager({
      yolo: false,
      allow: ['fetch:*.python.org', 'fetch:example.com'],
      cwd: '/tmp',
      ask: async () => {
        asked++;
        return 'no';
      },
    });
    expect(pm.matches(tool, { url: 'https://docs.python.org/3/' })).toBe(true);
    expect(pm.matches(tool, { url: 'https://example.com/x' })).toBe(true);
    expect(pm.matches(tool, { url: 'https://python.org.evil.example/' })).toBe(false);
    expect(pm.matches(tool, { url: 'https://sub.example.com/' })).toBe(false);
    expect(pm.alwaysRuleFor(tool, { url: 'https://Docs.Rust-Lang.org/book/' })).toBe(
      'fetch:docs.rust-lang.org',
    );
    expect(await pm.check(tool, { url: 'https://other.example/' })).toBe('deny');
    expect(asked).toBe(1);
  });

  test('in the agent loop: the model reads a page', async () => {
    const web = fakeWeb({
      'https://example.com/': html('<title>Example</title><p>The answer is 42.</p>'),
    });
    const agent = new Agent({
      model: mockModel([
        toolTurn('fetch', '{"url":"https://example.com/"}'),
        textTurn('It says 42.'),
      ]),
      modelLabel: 'test',
      profile: { kind: 'openai-compatible', model: 'm', baseURL: 'http://127.0.0.1:1/v1' },
      tools: [web.tool],
      permissions: new PermissionManager({
        yolo: false,
        allow: ['fetch:example.com'],
        cwd: '/tmp',
        ask: async () => 'no',
      }),
      cwd: '/tmp',
      systemPrompt: 'test',
      maxSteps: 4,
      maxToolOutputChars: 10_000,
      events: { onText: () => {} },
    });
    const result = await agent.run('what does example.com say?');
    expect(result.text).toBe('It says 42.');
    expect(JSON.stringify(agent.messages)).toContain('The answer is 42.');
  });
});
