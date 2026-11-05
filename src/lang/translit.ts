/**
 * Akkha transliteration (Track 2, A2): pure, table-driven functions, no model involved.
 *
 * Hub and spokes: Devanagari (NFC) is the hub; Akkha-Brahmi and ISO 15919-style romanization
 * are spokes. Every conversion goes through the hub. Rules: docs/LANGUAGE.md.
 *
 * Nothing is mapped silently. Converting to Akkha applies the lossy set (श, ष, visarga,
 * chandrabindu, nukta) and reports each use; any Devanagari, Brahmi or Latin letter with no
 * mapping is left as it is and reported.
 *
 * Romanization is strict ISO 15919-style: the inherent a is always written (no schwa deletion),
 * so it converts back exactly. Two marks keep it reversible: ":" separates letters that would
 * otherwise read as one (k:h is क्ह, kh is ख; ka:i is कइ, kai is कै), and dandas are | and ‖.
 */
import {
  AKKHA_BRAHMI,
  LOSSY,
  NUKTA,
  ROMAN_CONSONANTS,
  ROMAN_MATRAS,
  ROMAN_NUKTA,
  ROMAN_OTHER,
  ROMAN_VOWELS,
  VARIETIES,
  type Variety,
  VIRAMA,
} from './tables.ts';

export type Script = 'deva' | 'akkha' | 'roman';

/** The four Kham varieties: their spelling leaves out the glottal stop and breathy vowels. */
const KHAM: ReadonlySet<Variety> = new Set(['kgj', 'kip', 'kif', 'kjl']);

export const SCRIPTS: readonly Script[] = ['deva', 'akkha', 'roman'];

/** One reported character: how often it occurred and what became of it. */
export interface ReportEntry {
  char: string;
  name: string;
  /** What it was written as: a substitute, '' (dropped), or itself (left as is). */
  to: string;
  count: number;
  note: string;
}

export interface TranslitResult {
  text: string;
  /** Lossy-set substitutions made on the way to Akkha. */
  lossy: ReportEntry[];
  /** Characters with no mapping, left unchanged in the output. */
  unmapped: ReportEntry[];
  warnings: string[];
}

export interface TranslitOptions {
  variety?: Variety;
}

const nfc = (s: string) => s.normalize('NFC');
const nfcKeys = (t: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [nfc(k), nfc(v)]));
const invert = (t: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [v, k]));

