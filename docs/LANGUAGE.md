# Language and script strategy

mrig is used for work on **Akkha**, a Brahmi-derived abugida, across three language varieties. This file is the short, current rule set. The reasoning and sources are in [`docs/decisions/2026-09-23-akkha-encoding.md`](decisions/2026-09-23-akkha-encoding.md). If the two ever disagree, the decision file wins.

This is **track 2** work. It starts after Local AI v1.0; see [`docs/ROADMAP.md`](ROADMAP.md).

> **Superseded (September 23, 2026):** the earlier strategy is retired. It had romanization as canonical, the Private Use Area as the rendering target, and a flat roman↔PUA table. Don't reintroduce it. See [`docs/decisions/2026-09-23-akkha-encoding.md`](decisions/2026-09-23-akkha-encoding.md).

## Canonical text

- Canonical text is **Devanagari, NFC-normalized**. Store, diff and search this form.
- Romanization (ISO 15919-style) is **derived** from it mechanically. It is never the source of truth.

## Display encoding

- Akkha is displayed from the **Unicode Brahmi block (U+11000–1107F)**, using the GurbachhanAkkhaRik font (owned by Robin Thapa) re-encoded with Akkha-style glyphs.
- This is **not** the Private Use Area. Supplementary PUA-A is a fallback only, used only if the Brahmi font spike fails. The spike runs in the font repo, not mrig.
- The ASCII-slot encoding is **retired**.
  - No documents exist in it, so there's no legacy converter for documents.
  - The Akkha-Rik app's `ak` field (e.g. `a+A+m+A`) still uses it as data. That field will be **generated from `deva`** by the transliteration tool ([`docs/related/akkha-rik-integration.md`](related/akkha-rik-integration.md) §5.4).
- The Brahmi encoding needs community sign-off before anything is published. The community partner is the Bhutanese American Magar Association (BAMA), with Nepal-based advisory seats for Kham and Kaike.

## Transliteration

- Hub and spokes, with **Devanagari (NFC) as the hub**. The spokes are:
  - Akkha-Brahmi
  - ISO 15919-style romanization
  - PUA, only if the fallback is triggered
- The mapping is a table-driven character map from the hub to each spoke. The data has no reordering; the font handles visual order.
- Transliteration is pure functions with no model involvement.

## Round-trip tests and the lossy set

- Round-trip property tests run on the **Akkha-representable subset** only.
- Devanagari characters with no Akkha form are an **explicit lossy set**: श, ष, visarga, chandrabindu and nukta. The tool reports them and never maps them silently. The proposed default श/ष → स still needs Robin's confirmation.

## Varieties

Tag every text, lexicon entry and eval item with its variety, and never pool varieties silently. These are separate languages, so each one gets its own eval set.

| Variety | ISO 639-3 |
|---|---|
| Magar Dhut (Eastern / Western Magar) | `mgp`, `mrd` |
| Kham (Gamal, Sheshi, Eastern Parbate, Western Parbate) | `kgj`, `kip`, `kif`, `kjl` |
| Kaike | `kzq` |

## Resolved

- **Kham (November 2, 2026):** no extra Akkha letters are needed, so the Kham repertoire is stable.
  - Kham's glottal stop and breathy vowels don't show in the spelling.
  - So every Kham entry carries **audio and IPA**, or that pronunciation is lost.

## Open questions

- **Kaike:** are there sounds outside the Nepali inventory that need signs? Settle this before the transliteration table is frozen for Kaike.
- **Monastic punctuation:** do existing characters fit, or does it need a 2-character proposal?
- **Community sign-off** on the Brahmi encoding (BAMA, plus the Nepal advisory seats).
