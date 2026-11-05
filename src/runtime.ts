/**
 * Wires config → provider → permissions → agent → session. Shared by the REPL and headless mode.
 */
import type { LanguageModel } from 'ai';
import { Agent, type AgentEvents, type CompactionOptions } from './agent.ts';
import {
  loadConfig,
  type MrigConfig,
  type ProviderProfile,
  projectIgnoredNotice,
  resolveProfile,
} from './config.ts';
import {
  type ContextCheck,
  checkOllamaContext,
  checkProfile,
  type DoctorOptions,
  type ModelCheck,
} from './doctor.ts';
import { formatMcpStatus, type McpConnect, McpManager, type McpServerStatus } from './mcp.ts';
import { type AskFn, PermissionManager } from './permissions.ts';
import { buildSystemPrompt } from './prompt.ts';
import { createModel } from './providers.ts';
import { Session, type SessionMeta } from './session.ts';
import { toolsForMode } from './tools/index.ts';
import {
  assertNoYolo,
  assertProfileAllowed,
  assertResumeAllowed,
  describeOffline,
  type Offline,
  OfflineError,
  offlineTools,
  resolveOffline,
  splitBashRules,
  zoneSessionsDir,
} from './zone.ts';

export interface RuntimeOptions {
  cwd: string;
  provider?: string;
  model?: string;
  yolo?: boolean;
  maxSteps?: number;
  /** Session id to resume, or "latest" for the most recent session in cwd. */
  resume?: string;
  /** `--offline`: only local profiles, prompts always on (L5). A `.mrig-zone` marker also turns it on. */
  offline?: boolean;
  /** Keep the session in memory only (eval harness): no file under ~/.mrig/sessions. */
  ephemeral?: boolean;
  /** Use this model instead of building one from the profile (tests, the eval harness). */
  languageModel?: LanguageModel;
  /** Use this config instead of loading it from cwd (the eval harness runs in temp dirs). */
  config?: MrigConfig;
  ask: AskFn;
  events: AgentEvents;
}

export class Runtime {
  config: MrigConfig;
  providerName: string;
  profile: ProviderProfile;
  model: LanguageModel;
  agent: Agent;
  session: Session;
  permissions: PermissionManager;
  readonly cwd: string;
  /** Offline mode or zone in force (L5), if any. */
  readonly offline: Offline | undefined;
  /** The sessions folder: the zone's inside an offline zone, else undefined (~/.mrig/sessions). */
  readonly sessionsDir: string | undefined;
  /** `/verbose` (L7): the UIs show the model's reasoning as it streams. Off by default. */
  verbose = false;
  /** Connected MCP servers, once startMcp() ran. */
  private mcp: McpManager | undefined;
  private readonly events: AgentEvents;

  constructor(opts: RuntimeOptions) {
    this.cwd = opts.cwd;
    this.offline = resolveOffline(opts.cwd, opts.offline);
    this.events = opts.events;
    this.config = opts.config ?? loadConfig({ cwd: opts.cwd });
    const resolved = resolveProfile(this.config, opts.provider, opts.model);
    assertProfileAllowed(resolved.name, resolved.profile, this.offline);
    this.providerName = resolved.name;
    this.profile = resolved.profile;
    this.model = opts.languageModel ?? createModel(this.profile);

    const yolo = opts.yolo ?? this.config.permissions.yolo;
    let allow = this.config.permissions.allow;
    if (this.offline) {
      assertNoYolo(yolo, this.offline);
      const { kept, dropped } = splitBashRules(allow);
      allow = kept;
      if (dropped.length > 0) {
        opts.events.onNotice?.(
          `${describeOffline(this.offline)}: ignoring ${dropped.length} bash allow-rule${dropped.length === 1 ? '' : 's'}; every command asks.`,
        );
      }
    }
    this.permissions = new PermissionManager({
      yolo,
      allow,
      ask: opts.ask,
      cwd: opts.cwd,
      noBashRules: this.offline !== undefined,
    });
    this.sessionsDir = this.offline?.zone ? zoneSessionsDir(this.offline.zone) : undefined;

    if (opts.resume) {
      const id =
        opts.resume === 'latest' ? Session.latest(opts.cwd, this.sessionsDir)?.id : opts.resume;
      if (!id) throw new Error(`No previous session found for ${opts.cwd}.`);
      this.session = this.loadSession(id);
    } else {
      this.session = Session.create({
        cwd: opts.cwd,
        provider: this.providerName,
        model: this.profile.model,
        ephemeral: opts.ephemeral,
        dir: this.sessionsDir,
        ...(this.offline?.zone ? { zone: this.offline.zone } : {}),
      });
    }

    this.agent = new Agent({
      model: this.model,
      modelLabel: this.modelLabel(),
      profile: this.profile,
      tools: this.currentTools(),
      permissions: this.permissions,
      cwd: opts.cwd,
      systemPrompt: this.systemPrompt(),
      maxSteps: opts.maxSteps ?? this.config.maxSteps,
      maxToolOutputChars: this.config.maxToolOutputChars,
      cacheTtl: this.config.cacheTtl,
      compaction: this.compactionOptions(),
      events: opts.events,
      messages: this.session.messages,
    });
  }

  modelLabel(): string {
    return `${this.providerName}/${this.profile.model}`;
  }

