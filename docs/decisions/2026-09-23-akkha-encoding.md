# Akkha encoding and canonical-text decision

Date: September 23, 2026. Status: **decided by RT (rev 4)**, pending community sign-off on the Brahmi encoding before anything is published.

Labels: **[V]** verified against a primary source · **[S]** secondary · **[I]** inference or recommendation.

## Decisions

1. **Canonical text is Devanagari, NFC-normalized.** Romanization (ISO 15919-style) is derived mechanically when needed.
2. **Display encoding is the Unicode Brahmi block (U+11000–1107F)**, with Akkha-style glyphs. RT confirms Akkha derives from Brahmi's characters.
   - This matches Pandey's reading in 2011's L2/11-144 [V].
   - It also matches the existing Magar Akkha web keyboard, which uses Noto Sans Brahmi [V].
   - The Supplementary PUA-A range stays as a fallback only if the Brahmi font spike fails.
3. **Retire the ASCII-slot encoding now.** No text exists in it (RT), so migration costs nothing today and more with every document typed. No legacy converter is needed.
4. **The monastic punctuation (÷-like comma, ‖÷‖ full stop) needs its own characters. It is not restricted.**
   - First check whether existing characters already fit. Candidates: Brahmi punctuation U+11047–1104D, and General or Supplemental Punctuation. Unicode prefers reusing an existing character when its identity matches [I].
   - If none fits: use Supplementary PUA-A codepoints inside the Brahmi-encoded font as an interim measure, and prepare a **small proposal for two new characters**. The Brahmi block has 13 reserved code points [V].
   - Adding two characters to an encoded block is a far lighter process than a whole-script proposal. SEI (sei.berkeley.edu) gives proposal guidance [V/I].
5. **The dictionary is not restricted but is parked.** Nothing in the current plan is closed-zone material, so the open zone (API models allowed) covers all present work.

## Varieties

RT's plan is one script, Akkha, for three varieties. "Dhut" means "language".

**Variety tags for all data** [V, SIL ISO 639-3 registry / Wikipedia]:

| Variety | ISO 639-3 code(s) |
|---|---|
| Magar Dhut: Eastern Magar | `mgp` |
| Magar Dhut: Western Magar | `mrd` |
| Kham: Gamal | `kgj` |
| Kham: Sheshi | `kip` |
| Kham: Eastern Parbate | `kif` |
| Kham: Western Parbate | `kjl` |
| Kaike | `kzq` |

- The four Kham varieties are described as mutually unintelligible [S].
- Kaike had about 50 native speakers in the 2011 census [S]. It is critically endangered, so treat every Kaike recording or text as precious and consent-bound.

**Repertoire gap, now concrete** [S]: Kham has a **glottal stop** and **breathy-voiced vowels**, and Gamal Kham has ~29–30 consonant phonemes. Nepali Devanagari has no dedicated letters for these, and neither does the current Akkha chart. Before the translation table is frozen, find out:

- how Kham (and Kaike) speakers write these sounds in Devanagari today (a diacritic, visarga, apostrophe, or not at all?), and
- whether Akkha needs extra signs for them.

If Akkha needs extra signs, they are extra codepoints: existing Brahmi or Devanagari characters if any fit, otherwise more proposal characters.

**Previous notes on varieties:**

- **Linguistic flag.** Linguists classify these as separate languages, not dialects of one language.
  - Kaike (ISO 639-3 `kzq`) is Tamangic rather than Magaric [S, Wikipedia].
  - Kham is a separate Magaric language [S].
  - This doesn't affect the script, but it does affect the data:
    - Tag every text, lexicon entry and eval item with its variety.
    - Never pool them silently.
    - Build a separate eval set per variety [I].
- **Repertoire risk.** If Kaike or Kham have sounds that Nepali Devanagari lacks, the script needs extra letters or marks. Tone in Kaike is possible given its Tamangic affiliation [I].
  - Needing extra letters means Devanagari as the hub needs extra characters too.
  - A still-growing repertoire is also exactly what SEWG treats as "not stable" [V for the criterion].
  - Settle this before freezing the translation table.
- **Nepali-only letters.** Devanagari characters with no Akkha form (श, ष, visarga, chandrabindu, nukta) form an explicit lossy set in the transliteration tool. The default for श/ष is → स, **confirmed by RT on November 5, 2026**. The other three defaults (chandrabindu → anusvara, visarga and nukta dropped) await RT's confirmation.

## Font spike (the gate for decision 2)

This takes about one day and happens in the font repo, not mrig [I].

1. Build a test cmap mapping the Akkha glyphs to Brahmi codepoints.
2. Register the existing lookups under the `brah` script tag.
3. Check how USE's feature phases handle `<C, virama, C>` for subjoined य, व, ह. Upper vowels should attach to the cluster, and u/ū to the subjoined consonant.
4. Check that the left-extending e/ai marks and the padL bases still work.
5. Shape 10–20 test words with `hb-shape`, then check them in Safari (CoreText), Word (DirectWrite) and Chrome (HarfBuzz).

**Pass:** every engine matches the reference images in the chart PDF. **Fail on one engine:** document it and decide; don't fall back to PUA automatically.

## Transliteration tool (mrig backlog)

- **Hub:** Devanagari (NFC).
- **Spokes:** Akkha-Brahmi and ISO 15919-style romanization. Add a PUA spoke only if the fallback is triggered.
- **Mapping:** a table-driven character map. There is no reordering in the data.
- **Tests:** round-trip property tests on the Akkha-representable subset, plus an explicit lossy-set report.

## Still open

- Kaike and Kham sounds outside the Nepali inventory: are extra letters needed?
- ~~Does "Akkha" as a variety name mean Magar Dhut?~~ Yes: Magar Dhut = Eastern (`mgp`) + Western (`mrd`) Magar.
- ~~How are the Kham glottal stop and breathy vowels written today, in Devanagari and in Akkha?~~ **Resolved Nov 2:** Robin says Kham needs no extra Akkha letters, so the repertoire is stable. Record pronunciation with audio and IPA, because the spelling won't show these sounds.
- The community's sign-off on Brahmi encoding before public release.
