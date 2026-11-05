import { describe, expect, test } from 'bun:test';
import { AKKHA_BRAHMI, LOSSY, NUKTA, ROMAN_NUKTA, VIRAMA } from '../src/lang/tables.ts';
import {
  akkhaToDeva,
  devaToAkkha,
  devaToRoman,
  reportLines,
  romanToDeva,
  transliterate,
} from '../src/lang/translit.ts';
import { Runtime } from '../src/runtime.ts';
import { translitTool } from '../src/tools/translit.ts';
import { ctx, mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// ---- A seeded generator of well-formed Devanagari ----

/** mulberry32: a small seeded PRNG, so failures reproduce. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOWELS = [...'अआइईउऊऋएऐओऔ'];
const CONSONANTS = [...'कखगघङचछजझञटठडढणतथदधनपफबभमयरलवसह'];
const MATRAS = ['ा', 'ि', 'ी', 'ु', 'ू', 'ृ', 'े', 'ै', 'ो', 'ौ'];
const DIGITS = [...'०१२३४५६७८९'];
const ANUSVARA = 'ं';

interface GenOptions {
  /** Include the lossy set (श, ष, visarga, chandrabindu, nukta letters). */
  lossy?: boolean;
  digits?: boolean;
}

/** Random text: syllables, conjuncts, halanta, anusvara, dandas and spaces. */
function devanagari(next: () => number, opts: GenOptions = {}): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const consonants = opts.lossy ? [...CONSONANTS, 'श', 'ष'] : CONSONANTS;
  const consonant = () => {
    if (opts.lossy && next() < 0.1) return `${pick(['ड', 'ढ', 'ज', 'फ'])}${NUKTA}`;
    return pick(consonants);
  };
  const signs = opts.lossy ? [ANUSVARA, 'ँ', 'ः'] : [ANUSVARA];
  let out = '';
  const n = 1 + Math.floor(next() * 8);
  for (let s = 0; s < n; s++) {
    const r = next();
    if (r < 0.15) out += pick(VOWELS);
    else if (r < 0.2) out += ' ';
    else if (r < 0.23) out += pick(['।', '॥']);
    else if (r < 0.27 && opts.digits) out += pick(DIGITS);
    else {
      out += consonant();
      while (next() < 0.25) out += VIRAMA + consonant(); // a conjunct
      const end = next();
      if (end < 0.5) out += pick(MATRAS);
      else if (end < 0.6) out += VIRAMA; // halanta
    }
    if (!out.endsWith(VIRAMA) && /[ऀ-ॿ]$/u.test(out) && next() < 0.1) out += pick(signs);
  }
  return out.normalize('NFC');
}

const CASES = 3000;

describe('akkha: tables', () => {
  test('every Akkha-Brahmi value is a distinct Brahmi code point; no lossy letter has one', () => {
    const values = Object.values(AKKHA_BRAHMI);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v.codePointAt(0)).toBeWithin(0x11000, 0x11080);
    for (const k of Object.keys(LOSSY)) expect(AKKHA_BRAHMI[k]).toBeUndefined();
  });

  test('known words', () => {
    expect(devaToAkkha('आमा').text).toBe('\u{11006}\u{1102B}\u{11038}');
    expect(devaToAkkha('नमस्ते').text).toBe('𑀦𑀫𑀲𑁆𑀢𑁂');
    expect(devaToAkkha('२०८२ ।').text).toBe('𑁨𑁦𑁮𑁨 𑁇');
    expect(devaToRoman('आमा').text).toBe('āmā');
    expect(devaToRoman('नमस्ते').text).toBe('namaste'); // the inherent a is always written
    expect(devaToRoman('मगर ढुट').text).toBe('magara ḍhuṭa');
    expect(devaToRoman('ऋषि कृषि').text).toBe('r̥ṣi kr̥ṣi');
    expect(devaToRoman('पढ़ाइ').text).toBe('paṛhāi');
  });

  test('":" keeps romanization reversible where letters would merge', () => {
    expect(devaToRoman('क्ह').text).toBe('k:ha'); // not ख
    expect(devaToRoman('ड़्ह').text).toBe('ṛ:ha'); // not ढ़
    expect(devaToRoman('कइ').text).toBe('ka:i'); // not कै
    expect(devaToRoman('अउ').text).toBe('a:u'); // not औ
    expect(devaToRoman('क्इ').text).toBe('k:i'); // not कि
    expect(devaToRoman('कै कौ').text).toBe('kai kau');
    expect(romanToDeva('k:ha ka:i kai').text).toBe('क्ह कइ कै');
    // A colon that is not between two letters is punctuation.
    expect(romanToDeva('samaya: 3').text).toBe('समय: 3');
  });

  test('input is NFC-normalized: a decomposed nukta letter reads the same', () => {
    expect(devaToRoman('ड़').text).toBe('ṛa'); // ड़ as one code point
    expect(devaToRoman(`ड${NUKTA}`).text).toBe('ṛa');
  });
});

