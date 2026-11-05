import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { langDirs, langReport, loadLangMemory } from '../src/lang/memory.ts';
import { Runtime } from '../src/runtime.ts';
import { bannerLines, runCommand } from '../src/ui/commands.ts';
import { mockModel, tempDir, textTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('language memory (A3)', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  const globalLang = () => join(home.dir, 'lang');
  const projectLang = () => join(project.dir, '.mrig', 'lang');
  const put = (dir: string, name: string, text: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: {
          fake: { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake' },
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

  test('no folders, no memory, and a hint', () => {
    const mem = loadLangMemory(project.dir);
    expect(mem.files).toEqual([]);
    expect(mem.block).toBe('');
    expect(langReport(mem, project.dir)[0]).toMatch(
      /^No language memory loaded\. Add files such as/,
    );
  });

  test('names carry the variety; order is global first, shared first, then variety order', () => {
    put(globalLang(), 'mrd.md', 'Western Magar notes');
    put(globalLang(), 'shared.md', 'Rules for all varieties');
    put(projectLang(), 'mgp-lexicon.md', 'आमा = mother');
    put(projectLang(), 'mgp-grammar.md', 'SOV order');
    put(projectLang(), 'kzq.md', 'Kaike notes');
    put(projectLang(), 'notes.md', 'untagged');
    put(projectLang(), 'MGP.md', 'wrong case');
    put(projectLang(), 'readme.txt', 'not markdown, not reported');
    const mem = loadLangMemory(project.dir);
    expect(mem.files.map((f) => `${f.tag}${f.topic ? `-${f.topic}` : ''}`)).toEqual([
      'shared',
      'mrd',
      'mgp-grammar',
      'mgp-lexicon',
      'kzq',
    ]);
    expect(mem.skipped.map((s) => s.path.split(/[\\/]/).pop())).toEqual(['MGP.md', 'notes.md']);
    expect(mem.skipped[0]?.reason).toMatch(
      /<tag>\.md or <tag>-<topic>\.md, with tag one of shared, mgp/,
    );
    // Every file is labelled with its variety in the prompt.
    expect(mem.block).toStartWith('## Language memory (lang/*.md, by variety');
    expect(mem.block).toContain(
      '### all varieties · ~/.mrig/lang/shared.md\nRules for all varieties',
    );
    expect(mem.block).toContain(
      '### Eastern Magar (Magar Dhut) (mgp) · .mrig/lang/mgp-lexicon.md\nआमा = mother',
    );
    expect(mem.block).toContain('### Kaike (kzq) · .mrig/lang/kzq.md');
    expect(mem.tokens).toBeGreaterThan(0);
  });

  test('folders from the git root down to cwd load nearest last; home is read once', () => {
    const sub = join(project.dir, 'pkg');
    put(projectLang(), 'mgp.md', 'root');
    put(join(sub, '.mrig', 'lang'), 'mgp.md', 'nearer');
    expect(loadLangMemory(sub).files.map((f) => f.text)).toEqual(['root', 'nearer']);
    // In the home folder, <home>/.mrig/lang is the global folder.
    process.env.MRIG_HOME = join(home.dir, '.mrig');
    put(join(home.dir, '.mrig', 'lang'), 'shared.md', 'once');
    expect(langDirs(home.dir)).toHaveLength(1);
    expect(loadLangMemory(home.dir).files.map((f) => f.text)).toEqual(['once']);
  });

  test('content is NFC-normalized and flagged; empty files and the size limit are reported', () => {
    put(projectLang(), 'mgp.md', 'क़'); // NFC already: a nukta letter stays decomposed
    put(projectLang(), 'mrd.md', 'é'); // é decomposed: not NFC
    put(projectLang(), 'kgj.md', '   ');
    put(projectLang(), 'kzq.md', 'x'.repeat(50));
    const mem = loadLangMemory(project.dir, 40);
    expect(mem.files.map((f) => [f.tag, f.text, f.normalized])).toEqual([
      ['mgp', 'क़', false],
      ['mrd', 'é', true],
    ]);
    expect(mem.skipped.map((s) => [s.path.split(/[\\/]/).pop(), s.reason])).toEqual([
      ['kgj.md', 'empty'],
      ['kzq.md', 'over the 40-character limit for language memory'],
    ]);
    expect(langReport(mem, project.dir).join('\n')).toContain('not NFC on disk (normalized here)');
  });

  const runtime = (turns = [textTurn('one'), textTurn('two'), textTurn('three')]) => {
    const model = mockModel(turns);
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'fake',
      languageModel: model,
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    return { rt, model };
  };
  const systemOf = (call: { prompt: Array<{ role: string; content: unknown }> } | undefined) =>
    String(call?.prompt.find((m) => m.role === 'system')?.content ?? '');

  test('the block is in the system prompt and stays byte-identical across turns', async () => {
    put(projectLang(), 'mgp.md', 'Use आमा for mother.');
    const { rt, model } = runtime();
    await rt.agent.run('first');
    put(projectLang(), 'mgp.md', 'Edited while the session runs.'); // must not leak in
    await rt.agent.run('second');
    const [a, b] = model.doStreamCalls.map(systemOf);
    expect(a).toContain(
      '### Eastern Magar (Magar Dhut) (mgp) · .mrig/lang/mgp.md\nUse आमा for mother.',
    );
    expect(b).toBe(a ?? '');
    // /lang reload picks the edit up, once, on request.
    const out: string[] = [];
    const io = {
      write: (s: string) => out.push(plain(s)),
      busy: <T>(run: (s: AbortSignal) => Promise<T>) => run(new AbortController().signal),
    };
    await runCommand(rt, '/lang reload', io);
    expect(out.join('')).toContain('Reloaded. The system prompt changed');
    await rt.agent.run('third');
    expect(systemOf(model.doStreamCalls[2])).toContain('Edited while the session runs.');
    await rt.close();
  });

  test('/lang reports files and tokens; the banner names the varieties', async () => {
    put(globalLang(), 'shared.md', 'All.');
    put(projectLang(), 'kgj.md', 'Gamal Kham.');
    put(projectLang(), 'misc.md', 'no tag');
    const { rt } = runtime([]);
    const out: string[] = [];
    const io = {
      write: (s: string) => out.push(plain(s)),
      busy: <T>(run: (s: AbortSignal) => Promise<T>) => run(new AbortController().signal),
    };
    await runCommand(rt, '/lang', io);
    const text = out.join('');
    expect(text).toMatch(/^language memory: 2 files · ~\d+ tokens, in the cached system prompt/);
    expect(text).toContain('  shared ~/.mrig/lang/shared.md · ~1 tokens · all varieties');
    expect(text).toContain('  kgj    .mrig/lang/kgj.md · ~3 tokens · Kham: Gamal (kgj)');
    expect(text).toContain('  not loaded: .mrig/lang/misc.md: the name must be');
    out.length = 0;
    await runCommand(rt, '/lang reload', io);
    expect(out.join('')).toContain('Unchanged; the cached prompt stays as it is.');
    out.length = 0;
    await runCommand(rt, '/lang nope', io);
    expect(out.join('')).toBe('usage: /lang [reload]\n\n');
    expect(bannerLines(rt).map(plain)).toContain(
      `lang: 2 files (shared, kgj) · ~${rt.lang.tokens} tokens · /lang`,
    );
    await rt.close();
  });
});
