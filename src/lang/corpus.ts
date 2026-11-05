/**
 * Corpus search (Track 2, A4): plain text search over a CLDF Wordlist and any text files next to
 * it. No embeddings: those come only if plain search proves not to be enough, and only local
 * ones under offline mode (L5).
 *
 * A query is searched in every form it can take: the Devanagari (NFC) hub, its ISO 15919
 * romanization (also without the final inherent a, the way names and app data often write it),
 * Akkha-Brahmi, and the text as typed (so an English gloss finds the concept). Matching ignores
 * case and Latin diacritics (ama finds āmā), and a match must start a word.
 *
 * The search runs in-process rather than through ripgrep: ripgrep can't NFC-normalize a line or
 * fold diacritics, and it can't tell which variety a CSV row belongs to. Wordlists are small.
 *
 * CLDF awareness: the dataset's `*-metadata.json` (or the default file names forms.csv,
 * languages.csv, parameters.csv) says which file is which table and which column holds what.
 * A form row is labelled with its variety (ISO 639-3 code from the LanguageTable) and concept.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { looksBinary } from '../util/text.ts';
import { parseCsv } from './csv.ts';
import { VARIETIES } from './tables.ts';
import { akkhaToDeva, devaToAkkha, devaToRoman, romanToDeva } from './translit.ts';

const CLDF = 'http://cldf.clld.org/v1.0/terms.rdf#';
const TEXT_EXTS = new Set(['.csv', '.tsv', '.txt', '.md', '.json', '.jsonl']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type TableKind = 'forms' | 'languages' | 'parameters';

/** CLDF property terms, and the column names the spec uses when a table has no metadata. */
const DEFAULT_COLUMNS: Record<TableKind, Record<string, string>> = {
  forms: {
    id: 'ID',
    languageReference: 'Language_ID',
    parameterReference: 'Parameter_ID',
    form: 'Form',
    value: 'Value',
  },
  languages: { id: 'ID', name: 'Name', iso639P3code: 'ISO639P3code', glottocode: 'Glottocode' },
  parameters: { id: 'ID', name: 'Name', concepticonReference: 'Concepticon_ID' },
};
const DEFAULT_FILES: Record<TableKind, string> = {
  forms: 'forms.csv',
  languages: 'languages.csv',
  parameters: 'parameters.csv',
};

export interface Language {
  id: string;
  name?: string;
  iso?: string;
}
export interface Parameter {
  id: string;
  name?: string;
  concepticon?: string;
  file: string;
  line: number;
}
export interface FormRow {
  file: string;
  line: number;
  raw: string;
  languageId: string;
  parameterId: string;
  form: string;
}

export interface Corpus {
  dir: string;
  /** The CLDF metadata file, when the folder has one. */
  metadata?: string;
  /** Absolute path → which CLDF table it is. */
  tables: Map<string, TableKind>;
  languages: Map<string, Language>;
  parameters: Map<string, Parameter>;
  forms: FormRow[];
}

// ---- finding and loading ----

const expandHome = (p: string) =>
  p === '~' || /^~[\\/]/.test(p) ? join(homedir(), p.slice(1)) : p;
const metadataIn = (dir: string) =>
  readdirSync(dir)
    .filter((n) => n.endsWith('-metadata.json'))
    .sort()[0];
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/**
 * The corpus folder: an explicit path, else the configured `corpus`, else a `cldf/` folder (or a
 * folder holding a CLDF `*-metadata.json`) from cwd up to the git root.
 */
