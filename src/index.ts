#!/usr/bin/env bun
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HELP, parseArgs } from './cli/args.ts';
import { loadConfig, resolveProfile } from './config.ts';
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
