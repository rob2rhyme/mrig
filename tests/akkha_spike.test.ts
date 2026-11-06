import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AKKHA_BRAHMI } from '../src/lang/tables.ts';
import { devaToAkkha, devaToRoman } from '../src/lang/translit.ts';

// The A1 spike kit (tools/akkha-spike/) carries its own copy of the Brahmi table and test words.
// These checks keep it in step with mrig's tables, so the font is tested against what translit emits.
const KIT = join(import.meta.dir, '..', 'tools', 'akkha-spike');
const read = (name: string) => readFileSync(join(KIT, name), 'utf-8');

describe('A1 spike kit', () => {
  test("brahmi_spike.py's table is exactly AKKHA_BRAHMI", () => {
    const body = read('brahmi_spike.py').match(/DEVA_TO_BRAHMI = \{\n([\s\S]*?)\n\}/)?.[1] ?? '';
    const table = Object.fromEntries(
      [...body.matchAll(/^ {4}"(.+)": 0x([0-9A-F]+),$/gm)].map((m) => [
        m[1],
        String.fromCodePoint(Number.parseInt(m[2] ?? '', 16)),
      ]),
    );
    expect(body.split('\n')).toHaveLength(Object.keys(AKKHA_BRAHMI).length);
    expect(table).toEqual({ ...AKKHA_BRAHMI });
  });

  test('the page rows and words.txt come from translit', () => {
    const rows = [
      ...read('akkha-spike-test.html').matchAll(
        /<tr><td class="akkha">(.+?)<\/td><td>(.+?)<\/td><td>(.+?)<\/td><\/tr>/g,
      ),
    ];
    expect(rows).toHaveLength(22);
    for (const [, akkha, deva = '', roman] of rows) {
      expect(devaToAkkha(deva)).toMatchObject({ text: akkha, lossy: [], unmapped: [] });
      expect(devaToRoman(deva).text).toBe(roman ?? '');
    }
    expect(read('words.txt').trim().split('\n')).toEqual(rows.map((r) => r[1] ?? ''));
  });
});
