# Wordlist app — completeness audit and launch checklist

Date: September 24, 2026. This audits `docs/related/wordlist-app-plan.md` against what a complete public crowdsourcing app needs.

Labels: **[V]** verified against a primary source · **[S]** secondary · **[I]** inference or recommendation.

Status key: ✅ covered in the plan · ◐ partly covered · ✗ missing.

Gate column (when the item must exist):

- **Pilot:** before the Kobo pilot.
- **Launch:** before the public web launch.
- **Store:** before a Play or App Store release.

> Not legal advice. The privacy policy, terms and contributor licence should be reviewed by a lawyer before public launch. Nepal-qualified review is the priority; a US review is optional.

## Verdict

- **Well covered:** the core product (cards, profile, validation, offline, export) and part of the governance (consent screen, licence choice, advisory contact, Local Contexts labels, no trackers).
- **Missing:**
  - most legal documents;
  - contributor data rights (view, edit, delete, export, withdraw);
  - protections against identifying contributors in the published dataset;
  - moderation features required by app-store UGC policies;
  - security and operations;
  - contributor help content (guide, FAQ, about);
  - a way for elderly or low-literacy speakers to contribute.
- Some of these are legal requirements, not nice-to-haves. See section H.

---

## A. Legal and policy documents

| # | Item | Status | What's needed | Gate |
|---|---|---|---|---|
| A1 | **Legal home / data controller** | ✅ **Decided Sept 24** | RT personally, with a handover path to an organization. Protocol and dossier: `docs/related/wordlist-pilot-docs.md`, Part 6. Set up the transferable accounts now: project email, GitHub organization, domain, shared vault, second admin. | Pilot |
| A2 | **Privacy policy** (Nepali + English) | ◐ pilot version drafted (`docs/related/wordlist-pilot-docs.md`, Part 4) | Expand into the full launch policy. See below this table. | Launch |
| A3 | **Terms of use** | ✗ | See below this table. | Launch |
| A4 | **Contributor licence grant** | ⚠️ **Reopened Oct 14**: the licence model is pending ⚑ (`docs/related/magar-knowledge-platform.md` §8) | See below this table. | Pilot |
| A5 | **Informed consent** | ✅ drafted, needs Nepali review (`docs/related/wordlist-pilot-docs.md`, Part 3) | Add the audio consent before P3. See below this table. | Pilot |
| A6 | **Community guidelines / content policy** | ✗ | See below this table. | Launch |
| A7 | **Complaints and takedown procedure** | ✗ | A named contact, a response time, and a process for disputes about ownership or community objections. Nepal's 2023 social-media Directive expects a grievance contact and 24-hour removal of flagged content [S]. | Launch |
| A8 | **Community agreement (MoU)** with the advisory group(s) | ◐ | Who can speak for each language; how collective rights over traditional knowledge relate to individual contributor licences; CARE principles [S]; Local Contexts labels [V]. | Launch |
| A9 | **Dataset documentation** | ◐ | A data statement or datasheet (who contributed, varieties, collection method, known biases), a citation file, and versioned releases with a DOI (e.g. Zenodo) [I]. | First release |
| A10 | **Image credits page** | ◐ (fields exist) | A public page generated from the image licence and attribution fields. | Launch |
| A11 | **Code licence** | ✅ AGPL-3.0 (proposed) | Chosen by default; switch to MIT if preferred. | Launch |
| A12 | **Internal security and retention policy** | ✗ | A short written policy covering what is stored, where, for how long, and who has access. COPPA's amended rule requires written security and retention policies if children's data is ever collected [V]. It's good practice regardless. | Launch |
| A13 | **Incident response plan** | ✗ | Steps for a data breach: contain, assess, notify. GDPR requires notifying the regulator within 72 hours where it applies [I, standard Art. 33]. | Launch |

**A2 — Privacy policy must cover:**

- what is collected: the pseudonymous ID, language/variety, district, village, age band, answers, audio, and IP addresses for rate limiting;
- why it is collected, and the legal basis;
- what gets published and at what level of detail;
- how long each item is kept;
- the contributor's rights and how to use them;
- a contact.

Hosting requirements [V]:

