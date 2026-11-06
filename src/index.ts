#!/usr/bin/env bun
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HELP, parseArgs } from './cli/args.ts';
import { DEFAULT_APP_PORT, loadConfig, resolveProfile } from './config.ts';
import {
  checkOllamaContext,
  checkProfile,
  doctor,
  hasProblems,
  isOllama,
  PROBLEM_STATUSES,
} from './doctor.ts';
import { runHeadless } from './headless.ts';
import { initConfig, initReport } from './init.ts';
import type { Answer, AskRequest } from './permissions.ts';
import { Session } from './session.ts';
import { dim, green, red, yellow } from './ui/ansi.ts';
import { Repl } from './ui/repl.ts';
import { VERSION } from './version.ts';
import { findZone, resolveOffline, zoneSessionsDir } from './zone.ts';

async function headless(args: ReturnType<typeof parseArgs>, cwd: string): Promise<number> {
  const interactive = process.stdin.isTTY === true;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  const ask = async (req: AskRequest): Promise<Answer> => {
    if (!rl) {
      process.stderr.write(
        `${yellow('denied (no TTY):')} ${req.summary}  ${dim('use --yolo to allow')}\n`,
      );
      return 'no';
    }
    process.stderr.write(
      `${yellow('⚠')} ${req.summary}\n${req.preview ? `${dim(req.preview)}\n` : ''}`,
    );
    const a = (await rl.question('  Allow? yes / no / always › ')).trim().toLowerCase();
    return a.startsWith('a') ? 'always' : a.startsWith('y') ? 'yes' : 'no';
  };
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  try {
    return await runHeadless(
      {
        cwd,
        prompt: args.print ?? '',
        output: args.json ? 'json' : args.outputLast ? 'last' : 'stream',
        provider: args.provider,
        model: args.model,
        // Only an explicit --yolo overrides; otherwise MRIG_YOLO and permissions.yolo apply.
        yolo: args.yolo ? true : undefined,
        offline: args.offline,
        maxSteps: args.maxSteps,
        resume: args.continue ? 'latest' : args.resume,
        mode: args.mode,
        variety: args.variety,
        // Routing (T7) stays off when -P or -m chose the model.
        routing: !args.provider && !args.model,
      },
      {
        stdout: (t) => process.stdout.write(t),
        stderr: (t) => process.stderr.write(t),
        ask,
        signal: ac.signal,
      },
    );
  } finally {
    rl?.close();
  }
}

/** `mrig doctor`: one line per profile; exit 1 when a checked profile has a real problem. */
async function runDoctor(args: ReturnType<typeof parseArgs>, cwd: string): Promise<number> {
  const cfg = loadConfig({ cwd });
  const offline = resolveOffline(cwd, args.offline) !== undefined;
  const checks =
    args.provider || args.model
      ? [
          await (async () => {
            const r = resolveProfile(cfg, args.provider, args.model);
            return checkProfile(r.name, r.profile, { offline });
          })(),
        ]
      : await doctor(cfg, { offline });
  for (const c of checks) {
    const mark =
      c.status === 'ok' ? green('✓') : PROBLEM_STATUSES.has(c.status) ? red('✗') : dim('·');
    process.stdout.write(
      `${mark} ${c.name.padEnd(10)} ${dim(`${c.profile.kind} · ${c.profile.model}`)}\n    ${c.message}\n`,
    );
    if (isOllama(c.profile) && c.status !== 'unreachable') {
      const ctx = await checkOllamaContext(c.profile);
      if (ctx.status !== 'skipped') {
        process.stdout.write(
          `    ${ctx.status === 'ok' ? dim('context:') : yellow('context:')} ${ctx.message}\n`,
        );
      }
    }
  }
  return hasProblems(checks) ? 1 : 0;
}

/**
 * `mrig serve` (Track 4, U1): start the app server, print one JSON line with its address and
 * launch token (the app that started it reads that), and run until Ctrl+C, SIGTERM, or, when
 * stdin is a pipe, until the parent closes it.
 */
async function serve(args: ReturnType<typeof parseArgs>): Promise<void> {
  const { startServer } = await import('./server/serve.ts');
  // `--with-app`: the VS Code panel (U4) shows the web app from this server, with the token.
  const app = args.withApp ? (await import('./server/app-assets.ts')).APP_ASSETS : undefined;
  const server = startServer({
    port: args.port ?? 0,
    version: VERSION,
    ...(app ? { app } : {}),
    runtime: {
      provider: args.provider,
      model: args.model,
      yolo: args.yolo ? true : undefined,
      offline: args.offline,
      maxSteps: args.maxSteps,
      mode: args.mode,
      variety: args.variety,
      routing: !args.provider && !args.model,
    },
  });
  process.stdout.write(
    `${JSON.stringify({ protocol: 1, url: server.url, ws: server.ws, token: server.token })}\n`,
  );
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.stop().then(done);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (!process.stdin.isTTY) {
      process.stdin.on('end', stop);
      process.stdin.resume();
    }
  });
}

