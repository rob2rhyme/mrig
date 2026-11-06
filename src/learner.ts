/**
 * Learner memory (Track 3, T2): what mrig remembers between sessions about what you've learned.
 * The design and RT's answers are in docs/decisions/2026-11-06-learner-memory.md.
 *
 * One local JSON file: ~/.mrig/learner.json, or <zone>/.mrig/learner/learner.json inside an
 * offline zone. It holds one record per topic (variety, status, counts, a Leitner box and the
 * next review date, an optional note) and nothing else: no answers, questions or transcripts.
 * Writes are atomic. Nothing here touches the network.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mrigHome } from './config.ts';
import { VARIETIES, type Variety } from './lang/tables.ts';

export const LEARNER_VERSION = 1;
/** Days until the next review, by Leitner box (1–5). RT, November 6, 2026. */
export const REVIEW_DAYS = [1, 2, 4, 8, 16] as const;
export const MAX_TOPIC_CHARS = 80;
export const MAX_NOTE_CHARS = 200;
/** The summary for the model: at most this many topic lines (about 400 tokens). */
export const SUMMARY_LINES = 30;

export type LearnerStatus = 'introduced' | 'practising' | 'known';
export type LearnerResult = 'right' | 'missed' | 'introduced';

export interface LearnerTopic {
  topic: string;
  variety?: Variety;
  status: LearnerStatus;
  asked: number;
  right: number;
  /** Leitner box, 1–5. */
  box: number;
  /** Next review, YYYY-MM-DD. */
  due: string;
  /** Last practised, YYYY-MM-DD. */
  lastSeen: string;
  note?: string;
}

export interface LearnerFile {
  version: number;
  topics: LearnerTopic[];
}

const empty = (): LearnerFile => ({ version: LEARNER_VERSION, topics: [] });

/** The file for this place: the zone's own inside an offline zone, else ~/.mrig/learner.json. */
export function learnerPath(zone?: string): string {
  return zone ? join(zone, '.mrig', 'learner', 'learner.json') : join(mrigHome(), 'learner.json');
}

export class LearnerError extends Error {}

export function loadLearner(path: string): LearnerFile {
  if (!existsSync(path)) return empty();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Never overwrite a file we can't read: the user may want to fix it by hand.
    throw new LearnerError(
      `Learner memory at ${path} is not valid JSON (${(err as Error).message}); fix or delete it.`,
    );
  }
  const file = data as Partial<LearnerFile>;
  if (!file || typeof file !== 'object' || !Array.isArray(file.topics)) {
    throw new LearnerError(`Learner memory at ${path} has no "topics" list; fix or delete it.`);
  }
  if (typeof file.version === 'number' && file.version > LEARNER_VERSION) {
    throw new LearnerError(
      `Learner memory at ${path} is version ${file.version}, newer than this mrig understands.`,
    );
  }
  return { version: LEARNER_VERSION, topics: file.topics };
}

/** Write atomically: a temporary file renamed over the old one, so a crash never leaves half a file. */
export function saveLearner(path: string, file: LearnerFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Inside a zone the folder is mrig's own; keep it out of git like the zone's sessions.
  if (path.endsWith(join('.mrig', 'learner', 'learner.json'))) {
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '# mrig learner memory: never commit\n*\n');
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Trimmed, single-spaced, NFC; at most 80 characters. */
export function normalizeTopic(topic: string): string {
  return topic.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, MAX_TOPIC_CHARS);
}

const keyOf = (topic: string, variety?: string) =>
  `${variety ?? ''}\u0000${normalizeTopic(topic).toLowerCase()}`;

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Today as YYYY-MM-DD, in local time. */
export function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface RecordInput {
  topic: string;
  variety?: string;
  result: LearnerResult;
  note?: string;
}

/**
 * Record one result. right moves the topic up a box, missed sends it back to box 1, introduced
 * starts it without a score. Returns the updated topic; the file is changed in place.
 */
