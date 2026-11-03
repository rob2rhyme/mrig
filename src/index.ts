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
import type { Answer, AskRequest } from './permissions.ts';
import { formatModelError } from './providers.ts';
import { Runtime } from './runtime.ts';
import { Session } from './session.ts';
import { dim, green, red, yellow } from './ui/ansi.ts';
import { Repl } from './ui/repl.ts';
import { VERSION } from './version.ts';

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
  let atLineStart = true;
  const runtime = new Runtime({
    cwd,
    provider: args.provider,
    model: args.model,
    yolo: args.yolo,
    maxSteps: args.maxSteps,
    resume: args.continue ? 'latest' : args.resume,
    ask,
    events: {
      onText: (d) => {
        process.stdout.write(d);
        atLineStart = d.endsWith('\n');
      },
      onToolStart: (c) => {
        if (!atLineStart) process.stderr.write('\n');
        process.stderr.write(`${dim('⚙')} ${c.summary}\n`);
        atLineStart = true;
      },
      onToolEnd: (_c, o) => {
        if (o.status === 'denied') process.stderr.write(`  ${yellow('denied')}\n`);
        else if (o.status === 'error')
          process.stderr.write(`  ${red('error')} ${dim(o.text.split('\n')[0] ?? '')}\n`);
      },
      onNotice: (m) => process.stderr.write(`${yellow('!')} ${m}\n`),
    },
  });
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  try {
    let result: Awaited<ReturnType<typeof runtime.agent.run>>;
    try {
      result = await runtime.agent.run(args.print ?? '', ac.signal);
    } catch (err) {
      if (!atLineStart) process.stdout.write('\n');
      process.stderr.write(`${red('error:')} ${formatModelError(err, runtime.profile)}\n`);
      return 1;
    }
    if (!atLineStart) process.stdout.write('\n');
    const cost = runtime.agent.cost();
    const u = runtime.agent.usage;
    process.stderr.write(
      dim(
        `— ${result.steps} steps · ${u.inputTokens} in / ${u.outputTokens} out${cost !== undefined ? ` · ~$${cost.toFixed(4)}` : ''} · session ${runtime.session.meta.id}\n`,
      ),
    );
    return result.stop === 'done' ? 0 : result.stop === 'aborted' ? 130 : 2;
  } finally {
    runtime.save();
    rl?.close();
  }
}

/** `mrig doctor`: one line per profile; exit 1 when a checked profile has a real problem. */
async function runDoctor(args: ReturnType<typeof parseArgs>, cwd: string): Promise<number> {
  const cfg = loadConfig({ cwd });
  const checks =
    args.provider || args.model
      ? [
          await (async () => {
            const r = resolveProfile(cfg, args.provider, args.model);
            return checkProfile(r.name, r.profile);
          })(),
        ]
      : await doctor(cfg);
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
  const cwd = resolve(args.cwd ?? process.cwd());
  if (args.listSessions) {
    for (const s of Session.list())
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
  const repl = new Repl({
    cwd,
    provider: args.provider,
    model: args.model,
    yolo: args.yolo,
    maxSteps: args.maxSteps,
    resume: args.continue ? 'latest' : args.resume,
  });
  await repl.start(args.prompt);
}

main().catch((err) => {
  process.stderr.write(`${red('fatal:')} ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
