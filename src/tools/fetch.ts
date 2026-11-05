/**
 * fetch (L6): read a web page or API over http(s) and return readable text.
 *
 * - Asks before every fetch unless a `fetch:<domain-glob>` rule allows the host.
 * - Refuses private, loopback, link-local and other non-public addresses (cloud metadata at
 *   169.254.169.254, your router, localhost services), checked after DNS and again on every
 *   redirect. Residual risk: a host that changes its DNS answer between the check and the
 *   connection (DNS rebinding) is not caught.
 * - 20 s timeout, at most 2 MB downloaded, at most 100 KB of text returned (and never more
 *   than the session's tool-output cap).
 * - Marked `remote`, so offline mode (L5) drops it.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { defineTool, type MrigTool, ToolError } from './types.ts';

export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_CHARS = 100_000;
const MAX_REDIRECTS = 5;

// ---- addresses --------------------------------------------------------------------------------

function v4Parts(ip: string): number[] | undefined {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined;
}

function isBlockedV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true; // not an address we understand: refuse
  const [a = 0, b = 0, c = 0] = p;
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved, including 255.255.255.255
  );
}

/** Eight 16-bit groups, or undefined for something that is not an IPv6 address. */
function v6Groups(raw: string): number[] | undefined {
  let ip = raw.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (tail?.[1]) {
    const p = v4Parts(tail[1]);
    if (!p) return undefined;
    ip = `${ip.slice(0, -tail[1].length)}${((p[0] ?? 0) * 256 + (p[1] ?? 0)).toString(16)}:${((p[2] ?? 0) * 256 + (p[3] ?? 0)).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array(Math.max(0, fill)).fill('0'), ...rest];
  if (all.length !== 8) return undefined;
  const groups = all.map((g) => Number.parseInt(g, 16));
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function isBlockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) return isBlockedV4(embedded); // ::ffff:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b) return isBlockedV4(embedded); // NAT64
  if (g0 === 0x2002)
    return isBlockedV4(`${g1 >> 8}.${g1 & 0xff}.${(g[2] ?? 0) >> 8}.${(g[2] ?? 0) & 0xff}`); // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && g.slice(1, 4).every((x) => x === 0)) // discard
  );
}

/** True for any address that is not public: private, loopback, link-local, reserved, … */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(bare.split('%')[0] ?? '');
  if (kind === 4) return isBlockedV4(bare);
  if (kind === 6) return isBlockedV6(bare);
  return true;
}

export type Lookup = (host: string) => Promise<string[]>;

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

async function assertPublic(url: URL, lookup: Lookup): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`Only http and https URLs can be fetched, not ${url.protocol}`);
  }
  if (url.username || url.password)
    throw new ToolError('URLs with a username or password are not fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await lookup(host);
    } catch (err) {
      throw new ToolError(
        `Cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (addresses.length === 0) throw new ToolError(`Cannot resolve ${host}.`);
  const bad = addresses.find(isBlockedAddress);
  if (bad) {
    const what = bad === host ? host : `${host} resolves to ${bad}, which`;
    throw new ToolError(
      `Refused: ${what} is a private, loopback or otherwise non-public address. fetch only reads the public web.`,
    );
  }
}

// ---- HTML to text ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X'
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'iframe',
  'nav',
  'aside',
  'footer',
  'form',
  'button',
  'select',
  'canvas',
]);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'table',
  'tr',
  'blockquote',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'ul',
  'ol',
  'details',
  'summary',
  'address',
]);

/** Readable markdown-ish text from HTML: title, headings, paragraphs, lists, links, code. */
export async function htmlToText(html: string, baseUrl: string): Promise<string> {
  const out: string[] = [];
  let skip = 0;
  let pre = 0;
  let title = '';
  let inTitle = false;
  const rewriter = new HTMLRewriter().on('*', {
    element(el) {
      const tag = el.tagName.toLowerCase();
      const canEnd = (el as unknown as { canHaveContent?: boolean }).canHaveContent !== false;
      if (tag === 'title') {
        inTitle = true;
        if (canEnd)
          el.onEndTag(() => {
            inTitle = false;
          });
        return;
      }
      if (SKIP.has(tag)) {
        if (canEnd) {
          skip++;
          el.onEndTag(() => {
            skip--;
          });
        }
        return;
      }
      if (skip > 0) return;
      const end = (text: string) => {
        if (canEnd)
          el.onEndTag(() => {
            if (skip === 0) out.push(text);
          });
      };
      if (/^h[1-6]$/.test(tag)) {
        out.push(`\n\n${'#'.repeat(Number(tag[1]))} `);
        end('\n\n');
      } else if (tag === 'li') {
        out.push('\n- ');
      } else if (tag === 'br') {
        out.push('\n');
      } else if (tag === 'hr') {
        out.push('\n\n---\n\n');
      } else if (tag === 'pre') {
        out.push('\n\n```\n');
        pre++;
        if (canEnd)
          el.onEndTag(() => {
            pre--;
            if (skip === 0) out.push('\n```\n\n');
          });
      } else if (tag === 'code' && pre === 0) {
        out.push('`');
        end('`');
      } else if (tag === 'a') {
        const href = decodeEntities(el.getAttribute('href') ?? '');
        let target = '';
        try {
          if (href && !href.startsWith('#') && !/^(javascript|mailto|data):/i.test(href))
            target = new URL(href, baseUrl).href;
        } catch {
          target = '';
        }
        if (target) {
          out.push('[');
          end(`](${target})`);
        }
      } else if (tag === 'td' || tag === 'th') {
        out.push(' | ');
      } else if (tag === 'img') {
        const alt = el.getAttribute('alt');
        if (alt) out.push(`[image: ${decodeEntities(alt)}]`);
      } else if (BLOCK.has(tag)) {
        out.push('\n\n');
        end('\n\n');
      }
    },
    text(chunk) {
      if (inTitle) {
        title += chunk.text;
        return;
      }
      if (skip > 0 || !chunk.text) return;
      const text = decodeEntities(chunk.text);
      out.push(pre > 0 ? text : text.replace(/\s+/g, ' '));
    },
  });
  await rewriter.transform(new Response(html)).text();
  // Tidy whitespace, except inside code blocks, whose indentation is meaningful.
  let inFence = false;
  const body = out
    .join('')
    .split('\n')
    .map((l) => {
      if (l.trimStart().startsWith('```')) {
        inFence = !inFence;
        return l.trim();
      }
      return inFence ? l : l.replace(/[ \t]+$/g, '').replace(/^ +(?![-|])/g, '');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\[\s*\]\([^)]*\)/g, '') // links with no text
    .trim();
  const t = decodeEntities(title).replace(/\s+/g, ' ').trim();
  return t ? `# ${t}\n\n${body}` : body;
}