- Google Play needs it at an "active, publicly accessible and non-geofenced URL (no PDFs)" and linked inside the app.
- Nepal's Individual Privacy Act 2075 requires consent and notice of purpose before collection, and lists caste/ethnicity and biometric data as personal information [S].

**A3 — Terms of use must cover:**

- eligibility and minimum age;
- acceptable content;
- the licence grant (A4);
- the operator's rights to moderate and remove content;
- no warranty;
- governing law;
- how changes to the terms are handled.

Google Play's UGC policy requires users to **accept the terms before posting** [V].

**A4 — Contributor licence grant must cover:**

- **Which licence.** Decide between CC BY 4.0, CC0 (Mozilla Common Voice uses CC0 [V]) and CC BY-SA (Lingua Libre [S]).
- **What the grant rests on.** Single words aren't copyrightable in the US [V]. The licence matters for:
  - the **database** (CC 4.0 covers sui generis database rights [V]);
  - **audio**, which carries sound-recording and performer rights, so get an explicit grant at upload [V].
- **A warranty** that the contributor is sharing their own knowledge.

**A5 — Informed consent must include:**

- A short, plain-language screen, versioned.
- **Separate consent to audio.**
- **Explicit consent** to data that may reveal ethnic origin. Declaring Magar/Kham/Kaike plus a village can count as special-category data under GDPR Art. 9 [S] and as sensitive under Nepal's Act [S].
- A clear statement of what withdrawal can and cannot undo (section C).

**A6 — Community guidelines must cover:**

- What to submit: your own variety, real usage, not guesses.
- What never to submit: personal information about anyone, and hate or harassment.
- **Taboo and vulgar words are legitimate language data.** Flag them for review; don't auto-delete them.
- What happens to content that breaks the rules.
- Play's UGC policy requires this definition of objectionable content [V].

## B. Contributor-facing content

| # | Item | Status | Needed | Gate |
|---|---|---|---|---|
| B1 | Onboarding (3–4 screens) | ✅ drafted (`docs/related/wordlist-pilot-docs.md`, Part 2) | What the project is, why it matters, how a card works, consent | Pilot |
| B2 | Contributor guide | ✗ | See below this table | Launch |
| B3 | FAQ | ✗ | Starter questions below | Launch |
| B4 | About page | ✗ | Who runs it, the advisory group, funding, how the data will be used, dataset releases | Launch |
| B5 | Contact / support | ✗ | An email or form address; required by Apple guideline 1.2 [V] and by the grievance process (A7) | Launch |
| B6 | Credits and acknowledgements | ✗ | Opt-in contributor names, advisory members, image credits (A10) | Launch |
| B7 | UI localization | ◐ | Every string in Nepali and English, including legal documents | Launch |
| B8 | Release notes / changelog | ✗ | Per app version and per dataset release | Launch |

**B2 — Contributor guide covers:**

