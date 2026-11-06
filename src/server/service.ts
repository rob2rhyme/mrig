/**
 * `mrig app service install | remove | status` (Track 4, U3): keep `mrig app` running in the
 * background on the Mac, so a phone can reach it any time the Mac is on and awake.
 *
 * It is a macOS LaunchAgent: a plist in ~/Library/LaunchAgents that starts at login and is
 * restarted if it stops. It runs through your login shell (`-lic`), so the API keys you export
 * in ~/.zshrc reach it; no key is ever written into the plist. Output goes to
 * ~/.mrig/app/service.log.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { appDir } from './devices.ts';

export const SERVICE_LABEL = 'com.rob2rhyme.mrig.app';

/** Runs a command; the result says whether it worked and what it printed. */
export type ServiceRun = (cmd: string[]) => { ok: boolean; output: string };

const runCmd: ServiceRun = (cmd) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    return { ok: p.success, output: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
};

export interface ServiceEnv {
  platform: string;
  home: string;
  uid: number;
  /** The user's login shell. */
  shell: string;
  /** How to start mrig: the binary, or bun and the script when run from source. */
  command: string[];
  run: ServiceRun;
}

export function defaultServiceEnv(): ServiceEnv {
  const exe = process.execPath;
  const fromSource = /^bun(\.exe)?$/i.test(basename(exe));
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    shell: process.env.SHELL || '/bin/zsh',
    command: fromSource ? [exe, Bun.main] : [exe],
    run: runCmd,
  };
}

export function plistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/** A string as one single-quoted shell word. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The LaunchAgent: `mrig app --no-open` through the login shell, started at login, kept alive. */
export function launchAgentPlist(env: Pick<ServiceEnv, 'home' | 'shell' | 'command'>, log: string) {
  const line = `exec ${[...env.command, 'app', '--no-open'].map(shellQuote).join(' ')}`;
  const args = [env.shell, '-lic', line].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(env.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function macOnly(env: ServiceEnv): void {
  if (env.platform !== 'darwin') {
    throw new Error(
      'mrig app service works on macOS only for now. Elsewhere, start `mrig app --no-open` from your own login items or a systemd user service.',
    );
  }
}

/** Write the LaunchAgent and start it (replacing an older one). Returns what to tell the user. */
export function installService(env: ServiceEnv = defaultServiceEnv()): string[] {
  macOnly(env);
  const plist = plistPath(env.home);
  const log = join(appDir(), 'service.log');
  mkdirSync(join(plist, '..'), { recursive: true });
  mkdirSync(appDir(), { recursive: true, mode: 0o700 });
  const target = `gui/${env.uid}`;
  // An older copy may be loaded: take it out first (failing is fine when there is none).
  env.run(['launchctl', 'bootout', `${target}/${SERVICE_LABEL}`]);
  writeFileSync(plist, launchAgentPlist(env, log), { mode: 0o644 });
  const started = env.run(['launchctl', 'bootstrap', target, plist]);
  if (!started.ok) throw new Error(`launchctl could not start it: ${started.output}`);
  return [
    `mrig app now runs in the background, and starts when you log in.`,
    `Its output goes to ${log}.`,
    `\`mrig app service remove\` stops it.`,
  ];
}

/** Stop the LaunchAgent and delete it. */
export function removeService(env: ServiceEnv = defaultServiceEnv()): string[] {
  macOnly(env);
  const plist = plistPath(env.home);
  const had = existsSync(plist);
  env.run(['launchctl', 'bootout', `gui/${env.uid}/${SERVICE_LABEL}`]);
  rmSync(plist, { force: true });
  return [
    had
      ? 'mrig app no longer runs in the background.'
      : 'The background service was not installed.',
  ];
}

/** Is it installed, and is launchd running it. */
export function serviceStatus(env: ServiceEnv = defaultServiceEnv()): string[] {
  macOnly(env);
  if (!existsSync(plistPath(env.home)))
    return ['Not installed. `mrig app service install` adds it.'];
  const print = env.run(['launchctl', 'print', `gui/${env.uid}/${SERVICE_LABEL}`]);
  const state = /state = (\w+)/.exec(print.output)?.[1];
  return [
    print.ok
      ? `Installed; launchd reports it ${state ?? 'loaded'}.`
      : 'Installed, but launchd is not running it. `mrig app service install` restarts it.',
  ];
}
