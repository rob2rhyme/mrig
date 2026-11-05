/**
 * The TUI's state and behaviour, with no React in it (L6). The Ink view in `tui.tsx` only
 * renders a snapshot and forwards keys, so everything here is testable without a terminal.
 *
 * The transcript is a list of finished items (rendered once, then left to the terminal's own
 * scrollback) plus a live area: the text streaming in now, the tool running now, or a pending
 * permission question. A status line shows model, tokens, cost, context use and mode.
 */
import type { AgentEvents, ToolCallInfo, ToolCallOutcome } from '../agent.ts';
import type { Answer, AskRequest } from '../permissions.ts';
import { formatModelError } from '../providers.ts';
import { Runtime, type RuntimeOptions } from '../runtime.ts';
import { describeOffline } from '../zone.ts';
import { bannerLines, runCommand, startupChecks } from './commands.ts';

export type ItemKind =
  | 'banner'
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'notice'
  | 'info'
  | 'error'
  | 'footer';

export interface Item {
  id: number;
  kind: ItemKind;
  text: string;
}

export interface StatusInfo {
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Estimated USD; undefined when pricing is unknown. */
  cost?: number;
  /** Estimated share of the context window in use, 0–100. */
  contextPct: number;
  offline?: string;
  yolo: boolean;
  /** "2/3" when MCP servers are configured: connected / configured. */
  mcp?: string;
}

export interface TuiSnapshot {
  items: Item[];
  /** Assistant text streaming in right now. */
  live: string;
  /** Reasoning streaming in right now; only with /verbose. */
  reasoning: string;
  /** The tool call running right now. */
  activeTool?: string;
  running: boolean;
  ask?: { summary: string; preview?: string; alwaysRule: string };
  /** A transient hint under the input (not part of the transcript). */
  hint?: string;
  status: StatusInfo;
}

export type InterruptResult = 'aborted' | 'denied' | 'armed' | 'exit';

const EMPTY_STATUS: StatusInfo = {
  model: '',
  tokensIn: 0,
  tokensOut: 0,
  contextPct: 0,
  yolo: false,
};

export class TuiController {
  runtime: Runtime | undefined;
  private snap: TuiSnapshot = {
    items: [],
    live: '',
    reasoning: '',
    running: false,
    status: EMPTY_STATUS,
  };
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private running: AbortController | null = null;
  private pendingAsk: ((answer: Answer) => void) | null = null;
  private lastInterruptAt = 0;

