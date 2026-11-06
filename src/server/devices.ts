/**
 * The device allowlist (Track 4, U2): only devices saved here in advance can log in to the app.
 * See §4 of docs/decisions/2026-11-06-app-front-ends.md.
 *
 * - One file, `~/.mrig/app/devices.json`, readable only by you (0600), written atomically.
 *   It is edited from the Mac's terminal (`mrig app allow add`, `revoke`); the app itself has
 *   no way to add a device.
 * - Adding a device makes a one-time pairing code: 8 characters, 10 minutes, five tries.
 * - Pairing swaps the code for a device key (32 random bytes) held in an HttpOnly cookie. The
 *   file keeps only SHA-256 hashes of codes and keys, never the values.
 * - A key is good until the device is revoked or goes 90 days unseen.
 * - A device can be pinned to a Tailscale login (U3): it then logs in only through Tailscale
 *   Serve, as that user, so a copied cookie is no use from anywhere else.
 * - Every change re-reads the file first, so a revoke from the terminal is never overwritten by
 *   a running server's stale copy.
 * - Every pairing, login failure and revocation is appended to `access.log` (never a secret).
 */
import { createHash, randomInt } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { mrigHome } from '../config.ts';
import { newSecret, safeEqual } from './security.ts';

export const COOKIE_NAME = 'mrig_device';
export const PAIRING_MINUTES = 10;
export const PAIRING_TRIES = 5;
export const KEY_IDLE_DAYS = 90;
/** Where a request came from, as `requestFrom` in security.ts sorted it. */
export interface LoginFrom {
  remote: boolean;
  /** The Tailscale login Serve gave, for a remote request. */
  login?: string;
}

/** No 0/O, 1/I/L: easy to read off one screen and type on another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** lastSeen is written at most this often, to keep the file quiet. */
const SEEN_EVERY_MS = 60 * 60 * 1000;

export interface Device {
  name: string;
  createdAt: string;
  /** SHA-256 of the device key, once paired. */
  keyHash?: string;
  pairedAt?: string;
  lastSeen?: string;
  /** The Tailscale login it must come from (`Tailscale-User-Login`), when pinned. */
  login?: string;
  /** An open pairing: SHA-256 of the code, when it expires, wrong tries so far. */
  pairing?: { codeHash: string; expires: string; tries: number };
}

interface DeviceFile {
  version: 1;
  devices: Device[];
}

export type PairResult =
  | { ok: true; key: string }
  | { ok: false; reason: 'unknown' | 'no-code' | 'expired' | 'wrong' | 'burned' };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function appDir(): string {
  return join(mrigHome(), 'app');
}

export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function assertDeviceName(name: string): string {
  if (!NAME.test(name)) {
    throw new Error(
      `"${name}" can't be a device name: use 1–32 lowercase letters, digits and dashes, like phone or ipad-air.`,
    );
  }
  return name;
}

export class DeviceStore {
  readonly file: string;
  readonly log: string;

