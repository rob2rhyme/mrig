# Crowdsourced wordlist app — plan and decisions

Date: September 24, 2026. Status: **decisions recorded (Sept 24)**. Items marked ⚑ below are now resolved as listed here.

## Decisions (RT, Sept 24)

| Topic | Decision |
|---|---|
| Legal home / data controller | **RT personally for now.** If an organization takes responsibility, hand over under the documented protocol (`docs/related/wordlist-pilot-docs.md`, Part 6). Contributors agree to this at consent. |
| Minimum age | **18+.** Minors later only via facilitator mode with guardian consent. |
| Dataset licence | ~~CC BY 4.0~~ **Reopened Oct 14 ⚑.** The paid API and cultural knowledge are now in scope. Recommendation: hybrid, with an open basic dictionary and a tiered benefit-sharing licence for sentences, audio and cultural data (`docs/related/magar-knowledge-platform.md` §8). |
| Code licence | **AGPL-3.0.** My pick, since none was specified: forks that run the app publicly must share their changes. Switch to MIT if maximum reuse matters more. |
| EU/UK | **No targeted outreach at launch.** Revisit with an Art. 27 representative once the app is established. |
| Monetization | **No ads in the collection app, and the data is never sold.** |
| Hosting | **Cloudflare** (Workers/Pages + D1 + R2) for the MVP. |
| Pilot tool | See the correction below. |
| Launch size | **200 items** (as in the mockup). The pilot uses **20**. |

**Correction: KoboToolbox's free plan isn't available to RT.**

- The free Community plan is for "nonprofits, government agencies, UN organizations, and educational institutions".
- "Personal use not associated with an organization" falls under paid plans: Starter at $25/month [V, kobotoolbox.org/pricing].
- Pilot options:
  1. **Kobo Starter for one month (~$25)**, then cancel. **Recommended [I].** You get offline Android collection, images per question, and an XLSForm that carries forward.
  2. **A partner organization** hosts the pilot on its own Community plan. This also starts the relationship a later handover needs [I].
  3. **Google Forms** (free). No offline mode, and Google processes the data; fine for a small, connected pilot [I].
  4. **Skip the external pilot** and run it on the MVP card flow.
- The pilot documents are written tool-neutral (`[TOOL]` placeholder).

Labels: **[V]** verified · **[S]** secondary · **[I]** inference or recommendation.

## Update, Oct 14 (latest): Magar language and culture platform

The full plan is in `docs/related/magar-knowledge-platform.md`. It supersedes conflicting points below.

- **One PWA** (Akkha-Rik), with Learn and Contribute modes writing to **two separate data stores**. Wrap with Capacitor only if iPhone reminders or mic prompts hurt participation.
- **Daily questions** (about 5 a day), voting **within each variety**, named reviewers, and variants kept.
- **Voice answers** and a **cultural objects module**. The cultural module needs a community governing partner.
- **The LLM reads verified data** through retrieval and versioned snapshots. Nothing is stored "in" the weights.
- **Storage:** cloud live tier → NAS archive → off-site copy (3-2-1). The NAS is never exposed to the internet.
- **Licence reopened ⚑** for the paid API.

## Update, Oct 14 (later): integration with the Akkha-Rik web app

The full analysis is in `docs/related/akkha-rik-integration.md`.

- **Database: a separate Supabase project for community contributions**, replacing D1, with nightly `pg_dump` backups because Supabase Free has none [S].
  - It lives in its own repo under the project GitHub organization.
  - The learning app consumes CC BY releases, which keeps the paid product and the community commons separate (and makes handover clean).
  - Hosting the app on Cloudflare stands.
- **Item list v1 = the web app's 269 vocabulary items** (English + Nepali + image prompts), or a 200-item subset. This depends on whether those entries are Nepali or Magar (open question).
- **UK/EU:** the learning app already targets the UK and EU, so EU/UK representatives are needed for the project anyway. Once they're appointed, diaspora outreach for crowdsourcing can open.

## Update, Oct 14: the AI scope

RT wants the data to feed AI for all three languages, alongside the akkha-Rik book/web app. The full analysis is in **`docs/AI_FEASIBILITY.md`**.

Changes to this plan:

- **Add a sentence task** ("How would you say this in your language?"), seeded from SMOL's CC BY 4.0 sentences plus culturally specific ones. Parallel sentences matter most for AI; a wordlist alone is not enough.
- **Validation covers sentences too.**
- **Keep a private test set from day one:** ~200 sentences per variety, never published, never used in training.
- **Read-aloud audio** of validated items, collected for speech recognition later.
- **Kaike is not crowd-sourceable at scale.** Use ELAR/Meelen and Regmi, with permission, plus facilitator mode.
- **Consent and privacy notice now name AI training**, and say that others may also use the data for AI under CC BY 4.0 (`docs/related/wordlist-pilot-docs.md`, updated).
- **⚑ Open decision:** CC BY for everything, or an open dictionary with a controlled-access sentence and audio corpus? See `docs/AI_FEASIBILITY.md` §4.7.
- **Contact the KU Information & Language Processing Research Lab first.** The Magar community has pledged 25,000+ sentences and words to it.

## Goal

The app collects names for everyday items from speakers of three Akkha-script languages:

- Magar Dhut (`mgp`/`mrd`)
- Kham (`kgj`/`kip`/`kif`/`kjl`)
- Kaike (`kzq`)

It shows a picture plus the English and Nepali names, and asks for the word in the contributor's language. Its output is the first real dataset for the dictionary and, later, the Akkha learning tool. It is a **separate repo from mrig**, and Claude Code builds it.

## Mockup review

**Keep:**

- the image-first card
- the English and Nepali prompt
- the progress bar and submitted/skipped counters
- the prominent "I don't know, next" button

The UX is simple and works on a phone.

**Change** [I]:

1. **Ask for the language once, in the contributor's profile, not on every card.**
   - Profile fields:
     - variety (Magar Dhut / Kham / Kaike / not sure)
     - Kham sub-variety (Gamal, Sheshi, Eastern Parbate, Western Parbate, not sure)
     - district and village
   - Allow a per-answer override.
   - Where someone grew up is the standard way to pin down a dialect, and it's cheap to collect.
2. **Change the question wording.** "मगर भाषामा यसलाई के भनिन्छ?" asks for the word "in Magar language". Kaike is a separate language (Tamangic) [S], so use neutral wording such as "तपाईंको भाषामा यसलाई के भनिन्छ?" ("What is this called in your language?").
3. **Make Devanagari the requested script.**
   - Change the placeholder to "Type in Devanagari (or Roman letters if you can't)".
   - Store the raw input and a `script` flag: `deva` / `latn` / `mixed`.
   - Romanized answers are ad-hoc and can't be converted reliably, so treat them as needing review.
   - Android's Gboard includes a Nepali keyboard [I — confirm on a test phone].
4. **Add two answer buttons:**
   - "We use the Nepali word too", which records an explicit loanword.
   - "We have no specific word".
   - Both are real data, not skips.
5. **Allow more than one answer per item** ("Add another word") to catch synonyms.
6. **Add an optional audio recording, in phase 3.** This matters more here than for most languages:
   - Kham has a glottal stop and breathy vowels that Devanagari can't show [S].
   - Kaike may have tone [I].
   - A short Opus clip is roughly 10–30 KB [I].
7. **Show the answer in Akkha after submitting**, in phase 4, once the font spike and transliteration tool exist. It rewards the contributor and tests the font on real Android phones for free.

## Data model (minimum)

- **`concept`**
  - `id`
  - `concepticon_id` (nullable)
  - `en`
  - `ne`
  - `category`
  - `image_path`
  - `image_license`
  - `image_attribution`
- **`contributor`**
  - `id` (random, anonymous)
  - `variety`
  - `subvariety`
  - `district`
  - `village`
  - `age_band`
  - `consent_version`
  - `created_at`
  - optional display name, for credit
- **`answer`**
  - `id`
  - `concept_id`
  - `contributor_id`
  - `variety` (copied from the profile unless overridden)
  - `form_raw`
  - `form_nfc` (Devanagari, NFC-normalized)
  - `script`
  - `kind` (`word` / `nepali_loan` / `no_word` / `skip`)
  - `audio_path` (nullable)
  - `created_at`
- **`vote`**
  - `answer_id`
  - `contributor_id`
  - `agree` (bool)
  - `variety`

**Derived, never stored:** consensus status. An answer counts as "validated" when at least 3 independent contributors of the same variety agree [I — tune later].

## Item list

- **Map every item to a Concepticon concept ID where one exists.**
  - Concepticon is the standard catalogue of comparative concepts.
  - CLDF / Lexibank is the standard way to publish wordlists built on it [V].
  - With the mapping, the dataset is comparable with existing Tibeto-Burman wordlists and exportable as a **CLDF Wordlist** at no extra cost.