  constructor(
    private readonly opts: Omit<RuntimeOptions, 'ask' | 'events'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---- store (for useSyncExternalStore) ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TuiSnapshot => this.snap;

  private update(patch: Partial<TuiSnapshot>): void {
    this.snap = { ...this.snap, ...patch, status: this.computeStatus() };
    for (const listener of this.listeners) listener();
  }

  private push(kind: ItemKind, text: string, extra: Partial<TuiSnapshot> = {}): void {
    const clean = text.replace(/\n+$/, '');
    if (!clean) {
      if (Object.keys(extra).length > 0) this.update(extra);
      return;
    }
    this.update({
      items: [...this.snap.items, { id: this.nextId++, kind, text: clean }],
      ...extra,
    });
  }

  /** Move streamed reasoning into the transcript (shown dim). */
  private flushReasoning(): void {
    if (this.snap.reasoning.trim()) this.push('reasoning', this.snap.reasoning, { reasoning: '' });
    else if (this.snap.reasoning) this.update({ reasoning: '' });
  }

  /** Move streamed text into the transcript as a finished assistant item. */
  private flushLive(): void {
    this.flushReasoning();
    if (this.snap.live.trim()) this.push('assistant', this.snap.live, { live: '' });
    else if (this.snap.live) this.update({ live: '' });
  }

  private computeStatus(): StatusInfo {
    const rt = this.runtime;
    if (!rt) return EMPTY_STATUS;
    const report = rt.agent.contextReport();
    const mcp = rt.mcpStatus();
    const connected = mcp.filter((s) => s.state === 'connected').length;
    return {
      model: rt.modelLabel(),
      tokensIn: rt.agent.usage.inputTokens,
      tokensOut: rt.agent.usage.outputTokens,
      cost: rt.agent.cost(),
      contextPct: Math.min(100, Math.round((report.estimate / report.window) * 100)),
      ...(rt.offline ? { offline: describeOffline(rt.offline) } : {}),
      yolo: rt.permissions.yolo,
      ...(mcp.length > 0 ? { mcp: `${connected}/${mcp.length}` } : {}),
    };
  }

  // ---- runtime wiring ----

  private events(): AgentEvents {
    return {
      onText: (delta) => {
        this.flushReasoning();
        this.update({ live: this.snap.live + delta, hint: undefined });
      },
      onReasoning: (delta) => {
        if (!this.runtime?.verbose || !delta) return;
        this.update({ reasoning: this.snap.reasoning + delta, hint: undefined });
      },
      onToolStart: (call: ToolCallInfo) => {
        this.flushLive();
        this.update({ activeTool: call.summary });
      },
      onToolEnd: (call: ToolCallInfo, outcome: ToolCallOutcome) => {
        const secs = (outcome.ms / 1000).toFixed(1);
        let result: string;
        if (outcome.status === 'ok') {
          const lines = outcome.text.split('\n').length;
          result = `✓ ${lines} line${lines === 1 ? '' : 's'} · ${secs}s`;
        } else if (outcome.status === 'denied') {
          result = '✗ denied';
        } else {
          result = `✗ ${outcome.text.split('\n')[0] ?? 'error'}`;
        }
        this.push('tool', `⚙ ${call.summary}  ${result}`, { activeTool: undefined });
      },
      onNotice: (message) => this.push('notice', message),
    };
  }

  private ask(req: AskRequest): Promise<Answer> {
    this.flushLive();
    return new Promise((resolve) => {
      this.pendingAsk = resolve;
      this.update({
        ask: {
          summary: req.summary,
          ...(req.preview ? { preview: req.preview } : {}),
          alwaysRule: req.alwaysRule,
        },
      });
    });
  }

  /** Create the runtime, connect MCP servers, show the banner. Throws on bad config. */
  async start(): Promise<void> {
    const rt = new Runtime({ ...this.opts, ask: (r) => this.ask(r), events: this.events() });
    this.runtime = rt;
    await rt.startMcp();
    for (const line of bannerLines(rt)) this.push('banner', line);
    startupChecks(
      rt,
      (m) => this.push('notice', m),
      () => this.runtime === rt,
    );
  }

  // ---- user actions ----

  /** Send a line: a `/command` or a message to the agent. Resolves 'exit' when the UI should quit. */
  async submit(line: string): Promise<'exit' | undefined> {
    const rt = this.runtime;
    const text = line.trim();
    if (!rt || !text || this.snap.running) return undefined;
    this.push('user', text, { hint: undefined });
    if (text.startsWith('/')) {
      const exit = await runCommand(rt, text, {
        write: (s) => this.push('info', s),
        busy: (run) => this.whileRunning(run),
      });
      this.update({});
      return exit ? 'exit' : undefined;
    }
    try {
      const result = await this.whileRunning((signal) => rt.agent.run(text, signal));
      this.flushLive();
      const u = rt.agent.usage;
      const cost = rt.agent.cost();
      const steps = `${result.steps} step${result.steps === 1 ? '' : 's'}`;
      const tokens = `${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out`;
      this.push(
        'footer',
        `— ${steps} · ${tokens}${cost !== undefined ? ` · ~$${cost.toFixed(4)}` : ''}`,
      );
    } catch (err) {
      this.flushLive();
      this.push('error', formatModelError(err, rt.profile));
    } finally {
      rt.save();
      this.update({ activeTool: undefined });
    }
    return undefined;
  }

  private async whileRunning<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.running = new AbortController();
    this.update({ running: true });
    try {
      return await run(this.running.signal);
    } finally {
      this.running = null;
      this.update({ running: false });
    }
  }

  /** Answer the pending permission question. */
  answer(answer: Answer): void {
    const resolve = this.pendingAsk;
    if (!resolve) return;
    this.pendingAsk = null;
    const label = answer === 'always' ? `always (${this.snap.ask?.alwaysRule ?? ''})` : answer;
    this.push('info', `  → ${label}`, { ask: undefined });
    resolve(answer);
  }

  /**
   * Ctrl+C: deny a pending question and abort the turn, abort a running turn, or (when idle)
   * arm, and quit on a second press within 1.5 s, the same as the readline REPL.
   */
  interrupt(): InterruptResult {
    if (this.pendingAsk) {
      this.answer('no');
      this.running?.abort();
      this.push('notice', '⏹ aborted');
      return 'denied';
    }
    if (this.running) {
      this.running.abort();
      this.push('notice', '⏹ aborted');
      return 'aborted';
    }
    const now = this.now();
    if (now - this.lastInterruptAt < 1500) return 'exit';
    this.lastInterruptAt = now;
    this.update({ hint: 'press Ctrl+C again to exit' });
    return 'armed';
  }

  /** Save and stop MCP servers. */
  async close(): Promise<void> {
    this.runtime?.save();
    await this.runtime?.close();
  }
}
