/**
 * Headless mode (`mrig -p`): run one prompt and exit. Three output modes (L7):
 *
 *   stream (default)  assistant text streams to stdout as it arrives
 *   last              `--output-last`: only the final assistant message, printed at the end
 *   json              `--json`: one JSON object (HeadlessJson) on stdout at the end
 *
 * Tool lines, notices and the summary line always go to stderr, so stdout holds only the answer.
 */
import type { RunResult } from './agent.ts';
import type { AskFn } from './permissions.ts';
import { formatModelError, type UsageTotals } from './providers.ts';
import { Runtime, type RuntimeOptions } from './runtime.ts';
import { dim, red, yellow } from './ui/ansi.ts';
import { describeOffline } from './zone.ts';

export type OutputMode = 'stream' | 'last' | 'json';

/** What `--json` prints: one object, on one line. */
export interface HeadlessJson {
  /** The final assistant message (empty if the run ended on tool calls). */
  text: string;
  stop: RunResult['stop'] | 'error';
  steps: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  usage: UsageTotals;
  /** Estimated USD, or null when the profile has no pricing. */
  cost: number | null;
  /** Generated media by kind (T4+), when any: count and known cost. */
  media?: Record<string, { count: number; usd: number; unpriced: number }>;
  /** Set when the run failed: config, connection or model errors. */
  error?: string;
}

export interface HeadlessIO {
  stdout(text: string): void;
  stderr(text: string): void;
  ask: AskFn;
  signal?: AbortSignal;
}

export interface HeadlessOptions extends Omit<RuntimeOptions, 'ask' | 'events'> {
  prompt: string;
  output?: OutputMode;
}

const NO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
};

/** Run one prompt. Resolves the exit code: 0 done, 1 error, 2 max steps, 130 aborted. */
export async function runHeadless(opts: HeadlessOptions, io: HeadlessIO): Promise<number> {
  const { prompt, output = 'stream', ...runtimeOptions } = opts;
  const json = (value: HeadlessJson) => io.stdout(`${JSON.stringify(value)}\n`);
  let atLineStart = true;
  let runtime: Runtime;
  try {
    runtime = new Runtime({
      ...runtimeOptions,
      ask: io.ask,
      events: {
        onText: (d) => {
          if (output !== 'stream') return;
          io.stdout(d);
          atLineStart = d.endsWith('\n');
        },
        onToolStart: (c) => {
          if (!atLineStart) io.stderr('\n');
          io.stderr(`${dim('⚙')} ${c.summary}\n`);
          atLineStart = true;
        },
        onToolEnd: (_c, o) => {
          if (o.status === 'denied') io.stderr(`  ${yellow('denied')}\n`);
          else if (o.status === 'error')
            io.stderr(`  ${red('error')} ${dim(o.text.split('\n')[0] ?? '')}\n`);
        },
        onNotice: (m) => io.stderr(`${yellow('!')} ${m}\n`),
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    if (output === 'json') {
      json({ text: '', stop: 'error', steps: 0, usage: NO_USAGE, cost: null, error: message });
    } else {
      io.stderr(`${red('error:')} ${message}\n`);
    }
    return 1;
  }

  const base = () => ({
    sessionId: runtime.session.meta.id,
    provider: runtime.providerName,
    model: runtime.profile.model,
    usage: { ...runtime.agent.usage },
    cost: runtime.agent.cost() ?? null,
    ...(Object.keys(runtime.agent.media).length > 0 ? { media: { ...runtime.agent.media } } : {}),
  });
  try {
    await runtime.startMcp();
    if (runtime.offline) {
      io.stderr(
        dim(
          `${describeOffline(runtime.offline)} · local models only · every write, edit and command asks\n`,
        ),
      );
    }
    let result: RunResult;
    try {
      result = await runtime.runTurn(prompt, io.signal);
    } catch (err) {
      const message = formatModelError(err, runtime.profile);
      if (output === 'json') {
        json({ text: '', stop: 'error', steps: 0, ...base(), error: message });
      } else {
        if (!atLineStart) io.stdout('\n');
        io.stderr(`${red('error:')} ${message}\n`);
      }
      return 1;
    }
    if (output === 'json') {
      json({ text: result.text, stop: result.stop, steps: result.steps, ...base() });
    } else {
      if (output === 'last' && result.text) {
        io.stdout(result.text);
        atLineStart = result.text.endsWith('\n');
      }
      if (!atLineStart) io.stdout('\n');
      const cost = runtime.agent.cost();
      const u = runtime.agent.usage;
      io.stderr(
        dim(
          `— ${result.steps} steps · ${u.inputTokens} in / ${u.outputTokens} out${cost !== undefined ? ` · ~$${cost.toFixed(4)}` : ''} · session ${runtime.session.meta.id}\n`,
        ),
      );
    }
    return result.stop === 'done' ? 0 : result.stop === 'aborted' ? 130 : 2;
  } finally {
    runtime.save();
    await runtime.close();
  }
}
