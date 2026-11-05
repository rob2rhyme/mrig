/**
 * The TUI (L6, `mrig --tui`): an Ink view over TuiController. It renders the transcript
 * (finished items once, via <Static>, so the terminal's own scrollback scrolls it), the live
 * area (streaming text, the running tool, a permission question), an input line and a status
 * line. All behaviour lives in the controller; this file only draws and forwards keys.
 */
import { Box, render, Static, Text, useApp, useInput } from 'ink';
import { useState, useSyncExternalStore } from 'react';
import type { RuntimeOptions } from '../runtime.ts';
import { type Item, type StatusInfo, TuiController } from './tui-controller.ts';

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="magenta" bold>
            {'❯ '}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'tool':
      return <Text color="cyan">{item.text}</Text>;
    case 'notice':
      return <Text color="yellow">{`! ${item.text}`}</Text>;
    case 'error':
      return <Text color="red">{`error: ${item.text}`}</Text>;
    case 'footer':
      return <Text dimColor>{item.text}</Text>;
    case 'reasoning':
      return <Text dimColor italic>{`thinking: ${item.text}`}</Text>;
    default:
      return <Text>{item.text}</Text>;
  }
}

/**
 * Apply a chunk of typed or pasted text to the input line. Terminals can deliver a whole line
 * and its Enter in one chunk (a paste, or fast input), so a chunk ending in a newline submits.
 * Newlines inside a chunk become spaces.
 */
export function applyChunk(value: string, chunk: string): { value: string; submit: boolean } {
  const submit = /[\r\n]$/.test(chunk);
  const text = chunk.replace(/(\r\n|\r|\n)+$/, '').replace(/\r\n|\r|\n/g, ' ');
  return { value: value + text, submit };
}

export function formatStatus(s: StatusInfo): string {
  const parts = [
    s.model,
    `${s.tokensIn.toLocaleString()} in / ${s.tokensOut.toLocaleString()} out`,
    ...(s.cost !== undefined ? [`~$${s.cost.toFixed(4)}`] : []),
    `context ${s.contextPct}%`,
    ...(s.mode ? [`${s.mode} mode`] : []),
    ...(s.mcp ? [`mcp ${s.mcp}`] : []),
    ...(s.offline ? [s.offline.toLowerCase()] : []),
    ...(s.yolo ? ['yolo'] : []),
  ];
  return parts.join(' · ');
}

export function TuiApp({ controller }: { controller: TuiController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      if (controller.interrupt() === 'exit') exit();
      return;
    }
    if (state.ask) {
      const c = char.toLowerCase();
      if (c === 'y') controller.answer('yes');
      else if (c === 'a') controller.answer('always');
      else if (c === 'n' || key.return || key.escape) controller.answer('no');
      return;
    }
    if (key.ctrl && char === 'd' && input === '') {
      exit();
      return;
    }
    const send = (line: string) => {
      if (state.running || !line.trim()) {
        setInput(line);
        return;
      }
      setInput('');
      setHistory((h) => [...h, line]);
      setCursor(-1);
      void controller.submit(line).then((r) => {
        if (r === 'exit') exit();
      });
    };
    if (key.return) {
      send(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (history.length === 0) return;
      const next = key.upArrow
        ? cursor === -1
          ? history.length - 1
          : Math.max(0, cursor - 1)
        : cursor === -1
          ? -1
          : cursor + 1 >= history.length
            ? -1
            : cursor + 1;
      setCursor(next);
      setInput(next === -1 ? '' : (history[next] ?? ''));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      const next = applyChunk(input, char);
      if (next.submit) send(next.value);
      else setInput(next.value);
    }
  });

  return (
    <>
      <Static items={state.items}>{(item) => <ItemView key={item.id} item={item} />}</Static>
      {state.reasoning ? <Text dimColor italic>{`thinking: ${state.reasoning}`}</Text> : null}
      {state.live ? <Text>{state.live}</Text> : null}
      {state.activeTool ? <Text color="cyan">{`⚙ ${state.activeTool} …`}</Text> : null}
      {state.ask ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold>{`⚠ ${state.ask.summary}`}</Text>
          {state.ask.preview ? <Text dimColor>{state.ask.preview}</Text> : null}
          <Text>
            {'Allow? '}
            <Text bold>y</Text>
            {'es / '}
            <Text bold>n</Text>
            {'o / '}
            <Text bold>a</Text>
            {'lways '}
            <Text dimColor>{`(${state.ask.alwaysRule})`}</Text>
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="magenta" bold>
            {'❯ '}
          </Text>
          {state.running && !state.live && !state.reasoning && !state.activeTool ? (
            <Text dimColor>thinking… (Ctrl+C to stop)</Text>
          ) : (
            <Text>
              {input}
              <Text inverse> </Text>
            </Text>
          )}
        </Box>
      )}
      {state.hint ? <Text dimColor>{state.hint}</Text> : null}
      <Box
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text dimColor>{formatStatus(state.status)}</Text>
      </Box>
    </>
  );
}

/** Run the TUI until the user quits. Falls back to an error line when the config is bad. */
export async function startTui(
  opts: Omit<RuntimeOptions, 'ask' | 'events'>,
  initialPrompt?: string,
): Promise<void> {
  const controller = new TuiController(opts);
  try {
    await controller.start();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const app = render(<TuiApp controller={controller} />, { exitOnCtrlC: false });
  if (initialPrompt) void controller.submit(initialPrompt);
  await app.waitUntilExit();
  await controller.close();
}