- **Mix of items:**
  - A core list: a Swadesh or Leipzig-Jakarta style basic vocabulary.
  - The picture-friendly categories from the mockup: flowers, animals, food, tools, body parts.
  - A community-added list of culturally specific items (local plants, kinship terms, ritual objects).
- **Images:** CC0 or public-domain only (Wikimedia Commons, Openverse). Record the license and attribution per image. Compress to WebP at about 50 KB or less for rural data costs [I].
- ⚑ **Size:** how many items for launch? The mockup shows 200.

## Launch readiness (added Sept 24)

The full audit is in **`docs/related/wordlist-app-launch-checklist.md`**. It covers:

- legal documents
- help content
- data rights
- moderation
- security
- accessibility
- store compliance
- the minimum set of items per phase gate

Changes it makes to this plan:

- **Recommended minimum age is 18+ for the MVP.** COPPA covers a US operator collecting from under-13s anywhere [V]. Minors come later, only via facilitator mode with guardian consent.
- **New: facilitator mode.** A relative operates the app for an elderly speaker, with the speaker's consent recorded. Audio moves earlier for Kham and Kaike.
- **New: contributor data rights.** Contributors can view, edit, delete and export their data. Account deletion must be available both in-app and through a web link (Play Store).
- **New: a withdrawal policy stated up front.** CC releases can't be recalled [V]. Withdrawn data is removed from the app and all future releases, and access to old releases is restricted.
- **New: protecting identities in releases.** Publish district level only, and suppress groups of fewer than 5 speakers. This matters especially for Kaike, which has about 50 speakers.
- **New: moderation features required by Play's user-generated content policy [V].** Contributors accept the terms before posting, can report and hide answers, and admin actions are audit-logged. No social features.
- **New decisions** (see H in the checklist):
  - Who legally runs the app (the data controller).
  - EU/UK targeting: GDPR and whether an EU/UK representative is needed.

Data model additions:

- `contributor.recovery_code_hash`
- `contributor.email` (optional; for recovery only)
- `contributor.consent_audio`
- `contributor.consent_explicit_ethnicity`
- `contributor.deleted_at`
- `answer.consent_version`
- `answer.facilitator_id` (nullable)
- `answer.deleted_at`
- new tables: `report` and `admin_audit`

## Consent, licensing and governance ⚑

Decide these before the first public submission [I]:

- **Consent screen** in Nepali and English. It should say what's collected, the fact that it will be published as a dictionary, the license, and how to withdraw.
- **Data license** ⚑: CC BY 4.0 is the most reusable. CC BY-NC blocks commercial reuse. The license determines what the future AI tool can be trained on.
- **Minimum age** ⚑: **18+ recommended for the MVP** (see the Launch readiness section above). Minors come later, only via facilitator mode with guardian consent.
- **No trackers or analytics**, consistent with RT's other projects. Store no email or phone number unless someone opts in for credit.
- **Community advisory contact:** someone from each language who can arbitrate disputed forms.
- **Local Contexts labels** [V] can tag the dataset's provenance when it's published.

## Quality and abuse

- **Validation mode:** "Is this what *your* variety calls it?" as agree/disagree/unsure, shown only to contributors of the same variety.
- **Rate limiting** per device and IP; a simple admin moderation queue; and the ability to purge all answers from one contributor.
- **Duplicate detection** on `form_nfc` per concept and variety.

## Offline and low-bandwidth

- A PWA with an offline queue: answers are stored locally and synced when back online [I].
- Prefetch the next 10 cards and their images.

## Hosting ⚑

| Option | For | Against |
|---|---|---|
| **A. Next.js + Drizzle + libSQL/Turso** (the ShiftPay stack) on **Vercel Hobby** | Known stack, fastest to build | Vercel's Hobby plan is restricted to "non-commercial, personal use only" [V]. A public community app arguably isn't personal use |
| **B. Same app on Cloudflare** (Workers/Pages + D1 + R2) | Free tier with R2's 10 GB of storage and no egress fees [S] suits images and audio; no personal-use clause found [I] | New platform to learn |
| **C. KoboToolbox pilot** | Offline Android via KoboCollect; zero code [V]. **The free Community plan is for nonprofits only. As an individual, RT would need Starter (~$25/month) [V]** | No validation voting, gamification or Akkha rendering; data export only |

**Recommendation [I]:**

- **C first:** run a 2-week pilot with about 20 items and about 10 speakers per language, to test the prompts, the "language" wording and the Devanagari-typing assumption before writing code.
- **Then build B**, or A if you accept the Vercel terms risk or pay for Pro.

