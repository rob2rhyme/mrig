import { type Tool, tool } from 'ai';
import { bashTool } from './bash.ts';
import { editTool } from './edit.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { readTool } from './read.ts';
import type { MrigTool } from './types.ts';
import { writeTool } from './write.ts';

export type { MrigTool, ToolContext } from './types.ts';
export { ToolError } from './types.ts';

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs are validated per-tool
export type AnyTool = MrigTool<any>;

/** The default tool set, in the order the model sees them. */
export const DEFAULT_TOOLS: AnyTool[] = [
  readTool,
  editTool,
  writeTool,
  bashTool,
  globTool,
  grepTool,
];

export function toolRegistry(tools: AnyTool[] = DEFAULT_TOOLS): Map<string, AnyTool> {
  return new Map(tools.map((t) => [t.name, t]));
}

/**
 * Convert to AI SDK tool definitions WITHOUT `execute`, so the model returns tool
 * calls to our loop and we run them after the permission gate.
 */
export function toAiTools(tools: AnyTool[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const t of tools) {
    out[t.name] = tool({ description: t.description, inputSchema: t.inputSchema });
  }
  return out;
}
