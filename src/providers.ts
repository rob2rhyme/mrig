/**
 * One provider layer for every backend. Swap models by editing config, not code.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import { type Pricing, type ProviderProfile, resolveApiKey } from './config.ts';

/** USD per million tokens for known hosted models. Local/openai-compatible default to free. */
export const KNOWN_PRICING: Array<{ match: RegExp; pricing: Pricing }> = [
  { match: /claude-fable-5-1/, pricing: { input: 10, output: 50 } },
  { match: /claude-opus-5/, pricing: { input: 5, output: 25 } },
  { match: /claude-sonnet-5/, pricing: { input: 2, output: 10 } },
  { match: /claude-haiku-4-5/, pricing: { input: 1, output: 5 } },
];

export function pricingFor(profile: ProviderProfile): Pricing | undefined {
  if (profile.pricing) return profile.pricing;
  if (profile.kind === 'openai-compatible') return { input: 0, output: 0 };
  return KNOWN_PRICING.find((p) => p.match.test(profile.model))?.pricing;
}

/** Estimated cost in USD for a usage record. Returns undefined when pricing is unknown. */
export function estimateCost(usage: UsageTotals, pricing: Pricing | undefined): number | undefined {
  if (!pricing) return undefined;
  const cacheRead = pricing.cacheRead ?? pricing.input * 0.1;
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  return (
    (uncached * pricing.input +
      usage.cacheReadTokens * cacheRead +
      usage.outputTokens * pricing.output) /
    1_000_000
  );
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requests: number;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 };
}

export function addUsage(totals: UsageTotals, usage: LanguageModelUsage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.inputTokenDetails?.cacheReadTokens ?? 0),
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
