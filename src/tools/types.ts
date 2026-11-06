import type { JSONSchema7 } from 'ai';
import { z } from 'zod';

export interface ToolContext {
  /** Working directory for relative paths and commands */
  cwd: string;
  /** Aborts long-running tools (Ctrl+C) */
  signal?: AbortSignal;
  /** Cap on tool output returned to the model */
  maxOutputChars: number;
  /** The configured corpus folder (config `corpus`), for the corpus tool. */
  corpus?: string;
  /** The tutor mode's variety (T8): the corpus tool's default. */
  variety?: string;
  /** Record generated media and its cost (T4+); `usd` undefined when the price is unknown. */
  recordMedia?: (kind: string, count: number, usd: number | undefined) => void;
  /** Report a file the tool saved (absolute path), so an app can show or play it (U1). */
  recordFile?: (path: string, kind: MediaKind) => void;
}

export type MediaKind = 'image' | 'audio' | 'video';

/** Longest text a `ToolDisplay` carries; longer content is cut in the middle. */
export const DISPLAY_MAX_CHARS = 20_000;

/**
 * Structure for an app to draw a tool call (U1): a diff for edits, the file for writes, the
 * command for bash, the path for reads. The REPL and TUI ignore it and use `summarize`.
 */
export type ToolDisplay =
  | { kind: 'diff'; path: string; before: string; after: string }
  | { kind: 'file'; path: string; content: string }
  | { kind: 'command'; command: string }
  | { kind: 'path'; path: string };

export interface MrigTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Read-only tools never prompt for permission. */
  readOnly: boolean;
  /** Talks to hosts other than this machine (web fetch, remote MCP). Dropped in offline mode. */
  remote?: boolean;
  /**
   * JSON Schema shown to the model instead of one derived from `inputSchema`. For tools whose
   * schema arrives as JSON (MCP); `inputSchema` then only needs to accept the object.
   */
  parameters?: JSONSchema7;
  /** One line describing the call, for permission prompts and the transcript. */
  summarize(input: I): string;
  /** Structure for an app to draw the call (U1). Optional; text-only UIs never call it. */
  display?(input: I): ToolDisplay;
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
/** Like describeInputs, but prefers the JSON Schema a tool shows the model (MCP tools). */
export function describeToolInputs(tool: {
  inputSchema: z.ZodType;
  parameters?: JSONSchema7;
}): string {
  const props = tool.parameters?.properties;
  if (!props || typeof props !== 'object') return describeInputs(tool.inputSchema);
  const required = new Set(tool.parameters?.required ?? []);
  const parts = Object.entries(props).map(([name, def]) => {
    const d = (typeof def === 'object' && def ? def : {}) as {
      type?: unknown;
      description?: string;
    };
    const type = typeof d.type === 'string' ? d.type : 'value';
    return `${name} (${type}, ${required.has(name) ? 'required' : 'optional'})${d.description ? `: ${d.description}` : ''}`;
  });
  return parts.length > 0 ? parts.join('; ') : 'no arguments';
}

/** True when `{}` is a valid call: then an empty call is not a mistake to correct. */
export function acceptsEmptyInput(tool: {
  inputSchema: z.ZodType;
  parameters?: JSONSchema7;
}): boolean {
  if (tool.parameters) return (tool.parameters.required ?? []).length === 0;
  return tool.inputSchema.safeParse({}).success;
}

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
