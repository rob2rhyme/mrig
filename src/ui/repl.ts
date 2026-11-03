/**
 * Interactive terminal loop: streaming output, tool-call lines, permission prompts,
 * slash commands, Ctrl+C to abort a run (twice to exit).
 */
import { createInterface, type Interface } from 'node:readline/promises';
import type { AgentEvents, ToolCallInfo, ToolCallOutcome } from '../agent.ts';
import type { Answer, AskRequest } from '../permissions.ts';
import { findMemoryFiles } from '../prompt.ts';
import { CACHE_WRITE_MULTIPLIER, explainCacheMiss, formatModelError } from '../providers.ts';
import { Runtime, type RuntimeOptions } from '../runtime.ts';
import { Session } from '../session.ts';
import { VERSION } from '../version.ts';
import { bold, cyan, dim, green, magenta, red, yellow } from './ansi.ts';

const out = (s: string) => process.stdout.write(s);

export class Repl {
  private rl: Interface;
  private runtime!: Runtime;
  private running: AbortController | null = null;
  private questionAbort: AbortController | null = null;
  private atLineStart = true;
  private thinking = false;
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
      onText: (delta) => this.write(delta),
      onReasoning: () => {
        // Reasoning is not shown by default; a future /verbose flag can surface it.
      },
      onToolStart: (call: ToolCallInfo) => {
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
    this.banner();
    this.checkModelInBackground();
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
  }

  /**
   * Startup checks (L1, L2): short background requests; only problems are reported.
   * Model id not served by the provider, or an Ollama model running with under 32k context.
   */
  private checkModelInBackground(): void {
    const rt = this.runtime;
    void rt
      .checkModel({ timeoutMs: 3000 })
      .then((c) => {
        if (c.status !== 'unknown-model' || this.runtime !== rt) return;
        this.write(`${yellow('!')} ${c.message} ${dim('· mrig doctor')}\n`);
      })
      .catch(() => {});
    void rt
      .checkContext({ timeoutMs: 3000 })
      .then((c) => {
        if ((c.status !== 'low' && c.status !== 'unknown') || this.runtime !== rt) return;
        this.write(`${yellow('!')} ${c.message}\n`);
      })
      .catch(() => {});
  }