describe('akkha: round trips on the Akkha-representable subset', () => {
  test(`Devanagari → Akkha → Devanagari is exact (${CASES} seeded cases)`, () => {
    const next = rng(1);
    for (let i = 0; i < CASES; i++) {
      const deva = devanagari(next, { digits: true });
      const ak = devaToAkkha(deva);
      expect(ak.lossy).toEqual([]);
      expect(ak.unmapped).toEqual([]);
      expect(/[ऀ-ॿ]/u.test(ak.text)).toBe(false); // nothing left in Devanagari
      expect(akkhaToDeva(ak.text).text).toBe(deva);
    }
  });

  test(`Devanagari → roman → Devanagari is exact, lossy-set letters included (${CASES} cases)`, () => {
    const next = rng(2);
    for (let i = 0; i < CASES; i++) {
      // Romanization is derived from the hub, so it covers श, ष, visarga, chandrabindu and the
      // common nukta letters too. Digits are left out: they romanize to ASCII digits.
      const deva = devanagari(next, { lossy: true });
      const roman = devaToRoman(deva);
      expect(roman.unmapped).toEqual([]);
      const back = romanToDeva(roman.text);
      expect(back.unmapped).toEqual([]);
      expect(back.text).toBe(deva);
    }
  });

  test('Akkha → roman goes through the hub', () => {
    const next = rng(3);
    for (let i = 0; i < 500; i++) {
      const deva = devanagari(next);
      const ak = devaToAkkha(deva).text;
      expect(transliterate(ak, 'akkha', 'roman').text).toBe(devaToRoman(deva).text);
      expect(transliterate(devaToRoman(deva).text, 'roman', 'akkha').text).toBe(ak);
    }
  });
});

describe('akkha: the lossy set is reported, never silent', () => {
  test('श, ष → स; chandrabindu → anusvara; visarga and nukta dropped; each counted', () => {
    const r = devaToAkkha('शिक्षा शान्ति दुःख चाँद पढ़ाइ');
    expect(r.text).toBe(devaToAkkha('सिक्सा सान्ति दुख चांद पढाइ').text);
    expect(r.lossy.map((e) => [e.char, e.to, e.count])).toEqual([
      ['श', 'स', 2],
      ['ष', 'स', 1],
      ['ः', '', 1],
      ['ँ', 'ं', 1],
      [NUKTA, '', 1],
    ]);
    const lines = reportLines(r);
    expect(lines[0]).toBe(
      'lossy (no Akkha form): श sha → स ×2; ष ssa → स ×1; ◌ः visarga → dropped ×1; ◌ँ chandrabindu → ◌ं ×1; ◌़ nukta → dropped ×1',
    );
    expect(lines.at(-1)).toMatch(/^note: Akkha-Brahmi is provisional/);
  });

  test(`every lossy character in any text is counted (${CASES} seeded cases)`, () => {
    const next = rng(4);
    for (let i = 0; i < CASES; i++) {
      const deva = devanagari(next, { lossy: true });
      const expected = [...deva].filter((c) => LOSSY[c]).length;
      const counted = devaToAkkha(deva).lossy.reduce((n, e) => n + e.count, 0);
      expect(counted).toBe(expected);
    }
  });

  test('characters with no mapping are left as is and reported', () => {
    const ak = devaToAkkha('ॐ मणि');
    expect(ak.text.startsWith('ॐ ')).toBe(true);
    expect(ak.unmapped).toEqual([
      { char: 'ॐ', name: 'U+0950', to: 'ॐ', count: 1, note: 'no Akkha mapping; left as is' },
    ]);
    expect(akkhaToDeva('\u{11003}').unmapped[0]?.name).toBe('U+11003'); // a Brahmi-only sign
    const ro = romanToDeva('Magar wala');
    expect(ro.unmapped.map((e) => e.char)).toEqual(['M', 'w']);
    expect(ro.text).toBe('Mअगर् wअल'); // strict: no final a means a halanta
    // Text in other scripts passes through untouched and unreported.
    expect(devaToAkkha('Akkha (अक्खा) 2026!').unmapped).toEqual([]);
  });

  test('Brahmi letters Akkha does not use still map back', () => {
    expect(akkhaToDeva('\u{11030}\u{11031}\u{11002}').text).toBe('शषः');
  });

  test('every nukta letter in the romanization table round-trips', () => {
    for (const [deva, roman] of Object.entries(ROMAN_NUKTA)) {
      expect(devaToRoman(deva).text).toBe(`${roman}a`);
      expect(romanToDeva(`${roman}a`).text).toBe(deva);
    }
  });
});

