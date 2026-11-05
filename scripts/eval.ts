#!/usr/bin/env bun
/**
 * Run the mrig eval suite: `bun run eval` (see README, "Evaluating models").
 *
 * Runs each task against each profile, prints a summary, saves raw results as JSON, and can
 * regenerate the compatibility matrix from everything saved so far.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { type CheckStatus, checkProfile } from '../src/doctor.ts';
import { dim, green, red, yellow } from '../src/ui/ansi.ts';
import { EVAL_HELP, parseEvalArgs } from './eval/args.ts';
import {
  loadResults,
  type ProfileResult,
  runProfile,
  saveResult,
  summarize,
} from './eval/harness.ts';
import { recommendLocal, renderMatrix, renderSummary } from './eval/report.ts';
import { type EvalTask, selectTasks, TASKS } from './eval/tasks.ts';

const SKIP: ReadonlySet<CheckStatus> = new Set(['no-key', 'auth', 'unreachable', 'unknown-model']);
const err = (s: string) => process.stderr.write(s);

function writeMatrix(path: string, results: ProfileResult[]): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, renderMatrix(results));
  err(`${dim('matrix written to')} ${abs}\n`);
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseEvalArgs>;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (e) {
    err(`${red('error:')} ${(e as Error).message}\n\n${EVAL_HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(EVAL_HELP);
    return 0;
  }
  if (args.list) {
    for (const t of TASKS) {
      process.stdout.write(
        `${t.id.padEnd(16)} ${t.category.padEnd(7)} ${t.prompt.split('\n')[0]}\n`,
      );
    }
    return 0;
  }
  if (args.report) {
    writeMatrix(args.matrix ?? 'docs/COMPATIBILITY.md', loadResults(args.out));
    return 0;
  }

  let tasks: EvalTask[];
  try {
    tasks = selectTasks(args.tasks);
  } catch (e) {
    err(`${red('error:')} ${(e as Error).message}\n`);
    return 2;
  }
  const config = loadConfig({ cwd: process.cwd() });
  const names = args.profiles ?? Object.keys(config.providers);
  for (const n of names) {
    if (!config.providers[n]) {
      err(
        `${red('error:')} Unknown profile "${n}". Known: ${Object.keys(config.providers).join(', ')}\n`,
      );
      return 2;
    }
  }
  err(
    `${yellow('!')} Tasks run with permissions off in a temp directory; the model can run any shell command.\n`,
  );

  const ran: ProfileResult[] = [];
  for (const name of names) {
    const profile = config.providers[name];
    if (!profile) continue;
    if (!args.noCheck) {
      const check = await checkProfile(name, profile);
      if (SKIP.has(check.status)) {
        err(`${dim('·')} ${name}: skipped, ${check.message}\n`);
        continue;
      }
    }
    err(
      `\n▶ ${name} ${dim(`(${profile.model}, ${profile.toolMode ?? 'full'} tools) · ${tasks.length} tasks`)}\n`,
    );
    const result = await runProfile({
      profile: name,
      maxSteps: args.maxSteps,
      timeoutMs: args.timeoutSec * 1000,
      config,
      tasks,
      onTask: (r) => {
        const mark = r.pass ? green('✓') : red('✗');
        const detail = r.pass ? '' : `  ${dim(r.reason)}`;
        err(
          `  ${mark} ${r.id.padEnd(16)} ${String(r.steps).padStart(2)} steps ${(r.ms / 1000).toFixed(1).padStart(6)}s${detail}\n`,
        );
      },
    });
    const file = saveResult(args.out, result);
    const s = summarize(result);
    err(`  ${dim(`${s.passed}/${s.total} passed · saved ${file}`)}\n`);
    ran.push(result);
  }

  if (ran.length === 0) {
    err(`\n${red('Nothing ran.')} Every profile was skipped; see above, or pass --no-check.\n`);
    return 2;
  }
  process.stdout.write(`\n${renderSummary(ran)}\n`);
  const best = recommendLocal(ran);
  if (best)
    process.stdout.write(`\nBest local profile this run: ${best.profile} (${best.model})\n`);
  if (args.matrix) writeMatrix(args.matrix, loadResults(args.out));
  return 0;
}

process.exit(await main());
