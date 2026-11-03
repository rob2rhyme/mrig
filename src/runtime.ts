/**
 * Wires config → provider → permissions → agent → session. Shared by the REPL and headless mode.
 */
import type { LanguageModel } from 'ai';
import { Agent, type AgentEvents } from './agent.ts';
import { loadConfig, type MrigConfig, type ProviderProfile, resolveProfile } from './config.ts';
import { checkProfile, type DoctorOptions, type ModelCheck } from './doctor.ts';
import { type AskFn, PermissionManager } from './permissions.ts';
import { buildSystemPrompt } from './prompt.ts';
import { createModel } from './providers.ts';
import { Session } from './session.ts';
import { DEFAULT_TOOLS } from './tools/index.ts';

export interface RuntimeOptions {
  cwd: string;
  provider?: string;
  model?: string;
  yolo?: boolean;
  maxSteps?: number;
  /** Session id to resume, or "latest" for the most recent session in cwd. */
  resume?: string;
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

  constructor(opts: RuntimeOptions) {
    this.cwd = opts.cwd;
    this.config = loadConfig({ cwd: opts.cwd });
    const resolved = resolveProfile(this.config, opts.provider, opts.model);
    this.providerName = resolved.name;
    this.profile = resolved.profile;
    this.model = createModel(this.profile);

    this.permissions = new PermissionManager({
      yolo: opts.yolo ?? this.config.permissions.yolo,
      allow: this.config.permissions.allow,
      ask: opts.ask,
      cwd: opts.cwd,
    });

    if (opts.resume) {
      const id = opts.resume === 'latest' ? Session.latest(opts.cwd)?.id : opts.resume;
      if (!id) throw new Error(`No previous session found for ${opts.cwd}.`);
      this.session = Session.load(id);
    } else {
      this.session = Session.create({
        cwd: opts.cwd,
        provider: this.providerName,
        model: this.profile.model,
      });
    }

    this.agent = new Agent({
      model: this.model,
      modelLabel: this.modelLabel(),
      profile: this.profile,
      tools: DEFAULT_TOOLS,
      permissions: this.permissions,
      cwd: opts.cwd,
      systemPrompt: buildSystemPrompt({ cwd: opts.cwd, modelLabel: this.modelLabel() }),
      maxSteps: opts.maxSteps ?? this.config.maxSteps,
      maxToolOutputChars: this.config.maxToolOutputChars,
      events: opts.events,
      messages: this.session.messages,
    });
  }

  modelLabel(): string {
    return `${this.providerName}/${this.profile.model}`;
  }

  /** Ask the active provider whether it serves the configured model id (never throws). */
  checkModel(opts: DoctorOptions = {}): Promise<ModelCheck> {
    return checkProfile(this.providerName, this.profile, opts);
  }

  /** Switch provider and/or model mid-session, keeping the transcript. */
  switchModel(provider?: string, model?: string): void {
    const resolved = resolveProfile(this.config, provider ?? this.providerName, model);
    const nextModel = createModel(resolved.profile);
    this.providerName = resolved.name;
    this.profile = resolved.profile;
    this.model = nextModel;
    this.agent.opts.model = nextModel;
    this.agent.opts.profile = resolved.profile;
    this.agent.opts.modelLabel = this.modelLabel();
    this.agent.opts.systemPrompt = buildSystemPrompt({
      cwd: this.cwd,
      modelLabel: this.modelLabel(),
    });
    this.session.setModel(this.providerName, this.profile.model);
  }

  /** Persist the transcript after a run, compaction, or clear. */
  save(): void {
    this.session.sync(this.agent.messages);
  }
}
