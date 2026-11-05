/**
 * `mrig doctor`: ask each provider which models it serves and flag profiles whose model id is
 * not listed. Pure logic with an injectable fetch, so tests never touch the network. The REPL
 * runs the same check for the active profile at startup and prints a one-line warning.
 */
import { type MrigConfig, type ProviderProfile, resolveApiKey } from './config.ts';
import { isLocalProfile } from './zone.ts';

export type CheckStatus =
  | 'ok'
  | 'unknown-model'
  | 'no-key'
  | 'auth'
  | 'unreachable'
  /** The server answered but gave no usable model list; the id was not checked. */
  | 'no-list'
  /** Offline mode: a profile that is not on this machine is not contacted. */
  | 'offline';

export interface ModelCheck {
  name: string;
  profile: ProviderProfile;
  status: CheckStatus;
  /** One plain sentence for the terminal. */
  message: string;
  /** Model ids the server listed (empty unless a list came back). */
  models: string[];
}

/** Statuses that make `mrig doctor` exit non-zero. Skips (no key, no list) do not. */
export const PROBLEM_STATUSES: ReadonlySet<CheckStatus> = new Set([
  'unknown-model',
  'auth',
  'unreachable',
]);

const ANTHROPIC_HOST = 'https://api.anthropic.com';
const ANTHROPIC_URL = `${ANTHROPIC_HOST}/v1`;
const OPENAI_URL = 'https://api.openai.com/v1';

/** The provider's model-list endpoint for a profile. */
export function modelsUrl(profile: ProviderProfile): string {
  let base = (
    profile.baseURL ?? (profile.kind === 'anthropic' ? ANTHROPIC_URL : OPENAI_URL)
  ).replace(/\/+$/, '');
  // Mirror @ai-sdk/anthropic, which treats the bare host as the versioned URL.
  if (profile.kind === 'anthropic' && base === ANTHROPIC_HOST) base = ANTHROPIC_URL;
  return profile.kind === 'anthropic' ? `${base}/models?limit=1000` : `${base}/models`;
}

/** Exact id, or the Ollama convention where `qwen3-coder` is served as `qwen3-coder:latest`. */
export function modelMatches(model: string, ids: string[]): boolean {
  return ids.includes(model) || ids.includes(`${model}:latest`);
}

export interface DoctorOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Offline mode (L5): skip profiles that are not on this machine. */
  offline?: boolean;
}

function suggest(model: string, ids: string[]): string {
  const stem = (model.split(/[-:/]/)[0] ?? '').toLowerCase();
  const near = stem ? ids.filter((id) => id.toLowerCase().includes(stem)) : [];
  const pool = (near.length ? near : ids).slice(0, 5);
  if (pool.length === 0) return 'The server listed no models.';
  return `Available: ${pool.join(', ')}${ids.length > pool.length ? ', …' : ''}`;
}

/** Check one profile's model id against what its server lists. Never throws. */
export async function checkProfile(
  name: string,
  profile: ProviderProfile,
  opts: DoctorOptions = {},
): Promise<ModelCheck> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const key = resolveApiKey(profile, env);
  const base = { name, profile, models: [] as string[] };

  if (opts.offline && !isLocalProfile(profile)) {
    return {
      ...base,
      status: 'offline',
      message: 'skipped: offline mode only contacts this machine',
    };
  }

  if (profile.kind !== 'openai-compatible' && !key) {
    const envName =
      profile.apiKeyEnv ?? (profile.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
    return { ...base, status: 'no-key', message: `skipped: no API key (${envName} is unset)` };
  }
  if (profile.kind === 'openai-compatible' && !profile.baseURL) {
    return { ...base, status: 'no-list', message: 'skipped: profile has no baseURL' };
  }

  const url = modelsUrl(profile);
  const headers: Record<string, string> =
    profile.kind === 'anthropic'
      ? { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }
      : key && key !== 'none'
        ? { authorization: `Bearer ${key}` }
        : {};

  let res: Response;
  try {
    res = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const hint = profile.kind === 'openai-compatible' ? ' Is the server running?' : '';
    return { ...base, status: 'unreachable', message: `cannot reach ${url} (${reason}).${hint}` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ...base,
      status: 'auth',
      message: `authentication failed (HTTP ${res.status}) at ${url}`,
    };
  }
  if (!res.ok) {
    return {
      ...base,
      status: 'no-list',
      message: `server does not list models (HTTP ${res.status}); model id not checked`,
    };
  }
  let ids: string[];
  try {
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  } catch {
    return {
      ...base,
      status: 'no-list',
      message: 'server returned something that is not a model list; model id not checked',
    };
  }
  if (modelMatches(profile.model, ids)) {
    return { ...base, models: ids, status: 'ok', message: `model "${profile.model}" is available` };
  }
  return {
    ...base,
    models: ids,
    status: 'unknown-model',
    message: `model "${profile.model}" is not listed by the server. ${suggest(profile.model, ids)}`,
  };
}

