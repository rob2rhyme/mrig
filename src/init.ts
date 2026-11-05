/**
 * `mrig init` (L7): write a starter ~/.mrig/config.json. It never overwrites an existing file
 * and never writes a key: profiles read keys from environment variables.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, ensureMrigHome, type MrigConfig, mrigHome } from './config.ts';

/** The default profile for a new config: Claude with an Anthropic key, else OpenAI, else Ollama. */
export function pickDefaultProvider(env: NodeJS.ProcessEnv): string {
  if (env.ANTHROPIC_API_KEY) return 'claude';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'ollama';
}

/**
 * The starter config. It repeats the defaults that people most often change, so the file shows
 * where each setting goes. Every value is valid as written, and it adds no profile of its own.
 */
export function starterConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    defaultProvider: pickDefaultProvider(env),
    // Built-in profiles need no entry. Add your own servers here (see README).
    providers: {},
    permissions: {
      yolo: false,
      allow: ['bash:git status', 'bash:git diff', 'bash:git log'],
    },
    maxSteps: DEFAULT_CONFIG.maxSteps,
    cacheTtl: DEFAULT_CONFIG.cacheTtl,
    compaction: {
      threshold: DEFAULT_CONFIG.compaction.threshold,
      keep: DEFAULT_CONFIG.compaction.keep,
    },
    mcpServers: {},
    trustedProjects: [],
  } satisfies Partial<Record<keyof MrigConfig, unknown>>;
}

export interface InitResult {
  path: string;
  /** False when a config already existed; it is left as it was. */
  created: boolean;
  defaultProvider?: string;
}

export function initConfig(env: NodeJS.ProcessEnv = process.env): InitResult {
  const path = join(mrigHome(), 'config.json');
  if (existsSync(path)) return { path, created: false };
  ensureMrigHome();
  const config = starterConfig(env);
  // `wx` fails rather than overwrite a file that appeared in the meantime.
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { path, created: true, defaultProvider: String(config.defaultProvider) };
}

/** The lines `mrig init` prints. */
export function initReport(r: InitResult): string[] {
  if (!r.created) {
    return [`${r.path} already exists; it was not changed.`];
  }
  const lines = [`Wrote ${r.path} (default profile: ${r.defaultProvider}).`];
  if (r.defaultProvider === 'ollama') {
    lines.push(
      'No ANTHROPIC_API_KEY or OPENAI_API_KEY is set, so it uses Ollama: `ollama pull qwen3-coder` first.',
    );
  }
  lines.push(
    'Edit it to add profiles, allow rules, MCP servers and trusted projects (see README).',
    'Check the model ids with: mrig doctor',
  );
  return lines;
}