describe('akkha: varieties and the tool', () => {
  test('Kaike and Kham carry their caveats', () => {
    expect(transliterate('मगर', 'deva', 'akkha', { variety: 'kzq' }).warnings.join(' ')).toMatch(
      /Kaike \(kzq\): the table is not frozen/,
    );
    expect(transliterate('मगर', 'deva', 'roman', { variety: 'kgj' }).warnings[0]).toMatch(
      /^Kham: Gamal: the spelling does not show the glottal stop/,
    );
    expect(transliterate('मगर', 'deva', 'roman', { variety: 'mgp' }).warnings).toEqual([]);
  });

  test('the tool converts and appends the report; it is read-only and local', async () => {
    expect(translitTool.readOnly).toBe(true);
    expect(translitTool.remote).toBeUndefined();
    const out = await translitTool.execute({ text: 'शान्ति', to: 'akkha' }, ctx('/tmp'));
    expect(out.split('\n')[0]).toBe(devaToAkkha('सान्ति').text);
    expect(out).toContain('lossy (no Akkha form): श sha → स ×1');
    expect(
      await translitTool.execute({ text: 'āmā', from: 'roman', to: 'deva' }, ctx('/tmp')),
    ).toBe('आमा');
    await expect(translitTool.execute({ text: 'x', to: 'deva' }, ctx('/tmp'))).rejects.toThrow(
      /both "deva"/,
    );
    expect(translitTool.summarize({ text: 'आमा', to: 'roman' })).toBe(
      'translit deva → roman "आमा"',
    );
  });

  test('the model calls it without a permission prompt, also offline', async () => {
    const home = tempDir('mrig-home-');
    const prev = process.env.MRIG_HOME;
    process.env.MRIG_HOME = home.dir;
    try {
      const asked: string[] = [];
      const rt = new Runtime({
        cwd: home.dir,
        provider: 'ollama',
        offline: true,
        languageModel: mockModel([
          toolTurn('translit', '{"text":"आमा","to":"akkha","variety":"mgp"}'),
          textTurn('done'),
        ]),
        ask: async (r) => {
          asked.push(r.summary);
          return 'no';
        },
        events: { onText: () => {} },
      });
      await rt.agent.run('write आमा in Akkha');
      expect(asked).toEqual([]);
      const result = rt.agent.messages
        .filter((m) => m.role === 'tool')
        .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
        .map((p) => (p.type === 'tool-result' && p.output.type === 'text' ? p.output.value : ''));
      expect(result[0]?.split('\n')[0]).toBe('\u{11006}\u{1102B}\u{11038}');
      await rt.close();
    } finally {
      home.cleanup();
      if (prev === undefined) delete process.env.MRIG_HOME;
      else process.env.MRIG_HOME = prev;
    }
  });
});

test('akkha: two single dandas and a double danda stay different in romanization', () => {
  expect(devaToRoman('।। ॥').text).toBe('|| ‖');
  expect(romanToDeva('|| ‖').text).toBe('।। ॥');
});
