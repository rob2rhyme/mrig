/**
 * One provider layer for every backend. Swap models by editing config, not code.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  ImageModel,
  LanguageModel,
  LanguageModelUsage,
  SpeechModel,
  TranscriptionModel,
} from 'ai';
import { type CacheTtl, type Pricing, type ProviderProfile, resolveApiKey } from './config.ts';

/** USD per million tokens for known hosted models. Local/openai-compatible default to free. */
export const KNOWN_PRICING: Array<{ match: RegExp; pricing: Pricing }> = [
  { match: /claude-fable-5-1/, pricing: { input: 10, output: 50, cacheRead: 0.25 } },
  { match: /claude-opus-5/, pricing: { input: 5, output: 25 } },
  { match: /claude-sonnet-5/, pricing: { input: 2, output: 10 } },
  { match: /claude-haiku-4-5/, pricing: { input: 1, output: 5 } },
];

/** Cache writes are billed above the input price: 1.25× for the 5-minute TTL, 2× for 1 hour. */
export const CACHE_WRITE_MULTIPLIER: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 };

/**
 * Minimum cacheable prefix per Claude model, in tokens. Shorter prompts are silently not
 * cached (no error; cache_creation_input_tokens stays 0). Order matters: a model id must hit
 * its own row before a looser pattern (sonnet-5-5 → 512 before sonnet-5 → 1024).
 */
export const CACHE_MIN_PREFIX: Array<{ match: RegExp; tokens: number }> = [
  { match: /claude-(opus-5|fable-5|sonnet-5-5|haiku-5-5)/, tokens: 512 },
  {
    match:
      /claude-(opus-4-8|opus-4-1|opus-4-0|opus-4-2|sonnet-5|sonnet-4-6|sonnet-4-5|sonnet-4-0|sonnet-4-2)/,
    tokens: 1024,
  },
  { match: /claude-(opus-4-7|haiku-3-5|3-5-haiku)/, tokens: 2048 },
  { match: /claude-(opus-4-6|opus-4-5|haiku-4-5)/, tokens: 4096 },
];

/** Minimum cacheable prompt length for a model, or undefined when unknown. */
export function cacheMinPrefix(model: string): number | undefined {
  return CACHE_MIN_PREFIX.find((p) => p.match.test(model))?.tokens;
}

export type CacheProviderOptions = {
  anthropic: { cacheControl: { type: 'ephemeral'; ttl: CacheTtl } };
};

/**
 * Provider options that turn on prompt caching. Anthropic only: passed at request level it
 * enables automatic caching; on a system block or tool it marks an explicit breakpoint.
 * Undefined for OpenAI and local servers, which have no cache to pay for.
 */
export function cacheProviderOptions(
  profile: ProviderProfile,
  cacheTtl: CacheTtl,
): CacheProviderOptions | undefined {
  if (profile.kind !== 'anthropic') return undefined;
  return { anthropic: { cacheControl: { type: 'ephemeral', ttl: cacheTtl } } };
}

/** One line for `/cost` on why the cache did nothing, or undefined when there's nothing to say. */
export function explainCacheMiss(usage: UsageTotals, profile: ProviderProfile): string | undefined {
  if (profile.kind !== 'anthropic' || usage.requests === 0) return undefined;
  if (usage.cacheWriteTokens === 0 && usage.cacheReadTokens === 0) {
    const min = cacheMinPrefix(profile.model);
    const floor = min ? `${min.toLocaleString()} tokens` : 'a model-specific minimum';
    return `No prompt-cache activity: ${profile.model} only caches prefixes of at least ${floor}. More context (memory files, tool results) crosses it.`;
  }
  if (usage.requests >= 2 && usage.cacheReadTokens === 0) {
    return 'Cache written but never read: the prompt prefix changed between requests (system prompt, tool list, or edited history).';
  }
  return undefined;
}

export function pricingFor(profile: ProviderProfile): Pricing | undefined {
  if (profile.pricing) return profile.pricing;
  if (profile.kind === 'openai-compatible') return { input: 0, output: 0 };
  return KNOWN_PRICING.find((p) => p.match.test(profile.model))?.pricing;
}

/**
 * Estimated cost in USD for a usage record. Returns undefined when pricing is unknown.
 * `inputTokens` is the provider total (uncached + cache reads + cache writes); cache writes
 * carry the TTL premium unless the pricing sets `cacheWrite` explicitly.
 */
export function estimateCost(
  usage: UsageTotals,
  pricing: Pricing | undefined,
  cacheTtl: CacheTtl = '5m',
): number | undefined {
  if (!pricing) return undefined;
  const cacheRead = pricing.cacheRead ?? pricing.input * 0.1;
  const cacheWrite = pricing.cacheWrite ?? pricing.input * CACHE_WRITE_MULTIPLIER[cacheTtl];
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  return (
    (uncached * pricing.input +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite +
      usage.outputTokens * pricing.output) /
    1_000_000
  );
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
}

export function addUsage(totals: UsageTotals, usage: LanguageModelUsage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.inputTokenDetails?.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.inputTokenDetails?.cacheWriteTokens ?? 0),
    requests: totals.requests + 1,
  };
}

export class ProviderError extends Error {}

