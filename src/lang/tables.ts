/**
 * Character tables for Akkha transliteration (Track 2, A2). Rules: docs/LANGUAGE.md; decision:
 * docs/decisions/2026-09-23-akkha-encoding.md.
 *
 * The hub is Devanagari (NFC). Each spoke is a table from hub characters; there is no reordering
 * in the data: Devanagari and Brahmi are both stored in logical order, and the font handles
 * visual order.
 *
 * PROVISIONAL: the Akkha-Brahmi table follows the Unicode Brahmi block (U+11000–1107F), the
 * decided display encoding. It stays provisional until the font spike (A1) passes and the
 * community (BAMA, with the Nepal advisory seats) signs off. If the spike fails, a private-use
 * table replaces AKKHA_BRAHMI; the hub, the lossy set and the romanization stay as they are.
 */

/** Devanagari → Akkha-Brahmi, one code point to one. Akkha has a form for all of these. */
export const AKKHA_BRAHMI: Readonly<Record<string, string>> = {
  // Independent vowels
  अ: '\u{11005}',
  आ: '\u{11006}',
  इ: '\u{11007}',
  ई: '\u{11008}',
  उ: '\u{11009}',
  ऊ: '\u{1100A}',
  ऋ: '\u{1100B}',
  ए: '\u{1100F}',
  ऐ: '\u{11010}',
  ओ: '\u{11011}',
  औ: '\u{11012}',
  // Consonants (श and ष are in the lossy set, not here)
  क: '\u{11013}',
  ख: '\u{11014}',
  ग: '\u{11015}',
  घ: '\u{11016}',
  ङ: '\u{11017}',
  च: '\u{11018}',
  छ: '\u{11019}',
  ज: '\u{1101A}',
  झ: '\u{1101B}',
  ञ: '\u{1101C}',
  ट: '\u{1101D}',
  ठ: '\u{1101E}',
  ड: '\u{1101F}',
  ढ: '\u{11020}',
  ण: '\u{11021}',
  त: '\u{11022}',
  थ: '\u{11023}',
  द: '\u{11024}',
  ध: '\u{11025}',
  न: '\u{11026}',
  प: '\u{11027}',
  फ: '\u{11028}',
  ब: '\u{11029}',
  भ: '\u{1102A}',
  म: '\u{1102B}',
  य: '\u{1102C}',
  र: '\u{1102D}',
  ल: '\u{1102E}',
  व: '\u{1102F}',
  स: '\u{11032}',
  ह: '\u{11033}',
  // Vowel signs (matras)
  'ा': '\u{11038}', // ा
  'ि': '\u{1103A}', // ि
  'ी': '\u{1103B}', // ी
  'ु': '\u{1103C}', // ु
  'ू': '\u{1103D}', // ू
  'ृ': '\u{1103E}', // ृ
  'े': '\u{11042}', // े
  'ै': '\u{11043}', // ै
  'ो': '\u{11044}', // ो
  'ौ': '\u{11045}', // ौ
  // Signs
  'ं': '\u{11001}', // anusvara ं
  '्': '\u{11046}', // virama ्
  // Punctuation
  '।': '\u{11047}',
  '॥': '\u{11048}',
  // Digits
  '०': '\u{11066}',
  '१': '\u{11067}',
  '२': '\u{11068}',
  '३': '\u{11069}',
  '४': '\u{1106A}',
  '५': '\u{1106B}',
  '६': '\u{1106C}',
  '७': '\u{1106D}',
  '८': '\u{1106E}',
  '९': '\u{1106F}',
};

export interface LossyRule {
  /** What the hub character becomes in Akkha: a substitute, or '' when it is dropped. */
  to: string;
  name: string;
  /** Why, for the report. */
  note: string;
}

/**
 * Devanagari with no Akkha form: the explicit lossy set. Converting to Akkha applies these and
 * reports every one; nothing here is ever mapped silently.
 *
 * - श, ष → स: confirmed by Robin, November 5, 2026.
 * - Chandrabindu → anusvara, visarga dropped, nukta dropped: proposed defaults, pending
 *   Robin's confirmation. Change them here; nothing else depends on the choice.
 */
export const LOSSY: Readonly<Record<string, LossyRule>> = {
  श: { to: 'स', name: 'sha', note: 'no Akkha letter; written स' },
  ष: { to: 'स', name: 'ssa', note: 'no Akkha letter; written स' },
  'ँ': { to: 'ं', name: 'chandrabindu', note: 'no Akkha sign; written as anusvara' },
  'ः': { to: '', name: 'visarga', note: 'no Akkha sign; dropped' },
  '़': { to: '', name: 'nukta', note: 'no Akkha sign; the base letter is kept' },
};

/** Devanagari consonants → ISO 15919 (without the inherent vowel). */
export const ROMAN_CONSONANTS: Readonly<Record<string, string>> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'ṅ',
  च: 'c',
  छ: 'ch',
  ज: 'j',
  झ: 'jh',
  ञ: 'ñ',
  ट: 'ṭ',
  ठ: 'ṭh',
  ड: 'ḍ',
  ढ: 'ḍh',
  ण: 'ṇ',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ल: 'l',
  व: 'v',
  श: 'ś',
  ष: 'ṣ',
  स: 's',
  ह: 'h',
};

/** Consonant + nukta (NFC keeps them as two code points) → ISO 15919. */
export const ROMAN_NUKTA: Readonly<Record<string, string>> = {
  ड़: 'ṛ',
  ढ़: 'ṛh',
  ज़: 'z',
  फ़: 'f',
};

/** Independent vowels → ISO 15919. Nepali has no short e/o, so ए, ओ are plain e, o. */
export const ROMAN_VOWELS: Readonly<Record<string, string>> = {
  अ: 'a',
  आ: 'ā',
  इ: 'i',
  ई: 'ī',
  उ: 'u',
  ऊ: 'ū',
  ऋ: 'r̥',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
};

/** Vowel signs → ISO 15919 (the vowel that replaces the inherent a). */
export const ROMAN_MATRAS: Readonly<Record<string, string>> = {
  'ा': 'ā',
  'ि': 'i',
  'ी': 'ī',
  'ु': 'u',
  'ू': 'ū',
  'ृ': 'r̥',
  'े': 'e',
  'ै': 'ai',
  'ो': 'o',
  'ौ': 'au',
};

/**
 * Signs, punctuation and digits → romanization. Dandas become | and ‖ (not ISO's "."), so two
 * single dandas (।।) and a double danda (॥) stay different.
 */
export const ROMAN_OTHER: Readonly<Record<string, string>> = {
  'ं': 'ṁ',
  'ँ': 'm̐',
  'ः': 'ḥ',
  '।': '|',
  '॥': '‖',
  '०': '0',
  '१': '1',
  '२': '2',
  '३': '3',
  '४': '4',
  '५': '5',
  '६': '6',
  '७': '7',
  '८': '8',
  '९': '9',
};

export const VIRAMA = '्';
export const NUKTA = '़';

/** Varieties written in Akkha (docs/LANGUAGE.md). */
export const VARIETIES = {
  mgp: 'Eastern Magar (Magar Dhut)',
  mrd: 'Western Magar (Magar Dhut)',
  kgj: 'Kham: Gamal',
  kip: 'Kham: Sheshi',
  kif: 'Kham: Eastern Parbate',
  kjl: 'Kham: Western Parbate',
  kzq: 'Kaike',
} as const;

export type Variety = keyof typeof VARIETIES;