// ---- the tool -----------------------------------------------------------------------------------

const schema = z.object({
  url: z.string().describe('The http or https URL to read'),
  raw: z
    .boolean()
    .optional()
    .describe('Return the body as received instead of converting HTML to text'),
});

export interface FetchDeps {
  fetch?: typeof fetch;
  lookup?: Lookup;
  timeoutMs?: number;
}

function charsetOf(contentType: string): string {
  const m = /charset=([^;]+)/i.exec(contentType);
  return (m?.[1] ?? 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}

const TEXTUAL =
  /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml|x-yaml|yaml|toml))/i;

export function createFetchTool(deps: FetchDeps = {}): MrigTool<z.infer<typeof schema>> {
  const doFetch = deps.fetch ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  return defineTool<z.infer<typeof schema>>({
    name: 'fetch',
    description:
      'Read a public web page or API over http(s) and return its text (HTML is converted to readable text with links). Up to 100 KB of text; private and local addresses are refused.',
    inputSchema: schema,
    readOnly: false,
    remote: true,
    summarize: (i) => `fetch ${i.url}`,
    async execute(input, ctx) {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new ToolError(`Not a valid URL: ${input.url}`);
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      let res: Response | undefined;
      try {
        for (let hop = 0; ; hop++) {
          await assertPublic(url, lookup);
          res = await doFetch(url, {
            redirect: 'manual',
            signal,
            headers: {
              'user-agent': 'mrig-fetch/1',
              accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
            },
          });
          const location = res.headers.get('location');
          if (res.status >= 300 && res.status < 400 && location) {
            if (hop >= MAX_REDIRECTS)
              throw new ToolError(`Too many redirects (more than ${MAX_REDIRECTS}).`);
            await res.body?.cancel().catch(() => {});
            url = new URL(location, url);
            continue;
          }
          break;
        }
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (timeout.aborted)
          throw new ToolError(
            `Timed out after ${Math.round(timeoutMs / 1000)}s fetching ${url.href}`,
          );
        if (ctx.signal?.aborted) throw new ToolError('Fetch cancelled.');
        throw new ToolError(
          `Fetch failed for ${url.href}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res) throw new ToolError(`No response from ${url.href}`);
      const type = res.headers.get('content-type') ?? '';
      const head = `URL: ${url.href}\nStatus: ${res.status}${type ? `\nContent-Type: ${type}` : ''}`;
      if (type && !TEXTUAL.test(type)) {
        await res.body?.cancel().catch(() => {});
        throw new ToolError(`${head}\n\nNot text (${type}); fetch only returns text.`);
      }
      const { bytes, truncated: cut } = await readCapped(res, FETCH_MAX_BYTES);
      let text: string;
      try {
        // Labels come from the server; TextDecoder throws on ones it does not know.
        text = new TextDecoder(
          charsetOf(type) as ConstructorParameters<typeof TextDecoder>[0],
        ).decode(bytes);
      } catch {
        text = new TextDecoder().decode(bytes);
      }
      const isHtml = /html/i.test(type) || (!type && /^\s*<(!doctype|html)/i.test(text));
      if (isHtml && !input.raw) text = await htmlToText(text, url.href);
      const limit = Math.min(FETCH_MAX_CHARS, ctx.maxOutputChars);
      let note = cut ? `\n\n[download stopped at ${FETCH_MAX_BYTES / 1024 / 1024} MB]` : '';
      if (text.length > limit) {
        note = `\n\n[truncated: ${(text.length - limit).toLocaleString()} more characters not shown]${note}`;
        text = text.slice(0, limit);
      }
      if (res.status >= 400) {
        throw new ToolError(
          `${head}\n\nHTTP ${res.status} ${res.statusText}. ${text.slice(0, 500)}`,
        );
      }
      return `${head}\n\n${text}${note}`;
    },
  });
}

export const fetchTool = createFetchTool();