const isDevanagari = (c: string) => /[ऀ-ॿ꣠-ꣿ]/u.test(c);
const isBrahmi = (c: string) => /[\u{11000}-\u{1107F}]/u.test(c);
/** Latin letters, with or without diacritics: what a romanized text is made of. */
const isLatinLetter = (c: string) => /\p{Script=Latin}/u.test(c);
const codePoint = (c: string) =>
  `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Counts reports by character, in first-seen order. */
class Tally {
  private readonly entries = new Map<string, ReportEntry>();
  add(char: string, to: string, name: string, note: string): void {
    const e = this.entries.get(char);
    if (e) e.count++;
    else this.entries.set(char, { char, name, to, count: 1, note });
  }
  list(): ReportEntry[] {
    return [...this.entries.values()];
  }
}

// ---- Devanagari ↔ Akkha-Brahmi ----

const TO_AKKHA = nfcKeys(AKKHA_BRAHMI);
/**
 * Back from Brahmi. Brahmi also encodes letters Akkha does not use (श, ष, visarga, candrabindu);
 * if they turn up in a Brahmi text they map back to their Devanagari forms rather than being lost.
 */
const FROM_AKKHA: Record<string, string> = {
  ...invert(TO_AKKHA),
  '\u{11030}': 'श',
  '\u{11031}': 'ष',
  '\u{11000}': 'ँ',
  '\u{11002}': 'ः',
};

export function devaToAkkha(text: string): TranslitResult {
  const lossy = new Tally();
  const unmapped = new Tally();
  let out = '';
  for (const c of nfc(text)) {
    const rule = LOSSY[c];
    if (rule) {
      lossy.add(c, rule.to, rule.name, rule.note);
      for (const sub of rule.to) out += TO_AKKHA[sub] ?? sub;
    } else if (TO_AKKHA[c]) {
      out += TO_AKKHA[c];
    } else {
      if (isDevanagari(c)) unmapped.add(c, c, codePoint(c), 'no Akkha mapping; left as is');
      out += c;
    }
  }
  return {
    text: out,
    lossy: lossy.list(),
    unmapped: unmapped.list(),
    warnings: [
      'Akkha-Brahmi is provisional until the font spike (A1) passes and BAMA signs off; do not publish it.',
    ],
  };
}

export function akkhaToDeva(text: string): TranslitResult {
  const unmapped = new Tally();
  let out = '';
  for (const c of text) {
    const d = FROM_AKKHA[c];
    if (d) out += d;
    else {
      if (isBrahmi(c)) unmapped.add(c, c, codePoint(c), 'no Devanagari mapping; left as is');
      out += c;
    }
  }
  return { text: nfc(out), lossy: [], unmapped: unmapped.list(), warnings: [] };
}

// ---- Devanagari ↔ romanization ----

const R_CONS = nfcKeys(ROMAN_CONSONANTS);
const R_NUKTA = nfcKeys(ROMAN_NUKTA);
const R_VOWELS = nfcKeys(ROMAN_VOWELS);
const R_MATRAS = nfcKeys(ROMAN_MATRAS);
const R_OTHER = nfcKeys(ROMAN_OTHER);

/** Romanized consonant → Devanagari (nukta forms included), longest first for matching. */
const FROM_R_CONS: Array<[string, string]> = Object.entries({
  ...invert(R_CONS),
  ...invert(R_NUKTA),
}).sort((a, b) => b[0].length - a[0].length);
const FROM_R_VOWELS: Array<[string, string]> = Object.entries(invert(R_VOWELS)).sort(
  (a, b) => b[0].length - a[0].length,
);
const MATRA_FOR: Record<string, string> = invert(R_MATRAS);
/** Romanized signs and punctuation (not digits: ASCII digits stay ASCII). */
const FROM_R_OTHER: Array<[string, string]> = Object.entries(invert(R_OTHER))
  .filter(([r]) => !/^\d$/.test(r))
  .sort((a, b) => b[0].length - a[0].length);

/** True when `left` followed by `right` would be read as a longer token from `keys`. */
function wouldMerge(left: string, right: string, keys: Array<[string, string]>): boolean {
  const joined = left + right;
  return keys.some(([k]) => k.length > left.length && k.startsWith(left) && joined.startsWith(k));
}

type Emitted =
  | { kind: 'bare'; roman: string } // consonant with virama
  | { kind: 'vowel'; roman: string } // ends in this vowel (inherent, matra or independent)
  | { kind: 'other' };

export function devaToRoman(text: string): TranslitResult {
  const unmapped = new Tally();
  const chars = [...nfc(text)];
  let out = '';
  let last: Emitted = { kind: 'other' };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? '';
    let cons = R_CONS[c];
    if (cons !== undefined) {
      if (chars[i + 1] === NUKTA) {
        const withNukta = R_NUKTA[c + NUKTA];
        if (withNukta) cons = withNukta;
        else
          unmapped.add(
            c + NUKTA,
            cons,
            'nukta',
            'no romanization for this nukta letter; written without it',
          );
        i++;
      }
      if (last.kind === 'bare' && wouldMerge(last.roman, cons, FROM_R_CONS)) out += ':';
      out += cons;
      const next = chars[i + 1] ?? '';
      if (next === VIRAMA) {
        i++;
        last = { kind: 'bare', roman: cons };
      } else if (R_MATRAS[next]) {
        i++;
        out += R_MATRAS[next];
        last = { kind: 'vowel', roman: R_MATRAS[next] };
      } else {
        out += 'a';
        last = { kind: 'vowel', roman: 'a' };
      }
      continue;
    }
    const vowel = R_VOWELS[c];
    if (vowel !== undefined) {
      // A bare consonant would take it as a vowel sign; a vowel before it could merge (a + i = ai).
      if (
        last.kind === 'bare' ||
        (last.kind === 'vowel' && wouldMerge(last.roman, vowel, FROM_R_VOWELS))
      )
        out += ':';
      out += vowel;
      last = { kind: 'vowel', roman: vowel };
      continue;
    }
    const other = R_OTHER[c];
    if (other !== undefined) {
      out += other;
      last = { kind: 'other' };
      continue;
    }
    if (c === '‌' || c === '‍') continue; // ZWNJ / ZWJ only shape Devanagari
    if (isDevanagari(c)) unmapped.add(c, c, codePoint(c), 'no romanization; left as is');
    out += c;
    last = { kind: 'other' };
  }
  return { text: nfc(out), lossy: [], unmapped: unmapped.list(), warnings: [] };
}

export function romanToDeva(text: string): TranslitResult {
  const unmapped = new Tally();
  const s = nfc(text);
  const startsAt = (i: number, list: Array<[string, string]>) =>
    list.find(([r]) => s.startsWith(r, i));
  let out = '';
  let i = 0;
  while (i < s.length) {
    // ":" between two letters only separates; anywhere else it is punctuation.
    if (s[i] === ':' && isLatinLetter(s[i - 1] ?? '') && isLatinLetter(s[i + 1] ?? '')) {
      i++;
      continue;
    }
    const sign = startsAt(i, FROM_R_OTHER);
    if (sign) {
      out += sign[1];
      i += sign[0].length;
      continue;
    }
    const vowel = startsAt(i, FROM_R_VOWELS);
    if (vowel) {
      out += vowel[1];
      i += vowel[0].length;
      continue;
    }
    const cons = startsAt(i, FROM_R_CONS);
    if (cons) {
      out += cons[1];
      i += cons[0].length;
      const v = startsAt(i, FROM_R_VOWELS);
      if (v) {
        if (v[0] !== 'a') out += MATRA_FOR[v[0]] ?? '';
        i += v[0].length;
      } else {
        out += VIRAMA;
      }
      continue;
    }
    const c = String.fromCodePoint(s.codePointAt(i) ?? 0);
    if (isLatinLetter(c)) unmapped.add(c, c, codePoint(c), 'not in the romanization; left as is');
    out += c;
    i += c.length;
  }
  return { text: nfc(out), lossy: [], unmapped: unmapped.list(), warnings: [] };
}

// ---- Any spoke to any spoke, through the hub ----

const toHub: Record<Script, (t: string) => TranslitResult> = {
  deva: (t) => ({ text: nfc(t), lossy: [], unmapped: [], warnings: [] }),
  akkha: akkhaToDeva,
  roman: romanToDeva,
};
const fromHub: Record<Script, (t: string) => TranslitResult> = {
  deva: (t) => ({ text: t, lossy: [], unmapped: [], warnings: [] }),
  akkha: devaToAkkha,
  roman: devaToRoman,
};

export function transliterate(
  text: string,
  from: Script,
  to: Script,
  opts: TranslitOptions = {},
): TranslitResult {
  const a = toHub[from](text);
  const b = fromHub[to](a.text);
  const warnings = [...a.warnings, ...b.warnings];
  if (opts.variety === 'kzq' && to === 'akkha') {
    warnings.push(
      'Kaike (kzq): the table is not frozen; sounds outside the Nepali inventory may still need signs.',
    );
  }
  if (opts.variety && KHAM.has(opts.variety) && to !== 'deva') {
    warnings.push(
      `${VARIETIES[opts.variety]}: the spelling does not show the glottal stop or breathy vowels; keep audio and IPA with each entry.`,
    );
  }
  return { text: b.text, lossy: b.lossy, unmapped: [...a.unmapped, ...b.unmapped], warnings };
}

/** Report lines for people and the model: empty when nothing was lossy, unmapped or flagged. */
export function reportLines(r: TranslitResult): string[] {
  const show = (c: string) => (/\p{M}/u.test(c[0] ?? '') ? `◌${c}` : c); // ◌ for marks
  const lines: string[] = [];
  if (r.lossy.length > 0) {
    lines.push(
      `lossy (no Akkha form): ${r.lossy
        .map((e) => `${show(e.char)} ${e.name} → ${e.to ? show(e.to) : 'dropped'} ×${e.count}`)
        .join('; ')}`,
    );
  }
  if (r.unmapped.length > 0) {
    lines.push(
      `left as is (no mapping): ${r.unmapped.map((e) => `${show(e.char)} ${e.name} ×${e.count}`).join('; ')}`,
    );
  }
  for (const w of r.warnings) lines.push(`note: ${w}`);
  return lines;
}
