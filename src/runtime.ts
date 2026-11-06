/**
 * Wires config → provider → permissions → agent → session. Shared by the REPL and headless mode.
 */
import type { Experimental_VideoModelV4 as VideoModel } from '@ai-sdk/provider';
import type { ImageModel, LanguageModel, SpeechModel, TranscriptionModel } from 'ai';
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
import { findCorpus } from './lang/corpus.ts';
import { type LangMemory, loadLangMemory } from './lang/memory.ts';
import type { Variety } from './lang/tables.ts';
import { learnerPath, learnerSummary, loadLearner, today } from './learner.ts';
import { formatMcpStatus, type McpConnect, McpManager, type McpServerStatus } from './mcp.ts';
import { assertModeVariety, isModeName, MODES, type ModeName } from './modes.ts';
import { type AskFn, PermissionManager } from './permissions.ts';
import { buildSystemPrompt } from './prompt.ts';
import {
  createImageModel,
  createModel,
  createSpeechModel,
  createTranscriptionModel,
  createVideoModel,
} from './providers.ts';
import { classify, type RouteDecision, type Tier } from './routing.ts';
import { Session, type SessionMeta } from './session.ts';
import { createImageTool } from './tools/image.ts';
import { type AnyTool, toolsForMode } from './tools/index.ts';
import { createLearnedTool } from './tools/learned.ts';
import { createSpeakTool, createTranscribeTool } from './tools/speech.ts';
import { createVideoTool } from './tools/video.ts';
import { findImagePaths } from './vision.ts';
import {
  assertNoYolo,
  assertProfileAllowed,
  assertResumeAllowed,
  describeOffline,
  isLocalProfile,
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
  /** `--mode` (T1). Without it: the resumed session's mode, else default. */
  mode?: ModeName;
  /** `--variety` (T8): the tutor mode's variety. Without it: the resumed session's. */
  variety?: string;
  /** Use this image model instead of building one from `image.profile` (tests). */
  imageModel?: ImageModel;
  /** Test seams for the speech tools (T5). */
  speechModel?: SpeechModel;
  transcriptionModel?: TranscriptionModel;
  /** Test seam for the video tool (T6). */
  videoModel?: VideoModel;
  /** Use this model instead of building one from the profile (tests, the eval harness). */
  languageModel?: LanguageModel;
  /** Test seam: the model for a profile that routing or /provider switches to. */
  languageModelFor?: (profile: string) => LanguageModel | undefined;
  /** Model routing (T7) when the config has `routing`; off when -P or -m chose a model. */
  routing?: boolean;
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
  /** The mode (T1): its prompt text and permission policy are in force. */
  mode: ModeName = 'default';
  /** Media tools built from the config (T4+): `image` when `image` is configured. */
  private mediaTools: AnyTool[] = [];
  /**
   * Language memory (A3), read once here and on reloadLang(). Kept fixed in between, so the
   * system prompt, and with it the cached prefix, does not change from turn to turn.
   */
  lang: LangMemory;
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

    this.mediaTools = this.buildMediaTools(opts);
    this.modelFor = opts.languageModelFor;
    this.route = { active: this.routingUsable(opts.routing ?? true) };
    // An explicit --mode wins; a resumed session keeps the mode (and variety) it was saved with.
    const saved = this.session.meta.mode;
    const mode = opts.mode ?? (saved && isModeName(saved) ? saved : 'default');
    const variety = assertModeVariety(mode, opts.variety ?? this.session.meta.variety);
    this.applyMode(mode, variety);
    if (mode !== (saved ?? 'default') || variety !== this.session.meta.variety) {
      this.session.setMode(mode, variety);
    }
    this.lang = loadLangMemory(opts.cwd);
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
      ...(this.config.corpus ? { corpus: this.config.corpus } : {}),
      ...(this.variety ? { variety: this.variety } : {}),
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
      lang: this.lang.block,
      mode: this.mode,
      ...(this.variety ? { variety: this.variety } : {}),
      learner: this.learnerBlock(),
    });
  }

  /** Where learner memory lives here: the offline zone's own file, else ~/.mrig/learner.json. */
  get learnerFile(): string {
    return learnerPath(this.offline?.zone);
  }

  /** The learner summary, read once per session the first time learn or teach mode needs it. */
  private learnerSnapshot: string | undefined;
  private learnerNoticeShown = false;

  /**
   * Learner memory for the prompt (T2): only in learn and teach mode, and only to local models
   * unless the global `learner.shareWithCloud` is on (RT, November 6, 2026).
   */
  private learnerBlock(): string {
    if (this.mode === 'default') return '';
    if (!isLocalProfile(this.profile) && !this.config.learner?.shareWithCloud) {
      if (!this.learnerNoticeShown) {
        this.learnerNoticeShown = true;
        this.events.onNotice?.(
          `Learner memory isn't sent to cloud models like ${this.modelLabel()}, so this session starts without it. Results are still recorded locally; set "learner": { "shareWithCloud": true } in ~/.mrig/config.json to share the summary.`,
        );
      }
      return '';
    }
    if (this.learnerSnapshot === undefined) {
      try {
        this.learnerSnapshot = learnerSummary(loadLearner(this.learnerFile), today(), this.variety);
      } catch (err) {
        this.events.onNotice?.((err as Error).message);
        this.learnerSnapshot = '';
      }
    }
    return this.learnerSnapshot;
  }

  /**
   * The media tools the config asks for: image (T4), speak and transcribe (T5). Each one is
   * built on its own; a provider that can't be set up is a notice, not a crash.
   */
  private buildMediaTools(opts: RuntimeOptions): AnyTool[] {
    const tools: AnyTool[] = [];
    const build = (label: string, profileName: string, make: (remote: boolean) => AnyTool) => {
      try {
        const { profile } = resolveProfile(this.config, profileName);
        tools.push(make(!isLocalProfile(profile)));
      } catch (err) {
        opts.events.onNotice?.(`The ${label} tool is off: ${(err as Error).message}`);
      }
    };
    const { image, speech, transcription } = this.config;
    const profileOf = (name: string) => resolveProfile(this.config, name).profile;
    if (image) {
      build('image', image.profile, (remote) => {
        const model = opts.imageModel ?? createImageModel(profileOf(image.profile), image.model);
        return createImageTool({ config: image, model, remote }) as AnyTool;
      });
    }
    if (speech) {
      build('speak', speech.profile, (remote) => {
        const model =
          opts.speechModel ?? createSpeechModel(profileOf(speech.profile), speech.model);
        return createSpeakTool({ config: speech, model, remote }) as AnyTool;
      });
    }
    if (transcription) {
      build('transcribe', transcription.profile, (remote) => {
        const model =
          opts.transcriptionModel ??
          createTranscriptionModel(profileOf(transcription.profile), transcription.model);
        return createTranscribeTool({ config: transcription, model, remote }) as AnyTool;
      });
    }
    // Video goes through the AI Gateway, not a profile; it is always remote.
    const video = this.config.video;
    if (video) {
      try {
        const model = opts.videoModel ?? createVideoModel(video);
        tools.push(createVideoTool({ config: video, model }) as AnyTool);
      } catch (err) {
        opts.events.onNotice?.(`The video tool is off: ${(err as Error).message}`);
      }
    }
    return tools;
  }

  /** The tutor mode's variety (T8); undefined in other modes. */
  variety: Variety | undefined;

  private applyMode(name: ModeName, variety?: Variety): void {
    this.mode = name;
    this.variety = MODES[name].needsVariety ? variety : undefined;
    this.permissions.policy = MODES[name].permissions;
    this.learnerSnapshot = undefined; // a new mode or variety reads its own summary
    if (this.agent) this.agent.opts.variety = this.variety;
    if (name === 'tutor' && !findCorpus(this.cwd, this.config.corpus)) {
      this.events.onNotice?.(
        'No corpus found, so the tutor can only ask from language memory. Set "corpus" in the config or add a cldf/ folder.',
      );
    }
  }

  /** `/mode <name> [variety]`: switch the prompt, the tools on offer and the permission policy. */
  setMode(name: ModeName, variety?: string): void {
    const v = assertModeVariety(name, variety); // refuse before changing anything
    this.applyMode(name, v);
    this.session.setMode(name, v);
    this.agent.setTools(this.currentTools());
    this.agent.opts.systemPrompt = this.systemPrompt();
  }

  /** `/lang reload`: read the lang/ files again. The next request re-caches the prompt. */
  reloadLang(): LangMemory {
    this.lang = loadLangMemory(this.cwd);
    this.agent.opts.systemPrompt = this.systemPrompt();
    return this.lang;
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

  // ---- model routing (T7) ----

  /** Routing state: whether it's on, a pinned tier (/route easy|hard), and the last decision. */
  route: { active: boolean; pinned?: Tier; last?: RouteDecision & { profile: string } };
  private modelFor: RuntimeOptions['languageModelFor'];
  private routeFallbackShown = false;

  /** Routing needs a `routing` block whose two profiles exist; otherwise it stays off. */
  private routingUsable(wanted: boolean): boolean {
    const r = this.config.routing;
    if (!r || !wanted) return false;
    try {
      resolveProfile(this.config, r.easy);
      resolveProfile(this.config, r.hard);
      return true;
    } catch (err) {
      this.events.onNotice?.(`Routing is off: ${(err as Error).message}`);
      return false;
    }
  }

  /** Whether a tier's profile may run here (offline mode allows local profiles only). */
  private tierAllowed(tier: Tier): boolean {
    const name = this.config.routing?.[tier];
    if (!name) return false;
    return !this.offline || isLocalProfile(resolveProfile(this.config, name).profile);
  }

  /**
   * Route one message (T7): pick the tier by rules, switch to its profile if needed, and say
   * which and why. Returns the message to send (a `!easy` / `!hard` prefix removed).
   */
  routeMessage(text: string): string {
    const r = this.config.routing;
    if (!r || !this.route.active) return text;
    const vision = (t: Tier) => resolveProfile(this.config, r[t]).profile.vision === true;
    const decision: RouteDecision = this.route.pinned
      ? {
          tier: this.route.pinned,
          reason: 'pinned with /route',
          text: text.replace(/^\s*!(easy|hard)\b\s*/i, ''),
        }
      : classify(text, r, {
          hasImages: findImagePaths(text, this.cwd).images.length > 0,
          vision: { easy: vision('easy'), hard: vision('hard') },
        });
    let tier = decision.tier;
    if (!this.tierAllowed(tier)) {
      const other: Tier = tier === 'easy' ? 'hard' : 'easy';
      if (!this.tierAllowed(other)) return decision.text; // nothing usable: stay where we are
      if (!this.routeFallbackShown) {
        this.routeFallbackShown = true;
        this.events.onNotice?.(
          `Offline mode: the ${tier} profile (${r[tier]}) is not local, so its messages go to ${r[other]}.`,
        );
      }
      tier = other;
    }
    const profile = r[tier];
    if (profile !== this.providerName) this.switchTo(profile);
    this.route.last = { ...decision, tier, profile };
    this.events.onNotice?.(`→ ${this.modelLabel()} (${tier}: ${decision.reason})`);
    return decision.text;
  }

  /** `/route on|off|easy|hard`. On (or a pin) only when both profiles exist; returns whether it's on. */
  setRouting(state: 'on' | 'off' | Tier): boolean {
    delete this.route.pinned;
    if (state === 'off') {
      this.route.active = false;
      return false;
    }
    this.route.active = this.routingUsable(true);
    if (this.route.active && state !== 'on') this.route.pinned = state;
    return this.route.active;
  }

  /** Route the message, then run the turn. The REPL, the TUI and headless mode all use this. */
  runTurn(text: string, signal?: AbortSignal): ReturnType<Agent['run']> {
    return this.agent.run(this.routeMessage(text), signal);
  }

  /** Switch provider and/or model mid-session, keeping the transcript. Turns routing off. */
  switchModel(provider?: string, model?: string): void {
    this.switchTo(provider ?? this.providerName, model);
    if (this.route.active) {
      this.route.active = false;
      this.events.onNotice?.(
        'Routing is off for this session, because you chose a model. /route on turns it back on.',
      );
    }
  }

  private switchTo(provider: string, model?: string): void {
    const resolved = resolveProfile(this.config, provider, model);
    assertProfileAllowed(resolved.name, resolved.profile, this.offline);
    const nextModel = this.modelFor?.(resolved.name) ?? createModel(resolved.profile);
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
    const extra =
      this.profile.toolMode === 'minimal' ? [] : [...(this.mcp?.tools() ?? []), ...this.mediaTools];
    const tools = offlineTools([...toolsForMode(this.profile.toolMode), ...extra], this.offline);
    // learn and teach mode can record results in learner memory (T2).
    if (this.mode !== 'default')
      tools.push(
        createLearnedTool({
          path: this.learnerFile,
          ...(this.variety ? { variety: this.variety } : {}),
        }) as AnyTool,
      );
    // learn mode offers read-only tools only.
    return MODES[this.mode].permissions === 'read-only' ? tools.filter((t) => t.readOnly) : tools;
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
    if (on && this.mode !== 'default') {
      throw new Error(
        `${this.mode} mode ${this.mode === 'teach' ? 'asks before every change' : 'only reads'}; /mode default first to skip prompts.`,
      );
    }
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
    const saved = session.meta.mode;
    const mode = saved && isModeName(saved) ? saved : 'default';
    const variety = MODES[mode].needsVariety
      ? assertModeVariety(mode, session.meta.variety)
      : undefined;
    if (mode !== this.mode || variety !== this.variety) {
      this.applyMode(mode, variety);
      this.agent.setTools(this.currentTools());
      this.agent.opts.systemPrompt = this.systemPrompt();
    }
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
