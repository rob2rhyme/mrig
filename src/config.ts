/**
 * Configuration: named provider profiles, permissions, and defaults.
 *
 * Resolution order (later wins):
 *   built-in defaults → ~/.mrig/config.json → ./.mrig/config.json → env vars → CLI flags
 *
 * A project's config comes with the repo, so by default it may only set harmless keys
 * (PROJECT_KEYS). Permissions, providers and MCP servers come from the global config, unless
 * the folder is listed in the global "trustedProjects".
 *
 * MRIG_HOME overrides ~/.mrig (used by tests).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type McpServerConfig, parseMcpServers } from './mcp.ts';
import { parseRouting, type RoutingConfig } from './routing.ts';

export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible';

/**
 * Which tools the model sees. `minimal` is bash only, for local models that cannot handle
 * multi-tool calling; they read and edit files through shell commands instead.
 */
export type ToolMode = 'full' | 'minimal';

/** Prompt-cache lifetime for Anthropic profiles. Writes cost 1.25× input at 5m, 2× at 1h. */
export type CacheTtl = '5m' | '1h';

export interface Pricing {
  /** USD per million input tokens */
  input: number;
  /** USD per million output tokens */
  output: number;
  /** USD per million cache-read tokens (defaults to 10% of input) */
  cacheRead?: number;
  /** USD per million cache-write tokens (defaults to input × 1.25 for 5m, × 2 for 1h) */
  cacheWrite?: number;
}

export interface ProviderProfile {
  kind: ProviderKind;
  model: string;
  /** Base URL for openai-compatible servers (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter…) */
  baseURL?: string;
  /** Environment variable holding the API key */
  apiKeyEnv?: string;
  /** Literal API key (prefer apiKeyEnv) */
  apiKey?: string;
  /** Display name for openai-compatible providers */
  name?: string;
  /** Override pricing; local models default to free */
  pricing?: Pricing;
  /** Approximate context window in tokens (informational) */
  contextWindow?: number;
  /** Tool set for this model: "full" (default) or "minimal" (bash only). */
  toolMode?: ToolMode;
  /** The model reads images (T3): image paths in a prompt are attached. Default false. */
  vision?: boolean;
}

export interface PermissionsConfig {
  /** Skip all permission prompts. Dangerous; fine for sandboxes. */
  yolo: boolean;
  /**
   * Persistent allow rules. Forms:
   *   "bash:git status"   → allow any bash command starting with "git status"
   *   "write:src/**"      → allow writes under src/ (glob, relative to cwd)
   *   "edit:**"           → allow all edits
   */
  allow: string[];
}

export interface CompactionConfig {
  /** Compact automatically before a step when the context passes the threshold (default true). */
  enabled: boolean;
  /** A fraction of the context window (0–1], or an absolute token count (> 1). Default 0.7. */
  threshold: number;
  /** Messages kept verbatim after a summary (default 4). */
  keep: number;
  /** Profile that writes summaries (default: the active profile). Use a local one offline. */
  compactModel?: string;
}

/** Image generation (T4): which profile's provider makes images, and how they are priced. */
export interface ImageConfig {
  /** A profile name; its kind, base URL and key are used. Default "openai". */
  profile: string;
  /** The image model id, e.g. "gpt-image-1". */
  model: string;
  /** Default size, "WIDTHxHEIGHT". */
  size?: `${number}x${number}`;
  /** USD per image, for the permission prompt and /cost. Unset: the price is unknown. */
  pricePerImage?: number;
  /** Where images are saved, relative to the working directory. Default "images". */
  dir: string;
}

/** Text to speech (T5): the `speak` tool. */
export interface SpeechConfig {
  /** A profile name (openai, or openai-compatible for a local audio server). Default "openai". */
  profile: string;
  /** The speech model id, e.g. "gpt-4o-mini-tts". */
  model: string;
  voice?: string;
  /** Audio format, e.g. "mp3" (default) or "wav". */
  format: string;
  /** USD per million characters of text, for the prompt and /cost. */
  pricePerMillionChars?: number;
  /** Where audio is saved, relative to the working directory. Default "audio". */
  dir: string;
}

