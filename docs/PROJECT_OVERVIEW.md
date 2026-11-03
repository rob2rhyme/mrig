# Project overview: what we end up with

Date: October 14, 2026 (decisions updated November 2; priority set November 3). This is a one-page summary of the end state. The details are in the other project docs.

## Priority (Nov 3)

1. **Local AI first:** mrig as a dependable, fully offline agent on the M4 Pro (Local AI v1.0).
2. **Akkha second, as part of it:** font, transliteration, dataset and app work built on mrig.

The ordered backlog is in `docs/ROADMAP.md`.

## The end products

| # | Product | What it is | Status |
|---|---|---|---|
| 1 | **mrig (track 1, primary)** | Robin's own terminal AI agent: any model, works offline with local models on the M4 Pro (24 GB). The workbench for the language, font and data work: caching, language memory, transliteration, corpus search, evaluation harness, compaction | v0.1 shipped; backlog in `docs/HANDOFF.md` |
| 2 | **Akkha in real Unicode (track 2)** | The GurbachhanAkkhaRik font, owned by Robin Thapa, re-encoded to the Unicode Brahmi block. Akkha text can then be copied, searched, typed and read by screen readers on Windows, Mac and Android. Also: the keyboard layout, a Devanagari ↔ Akkha ↔ romanization transliteration tool, shaping tests, and a 2-character punctuation proposal | Decided; the font spike is next (`docs/decisions/2026-09-23-akkha-encoding.md`). The repertoire is stable: Kham needs no extra letters |
| 3 | **Akkha-Rik app (one PWA, on Vercel)** | **Learn mode:** script lessons, vocabulary (Nepali + Magar), real-speaker audio, a paid certificate, and accounts from age 8. **Contribute mode (18+):** daily questions, per-variety voting, voice answers, cultural objects | Learn mode exists; Contribute mode is planned (`docs/related/magar-knowledge-platform.md`) |
| 4 | **Magar language & culture dataset** | A verified lexicon for Magar Dhut, Kham (4 varieties) and Kaike (Devanagari, IPA, Akkha, glosses); parallel sentences; pronunciation audio; a cultural objects catalogue with photos, notes and TK labels. Versioned CLDF releases under **CC BY 4.0**, an audit trail, cloud → NAS → off-site storage | Planned; it starts with the pilot (free on BAMA's Kobo Community plan) |
| 5 | **AI tools** | (a) A Magar assistant and tutor that **looks up** verified data, on Claude now and local models offline. (b) A fine-tuned translation model (NLLB) once there are ≥2k sentences per variety. (c) Pronunciation feedback (speech recognition) once there are 1–2 h of audio per variety | Phase C onward (`docs/AI_FEASIBILITY.md`) |
| 6 | **Data access / API** | Open data (CC BY 4.0). Any paid API is a **service** (hosting, convenience), not a sale of the data | Licence decided Nov 2: open for now |
| 7 | **Governance & documents** | Consent, privacy, terms, the community agreement with **BAMA**, the handover dossier, licences | Drafted; waiting on BAMA's review and a signed agreement |

## Realistic expectations

- **No Magar LLM trained from scratch.** The AI is an existing model reading your verified data, plus small models you fine-tune.
- **Translation quality:** a drafting aid (about chrF 30–45 in comparable studies), not fluent.
- **Kaike** (~50 speakers) stays dictionary-level unless there's direct documentation work.
- **API revenue is likely small,** and with open data others can offer the same service. Grants and partnerships matter more.
- **The lasting value is the verified dataset and real-Unicode Akkha.** Both outlive any one app or model.

## Decisions (updated Nov 2)

| # | Decision | Answer |
|---|---|---|
| 1 | Licence | **Open, CC BY 4.0, for now.** Any API is a service. Releases stay open for good |
| 2 | Community partner | **Bhutanese American Magar Association (BAMA)**, a 501(c)(3) in Harrisburg, PA. Add Nepal-based advisory seats for Kham and Kaike |
| 3 | App vocabulary | **Both Nepali and Magar.** Tag every item with its language |
| 4 | Rights | **Robin Thapa** owns the book content and the GurbachhanAkkhaRik font |
| 5 | Hosting / ages | **Vercel**; learner accounts from **age 8** (family-account design needed) |
| 6 | Kham letters | **None needed.** The repertoire is stable |

## Still open

- A signed BAMA agreement, including Robin's font and content licence to BAMA (its site has a members-only "Akkha-Rik Project" page).
- A licence for the font (SIL OFL recommended).
- The design for under-13 accounts: family accounts, or accounts at 13+ with lessons open to everyone.
- The Vercel plan: Hobby → Pro before billing.
- EU/UK representatives.
