/**
 * `mrig doctor`: ask each provider which models it serves and flag profiles whose model id is
 * not listed. Pure logic with an injectable fetch, so tests never touch the network. The REPL
 * runs the same check for the active profile at startup and prints a one-line warning.
 */
import { type MrigConfig, type ProviderProfile, resolveApiKey } from './config.ts';

export type CheckStatus =
  | 'ok'
  | 'unknown-model'
  | 'no-key'
  | 'auth'
  | 'unreachable'
  /** The server answered but gave no usable model list; the id was not checked. */
  | 'no-list';

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