/** Speech to text (T5): the `transcribe` tool. */
export interface TranscriptionConfig {
  /** A profile name (openai, or openai-compatible for a local audio server). Default "openai". */
  profile: string;
  /** The transcription model id, e.g. "whisper-1". */
  model: string;
  /** USD per minute of audio, for /cost. */
  pricePerMinute?: number;
}

/** Video generation (T6), through the Vercel AI Gateway: the `video` tool. */
export interface VideoConfig {
  /** A gateway video model id, e.g. "google/veo-3.1-fast-generate-001". */
  model: string;
  /** The environment variable holding the gateway key. Default "AI_GATEWAY_API_KEY". */
  apiKeyEnv: string;
  /** Another gateway URL (rarely needed). */
  baseURL?: string;
  /** Default clip length in seconds. Default 5. */
  duration: number;
  aspectRatio?: `${number}:${number}`;
  resolution?: `${number}x${number}`;
  /** USD per second of video. Required: the cost cap needs it. */
  pricePerSecond: number;
  /** A job whose estimated cost is over this many US dollars never starts. Default 2. */
  maxCostPerJob: number;
  /** Seconds between status checks. Default 10. */
  pollSeconds: number;
  /** Give up waiting after this many minutes. Default 20. */
  timeoutMinutes: number;
  /** Where videos are saved, relative to the working directory. Default "videos". */
  dir: string;
}

export interface MrigConfig {
  defaultProvider: string;
  providers: Record<string, ProviderProfile>;
  permissions: PermissionsConfig;
  /** Max model turns per user message before mrig stops and asks. */
  maxSteps: number;
  /** Tool output cap in characters before truncation. */
  maxToolOutputChars: number;
  /** Prompt-cache TTL for Anthropic profiles: "5m" (default) or "1h". Ignored elsewhere. */
  cacheTtl: CacheTtl;
  /** Automatic context compaction (L4). */
  compaction: CompactionConfig;
  /** MCP servers (L6). Read from ~/.mrig/config.json, or a trusted project's config. */
  mcpServers: Record<string, McpServerConfig>;
  /**
   * Folders whose `.mrig/config.json` applies in full, subfolders included. Read from
   * ~/.mrig/config.json only. Absolute paths; a leading `~/` means the home folder.
   */
  trustedProjects: string[];
  /**
   * The corpus folder for the `corpus` tool (A4): a CLDF dataset, or any folder of text files.
   * Relative paths are relative to the working directory; `~/` is the home folder. When unset,
   * the tool looks for a `cldf/` folder from cwd up to the git root.
   */
  corpus?: string;
  /** Image generation (T4); the `image` tool exists only when this is set. */
  image?: ImageConfig;
  /** Text to speech (T5); the `speak` tool exists only when this is set. */
  speech?: SpeechConfig;
  /** Speech to text (T5); the `transcribe` tool exists only when this is set. */
  transcription?: TranscriptionConfig;
  /** Video generation (T6); the `video` tool exists only when this is set. */
  video?: VideoConfig;
  /** Learner memory (T2). Global only: whether the summary may go to cloud models too. */
  learner?: { shareWithCloud: boolean };
  /** Model routing (T7). Global only: an easy and a hard profile, and the rules between them. */
  routing?: RoutingConfig;
  /** Keys an untrusted project config tried to set and that were dropped (set by loadConfig). */
  projectIgnored?: string[];
}

export const DEFAULT_PROVIDERS: Record<string, ProviderProfile> = {
  claude: {
    kind: 'anthropic',
    model: 'claude-sonnet-5-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
    vision: true,
  },
  opus: {
    kind: 'anthropic',
    model: 'claude-opus-5-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
    vision: true,
  },
  fable: {
    kind: 'anthropic',
    model: 'claude-fable-5-1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
    vision: true,
  },
  haiku: {
    kind: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 200_000,
    vision: true,
  },
  openai: {
    kind: 'openai',
    // Check https://platform.openai.com/docs/models for the current ID you want.
    model: 'gpt-5',
    apiKeyEnv: 'OPENAI_API_KEY',
    vision: true,
  },
  ollama: {
    kind: 'openai-compatible',
    name: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    // `ollama pull qwen3-coder` first. Set OLLAMA_CONTEXT_LENGTH=65536 (or more) for agent use.
    model: 'qwen3-coder',
    pricing: { input: 0, output: 0 },
  },
  lmstudio: {
    kind: 'openai-compatible',
    name: 'lmstudio',
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    // Use the model identifier shown in LM Studio's server tab.
    model: 'qwen/qwen3-coder-30b',
    pricing: { input: 0, output: 0 },
  },
  llamacpp: {
    kind: 'openai-compatible',
    name: 'llama.cpp',
    baseURL: 'http://localhost:8080/v1',
    apiKey: 'none',
    model: 'default',
    pricing: { input: 0, output: 0 },
  },
};