/** Turn SDK/network errors into one actionable line for the terminal. */
export function formatModelError(err: unknown, profile: ProviderProfile): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes('unable to connect') ||
    lower.includes('econnrefused') ||
    lower.includes('cannot connect')
  ) {
    const where = profile.baseURL ?? 'the API';
    const hint =
      profile.kind === 'openai-compatible'
        ? ` Is the local server running? (Ollama: \`ollama serve\`; LM Studio: start the server tab; llama.cpp: \`llama-server\`)`
        : ' Check your network connection.';
    return `Cannot connect to ${where}.${hint}`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return `Authentication failed for ${profile.kind} (${profile.model}). Check ${profile.apiKeyEnv ?? 'the API key'}.`;
  }
  if (lower.includes('404') && profile.kind === 'openai-compatible') {
    return `Model "${profile.model}" not found at ${profile.baseURL}. Pull or load it first (Ollama: \`ollama pull ${profile.model}\`).`;
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return `Rate limited by ${profile.kind}. Wait a moment and retry, or switch models with /model.`;
  }
  return message.replace(/^Failed after \d+ attempts\. Last error: /, '');
}

/** Build a LanguageModel from a profile. Throws a readable error when a key is missing. */
export function createModel(
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  const apiKey = resolveApiKey(profile, env);
  switch (profile.kind) {
    case 'anthropic': {
      if (!apiKey) {
        throw new ProviderError(
          `No API key for Anthropic. Set ${profile.apiKeyEnv ?? 'ANTHROPIC_API_KEY'} or add "apiKey" to the profile.`,
        );
      }
      const anthropic = createAnthropic({
        apiKey,
        ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
      });
      return anthropic(profile.model);
    }
    case 'openai': {
      if (!apiKey) {
        throw new ProviderError(
          `No API key for OpenAI. Set ${profile.apiKeyEnv ?? 'OPENAI_API_KEY'} or add "apiKey" to the profile.`,
        );
      }
      const openai = createOpenAI({
        apiKey,
        ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
      });
      return openai(profile.model);
    }
    case 'openai-compatible': {
      if (!profile.baseURL) throw new ProviderError('openai-compatible profiles need a "baseURL".');
      const provider = createOpenAICompatible({
        name: profile.name ?? 'openai-compatible',
        baseURL: profile.baseURL,
        apiKey: apiKey ?? 'none',
        includeUsage: true,
      });
      return provider(profile.model);
    }
    default: {
      const kind: never = profile.kind;
      throw new ProviderError(`Unsupported provider kind: ${String(kind)}`);
    }
  }
}

/**
 * An image model (T4) from a profile: OpenAI's image API, or any OpenAI-compatible server that
 * serves /images/generations (a local one works offline). Anthropic models don't make images.
 */
export function createImageModel(
  profile: ProviderProfile,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): ImageModel {
  const apiKey = resolveApiKey(profile, env);
  switch (profile.kind) {
    case 'openai': {
      if (!apiKey) {
        throw new ProviderError(
          `No API key for OpenAI images. Set ${profile.apiKeyEnv ?? 'OPENAI_API_KEY'} or add "apiKey" to the profile.`,
        );
      }
      return createOpenAI({
        apiKey,
        ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
      }).image(modelId);
    }
    case 'openai-compatible': {
      if (!profile.baseURL) throw new ProviderError('openai-compatible profiles need a "baseURL".');
      return createOpenAICompatible({
        name: profile.name ?? 'openai-compatible',
        baseURL: profile.baseURL,
        apiKey: apiKey ?? 'none',
      }).imageModel(modelId);
    }
    case 'anthropic':
      throw new ProviderError(
        'Anthropic models do not generate images. Point "image.profile" at an openai or openai-compatible profile.',
      );
    default: {
      const kind: never = profile.kind;
      throw new ProviderError(`Unsupported provider kind: ${String(kind)}`);
    }
  }
}

/**
 * The OpenAI client for audio (T5). OpenAI's speech and transcription APIs are also served by
 * local OpenAI-compatible audio servers, so an `openai-compatible` profile points the same
 * client at its own base URL; that is the local, offline option. Anthropic has no audio models.
 */
function audioClient(profile: ProviderProfile, what: string, env: NodeJS.ProcessEnv) {
  const apiKey = resolveApiKey(profile, env);
  if (profile.kind === 'anthropic') {
    throw new ProviderError(
      `Anthropic has no ${what} models. Point the ${what} profile at an openai or openai-compatible profile.`,
    );
  }
  if (profile.kind === 'openai-compatible') {
    if (!profile.baseURL) throw new ProviderError('openai-compatible profiles need a "baseURL".');
    return createOpenAI({ apiKey: apiKey ?? 'none', baseURL: profile.baseURL });
  }
  if (!apiKey) {
    throw new ProviderError(
      `No API key for OpenAI ${what}. Set ${profile.apiKeyEnv ?? 'OPENAI_API_KEY'} or add "apiKey" to the profile.`,
    );
  }
  return createOpenAI({ apiKey, ...(profile.baseURL ? { baseURL: profile.baseURL } : {}) });
}

export function createSpeechModel(
  profile: ProviderProfile,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): SpeechModel {
  return audioClient(profile, 'speech', env).speech(modelId);
}

export function createTranscriptionModel(
  profile: ProviderProfile,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionModel {
  return audioClient(profile, 'transcription', env).transcription(modelId);
}
