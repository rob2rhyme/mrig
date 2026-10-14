# Language and script strategy

mrig is used for work on **Akkha**, a Brahmi-derived abugida, across three language varieties. This file is the short, current rule set. The reasoning and sources are in [`docs/decisions/2026-09-23-akkha-encoding.md`](decisions/2026-09-23-akkha-encoding.md); if the two ever disagree, the decision file wins.

> **Superseded (September 23, 2026):** the earlier strategy, where romanization was canonical, the Private Use Area was the rendering target and there was a flat roman↔PUA table, is retired. Don't reintroduce it. See [`docs/decisions/2026-09-23-akkha-encoding.md`](decisions/2026-09-23-akkha-encoding.md).

## Canonical text

- Canonical text is **Devanagari, NFC-normalized**. Store, diff and search this form.
- Romanization (ISO 15919-style) is **derived** from it mechanically. It is never the source of truth.

## Display encoding

- Akkha displays from the **Unicode Brahmi block (U+11000–1107F)**, using a font with Akkha-style glyphs.
- This is **not** the Private Use Area. Supplementary PUA-A is a fallback only, and only if the Brahmi font spike fails. The spike runs in the font repo, not mrig.
- The ASCII-slot encoding is **retired**. No text exists in it, so there's no legacy converter.
- The Brahmi encoding needs community sign-off before anything is published.

## Transliteration

- Hub and spokes, with **Devanagari (NFC) as the hub**. The spokes are:
  - Akkha-Brahmi
  - ISO 15919-style romanization
  - PUA, only if the fallback is triggered
- The mapping is a table-driven character map from the hub to each spoke. The data has no reordering; the font handles visual order.
- Transliteration is pure functions with no model involvement.

## Round-trip tests and the lossy set

- Round-trip property tests run on the **Akkha-representable subset** only.
- Devanagari characters with no Akkha form are an **explicit lossy set**: श, ष, visarga, chandrabindu and nukta. The tool reports them and never maps them silently. The proposed default श/ष → स still needs RT's confirmation.

## Varieties

Tag every text, lexicon entry and eval item with its variety, and never pool varieties silently. These are separate languages, so each one gets its own eval set.

| Variety | ISO 639-3 |
|---|---|
| Magar Dhut (Eastern / Western Magar) | `mgp`, `mrd` |
| Kham (Gamal, Sheshi, Eastern Parbate, Western Parbate) | `kgj`, `kip`, `kif`, `kjl` |
| Kaike | `kzq` |

## Open questions

- **Kham glottal stop and breathy vowels:** how are they written today, in Devanagari and in Akkha, and does Akkha need extra signs for them? The same question applies to any Kaike sounds outside the Nepali inventory. Settle this before the transliteration table is frozen.
- **Monastic punctuation:** do existing characters fit, or does it need a 2-character proposal?
- **Community sign-off** on the Brahmi encoding.
