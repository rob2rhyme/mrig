/** Track 4, U2: the device allowlist. Pairing, login, revocation, and no secret on disk. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from '../src/cli/args.ts';
import {
  DeviceStore,
  KEY_IDLE_DAYS,
  newPairingCode,
  PAIRING_TRIES,
} from '../src/server/devices.ts';
import { tempDir } from './helpers.ts';

describe('device allowlist (U2)', () => {
  let dir: ReturnType<typeof tempDir>;
  let now: number;
  let store: DeviceStore;
  beforeEach(() => {
    dir = tempDir('mrig-devices-');
    now = Date.parse('2026-11-06T12:00:00Z');
    store = new DeviceStore(dir.dir, () => now);
  });
  afterEach(() => dir.cleanup());

  test('pairing codes are 8 easy-to-read characters', () => {
    for (let i = 0; i < 50; i++) expect(newPairingCode()).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });

  test('a code pairs once, for this device only, and the key logs in', () => {
    const code = store.allow('phone');
    expect(store.pair('ipad', code)).toEqual({ ok: false, reason: 'unknown' });
    const result = store.pair('phone', code.toLowerCase()); // case does not matter
    if (!result.ok) throw new Error(result.reason);
    expect(result.key).toMatch(/^[0-9a-f]{64}$/);
    expect(store.verify(`phone.${result.key}`)).toBe('phone');
    expect(store.pair('phone', code)).toEqual({ ok: false, reason: 'no-code' }); // single use
  });

  test('a code expires after 10 minutes', () => {
    const code = store.allow('phone');
    now += 10 * 60_000 + 1;
    expect(store.pair('phone', code)).toEqual({ ok: false, reason: 'expired' });
  });

  test('five wrong tries burn the code', () => {
    const code = store.allow('phone');
    for (let i = 1; i < PAIRING_TRIES; i++) {
      expect(store.pair('phone', 'WRONG234')).toEqual({ ok: false, reason: 'wrong' });
    }
    expect(store.pair('phone', 'WRONG234')).toEqual({ ok: false, reason: 'burned' });
    expect(store.pair('phone', code)).toEqual({ ok: false, reason: 'no-code' });
  });

  test('a key is refused when wrong, revoked, replaced, or unused for 90 days', () => {
    const r = store.pair('phone', store.allow('phone'));
    if (!r.ok) throw new Error('pair');
    expect(store.verify(`phone.${'0'.repeat(64)}`)).toBeUndefined();
    expect(store.verify(`ipad.${r.key}`)).toBeUndefined();
    expect(store.verify(`phone.${r.key}x`)).toBeUndefined();
    expect(store.verify(undefined)).toBeUndefined();
    expect(store.verify('garbage')).toBeUndefined();

    // A new code leaves the old key working until the new code is used.
    const again = store.allow('phone');
    expect(store.verify(`phone.${r.key}`)).toBe('phone');
    const r2 = store.pair('phone', again);
    if (!r2.ok) throw new Error('pair again');
    expect(store.verify(`phone.${r.key}`)).toBeUndefined();
    expect(store.verify(`phone.${r2.key}`)).toBe('phone');

    now += (KEY_IDLE_DAYS - 1) * 86_400_000;
    expect(store.verify(`phone.${r2.key}`)).toBe('phone'); // seen again: the clock restarts
    now += KEY_IDLE_DAYS * 86_400_000 + 1;
    expect(store.verify(`phone.${r2.key}`)).toBeUndefined();

    const r3 = store.pair('ipad', store.allow('ipad'));
    if (!r3.ok) throw new Error('pair ipad');
    expect(store.revoke('ipad')).toBe(true);
    expect(store.verify(`ipad.${r3.key}`)).toBeUndefined();
    expect(store.revoke('ipad')).toBe(false);
  });

  test('no code or key is ever written to the file or the log; the file is private', () => {
    const code = store.allow('phone');
    const r = store.pair('phone', code);
    if (!r.ok) throw new Error('pair');
    store.pair('phone', 'WRONG234');
    store.verify(`phone.${'f'.repeat(64)}`);
    const file = readFileSync(store.file, 'utf8');
    const log = readFileSync(store.log, 'utf8');
    for (const secret of [code, r.key]) {
      expect(file).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
    expect(log).toContain('pair phone');
    expect(log).toContain('login-failed phone');
    if (process.platform !== 'win32') {
      expect(statSync(store.file).mode & 0o777).toBe(0o600);
      expect(statSync(store.log).mode & 0o777).toBe(0o600);
    }
  });

  test('device names are short, lowercase and plain', () => {
    expect(() => store.allow('Phone')).toThrow("can't be a device name");
    expect(() => store.allow('a b')).toThrow("can't be a device name");
    expect(() => store.allow('x'.repeat(33))).toThrow("can't be a device name");
    expect(() => store.allow('ipad-air')).not.toThrow();
  });

  test('a revoke from the terminal is never undone by a running server', () => {
    const r = store.pair('phone', store.allow('phone'));
    if (!r.ok) throw new Error('pair');
    const server = new DeviceStore(dir.dir, () => now); // the server's own instance
    new DeviceStore(dir.dir, () => now).revoke('phone'); // the terminal's
    now += 2 * 60 * 60 * 1000; // late enough that a login would rewrite lastSeen
    expect(server.verify(`phone.${r.key}`)).toBeUndefined();
    expect(server.get('phone')).toBeUndefined();
  });

  test('`mrig app` arguments', () => {
    expect(parseArgs(['app'])).toMatchObject({ app: { action: 'run', open: true, pair: false } });
    expect(parseArgs(['app', '--no-open', '--pair', '--port', '5000'])).toMatchObject({
      app: { action: 'run', open: false, pair: true },
      port: 5000,
    });
    expect(parseArgs(['app', 'allow', 'add', 'phone']).app).toEqual({
      action: 'allow',
      name: 'phone',
    });
    expect(parseArgs(['app', 'devices']).app).toEqual({ action: 'devices' });
    expect(parseArgs(['app', 'revoke', 'phone']).app).toEqual({ action: 'revoke', name: 'phone' });
    expect(parseArgs(['app', 'ideas', 'for', 'my', 'site'])).toMatchObject({
      prompt: 'app ideas for my site',
    });
    expect(() => parseArgs(['--no-open'])).toThrow('--no-open works with mrig app');
    expect(() => parseArgs(['app', 'devices', '--port', '1'])).toThrow('--port works with');
  });
});