export function findCorpus(cwd: string, configured?: string): string | undefined {
  const explicit = configured ? resolve(cwd, expandHome(configured)) : undefined;
  if (explicit) return isDir(explicit) ? explicit : undefined;
  let dir = resolve(cwd);
  for (;;) {
    if (isDir(join(dir, 'cldf'))) return join(dir, 'cldf');
    if (metadataIn(dir)) return dir;
    if (existsSync(join(dir, '.git'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface TableSpec {
  file: string;
  kind: TableKind;
  /** CLDF term → column name. */
  columns: Record<string, string>;
}

function tablesFromMetadata(dir: string, metadata: string): TableSpec[] {
  let doc: { tables?: unknown };
  try {
    doc = JSON.parse(readFileSync(join(dir, metadata), 'utf8'));
  } catch (err) {
    throw new Error(`Invalid CLDF metadata ${metadata}: ${(err as Error).message}`);
  }
  const specs: TableSpec[] = [];
  for (const t of Array.isArray(doc.tables) ? doc.tables : []) {
    const table = t as {
      url?: string;
      'dc:conformsTo'?: string;
      tableSchema?: { columns?: Array<{ name?: string; propertyUrl?: string }> };
    };
    const conforms = table['dc:conformsTo'] ?? '';
    const kind: TableKind | undefined = conforms.endsWith('#FormTable')
      ? 'forms'
      : conforms.endsWith('#LanguageTable')
        ? 'languages'
        : conforms.endsWith('#ParameterTable')
          ? 'parameters'
          : undefined;
    if (!kind) continue;
    const columns = { ...DEFAULT_COLUMNS[kind] };
    for (const c of table.tableSchema?.columns ?? []) {
      const term = c.propertyUrl?.startsWith(CLDF) ? c.propertyUrl.slice(CLDF.length) : undefined;
      if (term && c.name) columns[term] = c.name;
    }
    specs.push({ file: join(dir, table.url ?? DEFAULT_FILES[kind]), kind, columns });
  }
  return specs;
}

function readTable(
  spec: TableSpec,
): Array<{ line: number; raw: string; get: (term: string) => string }> {
  if (!existsSync(spec.file)) return [];
  const [header, ...rows] = parseCsv(readFileSync(spec.file, 'utf8'));
  if (!header) return [];
  const index = new Map(header.cells.map((name, i) => [name.trim(), i]));
  return rows.map((r) => ({
    line: r.line,
    raw: r.raw,
    get: (term: string) => {
      const name = spec.columns[term];
      const i = name === undefined ? undefined : index.get(name);
      return i === undefined ? '' : (r.cells[i] ?? '').normalize('NFC');
    },
  }));
}

export function loadCorpus(dir: string): Corpus {
  const metadata = metadataIn(dir);
  const specs = metadata
    ? tablesFromMetadata(dir, metadata)
    : (Object.keys(DEFAULT_FILES) as TableKind[])
        .map((kind) => ({
          file: join(dir, DEFAULT_FILES[kind]),
          kind,
          columns: DEFAULT_COLUMNS[kind],
        }))
        .filter((s) => existsSync(s.file));
  const corpus: Corpus = {
    dir,
    ...(metadata ? { metadata } : {}),
    tables: new Map(),
    languages: new Map(),
    parameters: new Map(),
    forms: [],
  };
  for (const spec of specs) {
    corpus.tables.set(spec.file, spec.kind);
    for (const row of readTable(spec)) {
      if (spec.kind === 'languages') {
        const id = row.get('id');
        corpus.languages.set(id, {
          id,
          name: row.get('name') || undefined,
          iso: row.get('iso639P3code') || undefined,
        });
      } else if (spec.kind === 'parameters') {
        const id = row.get('id');
        corpus.parameters.set(id, {
          id,
          name: row.get('name') || undefined,
          concepticon: row.get('concepticonReference') || undefined,
          file: spec.file,
          line: row.line,
        });
      } else {
        corpus.forms.push({
          file: spec.file,
          line: row.line,
          raw: row.raw,
          languageId: row.get('languageReference'),
          parameterId: row.get('parameterReference'),
          form: row.get('form') || row.get('value'),
        });
      }
    }
  }
  return corpus;
}

/** The variety tag for a language: its ISO 639-3 code, or its ID when that is a known tag. */
export function varietyOf(corpus: Corpus, languageId: string): string | undefined {
  const iso = corpus.languages.get(languageId)?.iso;
  if (iso) return iso;
  return languageId in VARIETIES ? languageId : undefined;
}

// ---- the query ----

export interface SearchForm {
  text: string;
  kind: 'devanagari' | 'iso 15919' | 'no final a' | 'akkha' | 'as typed';
}

const DEVANAGARI = /[ऀ-ॿ]/u;
const BRAHMI = /[\u{11000}-\u{1107F}]/u;
const WORD_FINAL_CONSONANT = /([क-ह]़?)(?=$|[^ऀ-ॿ])/gu;

/** Every form a query can take. Duplicates (after folding) are dropped. */
export function searchForms(query: string): SearchForm[] {
  const q = query.trim().normalize('NFC');
  let deva: string | undefined;
  if (BRAHMI.test(q)) deva = akkhaToDeva(q).text;
  else if (DEVANAGARI.test(q)) deva = q;
  else {
    const r = romanToDeva(q);
    // Only when every letter converts: an English gloss is searched as typed, not as Devanagari.
    // Romanized names usually drop the final a, so a final halanta is read as an inherent a.
    if (r.unmapped.length === 0) deva = r.text.replace(/्(?=$|[^ऀ-ॿ])/gu, '');
  }
  const forms: SearchForm[] = [{ text: q, kind: 'as typed' }];
  if (deva) {
    forms.push({ text: deva, kind: 'devanagari' });
    forms.push({ text: devaToRoman(deva).text, kind: 'iso 15919' });
    forms.push({
      text: devaToRoman(deva.replace(WORD_FINAL_CONSONANT, '$1्')).text,
      kind: 'no final a',
    });
    forms.push({ text: devaToAkkha(deva).text, kind: 'akkha' });
  }
  const seen = new Set<string>();
  return forms.filter((f) => {
    const key = fold(f.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Lowercase, drop Latin diacritics (ā → a), keep Devanagari and Brahmi marks, NFC. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .toLowerCase()
    .normalize('NFC');
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcher(forms: SearchForm[]): (text: string) => boolean {
  // A match starts a word: आमा finds आमाको, ama does not find kamala.
  const re = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])(?:${forms.map((f) => escapeRegex(fold(f.text))).join('|')})`,
    'u',
  );
  return (text) => re.test(fold(text));
}

// ---- the search ----

export interface Hit {
  /** Relative to the corpus folder, with forward slashes. */
  file: string;
  line: number;
  kind: 'form' | 'concept' | 'language' | 'text';
  text: string;
  variety?: string;
  concept?: string;
  concepticon?: string;
  /** For a concept: its forms that the search did not already list. */
  related?: Array<{ variety?: string; form: string; file: string; line: number }>;
}

export interface SearchOptions {
  /** Only lexicon forms of this variety (other matches stay, labelled untagged). */
  variety?: string;
  limit?: number;
}

export interface SearchResult {
  forms: SearchForm[];
  hits: Hit[];
  /** Form rows that matched but belong to another variety. */
  otherVarieties: number;
  /** More matches than `limit`. */
  truncated: boolean;
  files: number;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (TEXT_EXTS.has(extname(name).toLowerCase()) && !name.endsWith('-metadata.json')) {
      if (st.size <= MAX_FILE_BYTES) yield p;
    }
  }
}

export function searchCorpus(
  corpus: Corpus,
  query: string,
  opts: SearchOptions = {},
): SearchResult {
  const forms = searchForms(query);
  if (forms.length === 0) throw new Error('Empty query.');
  const matches = matcher(forms);
  const limit = opts.limit ?? 50;
  const rel = (p: string) => relative(corpus.dir, p).replaceAll('\\', '/');
  const hits: Hit[] = [];
  let otherVarieties = 0;
  let truncated = false;
  let files = 0;
  const paramAt = new Map(
    [...corpus.parameters.values()].map((p) => [`${rel(p.file)}:${p.line}`, p]),
  );
  const add = (h: Hit) => {
    if (hits.length >= limit) truncated = true;
    else hits.push(h);
  };

  for (const file of walk(corpus.dir)) {
    files++;
    const kind = corpus.tables.get(file);
    if (kind) {
      const rows =
        kind === 'forms'
          ? corpus.forms.filter((f) => f.file === file)
          : parseCsv(readFileSync(file, 'utf8')).slice(1);
      for (const row of rows) {
        if (!matches(row.raw)) continue;
        if (kind === 'forms') {
          const f = row as FormRow;
          const variety = varietyOf(corpus, f.languageId);
          if (opts.variety && variety !== opts.variety) {
            otherVarieties++;
            continue;
          }
          add({
            file: rel(file),
            line: f.line,
            kind: 'form',
            text: f.form,
            ...(variety ? { variety } : {}),
            ...(corpus.parameters.get(f.parameterId)?.name
              ? { concept: corpus.parameters.get(f.parameterId)?.name }
              : {}),
          });
        } else {
          add({
            file: rel(file),
            line: row.line,
            kind: kind === 'parameters' ? 'concept' : 'language',
            text: row.raw.trim(),
          });
        }
      }
      continue;
    }
    const buf = readFileSync(file);
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!matches(line)) return;
      add({ file: rel(file), line: i + 1, kind: 'text', text: line.trim().slice(0, 300) });
    });
  }

  // A matching concept brings its forms along: "mother" finds the words for mother.
  const shown = new Set(hits.filter((h) => h.kind === 'form').map((h) => `${h.file}:${h.line}`));
  for (const h of hits) {
    if (h.kind !== 'concept') continue;
    const param = paramAt.get(`${h.file}:${h.line}`);
    if (!param) continue;
    h.concept = param.name;
    if (param.concepticon) h.concepticon = param.concepticon;
    h.related = corpus.forms
      .filter((f) => f.parameterId === param.id && !shown.has(`${rel(f.file)}:${f.line}`))
      .map((f) => ({
        variety: varietyOf(corpus, f.languageId),
        form: f.form,
        file: rel(f.file),
        line: f.line,
      }))
      .filter((f) => !opts.variety || f.variety === opts.variety)
      .slice(0, 20);
  }
  return { forms, hits, otherVarieties, truncated, files };
}

/** Lines for the tool and for people. */
export function formatSearch(
  corpus: Corpus,
  query: string,
  r: SearchResult,
  opts: SearchOptions = {},
): string[] {
  const where = corpus.metadata
    ? `CLDF ${corpus.metadata} · ${corpus.forms.length} forms, ${corpus.languages.size} languages, ${corpus.parameters.size} concepts`
    : corpus.forms.length > 0
      ? `CLDF tables · ${corpus.forms.length} forms`
      : 'plain text files';
  const lines = [
    `corpus: ${corpus.dir} (${where})`,
    `searched: ${r.forms.map((f) => `${f.text} (${f.kind})`).join(' · ')}; case and Latin diacritics ignored`,
  ];
  if (r.hits.length === 0) {
    lines.push(
      `No matches for "${query}"${opts.variety ? ` in ${opts.variety}` : ''} in ${r.files} files.`,
    );
  }
  for (const h of r.hits) {
    const at = `${h.file}:${h.line}`;
    if (h.kind === 'form') {
      lines.push(`${at}  ${h.variety ?? 'untagged'}  ${h.concept ?? '?'}  ${h.text}`);
    } else if (h.kind === 'concept') {
      lines.push(
        `${at}  concept: ${h.concept ?? h.text}${h.concepticon ? ` (Concepticon ${h.concepticon})` : ''}`,
      );
      if (h.related && h.related.length > 0) {
        lines.push(
          `    forms: ${h.related.map((f) => `${f.variety ?? 'untagged'} ${f.form} (${f.file}:${f.line})`).join(' · ')}`,
        );
      }
    } else {
      lines.push(`${at}  ${h.kind === 'language' ? 'language' : 'untagged'}  ${h.text}`);
    }
  }
  const tail: string[] = [];
  if (r.truncated)
    tail.push(
      `more matches than the limit of ${opts.limit ?? 50}; narrow the query or raise limit`,
    );
  if (r.otherVarieties > 0)
    tail.push(
      `${r.otherVarieties} form${r.otherVarieties === 1 ? '' : 's'} in other varieties not shown`,
    );
  if (tail.length > 0) lines.push(`(${tail.join('; ')})`);
  return lines;
}
