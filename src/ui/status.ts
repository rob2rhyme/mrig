/**
 * The status a UI shows for a runtime: model, tokens, cost, context use, mode, offline, yolo
 * and MCP. One copy, shared by the TUI's status line and the app server (U1).
 */
import type { Runtime } from '../runtime.ts';
import { describeOffline } from '../zone.ts';
import { modeLabel } from './commands.ts';

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
  /** The mode, when not default (T1). */
  mode?: string;
  /** "2/3" when MCP servers are configured: connected / configured. */
  mcp?: string;
}

export const EMPTY_STATUS: StatusInfo = {
  model: '',
  tokensIn: 0,
  tokensOut: 0,
  contextPct: 0,
  yolo: false,
};

export function runtimeStatus(rt: Runtime | undefined): StatusInfo {
  if (!rt) return EMPTY_STATUS;
  const report = rt.agent.contextReport();
  const mcp = rt.mcpStatus();
  const connected = mcp.filter((s) => s.state === 'connected').length;
  const cost = rt.agent.cost();
  return {
    model: rt.modelLabel(),
    tokensIn: rt.agent.usage.inputTokens,
    tokensOut: rt.agent.usage.outputTokens,
    ...(cost !== undefined ? { cost } : {}),
    contextPct: Math.min(100, Math.round((report.estimate / report.window) * 100)),
    ...(rt.offline ? { offline: describeOffline(rt.offline) } : {}),
    yolo: rt.permissions.promptsSkipped,
    ...(rt.mode !== 'default' ? { mode: modeLabel(rt) } : {}),
    ...(mcp.length > 0 ? { mcp: `${connected}/${mcp.length}` } : {}),
  };
}