/** Open a URL in the default browser, without a shell (the URL may hold `&`). */
function openBrowser(url: string): boolean {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** `mrig app …` (Track 4, U2): the web app on this Mac, and its device allowlist. */
async function app(
  args: ReturnType<typeof parseArgs>,
  command: NonNullable<ReturnType<typeof parseArgs>['app']>,
): Promise<void> {
  const { DeviceStore, PAIRING_MINUTES } = await import('./server/devices.ts');
  const store = new DeviceStore();
  const cwd = resolve(args.cwd ?? process.cwd());
  const port = args.port ?? loadConfig({ cwd }).app?.port ?? DEFAULT_APP_PORT;
  const out = (line = '') => process.stdout.write(`${line}\n`);

  if (command.action === 'allow') {
    const code = store.allow(command.name);
    out(`${green('✓')} ${command.name} is on the allowlist. Its one-time pairing code:`);
    out();
    out(`    ${code}`);
    out();
    out(`On that device, open mrig and enter the device name "${command.name}" and this code.`);
    out(dim(`The code works once, for ${PAIRING_MINUTES} minutes; five wrong tries cancel it.`));
    out(
      dim(
        `On this Mac the app is at http://127.0.0.1:${port}. Other devices come in U3 (Tailscale).`,
      ),
    );
    return;
  }
  if (command.action === 'devices') {
    const devices = store.list();
    if (devices.length === 0)
      out('No devices yet. `mrig app` adds this Mac; `mrig app allow add <name>` adds another.');
    for (const d of devices) {
      const state = d.keyHash
        ? `paired ${d.pairedAt?.slice(0, 10)} · last seen ${d.lastSeen?.slice(0, 16).replace('T', ' ')}`
        : d.pairing
          ? yellow(`waiting for its pairing code (until ${d.pairing.expires.slice(11, 16)} UTC)`)
          : dim('not paired');
      out(`${d.name.padEnd(16)} ${state}`);
    }
    const failures = store
      .recent(50)
      .filter((l) => l.includes('-failed'))
      .slice(-5);
    if (failures.length) {
      out();
      out(yellow('Recent failed attempts:'));
      for (const l of failures) out(dim(`  ${l}`));
    }
    return;
  }
  if (command.action === 'revoke') {
    if (store.revoke(command.name))
      out(`${green('✓')} ${command.name} can no longer log in; any open window is closed.`);
    else throw new Error(`No device named "${command.name}". \`mrig app devices\` lists them.`);
    return;
  }

  // Pair this Mac's browser the first time (or with --pair): a one-time code in the URL fragment.
  const pairing = !store.get('mac')?.keyHash || command.pair ? store.allow('mac') : undefined;
  const base = `http://127.0.0.1:${port}/`;
  const url = pairing ? `${base}#pair=${pairing}&device=mac` : base;
  const { startServer } = await import('./server/serve.ts');
  const { APP_ASSETS } = await import('./server/app-assets.ts');
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = startServer({
      port,
      devices: store,
      app: APP_ASSETS,
      version: VERSION,
      runtime: {
        provider: args.provider,
        model: args.model,
        yolo: args.yolo ? true : undefined,
        offline: args.offline,
        maxSteps: args.maxSteps,
        mode: args.mode,
        variety: args.variety,
        routing: !args.provider && !args.model,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'EADDRINUSE') throw err;
    out(`mrig app is already running at ${base}`);
    if (command.open && !openBrowser(url)) out(`Open ${url} in your browser.`);
    return;
  }
  out(`${green('●')} mrig app is running at ${base}`);
  out(
    dim(
      'Install it as an app: Chrome or Edge, the install icon in the address bar; Safari, File → Add to Dock.',
    ),
  );
  out(dim('Press Ctrl+C to stop.'));
  if (!command.open || !openBrowser(url)) out(`Open ${url} in your browser.`);
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.stop().then(done);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${red('error:')} ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`mrig ${VERSION}\n`);
    return;
  }
  if (args.init) {
    try {
      for (const line of initReport(initConfig())) process.stdout.write(`${line}\n`);
    } catch (err) {
      process.stderr.write(`${red('error:')} ${(err as Error).message}\n`);
      process.exit(1);
    }
    return;
  }
  const cwd = resolve(args.cwd ?? process.cwd());
  if (args.listSessions) {
    const zone = findZone(cwd);
    for (const s of Session.list(zone ? zoneSessionsDir(zone) : undefined))
      process.stdout.write(`${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.cwd}  ${s.title}\n`);
    return;
  }
  if (args.app) {
    try {
      await app(args, args.app);
    } catch (err) {
      process.stderr.write(`${red('error:')} ${(err as Error).message}\n`);
      process.exit(1);
    }
    return;
  }
  if (args.serve) {
    try {
      await serve(args);
    } catch (err) {
      process.stderr.write(`${red('error:')} ${(err as Error).message}\n`);
      process.exit(1);
    }
    return;
  }
  if (args.doctor) {
    try {
      process.exit(await runDoctor(args, cwd));
    } catch (err) {
      process.stderr.write(`${red('error:')} ${(err as Error).message}\n`);
      process.exit(1);
    }
  }
  if (args.print !== undefined) {
    try {
      process.exit(await headless(args, cwd));
    } catch (err) {
      process.stderr.write(`${red('error:')} ${(err as Error).message}\n`);
      process.exit(1);
    }
  }
  const options = {
    cwd,
    provider: args.provider,
    model: args.model,
    // Only an explicit --yolo overrides; otherwise MRIG_YOLO and permissions.yolo apply.
    yolo: args.yolo ? true : undefined,
    offline: args.offline,
    maxSteps: args.maxSteps,
    resume: args.continue ? 'latest' : args.resume,
    mode: args.mode,
    variety: args.variety,
    routing: !args.provider && !args.model,
  };
  if (args.tui) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { startTui } = await import('./ui/tui.tsx');
      await startTui(options, args.prompt);
      return;
    }
    process.stderr.write(`${dim('--tui needs an interactive terminal; using the plain REPL.')}\n`);
  }
  const repl = new Repl(options);
  await repl.start(args.prompt);
}

main().catch((err) => {
  process.stderr.write(`${red('fatal:')} ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
