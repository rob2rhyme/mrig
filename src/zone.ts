/**
 * The offline guarantee (L5), as pure rules. The Runtime applies them at every way in.
 *
 * Offline mode is on with `--offline`, or inside an **offline zone**: a folder holding a
 * `.mrig-zone` marker, found by the same upward search as AGENTS.md (from the working directory
 * up to the git root). In offline mode mrig:
 *
 *   - refuses any provider profile whose server is not on loopback (this machine);
 *   - drops tools that reach other hosts (web fetch, remote MCP: none ship yet, L6 adds them);
 *   - refuses to turn permission prompts off (--yolo, MRIG_YOLO, permissions.yolo) and ignores
 *     bash allow-rules, because the shell is the one remaining way out: every command asks.
 *
 * Inside a zone it also keeps transcripts in the zone (`<zone>/.mrig/sessions`) and refuses to
 * resume a session across the zone's boundary.
 *
 * What it does not do: sandbox the shell. A command you approve can still reach the network.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProviderProfile } from './config.ts';

export const ZONE_MARKER = '.mrig-zone';

export interface Offline {
  /** `zone` when a marker was found (it wins over the flag), else `flag`. */
  source: 'flag' | 'zone';
  /** The zone's root: the folder holding the marker. Absent for `--offline` alone. */
  zone?: string;
}

/** A rule of the offline guarantee was broken. The message says what and how to proceed. */
export class OfflineError extends Error {}

/**
 * Hostnames that always mean this machine. Deliberately strict: `127.example.com`,
 * `localhost.example.com` and `*.localhost` names are not trusted, because DNS decides them.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]' || h === '0.0.0.0') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m?.slice(1).every((n) => Number(n) <= 255) ?? false;
}

export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * A profile whose server is on this machine. Decided by the base URL alone, whatever the kind:
 * an Anthropic-compatible endpoint on localhost is local; a profile with no base URL talks to
 * the provider's cloud API.
 */
export function isLocalProfile(profile: ProviderProfile): boolean {
  return isLoopbackUrl(profile.baseURL);
}

/** The folder holding a `.mrig-zone` marker, searching from cwd up to the git root. */
export function findZone(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ZONE_MARKER))) return dir;
    if (existsSync(join(dir, '.git'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveOffline(cwd: string, flag = false): Offline | undefined {
  const zone = findZone(cwd);
  if (zone) return { source: 'zone', zone };
  return flag ? { source: 'flag' } : undefined;
}

export function describeOffline(offline: Offline): string {
  return offline.zone ? `Offline zone ${offline.zone}` : 'Offline mode (--offline)';
}

function where(profile: ProviderProfile): string {
  if (!profile.baseURL) return `the ${profile.kind} cloud API`;
  try {
    return new URL(profile.baseURL).host;
  } catch {
    return profile.baseURL;
  }
}

export function assertProfileAllowed(
  name: string,
  profile: ProviderProfile,
  offline: Offline | undefined,
): void {
  if (!offline || isLocalProfile(profile)) return;
  throw new OfflineError(
    `${describeOffline(offline)} only allows profiles on this machine, and "${name}" uses ${where(profile)}. Pick a local profile such as ollama (-P ollama), or work outside the zone.`,
  );
}

export function assertNoYolo(yolo: boolean, offline: Offline | undefined): void {
  if (!offline || !yolo) return;
  throw new OfflineError(
    `${describeOffline(offline)} keeps permission prompts on: --yolo, MRIG_YOLO and permissions.yolo are refused here. Every write, edit and command asks.`,
  );
}

/** Offline mode ignores bash allow-rules (the shell is the way out); other rules stay. */
export function splitBashRules(allow: string[]): { kept: string[]; dropped: string[] } {
  const isBash = (r: string) => r.trim().startsWith('bash:');
  return { kept: allow.filter((r) => !isBash(r)), dropped: allow.filter(isBash) };
}

/** Tools that talk to other hosts are dropped offline. */
export function offlineTools<T extends { remote?: boolean }>(
  tools: T[],
  offline: Offline | undefined,
): T[] {
  return offline ? tools.filter((t) => !t.remote) : tools;
}

/** `<zone>/.mrig/sessions`, created with a `.gitignore` so transcripts never get committed. */
export function zoneSessionsDir(zone: string): string {
  const dir = join(zone, '.mrig', 'sessions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore))
    writeFileSync(ignore, '# mrig offline-zone transcripts: never commit\n*\n');
  return dir;
}

/** A session may only be resumed on the same side of a zone boundary it was created on. */
export function assertResumeAllowed(
  meta: { id: string; zone?: string },
  offline: Offline | undefined,
): void {
  const here = offline?.zone;
  if (meta.zone === here) return;
  if (meta.zone && !here) {
    throw new OfflineError(
      `Session ${meta.id} belongs to the offline zone ${meta.zone}. Resume it from inside that zone.`,
    );
  }
  if (!meta.zone && here) {
    throw new OfflineError(
      `Session ${meta.id} was started outside the offline zone ${here}, so it cannot be resumed inside it.`,
    );
  }
  throw new OfflineError(
    `Session ${meta.id} belongs to the offline zone ${meta.zone}, not to ${here}. Sessions cannot cross zones.`,
  );
}
