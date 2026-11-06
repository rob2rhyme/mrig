/**
 * Tailscale for `mrig app` (Track 4, U3): this Mac's Tailscale name, which `requestFrom` in
 * security.ts accepts as `Host` for other devices, and whether Serve or Funnel point at the app.
 *
 * mrig never changes Tailscale's settings. It reads them with the `tailscale` CLI, and only at
 * start-up. See §5 of docs/decisions/2026-11-06-app-front-ends.md.
 */
import { tailscaleName } from './security.ts';

/** Where the CLI usually is: on PATH, or inside the Mac app. */
export const TAILSCALE_CLIS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** Runs a command and returns its stdout, or undefined if it can't run or fails. */
export type Run = (cmd: string[]) => string | undefined;

const runCli: Run = (cmd) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore', timeout: 3000 });
    return p.success ? p.stdout.toString() : undefined;
  } catch {
    return undefined; // not installed
  }
};

export interface TailscaleInfo {
  /** This Mac's name, like `mac.tail1234.ts.net`. */
  host: string;
  /** Tailscale Serve forwards HTTPS on that name to this port. */
  serving: boolean;
  /** Funnel is on for that name: mrig refuses those requests. */
  funnel: boolean;
}

/** This Mac's Tailscale name and Serve setup, or undefined without Tailscale. */
export function detectTailscale(port: number, run: Run = runCli): TailscaleInfo | undefined {
  for (const cli of TAILSCALE_CLIS) {
    const status = run([cli, 'status', '--json']);
    if (status === undefined) continue;
    let host: string | undefined;
    try {
      const v = JSON.parse(status) as { Self?: { DNSName?: unknown } };
      host = typeof v.Self?.DNSName === 'string' ? tailscaleName(v.Self.DNSName) : undefined;
    } catch {
      host = undefined;
    }
    if (!host) return undefined;
    const serve = serveStatus(run([cli, 'serve', 'status', '--json']), host, port);
    return { host, ...serve };
  }
  return undefined;
}

/**
 * Read `tailscale serve status --json`: is `<host>:443` proxied to this port, and is Funnel on
 * for it. Shape: `{ Web: { "<host>:443": { Handlers: { "/": { Proxy } } } }, AllowFunnel }`.
 */
export function serveStatus(
  json: string | undefined,
  host: string,
  port: number,
): { serving: boolean; funnel: boolean } {
  try {
    const v = JSON.parse(json ?? '') as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      AllowFunnel?: Record<string, boolean>;
    };
    const web = v.Web?.[`${host}:443`];
    const target = web?.Handlers?.['/']?.Proxy ?? '';
    const serving = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(target);
    return { serving, funnel: v.AllowFunnel?.[`${host}:443`] === true };
  } catch {
    return { serving: false, funnel: false };
  }
}
