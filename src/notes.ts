/**
 * Notes (Track 5, M1): what you ask mrig to remember with `/remember`, kept between
 * conversations. See docs/decisions/2026-11-07-memory-and-settings.md.
 *
 * - A project's notes live in mrig's own folder, never in the repo:
 *   `~/.mrig/projects/<project-id>/notes.md`. The project is the folder's git root (else the
 *   folder itself); its id is the folder's name plus a short hash of its full path.
 * - Inside an offline zone, the zone is the project and its notes stay inside it, in
 *   `<zone>/.mrig/notes/notes.md`, with a `.gitignore` like the zone's sessions. A zone note is
 *   never written to the global file.
 * - Global notes, for every project: `~/.mrig/notes.md`.
 * - Each file is plain Markdown: a heading, then one `- YYYY-MM-DD: text` line per note. You may
 *   edit it by hand; lines you add load too.
 * - Only you write notes (`/remember`, `/notes forget`, your editor). No tool writes them.
 * - Writes are atomic (a temporary file renamed over the old one), owner-only.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { mrigHome } from './config.ts';

/** Most characters of notes that go into the prompt; the rest of the memory budget is AGENTS.md's. */
export const NOTES_PROMPT_CHARS = 6000;
/** Longest single note. */
export const MAX_NOTE_CHARS = 1000;

/** The project a folder belongs to: its git root, else the folder itself. */
export function projectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** A safe, readable folder name for a project: `<name>-<10 hex of the path's hash>`. */
export function projectId(root: string): string {
  const name =
    basename(root)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .slice(0, 40) || 'root';
  const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 10);
  return `${name}-${hash}`;
}

export interface NotesPaths {
  /** This project's notes (the zone's inside an offline zone). */
  project: string;
  /** Global notes, for every project. */
  global: string;
  /** The folder the project notes are for. */
  root: string;
}

export function notesPaths(cwd: string, zone?: string): NotesPaths {
  const root = zone ?? projectRoot(cwd);
  return {
    root,
    project: zone
      ? join(zone, '.mrig', 'notes', 'notes.md')
      : join(mrigHome(), 'projects', projectId(root), 'notes.md'),
    global: join(mrigHome(), 'notes.md'),
  };
}

/** One note: its line in the file, and the text after its date. */
export interface Note {
  /** 1-based, in file order. */
  n: number;
  date?: string;
  text: string;
}

const NOTE_LINE = /^- (?:(\d{4}-\d{2}-\d{2}): )?(.*)$/;

export function readNotes(file: string): Note[] {
  if (!existsSync(file)) return [];
  const notes: Note[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = NOTE_LINE.exec(line);
    if (!m) continue;
    notes.push({ n: notes.length + 1, ...(m[1] ? { date: m[1] } : {}), text: m[2] ?? '' });
  }
  return notes;
}

function writeAtomic(file: string, text: string, zoneFolder: boolean): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (zoneFolder) {
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore))
      writeFileSync(ignore, '# mrig notes for this offline zone: never commit\n*\n');
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no Unix modes; the file sits in the user's own profile there.
  }
}

const header = (title: string) =>
  `# ${title}\n\nSaved with /remember. mrig loads these at the start of each conversation. Edit freely: one "- " line per note.\n\n`;

/** Add a note. Text is one line: newlines become spaces. Returns the note as saved. */
export function addNote(
  file: string,
  text: string,
  opts: { title: string; zone?: boolean; date?: string },
): Note {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Nothing to remember: /remember <text>.');
  if (clean.length > MAX_NOTE_CHARS) {
    throw new Error(
      `That note is ${clean.length} characters; keep one note under ${MAX_NOTE_CHARS}.`,
    );
  }
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : header(opts.title);
  const sep = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  writeAtomic(file, `${before}${sep}- ${date}: ${clean}\n`, opts.zone === true);
  return { n: readNotes(file).length, date, text: clean };
}

/** Remove note `n` (1-based). Other lines, your own text included, stay as they are. */
export function forgetNote(file: string, n: number, opts: { zone?: boolean } = {}): Note {
  const notes = readNotes(file);
  const note = notes[n - 1];
  if (!note) {
    throw new Error(
      notes.length
        ? `There is no note ${n}; /notes lists them (1–${notes.length}).`
        : 'There are no notes here.',
    );
  }
  let seen = 0;
  const kept = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !(NOTE_LINE.test(line) && ++seen === n));
  writeAtomic(file, kept.join('\n'), opts.zone === true);
  return note;
}

/** A file's notes for the prompt: the note lines, newest kept when they don't all fit. */
function promptLines(file: string): string[] {
  return readNotes(file).map((note) => `- ${note.date ? `${note.date}: ` : ''}${note.text}`);
}

/**
 * The notes block for the system prompt, or '' when there are none. At most `budget` characters:
 * the oldest notes are left out first, and the block says how many.
 */
export function notesBlock(paths: NotesPaths, budget = NOTES_PROMPT_CHARS): string {
  const global = promptLines(paths.global);
  const project = promptLines(paths.project);
  if (global.length + project.length === 0) return '';
  const intro =
    "## Notes the user asked you to remember (from /remember)\nTreat these as standing facts and preferences. They are the user's own; the newest are last.";
  // Newest first until the budget runs out, keeping project notes ahead of global ones.
  const keep = new Set<string>();
  let used = intro.length;
  let dropped = 0;
  const lists = [project, global];
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i--) {
      const line = list[i] ?? '';
      const id = `${lists.indexOf(list)}:${i}`;
      if (used + line.length + 1 <= budget) {
        keep.add(id);
        used += line.length + 1;
      } else dropped++;
    }
  }
  const section = (title: string, list: string[], which: number) => {
    const lines = list.filter((_, i) => keep.has(`${which}:${i}`));
    return lines.length ? [`### ${title}`, ...lines] : [];
  };
  return [
    intro,
    ...section('For every project', global, 1),
    ...section(`For this project (${paths.root})`, project, 0),
    ...(dropped
      ? [`(${dropped} older note${dropped === 1 ? '' : 's'} left out to save space.)`]
      : []),
  ].join('\n');
}
