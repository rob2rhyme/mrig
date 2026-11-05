import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import {
  findCorpus,
  fold,
  formatSearch,
  loadCorpus,
  searchCorpus,
  searchForms,
} from '../src/lang/corpus.ts';
import { parseCsv } from '../src/lang/csv.ts';
import { devaToAkkha } from '../src/lang/translit.ts';
import { Runtime } from '../src/runtime.ts';
import { corpusTool } from '../src/tools/corpus.ts';
import { ctx, mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'cldf-wordlist');
const where = (r: ReturnType<typeof searchCorpus>) =>
  r.hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.variety ?? '-'} ${h.text}`);

describe('corpus: CSV', () => {
  test('quotes, commas, doubled quotes, newlines in fields, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n1,"x, y"\r\n2,"say ""hi"""\n3,"two\nlines"\n\n4,\n');
    expect(rows.map((r) => [r.line, r.cells])).toEqual([
      [1, ['a', 'b']],
      [2, ['1', 'x, y']],
      [3, ['2', 'say "hi"']],
      [4, ['3', 'two\nlines']],
      [7, ['4', '']], // the blank line 6 is skipped, and line numbers stay true
    ]);
    expect(rows[3]?.raw).toBe('3,"two\nlines"');
  });
});

describe('corpus: the query in every form', () => {
  test('Devanagari, romanized, Akkha and English queries', () => {
    expect(searchForms('आमा').map((f) => `${f.kind}:${f.text}`)).toEqual([
      'as typed:आमा',
      'iso 15919:āmā',
      `akkha:${devaToAkkha('आमा').text}`,
    ]); // the Devanagari form is the query itself; "no final a" equals ISO here
    expect(searchForms('मगर').map((f) => f.text)).toEqual([
      'मगर',
      'magara',
      'magar',
      devaToAkkha('मगर').text,
    ]);
    // A romanized query without the final a still finds the Devanagari.
    expect(searchForms('magar').map((f) => f.text)).toContain('मगर');
    expect(searchForms(devaToAkkha('घर').text).map((f) => f.text)).toContain('घर');
    // A Latin word is also tried as romanized Devanagari; an English word finds nothing that way,
    // and it is still searched as typed. A letter outside the romanization stops the conversion.
    expect(searchForms('mother')[0]).toEqual({ text: 'mother', kind: 'as typed' });
    expect(searchForms('wax').map((f) => f.kind)).toEqual(['as typed']);
  });

  test('folding drops case and Latin diacritics only', () => {
    expect(fold('Āmā ṬHA')).toBe('ama tha');
    expect(fold('आमा')).toBe('आमा'); // Devanagari marks are letters, not decoration
    expect(fold('क़')).toBe('क़');
  });
});

describe('corpus: search', () => {
  test('finds the dataset: explicit path, config, or a cldf/ folder up to the git root', () => {
    const t = tempDir('mrig-corpus-');
    try {
      mkdirSync(join(t.dir, '.git'));
      mkdirSync(join(t.dir, 'cldf'));
      mkdirSync(join(t.dir, 'src', 'deep'), { recursive: true });
      expect(findCorpus(join(t.dir, 'src', 'deep'))).toBe(join(t.dir, 'cldf'));
      expect(findCorpus(t.dir, FIXTURE)).toBe(FIXTURE);
      expect(findCorpus(t.dir, 'missing')).toBeUndefined();
      expect(findCorpus(FIXTURE)).toBe(FIXTURE); // a folder holding *-metadata.json
    } finally {
      t.cleanup();
    }
  });

  test('reads the metadata: tables, renamed columns, languages and concepts', () => {
    const c = loadCorpus(FIXTURE);
    expect(c.metadata).toBe('Wordlist-metadata.json');
    expect(c.forms.map((f) => `${f.line}:${f.languageId}:${f.form}`)).toEqual([
      '2:eastern:आमा',
      '3:gamal:आमा',
      '4:nepali:आमा',
      '5:eastern:पानी',
      '7:gamal:घर', // the comment on line 5 spans two lines
      '8:eastern:घर',
    ]);
    expect(c.languages.get('gamal')?.iso).toBe('kgj');
    expect(c.parameters.get('1')?.concepticon).toBe('1216');
  });

  test('a Devanagari query: every form row with its variety, plus text files', () => {
    const r = searchCorpus(loadCorpus(FIXTURE), 'आमा');
    expect(where(r)).toEqual([
      'forms.csv:2 form mgp आमा',
      'forms.csv:3 form kgj आमा',
      'forms.csv:4 form npi आमा',
      'notes/sentences.md:3 text - आमाको घर ठूलो छ।', // a match starts a word: आमाको counts
      'notes/sentences.md:4 text - The word for mother is written āmā in the app.',
    ]);
    expect(r.hits[0]?.concept).toBe('MOTHER');
  });

  test('a variety filter keeps other varieties apart and says how many were left out', () => {
    const corpus = loadCorpus(FIXTURE);
    const r = searchCorpus(corpus, 'आमा', { variety: 'kgj' });
    expect(where(r).filter((l) => l.includes(' form '))).toEqual(['forms.csv:3 form kgj आमा']);
    expect(r.otherVarieties).toBe(2);
    expect(formatSearch(corpus, 'आमा', r, { variety: 'kgj' }).at(-1)).toBe(
      '(2 forms in other varieties not shown)',
    );
  });

  test('ASCII finds diacritics; a match must start a word', () => {
    const r = searchCorpus(loadCorpus(FIXTURE), 'ama');
    // "ama" → अम, so it finds āmā by folding, and never Kamala.
    expect(where(r).some((l) => l.includes('āmā'))).toBe(true);
    expect(where(r).some((l) => l.includes('Kamala'))).toBe(false);
  });

  test('an English gloss finds the concept and brings its forms along', () => {
    const corpus = loadCorpus(FIXTURE);
    const r = searchCorpus(corpus, 'house');
    const concept = r.hits.find((h) => h.kind === 'concept');
    expect(concept).toMatchObject({
      file: 'parameters.csv',
      line: 4,
      concept: 'HOUSE',
      concepticon: '1252',
    });
    expect(concept?.related?.map((f) => `${f.variety} ${f.form} ${f.file}:${f.line}`)).toEqual([
      'kgj घर forms.csv:7',
      'mgp घर forms.csv:8',
    ]);
    const lines = formatSearch(corpus, 'house', r);
    expect(lines[0]).toBe(
      `corpus: ${FIXTURE} (CLDF Wordlist-metadata.json · 6 forms, 3 languages, 3 concepts)`,
    );
    expect(lines).toContain('parameters.csv:4  concept: HOUSE (Concepticon 1252)');
    expect(lines).toContain('    forms: kgj घर (forms.csv:7) · mgp घर (forms.csv:8)');
  });

  test('an Akkha query finds the Devanagari rows; no match says so', () => {
    const corpus = loadCorpus(FIXTURE);
    expect(where(searchCorpus(corpus, devaToAkkha('पानी').text))).toEqual([
      'forms.csv:5 form mgp पानी',
    ]);
    const none = searchCorpus(corpus, 'झरना');
    expect(none.hits).toEqual([]);
    expect(formatSearch(corpus, 'झरना', none)[2]).toMatch(/^No matches for "झरना" in \d+ files\.$/);
  });

  test('the limit is reported', () => {
    const corpus = loadCorpus(FIXTURE);
    const r = searchCorpus(corpus, 'आमा', { limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(formatSearch(corpus, 'आमा', r, { limit: 2 }).at(-1)).toMatch(
      /more matches than the limit of 2/,
    );
  });

  test('a folder with default table names and no metadata, and plain text folders', () => {
    const t = tempDir('mrig-corpus-');
    try {
      writeFileSync(join(t.dir, 'languages.csv'), 'ID,Name,ISO639P3code\nk,Kaike,kzq\n');
      writeFileSync(join(t.dir, 'forms.csv'), 'ID,Language_ID,Parameter_ID,Form\n1,k,water,पानी\n');
      writeFileSync(join(t.dir, 'story.txt'), 'पानी पर्यो\n');
      writeFileSync(join(t.dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
      const r = searchCorpus(loadCorpus(t.dir), 'पानी');
      expect(where(r)).toEqual(['forms.csv:2 form kzq पानी', 'story.txt:1 text - पानी पर्यो']);
    } finally {
      t.cleanup();
    }
  });

  test('NFC: a precomposed nukta letter in the corpus matches the NFC query', () => {
    const t = tempDir('mrig-corpus-');
    try {
      writeFileSync(join(t.dir, 'words.txt'), 'पढ़ाइ\nढ़ाइ\n'); // NFC, then precomposed ढ़
      expect(searchCorpus(loadCorpus(t.dir), 'ढ़ाइ').hits.map((h) => h.line)).toEqual([2]);
    } finally {
      t.cleanup();
    }
  });
});

describe('corpus: the tool and the config', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  test('the tool: read-only, local, cites file:line; clear errors', async () => {
    expect(corpusTool.readOnly).toBe(true);
    expect(corpusTool.remote).toBeUndefined();
    const out = await corpusTool.execute(
      { query: 'आमा', variety: 'mgp' },
      ctx(project.dir, { corpus: FIXTURE }),
    );
    expect(out).toContain('forms.csv:2  mgp  MOTHER  आमा');
    expect(out).toContain('(2 forms in other varieties not shown)');
    await expect(corpusTool.execute({ query: 'x' }, ctx(project.dir))).rejects.toThrow(
      /No corpus found/,
    );
    await expect(
      corpusTool.execute({ query: 'x', path: 'nope' }, ctx(project.dir)),
    ).rejects.toThrow(/Corpus folder not found: nope/);
    await expect(
      corpusTool.execute({ query: ' ', path: FIXTURE }, ctx(project.dir)),
    ).rejects.toThrow(/Empty query/);
  });

  test('"corpus" loads from a project config too; it must be a path', () => {
    mkdirSync(join(project.dir, '.mrig'));
    writeFileSync(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ corpus: 'data/cldf' }),
    );
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.corpus).toBe('data/cldf');
    expect(cfg.projectIgnored).toBeUndefined();
    writeFileSync(join(project.dir, '.mrig', 'config.json'), JSON.stringify({ corpus: 3 }));
    expect(() => loadConfig({ cwd: project.dir, env: {} })).toThrow(
      /"corpus" must be a folder path/,
    );
  });

  test('the model searches the configured corpus without a prompt, offline too', async () => {
    writeFileSync(join(home.dir, 'config.json'), JSON.stringify({ corpus: FIXTURE }));
    const asked: string[] = [];
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'ollama',
      offline: true,
      languageModel: mockModel([toolTurn('corpus', '{"query":"house"}'), textTurn('done')]),
      ask: async (r) => {
        asked.push(r.summary);
        return 'no';
      },
      events: { onText: () => {} },
    });
    await rt.agent.run('what is house?');
    expect(asked).toEqual([]);
    const result = rt.agent.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .map((p) => (p.type === 'tool-result' && p.output.type === 'text' ? p.output.value : ''));
    expect(result[0]).toContain('forms: kgj घर (forms.csv:7) · mgp घर (forms.csv:8)');
    await rt.close();
  });
});