  constructor(
    dir: string = appDir(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.file = join(dir, 'devices.json');
    this.log = join(dir, 'access.log');
  }

  /** The file's modification time, so a running server notices a revoke. */
  mtime(): number {
    return existsSync(this.file) ? statSync(this.file).mtimeMs : 0;
  }

  list(): Device[] {
    return this.load().devices;
  }

  get(name: string): Device | undefined {
    return this.list().find((d) => d.name === name);
  }

  /**
   * Allow a device, or give an allowed one a fresh pairing code. Returns the code; only its
   * hash is kept. An already-paired device keeps working until the new code is used.
   * `login` pins it to a Tailscale login; without it, an existing pin stays.
   */
  allow(name: string, opts: { login?: string } = {}): string {
    assertDeviceName(name);
    const login = opts.login?.trim().toLowerCase();
    if (opts.login !== undefined && !/^[^\s@]+@[^\s@]+$/.test(login ?? '')) {
      throw new Error(
        `"${opts.login}" doesn't look like a Tailscale login, like you@example.com or you@github.`,
      );
    }
    const code = newPairingCode();
    this.update((file) => {
      let device = file.devices.find((d) => d.name === name);
      if (!device) {
        device = { name, createdAt: this.iso() };
        file.devices.push(device);
      }
      if (login) device.login = login;
      device.pairing = {
        codeHash: sha256(code),
        expires: new Date(this.now() + PAIRING_MINUTES * 60_000).toISOString(),
        tries: 0,
      };
    });
    this.audit('allow', name);
    return code;
  }

  /** Swap a pairing code for a device key. Wrong codes count; the fifth burns the code. */
  pair(name: string, code: string, address = '-'): PairResult {
    let result: PairResult = { ok: false, reason: 'unknown' };
    this.update((file) => {
      const device = file.devices.find((d) => d.name === name);
      if (!device) return;
      const pairing = device.pairing;
      if (!pairing) {
        result = { ok: false, reason: 'no-code' };
        return;
      }
      if (Date.parse(pairing.expires) < this.now()) {
        delete device.pairing;
        result = { ok: false, reason: 'expired' };
        return;
      }
      if (!safeEqual(sha256(code.trim().toUpperCase()), pairing.codeHash)) {
        pairing.tries++;
        if (pairing.tries >= PAIRING_TRIES) {
          delete device.pairing;
          result = { ok: false, reason: 'burned' };
        } else {
          result = { ok: false, reason: 'wrong' };
        }
        return;
      }
      const key = newSecret();
      device.keyHash = sha256(key);
      device.pairedAt = this.iso();
      device.lastSeen = this.iso();
      delete device.pairing;
      result = { ok: true, key };
    });
    this.audit(result.ok ? 'pair' : `pair-failed:${result.reason}`, name, address);
    return result;
  }

  /**
   * The device a cookie value (`<name>.<key>`) belongs to, or undefined. Notes it as seen. A
   * pinned device must come through Tailscale as its login.
   */
  verify(
    cookie: string | undefined,
    address = '-',
    from: LoginFrom = { remote: false },
  ): string | undefined {
    if (!cookie) return undefined;
    const dot = cookie.indexOf('.');
    const name = cookie.slice(0, dot);
    const key = cookie.slice(dot + 1);
    if (dot < 1 || !NAME.test(name) || !/^[0-9a-f]{64}$/.test(key)) return undefined;
    const device = this.get(name);
    const ok =
      device?.keyHash !== undefined &&
      safeEqual(sha256(key), device.keyHash) &&
      this.now() - Date.parse(device.lastSeen ?? device.pairedAt ?? '') <
        KEY_IDLE_DAYS * 86_400_000;
    if (!ok) {
      this.audit('login-failed', name, address);
      return undefined;
    }
    if (device.login && !(from.remote && from.login?.toLowerCase() === device.login)) {
      this.audit('login-failed:pin', name, address);
      return undefined;
    }
    if (this.now() - Date.parse(device.lastSeen ?? '') > SEEN_EVERY_MS) {
      this.update((file) => {
        const d = file.devices.find((x) => x.name === name);
        if (d) d.lastSeen = this.iso();
      });
    }
    return name;
  }

  /** Remove a device. Its key stops working at once. */
  revoke(name: string): boolean {
    let removed = false;
    this.update((file) => {
      const before = file.devices.length;
      file.devices = file.devices.filter((d) => d.name !== name);
      removed = file.devices.length < before;
    });
    if (removed) this.audit('revoke', name);
    return removed;
  }

  /** The last few lines of the access log, newest last. */
  recent(lines = 10): string[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, 'utf8').trimEnd().split('\n').slice(-lines);
  }

  private load(): DeviceFile {
    if (!existsSync(this.file)) return { version: 1, devices: [] };
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DeviceFile>;
    return { version: 1, devices: Array.isArray(data.devices) ? data.devices : [] };
  }

  /** Read the file, change it, write it back atomically with owner-only permissions. */
  private update(change: (file: DeviceFile) => void): void {
    const file = this.load();
    change(file);
    const dir = join(this.file, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows has no Unix modes; the file sits in the user's own profile there.
    }
  }

  private audit(event: string, name: string, address = 'terminal'): void {
    mkdirSync(join(this.log, '..'), { recursive: true, mode: 0o700 });
    appendFileSync(this.log, `${this.iso()} ${event} ${name} ${address}\n`, { mode: 0o600 });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