## Native app and AdMob (evaluated Sept 24)

**Native app.**

- Useful for a Play Store listing (trust, discoverability), reliable audio recording, and offline storage.
- A PWA already covers offline use and audio on Android Chrome [I].
- **Recommendation [I]:**
  - Build the web app first.
  - Wrap it with Capacitor, or as a Trusted Web Activity, when it needs to be in the Play Store.
  - This keeps one TypeScript codebase.
  - If fully native, use Expo / React Native, not Flutter, to stay in TypeScript.
- **Store costs** [I, from memory; confirm]: Play Console $25 one-time; Apple $99/year.

**AdMob — not in the collection app.**

- **Revenue will be tiny.**
  - South Asian eCPMs are about $0.10–0.40 for banners and $0.50–1.50 for interstitials [S, Pakistan/India data; Nepal likely similar or lower, I].
  - Example: 100k banner impressions a month ≈ $10–40 [I].
- **It harms the data.**
  - Interstitials between cards push people to rush or skip.
  - Ads cost rural users mobile data.
- **It harms trust.**
  - Volunteers donating their language to an ad-supported app is an easy "they're selling our language" story.
  - The contributor agreement would have to grant commercial rights, which rules out a CC BY-NC license on contributions.
- **It adds compliance work.**
  - Advertising ID tracking breaks the no-trackers stance.
  - GDPR/UK consent through Google's consent SDK is needed for diaspora users.
  - If the later learning app attracts children, Google Play's **Families Policy** applies: self-certified ad SDKs only and restricted ad content [V].
- **It breaks the hosting options.** A commercial app loses Vercel Hobby, and probably KoboToolbox's nonprofit Community plan too [I].
- **AdMob works only in native apps.** Web needs AdSense or Ad Manager [I]. Choosing AdMob therefore forces a native or Capacitor build.

**Funding instead:**

- **ELDP 2026 round** [V]:
  - Small Grants go up to €10,000 for 12 months.
  - There are no nationality or institution restrictions, and community members are explicitly encouraged to apply.
  - **The application deadline is October 1, 5pm CEST**, with support statements due October 15. That leaves one week, so it's tight but possible for a small Kaike/Kham documentation proposal. Otherwise aim for the next round.
  - ELDP funds documentation (recordings archived in ELAR), not app development [I]. Pitch the audio collection and archiving, with the app as the tool.
- **Endangered Language Fund** [V exists; check its calls].
- **Magar community organizations or sponsors**, and donations [I].

**Monetization, if wanted, belongs in the later learning app** [I]:

- Prefer a one-time unlock, freemium content, or donations.
- If ads are used anyway: banner-only, non-personalized, none for children, disclosed up front, and agreed with the community.

## Output pipeline

1. **Export:** a nightly CLDF Wordlist (`FormTable` + `ParameterTable` with Concepticon IDs + `LanguageTable` with ISO codes).
2. **Dictionary seed:** validated forms → lexicon JSONL with these fields:
   - headword (Devanagari)
   - variety
   - English and Nepali glosses
   - concept ID
   - audio
   - number of agreeing contributors
3. **mrig:** the lexicon is open-zone data (unrestricted), used for retrieval in language sessions.
4. **Learning tool:** flashcards rendered in Akkha through the transliteration tool and web font, with audio.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| P0 | Decisions ⚑: legal home/controller, license, consent text, age (18+ recommended), EU/UK targeting, item list v1, hosting; plus the checklist's "Kobo pilot" minimum set | RT signs off |
| P1 | Kobo pilot (20 items) | Wording and typing assumptions confirmed |
| P2 | MVP: profile, cards, text answers, loan/no-word buttons, offline queue, admin export | First 100 contributors |
| P3 | Validation voting + audio | ≥3 agreements on core items per variety |
| P4 | Akkha rendering of answers | Font spike + transliteration tool done |
| P5 | CLDF export → dictionary seed → learning tool | — |

**Success metric:** a coverage grid of items × varieties, where each cell counts as filled once it has a validated form.

## Open questions

- ⚑ The decisions above: license, age, hosting, item count.
- Who are the first contributors (existing networks, organizations, social media groups)? That decides whether Kham and Kaike get enough coverage. Kaike has about 50 native speakers (2011) [S], so it may need direct outreach rather than open crowdsourcing.
- Are any existing Magar, Kham or Kaike wordlists (published fieldwork, Lexibank datasets) available as seed or cross-check data?
