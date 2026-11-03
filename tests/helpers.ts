import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ToolContext } from '../src/tools/types.ts';

export function tempDir(prefix = 'mrig-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd, maxOutputChars: 30_000, ...extra };
}

/** Token counts for a mock turn. `input` is the provider total, including cache reads/writes. */
export interface MockTokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const usage = (t: MockTokens) => {
  const cacheRead = t.cacheRead ?? 0;
  const cacheWrite = t.cacheWrite ?? 0;
  return {
    inputTokens: {
      total: t.input,
      noCache: t.input - cacheRead - cacheWrite,
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: t.output, text: t.output, reasoning: 0 },
  };
};

/** A mock model turn that emits text and finishes. */
export function textTurn(
  text: string,
  tokens: MockTokens = { input: 10, output: 5 },
): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp', modelId: 'mock', timestamp: new Date(0) },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: usage(tokens),
    },
  ];
}

/** A mock model turn that calls one tool. `input` is the JSON string the model "wrote". */
export function toolTurn(
  toolName: string,
  input: string,
  id = 'call-1',
  tokens: MockTokens = { input: 10, output: 5 },
): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp', modelId: 'mock', timestamp: new Date(0) },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: input },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      usage: usage(tokens),
    },
  ];
}

/** Build a mock model that plays back the given turns in order. */
export function mockModel(turns: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = turns[i] ?? textTurn('(no more scripted turns)');
      i++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}
