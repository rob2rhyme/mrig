/**
 * MCP client (L6): connect to configured MCP servers and expose their tools as mrig tools named
 * `mcp__<server>__<tool>`. They go through the same permission gate as every other tool: never
 * read-only, so each call asks unless an allow rule for that tool matches, such as
 * `mcp__github__list_issues:*`.
 *
 * Servers come only from the global config (~/.mrig/config.json): a project's config could
 * otherwise run any command the moment mrig starts in a cloned repo. A server that fails to
 * start becomes a notice and a "failed" line in `/mcp`, never a crash.
 */
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { JSONSchema7 } from 'ai';
import { z } from 'zod';
import type { AnyTool } from './tools/index.ts';
import { defineTool, ToolError } from './tools/types.ts';
import { truncateMiddle } from './util/text.ts';

export type McpServerConfig =
  | {
      /** Executable that speaks MCP over stdin/stdout. */
      command: string;
      args?: string[];
      /** Extra environment for the server. Only a safe subset of mrig's own env is passed on. */
      env?: Record<string, string>;
      cwd?: string;
      disabled?: boolean;
    }
  | {
      /** Remote server (Streamable HTTP, or SSE with `transport: "sse"`). */
      url: string;
      transport?: 'http' | 'sse';
      headers?: Record<string, string>;
      disabled?: boolean;
    };

export type McpServerState = 'connected' | 'failed' | 'disabled' | 'offline';

export interface McpServerStatus {
  name: string;
  kind: 'stdio' | 'remote';
  /** The command line or URL, for display. */
  target: string;
  state: McpServerState;
  error?: string;
  /** mrig tool names this server contributed. */
  tools: string[];
}

/** The subset of an MCP client mrig uses; a seam for tests. */
export interface McpClientLike {
  listTools(options?: { params?: { cursor?: string } }): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    nextCursor?: string;
  }>;
  callTool(args: {
    name: string;
    arguments?: Record<string, unknown>;
    options?: { signal?: AbortSignal; timeout?: number };
  }): Promise<unknown>;
  close(): Promise<void>;
}

export type McpConnect = (
  name: string,
  config: McpServerConfig,
  timeoutMs: number,
) => Promise<McpClientLike>;

const isRemote = (c: McpServerConfig): c is Extract<McpServerConfig, { url: string }> => 'url' in c;

/** Validate the `mcpServers` config value; throws a readable error. */
export function parseMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"mcpServers" must be an object: { "name": { "command": "…" } }.');
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const where = `"mcpServers.${name}"`;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      throw new Error(`${where}: names may use letters, digits, "_" and "-", up to 32 characters.`);
    }
    if (!raw || typeof raw !== 'object') throw new Error(`${where} must be an object.`);
    const c = raw as Record<string, unknown>;
    const hasCommand = typeof c.command === 'string' && c.command.length > 0;
    const hasUrl = typeof c.url === 'string' && c.url.length > 0;
    if (hasCommand === hasUrl) throw new Error(`${where} needs exactly one of "command" or "url".`);
    const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    const stringMap = (v: unknown) =>
      v !== null && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string');
    if (c.args !== undefined && !strings(c.args))
      throw new Error(`${where}.args must be a list of strings.`);
    if (c.env !== undefined && !stringMap(c.env))
      throw new Error(`${where}.env must map names to strings.`);
    if (c.headers !== undefined && !stringMap(c.headers)) {
      throw new Error(`${where}.headers must map names to strings.`);
    }
    if (c.transport !== undefined && c.transport !== 'http' && c.transport !== 'sse') {
      throw new Error(`${where}.transport must be "http" or "sse".`);
    }
    if (hasUrl) {
      try {
        new URL(c.url as string);
      } catch {
        throw new Error(`${where}.url is not a valid URL.`);
      }
    }
    out[name] = raw as McpServerConfig;
  }
  return out;
}

