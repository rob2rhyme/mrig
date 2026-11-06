/**
 * Interactive terminal loop: streaming output, tool-call lines, permission prompts,
 * slash commands, Ctrl+C to abort a run (twice to exit).
 */
import { createInterface, type Interface } from 'node:readline/promises';
import type { AgentEvents, ToolCallInfo, ToolCallOutcome } from '../agent.ts';
import type { Answer, AskRequest } from '../permissions.ts';
import { formatModelError } from '../providers.ts';
import { Runtime, type RuntimeOptions } from '../runtime.ts';
import { bold, cyan, dim, magenta, red, yellow } from './ansi.ts';
import { bannerLines, runCommand, startupChecks } from './commands.ts';

const out = (s: string) => process.stdout.write(s);

export class Repl {
  private rl: Interface;
  private runtime!: Runtime;
  private running: AbortController | null = null;
  private questionAbort: AbortController | null = null;
  private atLineStart = true;
  private thinking = false;
  /** Reasoning is being printed (dim) for /verbose; the next text or tool line starts a new line. */
  private inReasoning = false;
  private sigintAt = 0;

  constructor(private readonly opts: Omit<RuntimeOptions, 'ask' | 'events'>) {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    this.rl.on('SIGINT', () => this.onSigint());
  }

  private onSigint(): void {
    if (this.running) {
      this.running.abort();
      this.write(`\n${yellow('⏹ aborted')}\n`);
      return;
    }
    if (this.questionAbort) {
      const now = Date.now();
      if (now - this.sigintAt < 1500) {
        this.write('\n');
        this.rl.close();
        process.exit(0);
      }
      this.sigintAt = now;
      this.questionAbort.abort();
      this.write(`\n${dim('(press Ctrl+C again to exit)')}\n`);
    }
  }

  private write(s: string): void {
    if (this.thinking) {
      this.clearThinking();
    }
    out(s);
    this.atLineStart = s.endsWith('\n');
  }

  /** Close a /verbose reasoning block so the answer starts on its own line. */
  private endReasoning(): void {
    if (!this.inReasoning) return;
    this.inReasoning = false;
    this.ensureNewline();
  }

  private ensureNewline(): void {
    if (!this.atLineStart) this.write('\n');
  }

  private showThinking(): void {
    if (!process.stdout.isTTY) return;
    out(dim('· thinking…'));
    this.thinking = true;
  }

  private clearThinking(): void {
    if (!this.thinking) return;
    this.thinking = false;
    out('\r\x1b[K');
  }

  private events(): AgentEvents {
    return {
      onText: (delta) => {
        this.endReasoning();
        this.write(delta);
      },
      onReasoning: (delta) => {
        if (!this.runtime.verbose || !delta) return;
        if (!this.inReasoning) {
          this.ensureNewline();
          this.write(dim('thinking: '));
          this.inReasoning = true;
        }
        this.write(dim(delta));
      },
      onToolStart: (call: ToolCallInfo) => {
        this.endReasoning();
        this.ensureNewline();
        this.write(`${dim('⚙')} ${cyan(call.summary)}`);
      },
      onToolEnd: (_call: ToolCallInfo, outcome: ToolCallOutcome) => {
        const secs = (outcome.ms / 1000).toFixed(1);
        if (outcome.status === 'ok') {
          const lines = outcome.text.split('\n').length;
          this.write(` ${dim(`✓ ${lines} line${lines === 1 ? '' : 's'} · ${secs}s`)}\n`);
        } else if (outcome.status === 'denied') {
          this.write(` ${yellow('✗ denied')}\n`);
        } else {
          this.write(` ${red('✗ error')} ${dim(outcome.text.split('\n')[0] ?? '')}\n`);
        }
        this.showThinking();
      },
      onNotice: (msg) => {
        this.ensureNewline();
        this.write(`${yellow('!')} ${msg}\n`);
      },
    };
  }

  private async ask(req: AskRequest): Promise<Answer> {
    this.clearThinking();
    this.ensureNewline();
    this.write(`${yellow('⚠')} ${bold(req.summary)}\n`);
    if (req.preview) this.write(`${dim(req.preview)}\n`);
    for (;;) {
      const answer = (
        await this.rl.question(
          `  Allow? ${bold('y')}es / ${bold('n')}o / ${bold('a')}lways (${dim(req.alwaysRule)}) › `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') return 'yes';
      if (answer === 'n' || answer === 'no' || answer === '') return 'no';
      if (answer === 'a' || answer === 'always') return 'always';
    }
  }

  async start(initialPrompt?: string): Promise<void> {
    try {
      this.runtime = new Runtime({ ...this.opts, ask: (r) => this.ask(r), events: this.events() });
    } catch (err) {
      this.write(`${red('error:')} ${(err as Error).message}\n`);
      this.rl.close();
      process.exitCode = 1;
      return;
    }
    await this.runtime.startMcp();
    this.banner();
    const rt = this.runtime;
    startupChecks(
      rt,
      (m) => this.write(`${yellow('!')} ${m}\n`),
      () => this.runtime === rt,
    );
    if (initialPrompt) await this.send(initialPrompt);
    for (;;) {
      const line = await this.prompt();
      if (line === null) break;
      const text = line.trim();
      if (!text) continue;
      if (text.startsWith('/')) {
        if (await this.command(text)) break;
        continue;
      }
      await this.send(text);
    }
    this.rl.close();
    await this.runtime.close();
  }

  private banner(): void {
    this.write(`${bannerLines(this.runtime).join('\n')}\n\n`);
  }

  private async prompt(): Promise<string | null> {
    this.questionAbort = new AbortController();
    try {
      return await this.rl.question(`${bold(magenta('❯'))} `, {
        signal: this.questionAbort.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return '';
      return null;
    } finally {
      this.questionAbort = null;
    }
  }

  private async send(text: string): Promise<void> {
    const rt = this.runtime;
    this.running = new AbortController();
    this.write('\n');
    this.showThinking();
    try {
      const result = await rt.runTurn(text, this.running.signal);
      this.clearThinking();
      this.ensureNewline();
      const cost = rt.agent.cost();
      const u = rt.agent.usage;
      this.write(
        `${dim(`— ${result.steps} step${result.steps === 1 ? '' : 's'} · ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out${cost !== undefined ? ` · ~$${cost.toFixed(4)}` : ''}`)}\n\n`,
      );
    } catch (err) {
      this.clearThinking();
      this.ensureNewline();
      this.write(`${red('error:')} ${formatModelError(err, rt.profile)}\n\n`);
    } finally {
      this.running = null;
      this.inReasoning = false;
      rt.save();
    }
  }

  /** Returns true when the REPL should exit. */
  private async command(text: string): Promise<boolean> {
    return runCommand(this.runtime, text, {
      write: (s) => this.write(s),
      busy: async (run) => {
        this.running = new AbortController();
        this.showThinking();
        try {
          return await run(this.running.signal);
        } finally {
          this.clearThinking();
          this.running = null;
        }
      },
    });
  }
}
