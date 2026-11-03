/**
 * Configuration: named provider profiles, permissions, and defaults.
 *
 * Resolution order (later wins):
 *   built-in defaults → ~/.mrig/config.json → ./.mrig/config.json → env vars → CLI flags
 *
 * MRIG_HOME overrides ~/.mrig (used by tests).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible';

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
}

export const DEFAULT_PROVIDERS: Record<string, ProviderProfile> = {
  claude: {
    kind: 'anthropic',
    model: 'claude-sonnet-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
  },
  opus: {
    kind: 'anthropic',
    model: 'claude-opus-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
  },
  fable: {
    kind: 'anthropic',
    model: 'claude-fable-5-1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
  },
  haiku: {
    kind: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 200_000,
  },
  openai: {
    kind: 'openai',
    // Check https://platform.openai.com/docs/models for the current ID you want.
    model: 'gpt-5',
    apiKeyEnv: 'OPENAI_API_KEY',
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
};

export function mrigHome(): string {
  return process.env.MRIG_HOME ?? join(homedir(), '.mrig');
}

export function ensureMrigHome(): string {
  const home = mrigHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

type PartialConfig = Partial<Omit<MrigConfig, 'permissions'>> & {
  permissions?: Partial<PermissionsConfig>;
};

function readJson(path: string): PartialConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PartialConfig;
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

const CACHE_TTLS: readonly string[] = ['5m', '1h'];

function parseCacheTtl(value: unknown): CacheTtl | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && CACHE_TTLS.includes(value)) return value as CacheTtl;
  throw new Error(`Invalid "cacheTtl": ${JSON.stringify(value)}. Use "5m" or "1h".`);
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
  };
}

export interface LoadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Load config from all layers (defaults, global file, project file, env). */
export function loadConfig(opts: LoadOptions = {}): MrigConfig {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  let cfg = DEFAULT_CONFIG;
  cfg = merge(cfg, readJson(join(mrigHome(), 'config.json')));
  cfg = merge(cfg, readJson(join(cwd, '.mrig', 'config.json')));
  if (env.MRIG_PROVIDER) cfg = { ...cfg, defaultProvider: env.MRIG_PROVIDER };
  if (env.MRIG_YOLO === '1') cfg = { ...cfg, permissions: { ...cfg.permissions, yolo: true } };
  return cfg;
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
