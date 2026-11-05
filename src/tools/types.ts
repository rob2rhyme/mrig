import { z } from 'zod';

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
  /** Talks to hosts other than this machine (web fetch, remote MCP). Dropped in offline mode. */
  remote?: boolean;
  /** One line describing the call, for permission prompts and the transcript. */
  summarize(input: I): string;
  /** Run the tool. Return text for the model; throw for errors (message is sent to the model). */
  execute(input: I, ctx: ToolContext): Promise<string>;
}

export function defineTool<I>(tool: MrigTool<I>): MrigTool<I> {
  return tool;
}

export class ToolError extends Error {}

/**
 * One line listing a tool's input fields, e.g. `path (string, required): File path; limit
 * (number, optional): Max lines`. Sent to the model when it calls a tool with no arguments.
 */
export function describeInputs(schema: z.ZodType): string {
  if (!(schema instanceof z.ZodObject)) return 'a JSON object matching the tool schema';
  return Object.entries(schema.shape as Record<string, z.ZodType>)
    .map(([name, field]) => {
      const optional = field.safeParse(undefined).success;
      const inner = field instanceof z.ZodOptional ? (field.unwrap() as z.ZodType) : field;
      const type = (inner as { def?: { type?: string } }).def?.type ?? 'value';
      const desc = field.description ?? inner.description;
      return `${name} (${type}, ${optional ? 'optional' : 'required'})${desc ? `: ${desc}` : ''}`;
    })
    .join('; ');
}
