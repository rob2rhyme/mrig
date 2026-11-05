/**
 * Slash commands, shared by the readline REPL and the TUI so both behave the same. They write
 * plain text (with ANSI colour) through `io`; neither UI holds command logic of its own.
 */
import { langReport } from '../lang/memory.ts';
import { isModeName, MODE_NAMES, MODES } from '../modes.ts';
import { findMemoryFiles } from '../prompt.ts';
import { CACHE_WRITE_MULTIPLIER, explainCacheMiss, formatModelError } from '../providers.ts';
import type { Runtime } from '../runtime.ts';
import { VERSION } from '../version.ts';
import { describeOffline } from '../zone.ts';
import { bold, dim, green, magenta, red, yellow } from './ansi.ts';

export interface CommandIO {
  /** Write text as is (it carries its own newlines). */
  write(text: string): void;
  /** Run a long, abortable operation (`/compact`) while the UI shows it is busy. */
  busy<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** Run a `/command`. Returns true when the UI should exit. */
export async function runCommand(rt: Runtime, text: string, io: CommandIO): Promise<boolean> {
  const [cmd = '', ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const info = (msg: string): false => {
    io.write(`${msg}\n\n`);
    return false;
  };
  const trySwitch = (provider?: string, model?: string): false => {
    try {
      rt.switchModel(provider, model);
      return info(`now using ${rt.modelLabel()}`);
    } catch (err) {
      return info(red((err as Error).message));
    }
  };
  switch (cmd) {
    case 'exit':
    case 'quit':
    case 'q':
      return true;
    case 'help':
      io.write(
        `${[
          `${bold('/model <id>')}        switch model within the current provider`,
          `${bold('/provider <name>')}   switch provider profile (keeps the conversation)`,
          `${bold('/providers')}         list configured profiles`,
          `${bold('/cost')}              tokens and estimated spend this session`,
          `${bold('/context')}           how full the context is, and when it compacts`,
          `${bold('/compact')}           summarize the conversation to free context`,
          `${bold('/clear')}             start a fresh conversation (same session file)`,
          `${bold('/yolo')}              toggle permission prompts`,
          `${bold('/mode <name>')}       ${MODE_NAMES.join(' | ')}: how mrig works with you`,
          `${bold('/verbose')}           show or hide the model's reasoning`,
          `${bold('/sessions')}          list saved sessions · ${bold('/resume <id>')} to load one`,
          `${bold('/tools')}             list tools · ${bold('/memory')} show loaded AGENTS.md files`,
          `${bold('/mcp')}               MCP servers and the tools they added`,
          `${bold('/lang')}              language memory loaded from lang/*.md · ${bold('/lang reload')} to reread`,
          `${bold('/exit')}              quit`,
        ].join('\n')}\n\n`,
      );
      return false;
    case 'model':
      if (!arg) return info(`model: ${rt.modelLabel()}`);
      return trySwitch(undefined, arg);
    case 'provider':
      if (!arg) return info(`provider: ${rt.providerName}`);
      return trySwitch(arg, undefined);
    case 'providers':
      for (const [name, p] of Object.entries(rt.config.providers)) {
        const mark = name === rt.providerName ? green('●') : dim('○');
        io.write(
          `${mark} ${bold(name.padEnd(10))} ${p.kind.padEnd(18)} ${p.model}${p.baseURL ? dim(`  ${p.baseURL}`) : ''}\n`,
        );
      }
      io.write('\n');
      return false;
    case 'context': {
      const r = rt.agent.contextReport();
      const pct = Math.round((r.estimate / r.window) * 100);
      const when =
        r.threshold !== undefined
          ? `compacts at ~${r.threshold.toLocaleString()}`
          : 'auto-compaction off';
      return info(
        `~${r.estimate.toLocaleString()} of ${r.window.toLocaleString()} tokens (${pct}%) · ${when} · /compact summarizes now`,
      );
    }
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
      return info(lines.join('\n'));
    }
    case 'compact': {
      try {
        const summary = await io.busy((signal) => rt.agent.compact(signal));
        io.write(`${dim(summary)}\n`);
        info('Compacted.');
      } catch (err) {
        io.write(`${red('error:')} ${formatModelError(err, rt.profile)}\n\n`);
      } finally {
        rt.save();
      }
      return false;
    }
    case 'clear':
      rt.agent.clear();
      rt.save();
      return info('Conversation cleared.');
    case 'yolo':
      try {
        rt.setYolo(!rt.permissions.yolo);
      } catch (err) {
        return info(red((err as Error).message));
      }
      return info(
        rt.permissions.yolo
          ? yellow('yolo ON — no permission prompts')
          : 'yolo off — prompts enabled',
      );
    case 'mode': {
      if (!arg) {
        return info(
          MODE_NAMES.map(
            (n) =>
              `${n === rt.mode ? green('●') : dim('○')} ${bold(n.padEnd(8))} ${MODES[n].summary}`,
          ).join('\n'),
        );
      }
      if (!isModeName(arg))
        return info(red(`Unknown mode "${arg}". Modes: ${MODE_NAMES.join(', ')}.`));
      rt.setMode(arg);
      return info(`now in ${bold(arg)} mode: ${MODES[arg].summary}`);
    }
    case 'verbose': {
      if (arg && arg !== 'on' && arg !== 'off') return info('usage: /verbose [on|off]');
      rt.verbose = arg ? arg === 'on' : !rt.verbose;
      return info(
        rt.verbose
          ? `verbose on: reasoning is shown ${dim('(only models that stream it, such as Qwen3 or DeepSeek on a local server)')}`
          : 'verbose off: reasoning is hidden',
      );
    }
    case 'sessions': {
      const list = rt.listSessions().slice(0, 20);
      if (!list.length) return info('No sessions yet.');
      for (const s of list) {
        const here = s.cwd === rt.cwd ? green('•') : dim('·');
        io.write(
          `${here} ${s.id}  ${dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${s.title || dim('(empty)')}\n`,
        );
      }
      io.write('\n');
      return false;
    }
    case 'resume': {
      if (!arg) return info('usage: /resume <id>');
      try {
        const s = rt.resume(arg);
        return info(`Resumed ${s.meta.id} (${s.messages.length} messages).`);
      } catch (err) {
        return info(red((err as Error).message));
      }
    }
    case 'lang': {
      if (arg && arg !== 'reload') return info('usage: /lang [reload]');
      const before = rt.lang.block;
      const mem = arg === 'reload' ? rt.reloadLang() : rt.lang;
      const lines = langReport(mem, rt.cwd);
      if (arg === 'reload') {
        lines.push(
          dim(
            mem.block === before
              ? 'Unchanged; the cached prompt stays as it is.'
              : 'Reloaded. The system prompt changed, so the next request writes it to the cache again.',
          ),
        );
      }
      return info(lines.join('\n'));
    }
    case 'mcp':
      for (const line of rt.mcpReport()) io.write(`${line}\n`);
      io.write('\n');
      return false;
    case 'tools':
      for (const t of rt.agent.opts.tools)
        io.write(
          `${bold(t.name.padEnd(6))} ${t.readOnly ? dim('read-only') : yellow('asks')}  ${dim(t.description.split('. ')[0] ?? '')}\n`,
        );
      io.write('\n');
      return false;
    case 'memory': {
      const files = findMemoryFiles(rt.cwd);
      return info(
        files.length ? files.join('\n') : 'No AGENTS.md / MRIG.md found from here to the git root.',
      );
    }
    default:
      return info(`Unknown command /${cmd}. Try /help.`);
  }
}

/** The startup banner, one string per line (with ANSI colour). */
export function bannerLines(rt: Runtime): string[] {
  const lines: string[] = [];
  const memory = findMemoryFiles(rt.cwd);
  lines.push(
    `${bold(magenta('mrig'))} ${dim(`v${VERSION}`)} · ${rt.modelLabel()}${rt.mode !== 'default' ? ` · ${magenta(`${rt.mode} mode`)}` : ''}${rt.permissions.promptsSkipped ? ` · ${yellow('yolo')}` : ''}`,
  );
  if (rt.offline) {
    lines.push(
      `${yellow(describeOffline(rt.offline))} ${dim('· local models only · every write, edit and command asks')}`,
    );
  }
  lines.push(
    dim(
      `${rt.cwd}${memory.length ? ` · memory: ${memory.map((m) => m.split('/').pop()).join(', ')}` : ''}`,
    ),
  );
  if (rt.lang.files.length > 0) {
    const tags = [...new Set(rt.lang.files.map((f) => f.tag))].join(', ');
    lines.push(
      dim(
        `lang: ${rt.lang.files.length} file${rt.lang.files.length === 1 ? '' : 's'} (${tags}) · ~${rt.lang.tokens.toLocaleString()} tokens · /lang`,
      ),
    );
  }
  const mcp = rt.mcpStatus();
  if (mcp.length > 0) {
    const up = mcp.filter((x) => x.state === 'connected');
    const tools = up.reduce((n, x) => n + x.tools.length, 0);
    const failed = mcp.filter((x) => x.state === 'failed').length;
    lines.push(
      `${dim(`mcp: ${up.length} of ${mcp.length} server${mcp.length === 1 ? '' : 's'} · ${tools} tool${tools === 1 ? '' : 's'}`)}${failed ? ` ${yellow(`· ${failed} failed, see /mcp`)}` : ''}`,
    );
  }
  if (rt.agent.messages.length) {
    lines.push(dim(`resumed session ${rt.session.meta.id} (${rt.agent.messages.length} messages)`));
  }
  lines.push(dim('/help for commands · Ctrl+C aborts a run · /exit to quit'));
  return lines;
}

/**
 * Startup checks (L1, L2): short background requests; only problems are reported, through
 * `notify`. The model id is not served by the provider, or an Ollama model has under 32k context.
 * `stillCurrent` lets the UI ignore answers that arrive after a model switch.
 */
export function startupChecks(
  rt: Runtime,
  notify: (message: string) => void,
  stillCurrent: () => boolean,
): void {
  void rt
    .checkModel({ timeoutMs: 3000 })
    .then((c) => {
      if (c.status === 'unknown-model' && stillCurrent())
        notify(`${c.message} ${dim('· mrig doctor')}`);
    })
    .catch(() => {});
  void rt
    .checkContext({ timeoutMs: 3000 })
    .then((c) => {
      if ((c.status === 'low' || c.status === 'unknown') && stillCurrent()) notify(c.message);
    })
    .catch(() => {});
}