export function recordResult(file: LearnerFile, input: RecordInput, date: string): LearnerTopic {
  const topic = normalizeTopic(input.topic);
  if (!topic) throw new LearnerError('Empty topic.');
  if (input.variety !== undefined && !(input.variety in VARIETIES)) {
    throw new LearnerError(
      `Unknown variety "${input.variety}". Use one of ${Object.keys(VARIETIES).join(', ')}.`,
    );
  }
  const variety = input.variety as Variety | undefined;
  const key = keyOf(topic, variety);
  let t = file.topics.find((x) => keyOf(x.topic, x.variety) === key);
  if (!t) {
    t = {
      topic,
      ...(variety ? { variety } : {}),
      status: 'introduced',
      asked: 0,
      right: 0,
      box: 1,
      due: date,
      lastSeen: date,
    };
    file.topics.push(t);
  }
  if (input.result === 'right') {
    t.asked++;
    t.right++;
    t.box = Math.min(REVIEW_DAYS.length, t.box + 1);
  } else if (input.result === 'missed') {
    t.asked++;
    t.box = 1;
  }
  t.status = t.asked === 0 ? 'introduced' : t.box >= 4 ? 'known' : 'practising';
  t.due = addDays(date, REVIEW_DAYS[t.box - 1] ?? 1);
  t.lastSeen = date;
  if (input.note !== undefined) {
    const note = input.note.normalize('NFC').trim();
    if (note)
      t.note = note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS - 1)}…` : note;
    else delete t.note;
  }
  return t;
}

export type ForgetTarget =
  | { topic: string; variety?: string }
  | { variety: string }
  | { all: true };

/** Remove topics. Returns how many went. */
export function forget(file: LearnerFile, target: ForgetTarget): number {
  const before = file.topics.length;
  if ('all' in target) file.topics = [];
  else if ('topic' in target) {
    const wanted = normalizeTopic(target.topic).toLowerCase();
    file.topics = file.topics.filter(
      (t) =>
        !(
          t.topic.toLowerCase() === wanted &&
          (target.variety === undefined || t.variety === target.variety)
        ),
    );
  } else file.topics = file.topics.filter((t) => t.variety !== target.variety);
  return before - file.topics.length;
}

const label = (variety?: Variety) => (variety ? `${VARIETIES[variety]} (${variety})` : 'general');
const score = (t: LearnerTopic) =>
  t.asked === 0 ? 'not yet asked' : `${t.right}/${t.asked} right`;
const line = (t: LearnerTopic) =>
  `- ${t.topic}: ${t.status}, ${score(t)}, due ${t.due}${t.note ? ` (${t.note})` : ''}`;

/** Topics grouped by variety, in a stable order: general first, then the variety order. */
function grouped(topics: LearnerTopic[]): Array<[string, LearnerTopic[]]> {
  const order = ['', ...Object.keys(VARIETIES)];
  const groups = new Map<string, LearnerTopic[]>();
  for (const t of topics) {
    const k = t.variety ?? '';
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([k, ts]) => [label(k ? (k as Variety) : undefined), ts]);
}

/**
 * The block for the system prompt in learn and teach mode: due topics first, then the weakest,
 * at most 30 lines, grouped by variety so varieties are never pooled. '' when there is nothing.
 */
export function learnerSummary(file: LearnerFile, date: string, variety?: Variety): string {
  // The tutor (T8) sees only its own variety's topics.
  const topics = variety ? file.topics.filter((t) => t.variety === variety) : file.topics;
  const due = topics.filter((t) => t.due <= date).sort((a, b) => a.due.localeCompare(b.due));
  const rate = (t: LearnerTopic) => (t.asked === 0 ? 1 : t.right / t.asked);
  const weak = topics
    .filter((t) => t.due > date && t.status !== 'known')
    .sort((a, b) => rate(a) - rate(b) || a.due.localeCompare(b.due));
  const picked = [...due, ...weak].slice(0, SUMMARY_LINES);
  if (picked.length === 0) return '';
  const parts = [
    `## Learner memory (what the user has practised before; today is ${date}. Start with due topics. Record each result with the learned tool.)`,
  ];
  for (const [name, ts] of grouped(picked)) parts.push(`### ${name}\n${ts.map(line).join('\n')}`);
  const left = topics.length - picked.length;
  if (left > 0)
    parts.push(`(${left} more topic${left === 1 ? '' : 's'} not listed; /learned shows all)`);
  return parts.join('\n');
}

/** Lines for /learned: everything, what's due, or topics matching words. */
export function learnerReport(file: LearnerFile, date: string, filter?: 'due' | string): string[] {
  let topics = file.topics;
  if (filter === 'due') topics = topics.filter((t) => t.due <= date);
  else if (filter) {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    topics = topics.filter((t) =>
      words.every((w) => `${t.topic} ${t.note ?? ''}`.toLowerCase().includes(w)),
    );
  }
  if (file.topics.length === 0) {
    return ['No learner memory yet. Practise in /mode learn, and results are recorded as you go.'];
  }
  if (topics.length === 0)
    return [filter === 'due' ? 'Nothing is due today.' : `No topics match "${filter}".`];
  const lines: string[] = [];
  for (const [name, ts] of grouped(topics)) {
    lines.push(`${name}:`);
    for (const t of [...ts].sort((a, b) => a.due.localeCompare(b.due)))
      lines.push(`  ${line(t).slice(2)}`);
  }
  return lines;
}

/** Delete the file itself (`/forget all`). */
export function deleteLearnerFile(path: string): void {
  rmSync(path, { force: true });
}
