/**
 * The app server's security rules (Track 4, U1), as pure functions so each one can be tested
 * on its own. See §3 of docs/decisions/2026-11-06-app-front-ends.md.
 *
 * - The server listens on 127.0.0.1 only (serve.ts); `Host` must name it, which defeats DNS
 *   rebinding.
 * - A browser always sends `Origin` on a WebSocket upgrade; it must be the server's own origin
 *   or VS Code's webview, so no other website can talk to mrig.
 * - A client that started the server proves it with the launch token (subprotocol
 *   `mrig.token.<hex>`); it is compared in constant time.
 * - Media is served only from the conversation's media folders, through links signed with a
 *   per-process key that expire.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TOKEN_PROTOCOL_PREFIX } from './protocol.ts';

/** 32 random bytes as hex: a launch token or a signing key. */
export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

/** True when the strings are equal, in time that does not depend on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The `Host` values this server answers to. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function hostAllowed(host: string | null, port: number): boolean {
  if (!host) return false;
  return allowedHosts(port).includes(host.toLowerCase());
}

/**
 * An upgrade's `Origin`: absent for a program that is not a browser (it must then hold the
 * launch token, which every U1 client does); otherwise the server's own origin or a VS Code
 * webview.
 */
export function originAllowed(origin: string | null, port: number): boolean {
  if (origin === null) return true;
  const o = origin.toLowerCase();
  if (allowedHosts(port).some((h) => o === `http://${h}`)) return true;
  return /^vscode-webview:\/\/[a-z0-9-]+$/.test(o);
}

/** The launch token offered in `Sec-WebSocket-Protocol`, if any. */
export function tokenFromProtocols(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const p = part.trim();
    if (p.startsWith(TOKEN_PROTOCOL_PREFIX)) return p.slice(TOKEN_PROTOCOL_PREFIX.length);
  }
  return undefined;
}

/** File types the media route serves, with their content types. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * True when `path` is a media file inside one of the folders, after resolving symlinks, so a
 * link inside `images/` that points elsewhere is refused.
 */
export function insideMediaFolders(path: string, folders: string[]): boolean {
  if (!isAbsolute(path) || !(extname(path).toLowerCase() in MEDIA_TYPES)) return false;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return folders.some((folder) => {
    let base: string;
    try {
      base = realpathSync(resolve(folder));
    } catch {
      return false;
    }
    const rel = relative(base, real);
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  });
}

/** Signs and checks media links. One key per server process; links expire. */
export class MediaSigner {
  constructor(
    private readonly key: string = newSecret(),
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = 60 * 60 * 1000,
  ) {}

  private mac(conversation: string, path: string, expires: number): string {
    return createHmac('sha256', this.key)
      .update(`${conversation}\n${path}\n${expires}`)
      .digest('base64url');
  }

  /** `/media/<conversation>?p=…&e=…&s=…` for an absolute path. */
  url(conversation: string, path: string): string {
    const expires = this.now() + this.ttlMs;
    const p = Buffer.from(path).toString('base64url');
    const s = this.mac(conversation, path, expires);
    return `/media/${encodeURIComponent(conversation)}?p=${p}&e=${expires}&s=${s}`;
  }

  /** The path a link names, when its signature is valid and it has not expired. */
  verify(conversation: string, params: URLSearchParams): string | undefined {
    const p = params.get('p');
    const e = params.get('e');
    const s = params.get('s');
    if (!p || !e || !s || !/^\d+$/.test(e)) return undefined;
    const expires = Number(e);
    if (expires < this.now()) return undefined;
    const path = Buffer.from(p, 'base64url').toString();
    return safeEqual(s, this.mac(conversation, path, expires)) ? path : undefined;
  }
}

/** A cookie's value from a `Cookie` header, or undefined. */
export function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * The device cookie: HttpOnly (page scripts can't read it), SameSite=Strict (no other site's
 * page can send it), Secure when the app is served over HTTPS (U3).
 */
export function deviceCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/** At most `limit` hits per key in any `windowMs`: slows down guessing pairing codes. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record a hit; false when the key is over its limit. */
  hit(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    recent.push(t);
    this.hits.set(key, recent);
    return recent.length <= this.limit;
  }
}
