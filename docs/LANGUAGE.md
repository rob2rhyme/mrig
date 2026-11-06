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
- Devanagari characters with no Akkha form are an **explicit lossy set**: श, ष, visarga, chandrabindu and nukta. The tool reports them and never maps them silently.
  - श/ष → स: **confirmed by Robin, November 5, 2026.**
  - Chandrabindu → anusvara, visarga dropped, nukta dropped (base letter kept): **confirmed by Robin, November 6, 2026.**
- Everything else in Nepali Devanagari has an Akkha form (Robin, November 5, 2026), mapped one to one onto the Brahmi block. The Brahmi table stays provisional until the font spike passes.

## Language memory files (`lang/*.md`)

Notes that mrig puts into the model's system prompt, one variety per file.

- **Where:** `~/.mrig/lang/` for notes that apply everywhere, and `.mrig/lang/` in a project.
  Project folders from the git root down to the working directory are all read, nearest last.
- **Names:** `<tag>.md` or `<tag>-<topic>.md`. The tag is a variety (`mgp`, `mrd`, `kgj`, `kip`,
  `kif`, `kjl`, `kzq`) or `shared` for rules that hold for every variety, e.g. `mgp-lexicon.md`,
  `kgj-grammar.md`, `shared-orthography.md`. Other names are not loaded, and `/lang` says why.
- **Content:** Devanagari in NFC (mrig normalizes and flags files that are not); romanization
  and Akkha produced with `translit`, never typed by hand; IPA for Kham entries, whose spelling
  omits the glottal stop and breathy vowels. Keep one variety per file: the prompt labels each
  file with its variety, and pooling them would mix separate languages.
- **Budget:** 32,000 characters in total (about 8,000 tokens). A file that would pass it is not
  loaded at all rather than cut, and `/lang` lists it.
- **Caching:** the files are read once when the session starts. Edits take effect on
  `/lang reload` (or the next session), so the cached prompt prefix doesn't change from turn to
  turn.
- **Privacy:** the files go to whichever model is active. Keep consent-bound material, such as
  Kaike recordings and their transcripts, out of them, or work in an offline zone (`.mrig-zone`).

## Romanization conventions

The tool's romanization is strict ISO 15919-style, so it converts back to Devanagari exactly:

- The inherent a is always written (no schwa deletion): मगर → magara.
- ए, ओ are e, o (Nepali has no short e/o to contrast with).
- `:` separates letters that would otherwise read as one: क्ह → k:ha (ख is kh), कइ → ka:i (कै is kai).
- Dandas are `|` and `‖`; Devanagari digits become ASCII digits.

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
