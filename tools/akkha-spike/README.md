# A1 font spike kit

The A1 spike answers one question: does the GurbachhanAkkhaRik font render Akkha from the Unicode
Brahmi block (U+11000–1107F) in HarfBuzz, Safari (CoreText), Chrome (HarfBuzz) and Word on
Windows (DirectWrite)? If yes, mrig's Akkha-Brahmi table stops being provisional. If one engine
fails, document it and decide; don't fall back to PUA automatically. The plan is in
[the encoding decision](../../docs/decisions/2026-09-23-akkha-encoding.md), under "Font spike".
Allow about a day.

| File | What it is |
| --- | --- |
| `brahmi_spike.py` | Makes a test copy of the font that answers to Brahmi. It never changes the original. |
| `words.txt` | The 22 test words in Akkha-Brahmi, one per line. |
| `akkha-spike-test.html` | The same words as Akkha, Devanagari and romanization, for checking in each browser. |
| `test_spike.py` | The kit's self-test, on a stand-in font. |

The Brahmi table in `brahmi_spike.py` and every test word come from mrig's
`src/lang/tables.ts` and the `translit` tool. `tests/akkha_spike.test.ts` fails if they drift,
so change the mapping in `tables.ts` first, then here.

## What `brahmi_spike.py` does

1. **cmap:** each glyph listed in `mapping.csv` also answers to its Brahmi code point. Brahmi is
   above U+FFFF, so it adds format 12 subtables. The font's current characters keep working.
2. **Script tag:** it registers the existing GSUB and GPOS lookups (the first script other than
   `DFLT`, or the one named with `--from-script=`) under `brah` as well, so shapers apply them to
   Brahmi text.
3. **Name:** the family becomes "<family> Brahmi Test", so it installs next to the original.

It refuses a Devanagari letter Akkha doesn't map, a character or glyph the font lacks, a letter
mapped to two glyphs, and an output path that is the input. It lists the Akkha letters still unmapped.

## Steps

### 1. Set up a folder and the tools

```bash
mkdir -p ~/akkha-spike && cd ~/akkha-spike
```

Copy this folder's files and the built font (`.ttf` or `.otf`) into it, and name the font
`Akkha.ttf`. Then:

```bash
brew install harfbuzz
```
```bash
python3 -m pip install fonttools
```

### 2. See how the font maps letters today

```bash
fonttools ttx -t cmap -o - Akkha.ttf | grep "<map" | head -40
```

Lines like `<map code="0x6b" name="ka"/>` show the character (here `k`) each glyph uses now.
Then see which scripts its rules are registered under:

```bash
fonttools ttx -t GSUB -o - Akkha.ttf | grep ScriptTag
```

### 3. Write `mapping.csv`

One line per glyph: the character the font uses for it now, and the Devanagari letter it is
(use the chart). For a glyph with no character of its own, leave `old` empty and give its name
in `glyph`.

```
old,glyph,deva
k,,क
A,,ा
x,,्
```

Include every vowel, consonant, vowel sign, the virama (्), anusvara (ं), the digits and the
dandas. Leave out श, ष, visarga, chandrabindu and nukta: they have no Akkha form.

### 4. Make the test font

```bash
python3 brahmi_spike.py Akkha.ttf mapping.csv AkkhaBrahmiTest.ttf
```

Fill in any letters it reports as unmapped and run it again. If the rules sit under an
unexpected script, add `--from-script=<tag>` with the tag from step 2.

### 5. Shape the words with HarfBuzz

```bash
while read -r w; do echo "$w"; hb-shape --script=brah AkkhaBrahmiTest.ttf "$w"; done < words.txt
```

Look for a subjoined glyph where य, व or ह follow a virama, and for dotted circles (`uni25CC`
or `dottedcircle`), which mean the shaper sees a broken cluster. To see a word:

```bash
hb-view --script=brah AkkhaBrahmiTest.ttf "$(sed -n 1p words.txt)" -o word1.png
```

### 6. Safari and Chrome

1. Double-click `AkkhaBrahmiTest.ttf` and choose **Install**.
2. Open the page in both browsers:
   ```bash
   open -a Safari akkha-spike-test.html
   ```
   ```bash
   open -a "Google Chrome" akkha-spike-test.html
   ```
3. Type the family name exactly as Font Book shows it into the box at the top.
4. Compare each row with the chart PDF: subjoined य, व, ह; vowel signs above the cluster; u/ū
   under the subjoined letter; the e/ai marks and the padL bases.

### 7. Word on Windows

Copy `AkkhaBrahmiTest.ttf` and `words.txt` to the PC, install the font, paste the words into
Word, set the font to "… Brahmi Test" at a large size, and compare with the chart. (Word on a
Mac uses CoreText, the same engine as Safari.)

### 8. Record the result

For each word, note pass or fail in HarfBuzz, Safari, Chrome and Word, with a screenshot of
each failure.

## What the result means

- **Pass everywhere:** the Brahmi encoding stands. Mark A1 ✅ in `docs/ROADMAP.md` and drop the
  "provisional" note in `src/lang/tables.ts`. Publishing still waits for BAMA's sign-off.
- **Fails in one engine:** write down which, and decide, as the decision note says.
- **Subjoined letters don't form, or dotted circles appear:** the rules were probably written
  for the font's old keyboard sequences, not virama + letter. Shapers apply Brahmi rules in
  fixed stages, so some lookups may need moving to the features meant for subjoined letters and
  marks. That is font work, done in the font repo.

## The self-test

```bash
python3 -m pip install fonttools uharfbuzz
```
```bash
python3 test_spike.py
```

It builds a stand-in font with the old keyboard layout (k = KA, y = YA, A = the AA sign, x =
virama, and a `liga` rule for virama + YA), re-encodes it, and checks that Brahmi क्या shapes to
KA + subjoined YA + AA sign, that the old text still shapes, and that bad mappings are refused.
It writes only to a temp folder. It proves the script's mechanics, not the real font's rules.