  private systemPrompt(): string {
    return buildSystemPrompt({
      cwd: this.cwd,
      modelLabel: this.modelLabel(),
      toolMode: this.profile.toolMode,
    });
  }

  /** Ask the active provider whether it serves the configured model id (never throws). */
  checkModel(opts: DoctorOptions = {}): Promise<ModelCheck> {
    return checkProfile(this.providerName, this.profile, opts);
  }

  /** For Ollama profiles: warn when the model runs with under 32k context (never throws). */
  async checkContext(opts: DoctorOptions = {}): Promise<ContextCheck> {
    const profile = this.profile;
    const result = await checkOllamaContext(profile, opts);
    // Use the server's real context length for compaction when the profile does not set one.
    if (result.contextLength && !profile.contextWindow && this.profile === profile) {
      this.agent.setDetectedContextWindow(result.contextLength);
    }
    return result;
  }

  private compactionOptions(): CompactionOptions {
    const { enabled, threshold, keep, compactModel } = this.config.compaction;
    if (!compactModel) return { enabled, threshold, keep };
    let resolved: ReturnType<typeof resolveProfile>;
    try {
      resolved = resolveProfile(this.config, compactModel);
    } catch (err) {
      throw new Error(`Invalid "compaction.compactModel": ${(err as Error).message}`);
    }
    assertProfileAllowed(resolved.name, resolved.profile, this.offline);
    return {
      enabled,
      threshold,
      keep,
      model: createModel(resolved.profile),
      profile: resolved.profile,
    };
  }

  /** Switch provider and/or model mid-session, keeping the transcript. */
  switchModel(provider?: string, model?: string): void {
    const resolved = resolveProfile(this.config, provider ?? this.providerName, model);
    assertProfileAllowed(resolved.name, resolved.profile, this.offline);
    const nextModel = createModel(resolved.profile);
    this.providerName = resolved.name;
    this.profile = resolved.profile;
    this.model = nextModel;
    this.agent.opts.model = nextModel;
    this.agent.opts.profile = resolved.profile;
    this.agent.opts.modelLabel = this.modelLabel();
    this.agent.setTools(this.currentTools());
    this.agent.opts.systemPrompt = this.systemPrompt();
    this.agent.setDetectedContextWindow(undefined);
    this.session.setModel(this.providerName, this.profile.model);
  }

  /**
   * The tools for the current profile: the built-ins for its tool mode, plus MCP tools (except
   * in bash-only mode), minus anything that reaches other hosts when offline.
   */
  private currentTools() {
    const mcp = this.profile.toolMode === 'minimal' ? [] : (this.mcp?.tools() ?? []);
    return offlineTools([...toolsForMode(this.profile.toolMode), ...mcp], this.offline);
  }

  /**
   * Connect the MCP servers from the global config (L6) and add their tools. Call once after
   * construction; failures become notices. It also reports keys an untrusted project config
   * tried to set. The eval harness never calls it.
   */
  async startMcp(opts: { connect?: McpConnect } = {}): Promise<void> {
    const ignored = projectIgnoredNotice(this.config, this.cwd);
    if (ignored && !this.mcp) this.events.onNotice?.(ignored);
    if (this.mcp || Object.keys(this.config.mcpServers).length === 0) return;
    this.mcp = new McpManager(this.config.mcpServers, {
      offline: this.offline !== undefined,
      onNotice: (m) => this.events.onNotice?.(m),
      ...(opts.connect ? { connect: opts.connect } : {}),
    });
    await this.mcp.start();
    this.agent.setTools(this.currentTools());
  }

  mcpStatus(): McpServerStatus[] {
    return this.mcp?.status() ?? [];
  }

  /** Lines for `/mcp`. */
  mcpReport(): string[] {
    return formatMcpStatus(this.mcpStatus());
  }

  /** Stop MCP servers. Safe to call more than once. */
  async close(): Promise<void> {
    await this.mcp?.close();
  }

  /** Turn permission prompts off or on (`/yolo`). Offline mode refuses to turn them off. */
  setYolo(on: boolean): void {
    if (on) assertNoYolo(true, this.offline);
    this.permissions.yolo = on;
  }

  /** Sessions visible from here: the zone's inside an offline zone, else ~/.mrig/sessions. */
  listSessions(): SessionMeta[] {
    return Session.list(this.sessionsDir);
  }

  /** Resume another session (`/resume`), within the same side of any zone boundary. */
  resume(id: string): Session {
    const session = this.loadSession(id);
    this.session = session;
    this.agent.loadTranscript(session.messages);
    return session;
  }

  private loadSession(id: string): Session {
    let session: Session;
    try {
      session = Session.load(id, this.sessionsDir);
    } catch (err) {
      if (this.offline?.zone) {
        throw new OfflineError(
          `${(err as Error).message} Inside the offline zone ${this.offline.zone} only its own sessions can be resumed.`,
        );
      }
      throw err;
    }
    assertResumeAllowed(session.meta, this.offline);
    return session;
  }

  /** Persist the transcript after a run, compaction, or clear. */
  save(): void {
    this.session.sync(this.agent.messages, {
      rewrite: this.agent.takeHistoryEdited(),
      titleHint: this.agent.firstPrompt,
    });
  }
}
