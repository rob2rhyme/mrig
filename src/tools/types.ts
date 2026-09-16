import type { z } from 'zod';

export interface ToolContext {
  /** Working directory for relative paths and commands */
  cwd: string;
  /** Aborts long-running tools (Ctrl+C) */
  signal?: AbortSignal;
  /** Cap on tool output returned to the model */
  maxOutputChars: number;
}

export interface MrigTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Read-only tools never prompt for permission. */
  readOnly: boolean;
  /** One line describing the call, for permission prompts and the transcript. */
  summarize(input: I): string;
  /** Run the tool. Return text for the model; throw for errors (message is sent to the model). */
  execute(input: I, ctx: ToolContext): Promise<string>;
}

export function defineTool<I>(tool: MrigTool<I>): MrigTool<I> {
  return tool;
}

export class ToolError extends Error {}