export const DEFAULT_CONFIG: MrigConfig = {
  defaultProvider: 'claude',
  providers: DEFAULT_PROVIDERS,
  permissions: { yolo: false, allow: [] },
  maxSteps: 40,
  maxToolOutputChars: 30_000,
  cacheTtl: '5m',
  compaction: { enabled: true, threshold: 0.7, keep: 4 },
  mcpServers: {},
  trustedProjects: [],
};

/** What an untrusted project config may set. Everything else is dropped with a notice. */
export const PROJECT_KEYS: readonly string[] = [
  'defaultProvider',
  'maxSteps',
  'maxToolOutputChars',
  'cacheTtl',
  'compaction',
  'corpus',
];

export function mrigHome(): string {
  return process.env.MRIG_HOME ?? join(homedir(), '.mrig');
}

export function ensureMrigHome(): string {
  const home = mrigHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

type PartialConfig = Partial<Omit<MrigConfig, 'permissions' | 'compaction'>> & {
  permissions?: Partial<PermissionsConfig>;
  compaction?: Partial<CompactionConfig>;
  mcpServers?: unknown;
  trustedProjects?: unknown;
};

function readJson(path: string): PartialConfig | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must hold a JSON object.`);
  }
  return value as PartialConfig;
}

function parseTrustedProjects(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new Error('"trustedProjects" must be a list of folder paths.');
  }
  return value.map((v: string) => {
    const expanded = v === '~' || /^~[\\/]/.test(v) ? join(homedir(), v.slice(1)) : v;
    if (!isAbsolute(expanded)) {
      throw new Error(`"trustedProjects" entries must be absolute paths: ${JSON.stringify(v)}.`);
    }
    return resolve(expanded);
  });
}

/** Whether `dir` is one of the trusted folders or inside one. */
export function isTrustedProject(dir: string, trusted: readonly string[]): boolean {
  const target = resolve(dir);
  return trusted.some((t) => {
    const rel = relative(t, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/** Split an untrusted project config into what it may set and the keys it may not. */
function restrictProject(layer: PartialConfig): { kept: PartialConfig; ignored: string[] } {
  const kept: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(layer)) {
    if (PROJECT_KEYS.includes(key)) {
      kept[key] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const names = Object.keys(value);
      if (names.length === 0) continue;
      // Name what was dropped: permissions.allow, providers.evil, mcpServers.files.
      ignored.push(...names.map((n) => `${key}.${n}`));
    } else {
      ignored.push(key);
    }
  }
  return { kept: kept as PartialConfig, ignored };
}

const CACHE_TTLS: readonly string[] = ['5m', '1h'];

function parseCacheTtl(value: unknown): CacheTtl | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && CACHE_TTLS.includes(value)) return value as CacheTtl;
  throw new Error(`Invalid "cacheTtl": ${JSON.stringify(value)}. Use "5m" or "1h".`);
}

function parseCompaction(
  layer: Partial<CompactionConfig> | undefined,
  base: CompactionConfig,
): CompactionConfig {
  if (layer === undefined) return base;
  if (!layer || typeof layer !== 'object') throw new Error('"compaction" must be an object.');
  const out: CompactionConfig = { ...base, ...layer };
  if (typeof out.enabled !== 'boolean')
    throw new Error('"compaction.enabled" must be true or false.');
  if (typeof out.threshold !== 'number' || !(out.threshold > 0)) {
    throw new Error(
      `Invalid "compaction.threshold": ${JSON.stringify(out.threshold)}. Use a fraction of the context window such as 0.7, or a token count such as 90000.`,
    );
  }
  if (!Number.isInteger(out.keep) || out.keep < 0) {
    throw new Error(
      `Invalid "compaction.keep": ${JSON.stringify(out.keep)}. Use a whole number such as 4.`,
    );
  }
  if (out.compactModel !== undefined && typeof out.compactModel !== 'string') {
    throw new Error('"compaction.compactModel" must be a profile name.');
  }
  return out;
}

function merge(base: MrigConfig, layer: PartialConfig | undefined): MrigConfig {
  if (!layer) return base;
  return {
    defaultProvider: layer.defaultProvider ?? base.defaultProvider,
    providers: { ...base.providers, ...(layer.providers ?? {}) },
    permissions: {
      yolo: layer.permissions?.yolo ?? base.permissions.yolo,
      allow: [...base.permissions.allow, ...(layer.permissions?.allow ?? [])],
    },
    maxSteps: layer.maxSteps ?? base.maxSteps,
    maxToolOutputChars: layer.maxToolOutputChars ?? base.maxToolOutputChars,
    cacheTtl: parseCacheTtl(layer.cacheTtl) ?? base.cacheTtl,
    compaction: parseCompaction(layer.compaction, base.compaction),
    mcpServers: { ...base.mcpServers, ...parseMcpServers(layer.mcpServers) },
    trustedProjects: base.trustedProjects,
    ...parseCorpus(layer.corpus, base.corpus),
    ...parseImage(layer.image, base.image),
    ...parseSpeech(layer.speech, base.speech),
    ...parseTranscription(layer.transcription, base.transcription),
    ...parseVideo(layer.video, base.video),
    ...parseLearner(layer.learner, base.learner),
    ...(layer.routing !== undefined
      ? { routing: parseRouting(layer.routing) }
      : base.routing
        ? { routing: base.routing }
        : {}),
  };
}

const SIZE = /^\d+x\d+$/;

/** The shared part of a media block: an object with a model id and an optional profile name. */
function mediaBlock(key: string, value: unknown, base: object | undefined, example: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`"${key}" must be an object, e.g. ${example}.`);
  }
  const v: Record<string, unknown> = { ...base, ...(value as Record<string, unknown>) };
  if (typeof v.model !== 'string' || !v.model)
    throw new Error(`"${key}.model" must be a model id.`);
  if (v.profile !== undefined && typeof v.profile !== 'string') {
    throw new Error(`"${key}.profile" must be a profile name.`);
  }
  return v;
}

function optionalPrice(key: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || value < 0)
    throw new Error(`"${key}" must be a number of US dollars.`);
  return value;
}

function parseSpeech(value: unknown, base: SpeechConfig | undefined): { speech?: SpeechConfig } {
  if (value === undefined) return base ? { speech: base } : {};
  const v = mediaBlock('speech', value, base, '{ "model": "gpt-4o-mini-tts" }');
  for (const k of ['voice', 'format', 'dir'] as const) {
    if (v[k] !== undefined && (typeof v[k] !== 'string' || !(v[k] as string).trim())) {
      throw new Error(`"speech.${k}" must be a string.`);
    }
  }
  const price = optionalPrice('speech.pricePerMillionChars', v.pricePerMillionChars);
  return {
    speech: {
      profile: (v.profile as string | undefined) ?? 'openai',
      model: v.model as string,
      ...(v.voice ? { voice: v.voice as string } : {}),
      format: (v.format as string | undefined) ?? 'mp3',
      ...(price !== undefined ? { pricePerMillionChars: price } : {}),
      dir: (v.dir as string | undefined) ?? 'audio',
    },
  };
}

function parseTranscription(
  value: unknown,
  base: TranscriptionConfig | undefined,
): { transcription?: TranscriptionConfig } {
  if (value === undefined) return base ? { transcription: base } : {};
  const v = mediaBlock('transcription', value, base, '{ "model": "whisper-1" }');
  const price = optionalPrice('transcription.pricePerMinute', v.pricePerMinute);
  return {
    transcription: {
      profile: (v.profile as string | undefined) ?? 'openai',
      model: v.model as string,
      ...(price !== undefined ? { pricePerMinute: price } : {}),
    },
  };
}

function parseLearner(
  value: unknown,
  base: MrigConfig['learner'],
): { learner?: { shareWithCloud: boolean } } {
  if (value === undefined) return base ? { learner: base } : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"learner" must be an object, e.g. { "shareWithCloud": false }.');
  }
  const share = (value as Record<string, unknown>).shareWithCloud ?? base?.shareWithCloud ?? false;
  if (typeof share !== 'boolean')
    throw new Error('"learner.shareWithCloud" must be true or false.');
  return { learner: { shareWithCloud: share } };
}

function parseVideo(value: unknown, base: VideoConfig | undefined): { video?: VideoConfig } {
  if (value === undefined) return base ? { video: base } : {};
  const v = mediaBlock(
    'video',
    value,
    base,
    '{ "model": "google/veo-3.1-fast-generate-001", "pricePerSecond": 0.15 }',
  );
  const positive = (key: string, x: unknown, fallback: number): number => {
    if (x === undefined) return fallback;
    if (typeof x !== 'number' || !(x > 0))
      throw new Error(`"video.${key}" must be a positive number.`);
    return x;
  };
  if (v.pricePerSecond === undefined) {
    throw new Error(
      '"video.pricePerSecond" is required: the per-job cost cap needs it. Take it from your provider\'s price page.',
    );
  }
  const price = optionalPrice('video.pricePerSecond', v.pricePerSecond) as number;
  if (
    v.aspectRatio !== undefined &&
    (typeof v.aspectRatio !== 'string' || !/^\d+:\d+$/.test(v.aspectRatio))
  ) {
    throw new Error(
      `Invalid "video.aspectRatio": ${JSON.stringify(v.aspectRatio)}. Use W:H, e.g. "16:9".`,
    );
  }
  if (
    v.resolution !== undefined &&
    (typeof v.resolution !== 'string' || !SIZE.test(v.resolution))
  ) {
    throw new Error(
      `Invalid "video.resolution": ${JSON.stringify(v.resolution)}. Use WIDTHxHEIGHT, e.g. "1280x720".`,
    );
  }
  for (const k of ['apiKeyEnv', 'baseURL', 'dir'] as const) {
    if (v[k] !== undefined && (typeof v[k] !== 'string' || !(v[k] as string).trim())) {
      throw new Error(`"video.${k}" must be a string.`);
    }
  }
  return {
    video: {
      model: v.model as string,
      apiKeyEnv: (v.apiKeyEnv as string | undefined) ?? 'AI_GATEWAY_API_KEY',
      ...(v.baseURL ? { baseURL: v.baseURL as string } : {}),
      duration: positive('duration', v.duration, 5),
      ...(v.aspectRatio ? { aspectRatio: v.aspectRatio as VideoConfig['aspectRatio'] } : {}),
      ...(v.resolution ? { resolution: v.resolution as VideoConfig['resolution'] } : {}),
      pricePerSecond: price,
      maxCostPerJob: positive('maxCostPerJob', v.maxCostPerJob, 2),
      pollSeconds: positive('pollSeconds', v.pollSeconds, 10),
      timeoutMinutes: positive('timeoutMinutes', v.timeoutMinutes, 20),
      dir: (v.dir as string | undefined) ?? 'videos',
    },
  };
}

function parseImage(value: unknown, base: ImageConfig | undefined): { image?: ImageConfig } {
  if (value === undefined) return base ? { image: base } : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      '"image" must be an object, e.g. { "profile": "openai", "model": "gpt-image-1" }.',
    );
  }
  const v = { ...base, ...(value as Record<string, unknown>) };
  if (typeof v.model !== 'string' || !v.model)
    throw new Error('"image.model" must be an image model id.');
  if (v.profile !== undefined && typeof v.profile !== 'string') {
    throw new Error('"image.profile" must be a profile name.');
  }
  if (v.size !== undefined && (typeof v.size !== 'string' || !SIZE.test(v.size))) {
    throw new Error(
      `Invalid "image.size": ${JSON.stringify(v.size)}. Use WIDTHxHEIGHT, e.g. "1024x1024".`,
    );
  }
  if (
    v.pricePerImage !== undefined &&
    (typeof v.pricePerImage !== 'number' || v.pricePerImage < 0)
  ) {
    throw new Error('"image.pricePerImage" must be a number of US dollars.');
  }
  if (v.dir !== undefined && (typeof v.dir !== 'string' || !v.dir.trim())) {
    throw new Error('"image.dir" must be a folder path.');
  }
  return {
    image: {
      profile: (v.profile as string | undefined) ?? 'openai',
      model: v.model,
      ...(v.size ? { size: v.size as ImageConfig['size'] } : {}),
      ...(v.pricePerImage !== undefined ? { pricePerImage: v.pricePerImage as number } : {}),
      dir: (v.dir as string | undefined) ?? 'images',
    },
  };
}

function parseCorpus(value: unknown, base: string | undefined): { corpus?: string } {
  if (value === undefined) return base === undefined ? {} : { corpus: base };
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('"corpus" must be a folder path.');
  }
  return { corpus: value };
}

export interface LoadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Load config from all layers (defaults, global file, project file, env). */
export function loadConfig(opts: LoadOptions = {}): MrigConfig {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const globalPath = join(mrigHome(), 'config.json');
  const global = readJson(globalPath);
  let cfg = merge(DEFAULT_CONFIG, global);
  cfg = { ...cfg, trustedProjects: parseTrustedProjects(global?.trustedProjects) };

  const projectPath = join(cwd, '.mrig', 'config.json');
  // Running in the home folder: ./.mrig/config.json is the global config, already applied.
  const project = resolve(projectPath) === resolve(globalPath) ? undefined : readJson(projectPath);
  if (project) {
    // trustedProjects is global-only, even for a trusted project.
    const { trustedProjects: selfTrust, ...rest } = project;
    if (isTrustedProject(cwd, cfg.trustedProjects)) {
      cfg = merge(cfg, rest);
    } else {
      // A cloned repo's config must not grant itself permissions, point a profile (and its API
      // key) at another server, or start commands. Those keys are dropped and reported.
      const { kept, ignored } = restrictProject(rest);
      cfg = merge(cfg, kept);
      // A default or summarizer naming a profile that was just dropped falls back, not crashes.
      if (kept.defaultProvider !== undefined && !cfg.providers[cfg.defaultProvider]) {
        ignored.push('defaultProvider');
        cfg = { ...cfg, defaultProvider: merge(DEFAULT_CONFIG, global).defaultProvider };
      }
      const compactModel = kept.compaction?.compactModel;
      if (typeof compactModel === 'string' && !cfg.providers[compactModel]) {
        ignored.push('compaction.compactModel');
        const { compactModel: _dropped, ...compaction } = cfg.compaction;
        cfg = { ...cfg, compaction };
      }
      if (ignored.length > 0) cfg = { ...cfg, projectIgnored: ignored };
    }
    if (selfTrust !== undefined)
      cfg = { ...cfg, projectIgnored: [...(cfg.projectIgnored ?? []), 'trustedProjects'] };
  }
  if (env.MRIG_PROVIDER) cfg = { ...cfg, defaultProvider: env.MRIG_PROVIDER };
  if (env.MRIG_YOLO === '1') cfg = { ...cfg, permissions: { ...cfg.permissions, yolo: true } };
  return cfg;
}

/** The notice for an untrusted project's dropped keys, or undefined when nothing was dropped. */
export function projectIgnoredNotice(cfg: MrigConfig, cwd: string): string | undefined {
  const ignored = cfg.projectIgnored ?? [];
  if (ignored.length === 0) return undefined;
  return `Ignored ${ignored.join(', ')} from this project's .mrig/config.json: permissions, providers and MCP servers come from ~/.mrig/config.json. If you trust this project, add ${JSON.stringify(resolve(cwd))} to "trustedProjects" there.`;
}

/** Resolve a provider profile by name, applying an optional model override. */
export function resolveProfile(
  cfg: MrigConfig,
  name?: string,
  modelOverride?: string,
): { name: string; profile: ProviderProfile } {
  const key = name ?? cfg.defaultProvider;
  const profile = cfg.providers[key];
  if (!profile) {
    const known = Object.keys(cfg.providers).join(', ');
    throw new Error(`Unknown provider "${key}". Known providers: ${known}`);
  }
  return { name: key, profile: modelOverride ? { ...profile, model: modelOverride } : profile };
}

/** Resolve the API key for a profile from literal, env var, or well-known env var. */
export function resolveApiKey(profile: ProviderProfile, env: NodeJS.ProcessEnv = process.env) {
  if (profile.apiKey) return profile.apiKey;
  if (profile.apiKeyEnv && env[profile.apiKeyEnv]) return env[profile.apiKeyEnv];
  if (profile.kind === 'anthropic') return env.ANTHROPIC_API_KEY;
  if (profile.kind === 'openai') return env.OPENAI_API_KEY;
  return undefined;
}