/** Check every profile in the config, or just `only`. Runs the checks concurrently. */
export async function doctor(
  cfg: MrigConfig,
  opts: DoctorOptions & { only?: string } = {},
): Promise<ModelCheck[]> {
  const names = opts.only ? [opts.only] : Object.keys(cfg.providers);
  const entries = names.map((n) => {
    const profile = cfg.providers[n];
    if (!profile) {
      const known = Object.keys(cfg.providers).join(', ');
      throw new Error(`Unknown provider "${n}". Known providers: ${known}`);
    }
    return [n, profile] as const;
  });
  return Promise.all(entries.map(([n, p]) => checkProfile(n, p, opts)));
}

export function hasProblems(checks: ModelCheck[]): boolean {
  return checks.some((c) => PROBLEM_STATUSES.has(c.status));
}

// ---- Ollama context length (L2 hardening) ----------------------------------------------------

/** Agents need room for the system prompt, memory and tool output; below this they thrash. */
export const MIN_LOCAL_CONTEXT = 32_768;

export type ContextStatus = 'ok' | 'low' | 'unknown' | 'skipped';

export interface ContextCheck {
  status: ContextStatus;
  /** Tokens, when the server reported one (num_ctx or the model's maximum). */
  contextLength?: number;
  message: string;
}

/** An openai-compatible profile that points at Ollama (by name, port or host). */
export function isOllama(profile: ProviderProfile): boolean {
  if (profile.kind !== 'openai-compatible' || !profile.baseURL) return false;
  return (
    profile.name?.toLowerCase() === 'ollama' ||
    /:11434(\/|$)/.test(profile.baseURL) ||
    /ollama/i.test(profile.baseURL)
  );
}

/** `http://host:11434/v1` → `http://host:11434`, where Ollama's native API lives. */
export function ollamaApiRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** `num_ctx` from the `parameters` text of /api/show, when the Modelfile sets one. */
export function parseNumCtx(parameters: unknown): number | undefined {
  if (typeof parameters !== 'string') return undefined;
  const m = /^\s*num_ctx\s+(\d+)/m.exec(parameters);
  return m ? Number(m[1]) : undefined;
}

/** The model's trained maximum, e.g. `model_info["qwen3.context_length"]`. */
export function modelMaxContext(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== 'object') return undefined;
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value;
  }
  return undefined;
}

const CONTEXT_FIX =
  'Set OLLAMA_CONTEXT_LENGTH=65536 before `ollama serve`, or PARAMETER num_ctx 65536 in a Modelfile.';

/**
 * Ask Ollama (POST /api/show) what context the model runs with and warn under 32k. Ollama only
 * reports `num_ctx` when a Modelfile sets it; otherwise the server default applies (4,096 unless
 * OLLAMA_CONTEXT_LENGTH is set), which this cannot see, so that case is reported as unknown.
 */
export async function checkOllamaContext(
  profile: ProviderProfile,
  opts: DoctorOptions = {},
): Promise<ContextCheck> {
  if (!isOllama(profile) || !profile.baseURL)
    return { status: 'skipped', message: 'not an Ollama profile' };
  const doFetch = opts.fetch ?? fetch;
  const url = `${ollamaApiRoot(profile.baseURL)}/api/show`;
  let json: { parameters?: unknown; model_info?: unknown };
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: profile.model }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok)
      return { status: 'skipped', message: `Ollama /api/show answered HTTP ${res.status}` };
    json = (await res.json()) as typeof json;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'skipped', message: `cannot reach ${url} (${reason})` };
  }
  const n = MIN_LOCAL_CONTEXT.toLocaleString();
  const numCtx = parseNumCtx(json.parameters);
  if (numCtx !== undefined) {
    return numCtx >= MIN_LOCAL_CONTEXT
      ? {
          status: 'ok',
          contextLength: numCtx,
          message: `Ollama runs ${profile.model} with a ${numCtx.toLocaleString()}-token context`,
        }
      : {
          status: 'low',
          contextLength: numCtx,
          message: `Ollama runs ${profile.model} with num_ctx ${numCtx.toLocaleString()}; agents need at least ${n}. ${CONTEXT_FIX}`,
        };
  }
  const max = modelMaxContext(json.model_info);
  if (max !== undefined && max < MIN_LOCAL_CONTEXT) {
    return {
      status: 'low',
      contextLength: max,
      message: `${profile.model} supports at most ${max.toLocaleString()} context tokens; agents need at least ${n}. Pick a model with a larger context.`,
    };
  }
  return {
    status: 'unknown',
    message: `Ollama did not report a context length for ${profile.model} (no num_ctx in its Modelfile), so the server default applies: 4,096 unless OLLAMA_CONTEXT_LENGTH is set. Agents need at least ${n}. ${CONTEXT_FIX}`,
  };
}
