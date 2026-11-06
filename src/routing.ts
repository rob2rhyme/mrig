/**
 * Model routing (Track 3, T7): each message goes to an `easy` or a `hard` profile, by rules
 * alone. No model call decides the route, so every decision is predictable and explainable.
 *
 * Rules, first match wins:
 *   1. a `!easy` / `!hard` prefix (stripped from the message)
 *   2. an image in the prompt goes to whichever tier has vision (when only one has it)
 *   3. the user's own `rules`: a regex, or a list of words, mapped to a tier
 *   4. a long message (over `longChars`) is hard
 *   5. a "hard" word (plan, design, refactor, debug, why, review, …) is hard
 *   6. otherwise `default` (easy)
 */

export type Tier = 'easy' | 'hard';

export interface RoutingRule {
  /** A regular expression (as a string, matched case-insensitively) or a list of words. */
  match: string | string[];
  use: Tier;
}

export interface RoutingConfig {
  /** Profile names. */
  easy: string;
  hard: string;
  default: Tier;
  /** Messages longer than this many characters are hard. */
  longChars: number;
  rules: RoutingRule[];
}

/** Words that usually mean the work needs the stronger model. */
export const HARD_WORDS = [
  'plan',
  'design',
  'architecture',
  'architect',
  'refactor',
  'debug',
  'why',
  'review',
  'security',
  'migrate',
  'optimize',
  'optimise',
  'prove',
  'investigate',
] as const;

export interface RouteDecision {
  tier: Tier;
  /** Why, in a few words: `"refactor"`, `long (2,140 characters)`, `you asked`. */
  reason: string;
  /** The message to send: the `!easy` / `!hard` prefix removed. */
  text: string;
}

export interface RouteContext {
  hasImages: boolean;
  vision: Record<Tier, boolean>;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first whole word of `words` found in `text`, case-insensitive. */
function findWord(text: string, words: readonly string[]): string | undefined {
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(w)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(text)) return w;
  }
  return undefined;
}

export function classify(input: string, config: RoutingConfig, ctx: RouteContext): RouteDecision {
  const prefix = /^\s*!(easy|hard)\b\s*/i.exec(input);
  if (prefix) {
    return {
      tier: (prefix[1] ?? 'easy').toLowerCase() as Tier,
      reason: 'you asked',
      text: input.slice(prefix[0].length),
    };
  }
  const text = input;
  if (ctx.hasImages && ctx.vision.easy !== ctx.vision.hard) {
    return { tier: ctx.vision.easy ? 'easy' : 'hard', reason: 'an image needs vision', text };
  }
  for (const rule of config.rules) {
    if (Array.isArray(rule.match)) {
      const word = findWord(text, rule.match);
      if (word) return { tier: rule.use, reason: `your rule: "${word}"`, text };
    } else if (new RegExp(rule.match, 'iu').test(text)) {
      return { tier: rule.use, reason: `your rule: /${rule.match}/`, text };
    }
  }
  if (text.length > config.longChars) {
    return {
      tier: 'hard',
      reason: `long (${text.length.toLocaleString('en-US')} characters)`,
      text,
    };
  }
  const word = findWord(text, HARD_WORDS);
  if (word) return { tier: 'hard', reason: `"${word}"`, text };
  return { tier: config.default, reason: 'default', text };
}

/** Validate a `routing` block from the config. Profile names are checked by the runtime. */
export function parseRouting(value: unknown): RoutingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"routing" must be an object, e.g. { "easy": "ollama", "hard": "claude" }.');
  }
  const v = value as Record<string, unknown>;
  for (const k of ['easy', 'hard'] as const) {
    if (typeof v[k] !== 'string' || !(v[k] as string).trim())
      throw new Error(`"routing.${k}" must be a profile name.`);
  }
  const tier = (x: unknown, key: string): Tier => {
    if (x === 'easy' || x === 'hard') return x;
    throw new Error(`"${key}" must be "easy" or "hard".`);
  };
  const longChars = v.longChars ?? 1500;
  if (typeof longChars !== 'number' || !(longChars > 0))
    throw new Error('"routing.longChars" must be a positive number.');
  const rules = v.rules ?? [];
  if (!Array.isArray(rules)) throw new Error('"routing.rules" must be a list.');
  const parsed = rules.map((r, i): RoutingRule => {
    const rule = r as { match?: unknown; use?: unknown };
    const where = `routing.rules[${i}]`;
    const use = tier(rule?.use, `${where}.use`);
    if (
      Array.isArray(rule.match) &&
      rule.match.length > 0 &&
      rule.match.every((w) => typeof w === 'string' && w.trim())
    ) {
      return { match: rule.match as string[], use };
    }
    if (typeof rule.match === 'string' && rule.match) {
      try {
        new RegExp(rule.match, 'iu');
      } catch (err) {
        throw new Error(
          `"${where}.match" is not a valid regular expression: ${(err as Error).message}`,
        );
      }
      return { match: rule.match, use };
    }
    throw new Error(`"${where}.match" must be a regular expression or a list of words.`);
  });
  return {
    easy: v.easy as string,
    hard: v.hard as string,
    default: v.default === undefined ? 'easy' : tier(v.default, 'routing.default'),
    longChars,
    rules: parsed,
  };
}
