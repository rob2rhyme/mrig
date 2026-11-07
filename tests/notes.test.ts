/**
 * Track 5, M1: notes saved with `/remember`. Where they live (mrig's own folder, the zone's
 * inside an offline zone), adding and forgetting, the prompt budget, a stable prompt across
 * turns, and `/notes` (list, forget, edit, reload) through the runtime.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addNote,
  forgetNote,
  MAX_NOTE_CHARS,
  NOTES_PROMPT_CHARS,
  notesBlock,
  notesPaths,
  projectId,
  projectRoot,
  readNotes,
} from '../src/notes.ts';
import { buildSystemPrompt, MAX_MEMORY_CHARS } from '../src/prompt.ts';
import { Runtime } from '../src/runtime.ts';
import { runCommand } from '../src/ui/commands.ts';
import { editorCommand } from '../src/util/editor.ts';
import { ZONE_MARKER } from '../src/zone.ts';
import { mockModel, tempDir, textTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

let home: ReturnType<typeof tempDir>;
let project: ReturnType<typeof tempDir>;
const prevHome = process.env.MRIG_HOME;
beforeEach(() => {
  home = tempDir('mrig-notes-home-');
  project = tempDir('mrig-notes-proj-');
  mkdirSync(join(project.dir, '.git'));
  process.env.MRIG_HOME = home.dir;
  writeFileSync(
    join(home.dir, 'config.json'),
    JSON.stringify({
      providers: {
        local: {
          kind: 'openai-compatible',
          baseURL: 'http://localhost:8000/v1',
          model: 'm',
          pricing: { input: 0, output: 0 },
        },
      },
    }),
  );
});
afterEach(() => {
  home.cleanup();
  project.cleanup();
  if (prevHome === undefined) delete process.env.MRIG_HOME;
  else process.env.MRIG_HOME = prevHome;
});

describe('where notes live (M1)', () => {
  test('a project is its git root; its notes are in mrig’s own folder, never the repo', () => {
    mkdirSync(join(project.dir, 'src', 'deep'), { recursive: true });
    expect(projectRoot(join(project.dir, 'src', 'deep'))).toBe(project.dir);
    const paths = notesPaths(join(project.dir, 'src', 'deep'));
    expect(paths.root).toBe(project.dir);
    expect(paths.project).toBe(join(home.dir, 'projects', projectId(project.dir), 'notes.md'));
    expect(paths.project.startsWith(project.dir)).toBe(false);
    expect(paths.global).toBe(join(home.dir, 'notes.md'));
  });

  test('project ids are readable, safe, and differ for folders with the same name', () => {
    expect(projectId('/Users/rt/my app!')).toMatch(/^my-app--[0-9a-f]{10}$/);
    expect(projectId('/a/mrig')).not.toBe(projectId('/b/mrig'));
    expect(projectId('/a/mrig')).toBe(projectId('/a/mrig'));
    expect(projectId('/')).toMatch(/^root-[0-9a-f]{10}$/);
  });

  test('inside an offline zone, the zone is the project and its notes stay inside it', () => {
    const paths = notesPaths(join(project.dir, 'sub'), project.dir);
    expect(paths.root).toBe(project.dir);
    expect(paths.project).toBe(join(project.dir, '.mrig', 'notes', 'notes.md'));
    addNote(paths.project, 'zone secret', { title: 't', zone: true });
    expect(readFileSync(join(project.dir, '.mrig', 'notes', '.gitignore'), 'utf8')).toContain('*');
    expect(existsSync(paths.global)).toBe(false);
  });
});

describe('adding and forgetting notes (M1)', () => {
  const file = () => join(home.dir, 'projects', 'p', 'notes.md');

  test('a note is one dated line; the file is plain Markdown, owner-only, written atomically', () => {
    const note = addNote(file(), '  use bun,\n not npm  ', {
      title: 'notes for p',
      date: '2026-11-07',
    });
    expect(note).toEqual({ n: 1, date: '2026-11-07', text: 'use bun, not npm' });
    addNote(file(), 'tabs are two spaces', { title: 'x', date: '2026-11-08' });
    const text = readFileSync(file(), 'utf8');
    expect(text.startsWith('# notes for p\n')).toBe(true);
    expect(text).toContain('- 2026-11-07: use bun, not npm\n- 2026-11-08: tabs are two spaces\n');
    expect(readdirSync(join(home.dir, 'projects', 'p'))).toEqual(['notes.md']); // no temp file left
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  test('empty and overlong notes are refused, and nothing is written', () => {
    expect(() => addNote(file(), '   ', { title: 't' })).toThrow('Nothing to remember');
    expect(() => addNote(file(), 'x'.repeat(MAX_NOTE_CHARS + 1), { title: 't' })).toThrow('under');
    expect(existsSync(file())).toBe(false);
  });

  test('forget removes one note and keeps everything you wrote by hand', () => {
    addNote(file(), 'one', { title: 't', date: '2026-11-01' });
    addNote(file(), 'two', { title: 't', date: '2026-11-02' });
    writeFileSync(file(), `${readFileSync(file(), 'utf8')}My own paragraph.\n- three, by hand\n`);
    expect(readNotes(file()).map((n) => n.text)).toEqual(['one', 'two', 'three, by hand']);
    expect(forgetNote(file(), 2).text).toBe('two');
    const text = readFileSync(file(), 'utf8');
    expect(text).toContain('My own paragraph.');
    expect(readNotes(file()).map((n) => `${n.n}:${n.text}`)).toEqual(['1:one', '2:three, by hand']);
    expect(() => forgetNote(file(), 9)).toThrow('There is no note 9');
  });
});

describe('notes in the prompt (M1)', () => {
  test('project notes, then global; newest kept when they don’t fit, and it says so', () => {
    const paths = notesPaths(project.dir);
    expect(notesBlock(paths)).toBe(''); // nothing saved yet: nothing in the prompt
    for (let i = 1; i <= 3; i++)
      addNote(paths.global, `global ${i}`, { title: 'g', date: '2026-11-01' });
    for (let i = 1; i <= 200; i++)
      addNote(paths.project, `project note number ${i} ${'x'.repeat(40)}`, {
        title: 'p',
        date: '2026-11-02',
      });
    const block = notesBlock(paths);
    expect(block.length).toBeLessThanOrEqual(NOTES_PROMPT_CHARS + 200);
    expect(block).toContain('project note number 200');
    expect(block).not.toContain('project note number 1 ');
    expect(block).toMatch(/\(\d+ older notes left out to save space\.\)/);
  });

  test('notes and AGENTS.md share one 24,000-character budget', () => {
    writeFileSync(join(project.dir, 'AGENTS.md'), `# rules\n${'r'.repeat(30_000)}`);
    const notes = notesBlock({
      ...notesPaths(project.dir),
      project: (() => {
        const p = notesPaths(project.dir).project;
        for (let i = 0; i < 100; i++) addNote(p, `note ${i} ${'n'.repeat(50)}`, { title: 'p' });
        return p;
      })(),
    });
    const prompt = buildSystemPrompt({ cwd: project.dir, modelLabel: 'x', notes });
    const memoryStart = prompt.indexOf('## Project memory');
    const memory = prompt.slice(memoryStart);
    expect(memory).toContain('… [memory truncated]');
    expect(memory).toContain('## Notes the user asked you to remember');
    expect(memory.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS + 200); // headings and marker
  });
});

describe('/remember and /notes through the runtime (M1)', () => {
  const make = (turns = [textTurn('ok'), textTurn('ok'), textTurn('ok'), textTurn('ok')]) => {
    const model = mockModel(turns);
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'local',
      languageModel: model,
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    return { rt, model };
  };
  const systemOf = (model: ReturnType<typeof mockModel>, call: number) =>
    String(model.doStreamCalls[call]?.prompt.find((m) => m.role === 'system')?.content ?? '');
  const run = async (rt: Runtime, text: string, edit?: (path: string) => Promise<void>) => {
    const out: string[] = [];
    await runCommand(rt, text, {
      write: (s) => out.push(plain(s)),
      busy: (r) => r(new AbortController().signal),
      ...(edit ? { edit } : {}),
    });
    return out.join('');
  };

  test('a note is used from the next message, and the prompt then stays byte-identical', async () => {
    addNote(notesPaths(project.dir).global, 'answer in British English', { title: 'g' });
    const { rt, model } = make();
    await rt.agent.run('hi');
    expect(systemOf(model, 0)).toContain('answer in British English');
    expect(await run(rt, '/remember the API lives in src/server')).toContain(
      'Remembered for this project (note 1)',
    );
    await rt.agent.run('again');
    await rt.agent.run('and again');
    expect(systemOf(model, 1)).toContain('the API lives in src/server');
    expect(systemOf(model, 2)).toBe(systemOf(model, 1)); // stable between turns
    // A new conversation in the same project loads it too.
    const next = make();
    await next.rt.agent.run('hello');
    expect(systemOf(next.model, 0)).toContain('the API lives in src/server');
    await rt.close();
    await next.rt.close();
  });

  test('/notes lists both files, /notes forget removes one, /remember --global saves for all', async () => {
    const { rt, model } = make();
    await run(rt, '/remember use bun');
    await run(rt, '/remember --global I prefer short answers');
    const list = await run(rt, '/notes');
    expect(list).toContain(`For this project (${project.dir})`);
    expect(list).toMatch(/1\. \d{4}-\d{2}-\d{2} {2}use bun/);
    expect(list).toMatch(/g1\. \d{4}-\d{2}-\d{2} {2}I prefer short answers/);
    expect(await run(rt, '/notes forget g1')).toContain('Forgot: I prefer short answers');
    expect(await run(rt, '/notes forget 7')).toContain('There is no note 7');
    expect(await run(rt, '/notes forget x')).toContain('usage');
    await rt.agent.run('hi');
    expect(systemOf(model, 0)).toContain('use bun');
    expect(systemOf(model, 0)).not.toContain('short answers');
    expect(await run(rt, '/remember')).toContain('usage: /remember');
    await rt.close();
  });

  test('/notes edit opens the editor where there is one, then reloads; elsewhere it gives the path', async () => {
    const { rt, model } = make();
    await run(rt, '/remember first');
    const file = rt.notesPaths.project;
    expect(await run(rt, '/notes edit')).toContain(`then run /notes reload:\n${file}`);
    const opened: string[] = [];
    const out = await run(rt, '/notes edit', async (path) => {
      opened.push(path);
      writeFileSync(path, `${readFileSync(path, 'utf8')}- edited by hand\n`);
    });
    expect(opened).toEqual([file]);
    expect(out).toContain('Notes reloaded: 2');
    await rt.agent.run('hi');
    expect(systemOf(model, 0)).toContain('edited by hand');
    // A change made outside mrig loads after /notes reload.
    writeFileSync(file, `${readFileSync(file, 'utf8')}- added outside\n`);
    expect(await run(rt, '/notes reload')).toContain('reloaded');
    await rt.agent.run('again');
    expect(systemOf(model, 1)).toContain('added outside');
    await rt.close();
  });

  test('inside an offline zone notes stay in the zone, and --global is refused', async () => {
    writeFileSync(join(project.dir, ZONE_MARKER), '');
    const { rt } = make();
    expect(await run(rt, '/remember --global leak this')).toContain("--global isn't allowed here");
    expect(existsSync(join(home.dir, 'notes.md'))).toBe(false);
    expect(await run(rt, '/remember zone fact')).toContain('for this offline zone');
    expect(readNotes(join(project.dir, '.mrig', 'notes', 'notes.md')).map((n) => n.text)).toEqual([
      'zone fact',
    ]);
    expect(existsSync(join(home.dir, 'projects'))).toBe(false);
    expect(await run(rt, '/notes edit --global')).toContain("only the zone's notes");
    await rt.close();
  });
});

describe('the editor for /notes edit (M1)', () => {
  test('$VISUAL, then $EDITOR (with its arguments), then a default per system', () => {
    expect(editorCommand('/n.md', { VISUAL: 'code --wait', EDITOR: 'nano' }, 'darwin')).toEqual([
      'code',
      '--wait',
      '/n.md',
    ]);
    expect(editorCommand('/n.md', { EDITOR: 'nano' }, 'darwin')).toEqual(['nano', '/n.md']);
    expect(editorCommand('/n.md', {}, 'darwin')).toEqual(['vi', '/n.md']);
    expect(editorCommand('C:\\n.md', { EDITOR: '  ' }, 'win32')).toEqual(['notepad', 'C:\\n.md']);
  });
});