- how to type Devanagari on Android (enable Gboard's Nepali keyboard);
- how to choose your variety;
- when to use "Nepali word" vs "no word";
- recording tips;
- how validation works.

**FAQ starter list (B3):**

- Who is behind this, and is it free?
- Why do you need my village and age band?
- Is my name or phone number collected?
- What happens to my words and recordings? Where will they be published?
- Can I delete my contributions? What if they're already published?
- I don't know how to type Devanagari. Can I use Roman letters?
- My variety isn't listed, or I speak two. What do I do?
- What if two people give different words?
- Can I record for my grandmother or grandfather?
- Is it okay to submit rude or old-fashioned words?
- Will you sell the data or show ads? (Say no, explicitly.)
- How do I report a wrong picture or a wrong Nepali name?
- How do I get credited?

## C. Contributor data management

| # | Item | Status | Needed | Gate |
|---|---|---|---|---|
| C1 | "My contributions" page: view, edit, delete individual answers | ✗ | — | Launch |
| C2 | **Delete everything / delete account**, in-app **and** via a web link | ✗ (admin purge only) | See below this table | Launch / Store |
| C3 | Export my data (JSON/CSV) | ✗ | A data-portability expectation [I] | Launch |
| C4 | **Withdrawal after publication** | ✗ | See below this table | Launch |
| C5 | ID recovery | ✗ | See below this table | Launch |
| C6 | Consent versioning and re-consent | ◐ (field exists) | Prompt contributors again when the terms change materially; record the version on each answer | Launch |
| C7 | **Protecting identities in releases** | ✗ | See below this table | First release |
| C8 | Retention schedule | ✗ | See below this table | Launch |
| C9 | Correction requests | ✗ | Covered by C1; Nepal's Act gives a right to correction [S] | Launch |

**C2 — Delete account:**

- Google Play requires both paths if users can create an account [V].
- A returnable random ID may count as an account [S], so build both.
- Deleted records get a `deleted_at` tombstone and are purged from backups on rotation.

**C4 — Withdrawal after publication:**

- CC licences can't be revoked. Copies already published stay out there [V].
- The policy should be:
  - remove the data from the app and all future releases;
  - restrict access to old releases, as Mozilla Common Voice does [V];
  - tell known mirrors, as GDPR Art. 17(2) expects [V].
- Say all of this in the consent screen before anyone contributes.

**C5 — ID recovery:**

- Pseudonymous IDs are lost when someone clears their browser.
- Offer an optional recovery code (copy it or save it) and an optional email, used for recovery only.

**C7 — Protecting identities in releases:**

- **Kaike has about 50 native speakers [S].** Variety + village + age band can identify a person.
- Publish **district level only**, age bands only, and stable per-release pseudonyms.
- Suppress any group with fewer than 5 speakers [I].
- Keep villages private, for internal dialect analysis only.

**C8 — Retention schedule:**

| Data | Kept for [I] |
|---|---|
| IP / rate-limit logs | ≤30 days |
| Admin audit log | 1 year |
| Contributions | Until deleted |
| Backups | Rotated within 35 days |

## D. Moderation and safety

Google Play's UGC policy applies, because validation mode shows other people's answers [V].

| # | Item | Status | Needed | Gate |
|---|---|---|---|---|
| D1 | Accept the terms before the first submission | ✗ | Play requirement [V] | Launch |
| D2 | Report an answer (wrong, offensive, personal information) | ✗ | Play requirement [V] | Launch |
| D3 | "Hide answers from this contributor" (blocking) | ✗ (admin purge only) | Play and Apple both require user blocking [V]; for anonymous users, "hide this contributor" works [I] | Launch |
| D4 | Moderation queue + response-time target | ◐ | A named moderator per language; review reports within 24–48 hours [I] | Launch |
| D5 | Report a problem with an item (bad image, wrong Nepali word) | ✗ | — | Launch |
| D6 | Admin audit log | ✗ | Every edit, delete and ban, with who and when | Launch |
| D7 | Keep social features to a minimum | ✗ (not stated) | No profiles, comments or messaging. This lowers UGC risk and keeps the app further from Nepal's "social network" Directive [S/I] | Launch |

## E. Security and operations

| # | Item | Status | Needed | Gate |
|---|---|---|---|---|
| E1 | Admin authentication | ✗ | Strong login + 2FA; separate moderator and admin roles | Launch |
| E2 | Rate limiting and abuse controls | ✅ | Per device and IP; bot protection such as Cloudflare Turnstile [I] | Launch |
| E3 | Encryption | ◐ | HTTPS everywhere; the provider's encryption at rest; audio stored in a private bucket with signed URLs | Launch |
| E4 | Backups | ✗ | Daily and off-site; **test a restore** before launch | Launch |
| E5 | Error monitoring without third-party trackers | ✗ | Server logs plus a self-hosted or no-SDK option [I] | Launch |
| E6 | Secrets and dependency hygiene | ✗ | No secrets in the repo; automated dependency updates | Launch |
| E7 | Continuity | ✗ | See below this table | Launch |

**E7 — Continuity:**

- Domain owned by the legal home (A1).
- A second admin.
- Dataset releases also deposited with Zenodo and/or ELAR, so the data outlives the app.

## F. Accessibility and inclusion

| # | Item | Status | Needed | Gate |
|---|---|---|---|---|
| F1 | **Facilitator mode** | ✗ | See below this table | Launch |
| F2 | **Audio-first input** for people who can't write their language | ◐ (audio in P3) | Move audio earlier for Kham and Kaike | P3 → earlier |
| F3 | Large text, contrast, screen-reader labels | ✗ | — | Launch |
| F4 | Low-end Android performance, data saver | ◐ | Test on a cheap device; image budget in place | Launch |

**F1 — Facilitator mode:**

- The best speakers of Kaike and Kham are often elderly and may not read or type Devanagari.
- In facilitator mode, a younger relative operates the app for them.
- The speaker's consent is recorded on the speaker's behalf, and the facilitator's ID is logged [I].

## G. Store and platform compliance

| # | Item | Status | Needed | Gate |
|---|---|---|---|---|
| G1 | Google Play Data safety form | ✗ | Declare user IDs, voice recordings, user-provided location/personal info, and answers. Required even if nothing is collected [V] | Store |
| G2 | Privacy policy URL in Console and in-app | ✗ | See A2 [V] | Store |
| G3 | Account deletion (in-app + web link) | ✗ | See C2 [V] | Store |
| G4 | Target audience and content rating | ✗ | Declaring 18+ avoids the Families Policy for the collection app [I] | Store |
| G5 | Apple (later) | ✗ | Guideline 4.2 rejects apps that are just a "repackaged website" [V], so the Capacitor build needs real native value such as offline audio. Also 5.1.1(v) account deletion and 1.2 UGC [V] | Store (iOS) |
| G6 | Nepal platform rules | ✗ | See below this table | Launch |

**G6 — Nepal platform rules:**

- The 2023 social-media Directive is still in force [S]. It expects listing with the communications ministry, a grievance contact in Nepal, and 24-hour takedowns.
- The 2025 Social Media Bill was withdrawn in February 2026 [V, news].
- A small word-collection app without social features is unlikely to be a target, but its scope is broad [S].
- Get local advice before scaling, and keep D7 true.

## H. Legal questions that need a decision

- **Minimum age.**
  - COPPA applies to a US-based operator collecting from children under 13 **anywhere**, including children's voice recordings. The amended rule's compliance date was 22 Apr 2026 [V].
  - Common Voice and Mozilla Data Collective use 18+ or 19+ [V].
  - **Recommendation:** 18+ for the MVP. Add minors later only through facilitator mode with guardian consent [I].
  - **✅ Decided Sept 24: 18+.**
- **GDPR / UK GDPR for the diaspora.**
  - GDPR applies if the app *targets* people in the EU or UK, even for free services [V].
  - Ongoing collection probably doesn't qualify for the Art. 27 "occasional processing" exemption, so an EU/UK representative would be needed [V/S].
  - **✅ Decided Sept 24:** no targeted UK/EU outreach at launch. Revisit with a representative later.
  - **⚠️ Oct 14:** the Akkha-Rik learning app targets the UK and EU first, so representatives are needed for the project regardless. Appoint them before the learning app's public launch; diaspora crowdsourcing can open then. See `docs/related/akkha-rik-integration.md` §5.2.
  - **Options (for reference):**
    - at launch, don't target the UK or EU (no UK-specific outreach or store listing), and add a representative later; or
    - budget for a representative service from day one.
  - Ethnicity may be inferred from the data, so rely on **explicit consent** (A5) [S].
- **Nepal.**
  - The Individual Privacy Act 2075 and Privacy Regulation 2077 still apply: consent, purpose limitation, security and correction [S].
  - The broader IT & Cyber Security Bill probably lapsed when the House was dissolved in 2025 [S/I]. Watch for it to be reintroduced.
- **ELDP (if you apply).**
  - The grant requires evidence of community awareness and acceptance, informed consent, paid consultants, and deposit at ELAR [V].
  - ELAR offers Open, User and Subscriber access levels [V].
  - A1, A5 and A8 double as grant documents.

## Minimum set per gate

- **Pilot** (Kobo Starter, a partner org, or Google Forms; see the plan's Decisions section):
  - A1 (the decision on who runs it)
  - A5 (consent script)
  - a one-page privacy notice
  - the licence choice
  - an 18+ age check
  - B1
  - retention for the pilot data
- **Public web launch:**
  - everything in A–F marked Launch
  - lawyer review of A2, A3 and A4
- **Play Store:** G1–G4, plus a test run of C2.
- **First dataset release:** A9 and C7, deposited on Zenodo or ELAR.
