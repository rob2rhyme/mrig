#!/usr/bin/env bun
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HELP, parseArgs } from './cli/args.ts';
import type { Answer, AskRequest } from './permissions.ts';
import { formatModelError } from './providers.ts';
import { Runtime } from './runtime.ts';
import { Session } from './session.ts';
import { dim, red, yellow } from './ui/ansi.ts';
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