  private banner(): void {
    const rt = this.runtime;
    const memory = findMemoryFiles(rt.cwd);
    this.write(
      `${bold(magenta('mrig'))} ${dim(`v${VERSION}`)} · ${rt.modelLabel()}${rt.permissions.yolo ? ` · ${yellow('yolo')}` : ''}\n`,
    );
    this.write(
      `${dim(`${rt.cwd}${memory.length ? ` · memory: ${memory.map((m) => m.split('/').pop()).join(', ')}` : ''}`)}\n`,
    );
    if (rt.agent.messages.length)
      this.write(
        `${dim(`resumed session ${rt.session.meta.id} (${rt.agent.messages.length} messages)`)}\n`,
      );
    this.write(`${dim('/help for commands · Ctrl+C aborts a run · /exit to quit')}\n\n`);
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
      const result = await rt.agent.run(text, this.running.signal);
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
      rt.save();
    }
  }

  /** Returns true when the REPL should exit. */
  private async command(text: string): Promise<boolean> {
    const rt = this.runtime;
    const [cmd = '', ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'exit':
      case 'quit':
      case 'q':
        return true;
      case 'help':
        this.write(
          `${[
            `${bold('/model <id>')}        switch model within the current provider`,
            `${bold('/provider <name>')}   switch provider profile (keeps the conversation)`,
            `${bold('/providers')}         list configured profiles`,
            `${bold('/cost')}              tokens and estimated spend this session`,
            `${bold('/compact')}           summarize the conversation to free context`,
            `${bold('/clear')}             start a fresh conversation (same session file)`,
            `${bold('/yolo')}              toggle permission prompts`,
            `${bold('/sessions')}          list saved sessions · ${bold('/resume <id>')} to load one`,
            `${bold('/tools')}             list tools · ${bold('/memory')} show loaded AGENTS.md files`,
            `${bold('/exit')}              quit`,
          ].join('\n')}\n\n`,
        );
        return false;
      case 'model':
        if (!arg) return this.info(`model: ${rt.modelLabel()}`);
        return this.trySwitch(undefined, arg);
      case 'provider':
        if (!arg) return this.info(`provider: ${rt.providerName}`);
        return this.trySwitch(arg, undefined);
      case 'providers':
        for (const [name, p] of Object.entries(rt.config.providers)) {
          const mark = name === rt.providerName ? green('●') : dim('○');
          this.write(
            `${mark} ${bold(name.padEnd(10))} ${p.kind.padEnd(18)} ${p.model}${p.baseURL ? dim(`  ${p.baseURL}`) : ''}\n`,
          );
        }
        this.write('\n');
        return false;
      case 'cost': {
        const u = rt.agent.usage;
        const cost = rt.agent.cost();
        const lines = [
          `${u.requests} requests · ${u.inputTokens.toLocaleString()} input (${u.cacheReadTokens.toLocaleString()} cache read, ${u.cacheWriteTokens.toLocaleString()} cache write) · ${u.outputTokens.toLocaleString()} output · ${cost !== undefined ? `~$${cost.toFixed(4)}` : 'pricing unknown'}`,
        ];
        if (rt.profile.kind === 'anthropic') {
          const ttl = rt.agent.cacheTtl();
          lines.push(
            `prompt cache: ${ttl} TTL · writes billed at ${CACHE_WRITE_MULTIPLIER[ttl]}× input (cacheTtl in config)`,
          );
        }
        const miss = explainCacheMiss(u, rt.profile);
        if (miss) lines.push(miss);
        return this.info(lines.join('\n'));
      }
      case 'compact': {
        this.running = new AbortController();
        this.showThinking();
        try {
          const summary = await rt.agent.compact(this.running.signal);
          this.clearThinking();
          this.write(`${dim(summary)}\n`);
          this.info('Compacted.');
        } catch (err) {
          this.clearThinking();
          this.write(`${red('error:')} ${formatModelError(err, rt.profile)}\n\n`);
        } finally {
          this.running = null;
          rt.save();
        }
        return false;
      }
      case 'clear':
        rt.agent.clear();
        rt.save();
        return this.info('Conversation cleared.');
      case 'yolo':
        rt.permissions.yolo = !rt.permissions.yolo;
        return this.info(
          rt.permissions.yolo
            ? yellow('yolo ON — no permission prompts')
            : 'yolo off — prompts enabled',
        );
      case 'sessions': {
        const list = Session.list().slice(0, 20);
        if (!list.length) return this.info('No sessions yet.');
        for (const s of list) {
          const here = s.cwd === rt.cwd ? green('•') : dim('·');
          this.write(
            `${here} ${s.id}  ${dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${s.title || dim('(empty)')}\n`,
          );
        }
        this.write('\n');
        return false;
      }
      case 'resume': {
        if (!arg) return this.info('usage: /resume <id>');
        try {
          const s = Session.load(arg);
          rt.session = s;
          rt.agent.messages = s.messages;
          return this.info(`Resumed ${s.meta.id} (${s.messages.length} messages).`);
        } catch (err) {
          return this.info(red((err as Error).message));
        }
      }
      case 'tools':
        for (const t of rt.agent.opts.tools)
          this.write(
            `${bold(t.name.padEnd(6))} ${t.readOnly ? dim('read-only') : yellow('asks')}  ${dim(t.description.split('. ')[0] ?? '')}\n`,
          );
        this.write('\n');
        return false;
      case 'memory': {
        const files = findMemoryFiles(rt.cwd);
        return this.info(
          files.length
            ? files.join('\n')
            : 'No AGENTS.md / MRIG.md found from here to the git root.',
        );
      }
      default:
        return this.info(`Unknown command /${cmd}. Try /help.`);
    }
  }

  private info(msg: string): false {
    this.write(`${msg}\n\n`);
    return false;
  }

  private trySwitch(provider?: string, model?: string): false {
    try {
      this.runtime.switchModel(provider, model);
      return this.info(`now using ${this.runtime.modelLabel()}`);
    } catch (err) {
      return this.info(red((err as Error).message));
    }
  }
}