/**
 * `mcp__<server>__<tool>`, limited to the characters and the 64-character length every provider
 * accepts. `taken` holds names already used, so a clash gets a numeric suffix.
 */
export function mcpToolName(server: string, tool: string, taken: Set<string> = new Set()): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  let name = `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
  for (let i = 2; taken.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
  taken.add(name);
  return name;
}

/** The text an MCP tool result carries, and whether the server flagged it as an error. */
export function mcpResultText(result: unknown): { text: string; isError: boolean } {
  const r = (result ?? {}) as {
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
    toolResult?: unknown;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image' || c.type === 'audio')
      parts.push(`[${c.type}: ${String(c.mimeType ?? 'unknown')}]`);
    else if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
      const res = c.resource as Record<string, unknown>;
      parts.push(typeof res.text === 'string' ? res.text : `[resource: ${String(res.uri ?? '')}]`);
    } else if (c.type === 'resource_link') parts.push(`[resource: ${String(c.uri ?? '')}]`);
  }
  if (parts.length === 0 && r.structuredContent !== undefined)
    parts.push(JSON.stringify(r.structuredContent));
  if (parts.length === 0 && r.toolResult !== undefined) parts.push(JSON.stringify(r.toolResult));
  return { text: parts.join('\n'), isError: r.isError === true };
}

function withObjectType(schema: Record<string, unknown>): JSONSchema7 {
  return { type: 'object', properties: {}, ...schema } as JSONSchema7;
}

const realConnect: McpConnect = async (_name, config, timeoutMs) => {
  const transport = isRemote(config)
    ? { type: config.transport ?? 'http', url: config.url, headers: config.headers }
    : new StdioMCPTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        stderr: 'ignore', // keep server logs out of the terminal UI
      });
  return createMCPClient({
    transport,
    clientName: 'mrig',
    initializationOptions: { timeout: timeoutMs },
    onUncaughtError: () => {},
  }) as Promise<McpClientLike>;
};

export interface McpManagerOptions {
  /** Offline mode (L5): remote servers are not contacted. */
  offline?: boolean;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** How long close() waits for each server before giving up on it (default 3 s). */
  closeTimeoutMs?: number;
  onNotice?: (message: string) => void;
  /** Test seam. */
  connect?: McpConnect;
}

export class McpManager {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly opts: McpManagerOptions;
  private readonly clients = new Map<string, McpClientLike>();
  private readonly statuses: McpServerStatus[] = [];
  private readonly toolList: AnyTool[] = [];

  constructor(servers: Record<string, McpServerConfig>, opts: McpManagerOptions = {}) {
    this.servers = servers;
    this.opts = opts;
  }

  /** Connect every enabled server in parallel. Never throws. */
  async start(): Promise<void> {
    const taken = new Set<string>();
    const results = await Promise.all(
      Object.entries(this.servers).map(async ([name, config]) => ({
        name,
        config,
        ...(await this.startOne(name, config)),
      })),
    );
    // Build tools after all connections, in config order, so names are stable.
    for (const r of results) {
      const status: McpServerStatus = {
        name: r.name,
        kind: isRemote(r.config) ? 'remote' : 'stdio',
        target: isRemote(r.config)
          ? r.config.url
          : [r.config.command, ...(r.config.args ?? [])].join(' '),
        state: r.state,
        tools: [],
        ...(r.error ? { error: r.error } : {}),
      };
      if (r.client && r.defs) {
        for (const def of r.defs) {
          const tool = this.makeTool(r.name, r.config, r.client, def, taken);
          this.toolList.push(tool);
          status.tools.push(tool.name);
        }
      }
      this.statuses.push(status);
      if (r.state === 'failed')
        this.opts.onNotice?.(`MCP server "${r.name}" did not start: ${r.error}`);
    }
  }

  private async startOne(
    name: string,
    config: McpServerConfig,
  ): Promise<{
    state: McpServerState;
    error?: string;
    client?: McpClientLike;
    defs?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  }> {
    if (config.disabled) return { state: 'disabled' };
    if (this.opts.offline && isRemote(config)) {
      return { state: 'offline', error: 'remote servers are not contacted in offline mode' };
    }
    const timeout = this.opts.connectTimeoutMs ?? 15_000;
    let client: McpClientLike | undefined;
    const pending = (this.opts.connect ?? realConnect)(name, config, timeout);
    try {
      // The client enforces `timeout` itself and stops the server; this backstop fires later and
      // closes a client that connects after it gave up, so no server process is left behind.
      client = await withTimeout(pending, timeout + 2000, () => {
        pending.then((late) => late.close()).catch(() => {});
      });
      const defs: Array<{
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }> = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(
          client.listTools(cursor ? { params: { cursor } } : undefined),
          timeout,
        );
        defs.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      this.clients.set(name, client);
      return { state: 'connected', client, defs };
    } catch (err) {
      await client?.close().catch(() => {});
      return { state: 'failed', error: friendlyError(err) };
    }
  }

  private makeTool(
    server: string,
    config: McpServerConfig,
    client: McpClientLike,
    def: { name: string; description?: string; inputSchema: Record<string, unknown> },
    taken: Set<string>,
  ): AnyTool {
    const callTimeoutMs = this.opts.callTimeoutMs ?? 120_000;
    return defineTool<Record<string, unknown>>({
      name: mcpToolName(server, def.name, taken),
      description: `[MCP server "${server}"] ${def.description ?? def.name}`,
      inputSchema: z.record(z.string(), z.unknown()),
      parameters: withObjectType(def.inputSchema),
      readOnly: false,
      remote: isRemote(config),
      summarize: (input) => {
        const args = JSON.stringify(input);
        return `${server} · ${def.name}${args === '{}' ? '' : ` ${args.length > 80 ? `${args.slice(0, 79)}…` : args}`}`;
      },
      async execute(input, ctx) {
        const result = await client.callTool({
          name: def.name,
          arguments: input,
          options: { signal: ctx.signal, timeout: callTimeoutMs },
        });
        const { text, isError } = mcpResultText(result);
        if (isError) throw new ToolError(text || `MCP tool "${def.name}" reported an error.`);
        return truncateMiddle(text || '(no output)', ctx.maxOutputChars);
      },
    }) as AnyTool;
  }

  tools(): AnyTool[] {
    return [...this.toolList];
  }

  status(): McpServerStatus[] {
    return this.statuses.map((s) => ({ ...s, tools: [...s.tools] }));
  }

  /**
   * Close every connection; stdio servers are stopped. Each server gets a few seconds: closing
   * with a call still in flight can stall (seen on Windows), and quitting mrig must not hang.
   */
  async close(): Promise<void> {
    const wait = this.opts.closeTimeoutMs ?? 3000;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => withTimeout(c.close(), wait).catch(() => {})));
  }
}

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/closed client|connection closed|EPIPE/i.test(message)) {
    return `the server exited during startup (${message})`;
  }
  if (/ENOENT/.test(message)) return `command not found (${message})`;
  return message;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Lines for `/mcp`. */
export function formatMcpStatus(statuses: McpServerStatus[]): string[] {
  if (statuses.length === 0) {
    return ['No MCP servers configured. Add "mcpServers" to ~/.mrig/config.json (see README).'];
  }
  const lines: string[] = [];
  for (const s of statuses) {
    const head = `${s.name} (${s.kind}: ${s.target})`;
    if (s.state === 'connected') {
      lines.push(`● ${head} · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`);
      for (const t of s.tools) lines.push(`    ${t}`);
    } else if (s.state === 'failed') lines.push(`✗ ${head} · failed: ${s.error}`);
    else if (s.state === 'offline') lines.push(`· ${head} · skipped: offline mode`);
    else lines.push(`· ${head} · disabled`);
  }
  return lines;
}
