/**
 * Modes (Track 3, T1): named presets of system-prompt text and permission defaults, defined in
 * code. `/mode <name>` switches; `--mode <name>` starts in one; the session remembers it.
 *
 * - default: today's behaviour.
 * - teach: explains before acting, works in small steps, and asks the user to try each next step
 *   first. Every change asks, even with yolo or a matching allow rule.
 * - learn: quizzes the user and keeps a running list of what was covered; results go into
 *   learner memory (T2) through the `learned` tool, as does what teach mode introduces.
 *   Only read-only tools are offered.
 * - tutor: the Akkha language tutor (T8), a learn-style mode for one variety. Every word comes
 *   from the corpus (A4) or language memory (A3); the variety is enforced by the tools.
 */
import { VARIETIES, type Variety } from './lang/tables.ts';

/** How a mode changes the permission gate. */
export type PermissionPolicy =
  /** Today's gate: read-only tools run, then yolo, allow rules, else ask. */
  | 'normal'
  /** Every non-read-only call asks: yolo and allow rules are set aside, "always" means once. */
  | 'ask-every-time'
  /** Only read-only tools: the rest are not offered, and refused if called anyway. */
  | 'read-only';

export interface Mode {
  name: ModeName;
  /** One line for /mode and the banner. */
  summary: string;
  /** Text added to the system prompt; empty for default. `{variety}` is filled in. */
  prompt: string[];
  permissions: PermissionPolicy;
  /** The mode works on one language variety, which must be chosen (tutor). */
  needsVariety?: boolean;
}

export type ModeName = 'default' | 'teach' | 'learn' | 'tutor';

export const MODES: Readonly<Record<ModeName, Mode>> = {
  default: {
    name: 'default',
    summary: 'does the work, asking before changes as usual',
    prompt: [],
    permissions: 'normal',
  },
  teach: {
    name: 'teach',
    summary: 'explains before acting, one small step at a time; you try each next step first',
    prompt: [
      '## Mode: teach',
      'The user wants to learn how to do this, not only to have it done.',
      '- Before acting, explain what you will do and why, in plain words.',
      '- Work in small steps: one change or command at a time, then check that it made sense.',
      '- Before each next step, ask the user to try it first and say what to try. Review their attempt, say what worked, and correct the rest kindly.',
      '- Every change asks for permission in this mode. Prefer short, explained snippets over long code.',
      '- After teaching a new topic, record it with the learned tool as introduced (with the variety for a language topic).',
    ],
    permissions: 'ask-every-time',
  },
  learn: {
    name: 'learn',
    summary: 'quizzes you and tracks what you have covered; read-only tools only',
    prompt: [
      '## Mode: learn',
      'Quiz the user to check and build what they know.',
      '- Ask one question at a time and wait for the answer. Then say whether it is right, and explain briefly.',
      '- Make the next question harder after a right answer and easier after a wrong one.',
      '- Record each answer with the learned tool: right or missed, with the variety for a language topic. Start with topics the learner memory lists as due.',
      '- Keep a short running list of what was covered (topic: right or missed). Show it every five questions, and when asked.',
      "- Don't give an answer before the user tries, unless they ask for it.",
      '- You may read and search files to make questions. Only read-only tools are available, so do not offer to change files or run commands.',
    ],
    permissions: 'read-only',
  },
  tutor: {
    name: 'tutor',
    summary: 'the Akkha language tutor for one variety: /mode tutor <variety>',
    prompt: [
      '## Mode: tutor ({variety})',
      'You are a patient language tutor for {variety}, written in Akkha. Teach and quiz this variety only.',
      '- Take every word, gloss and example from the corpus tool or the language memory above. Never invent a word or a form; if they have nothing on a topic, say so and pick another.',
      '- Devanagari is the canonical spelling. Get the Akkha form and the romanization from the translit tool, never by hand, and show all three: Akkha, Devanagari, romanization.',
      '- Quiz one item at a time: meaning from the word, the word from the meaning, or reading an Akkha form aloud in romanization. Start with topics the learner memory lists as due.',
      '- After each answer, say whether it is right, give the correct form with its source (file:line), and record it with the learned tool.',
      '- Only read-only tools are available; do not offer to change files or run commands.',
    ],
    permissions: 'read-only',
    needsVariety: true,
  },
};

/** The mode's prompt lines, with the variety filled in. */
export function modePrompt(name: ModeName, variety?: Variety): string[] {
  const label = variety ? `${VARIETIES[variety]}, ${variety}` : 'the chosen variety';
  return MODES[name].prompt.map((line) => line.replaceAll('{variety}', label));
}

export function isVariety(tag: string): tag is Variety {
  return tag in VARIETIES;
}

/** Refuse a mode that needs a variety when none (or an unknown one) is given. */
export function assertModeVariety(
  name: ModeName,
  variety: string | undefined,
): Variety | undefined {
  if (!MODES[name].needsVariety) return undefined;
  const tags = Object.keys(VARIETIES).join(', ');
  if (!variety) {
    throw new Error(
      `The ${name} mode works on one variety, so varieties are never pooled. Choose one: ${tags} (for example /mode ${name} mgp).`,
    );
  }
  if (!isVariety(variety)) throw new Error(`Unknown variety "${variety}". Use one of ${tags}.`);
  return variety;
}

export const MODE_NAMES = Object.keys(MODES) as ModeName[];

export function isModeName(name: string): name is ModeName {
  return (MODE_NAMES as string[]).includes(name);
}

export function parseMode(name: string): ModeName {
  if (isModeName(name)) return name;
  throw new Error(`Unknown mode "${name}". Modes: ${MODE_NAMES.join(', ')}.`);
}
