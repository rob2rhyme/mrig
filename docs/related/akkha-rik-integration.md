# Akkha-Rik web app × crowdsourcing × AI: integration analysis

Date: October 14, 2026 (updated November 2 with Robin's answers, §0). Based on the README of `akkha-Rik-BookAndWebApp`, which RT pasted. I couldn't access the repo itself.

Labels: **[V]** verified against a primary source · **[S]** secondary · **[I]** inference or recommendation · **[R]** stated in the README.

## 0. Robin's answers (Nov 2) and what they change

This section overrides the open questions in sections 3, 5.3, 5.5 and 5.6 below.

| Question | Answer | Consequence |
|---|---|---|
| Vocabulary language | **Both Nepali and Magar** | See 0.1 |
| Rights holder | **Robin Thapa** (developer) owns the book content and the GurbachhanAkkhaRik font | See 0.2 |
| Hosting | **Vercel** | See 0.3 |
| Learner account minimum age | **8** | **Biggest change.** See 0.4 |
| Kham extra letters | **Not needed** | Repertoire stable. See 0.5 |

### 0.1 Mixed vocabulary [I]

- Add a `lang` field to every item in `data-vocab.ts`: `npi` for Nepali, or the Magar variety code (`mgp`/`mrd`, etc.). Make `check-data` fail on any item without it.
- **Magar items** become seed dictionary entries with the status *candidate (author)*. They still need ≥3 same-variety speakers to agree before they count as verified.
- **Nepali items** become crowdsourcing prompts: "What is this called in your language?"
- If an item holds *both* a Nepali and a Magar form, split it into two linked fields rather than guessing which is which.

### 0.2 Rights [I]

- Change "Content © Akkha-Rik Project" to name the actual rights holder, e.g. "© 2026 Robin Thapa".
- **The Bhutanese American Magar Association (BAMA) website has a members-only "Akkha-Rik Project" page** [V]. Write down the relationship now, before the partnership grows. For example: Robin owns the content and font, and BAMA has a licence to use them. Unwritten ownership is the most common source of later disputes.
- **Choose a licence for the font.**
  - SIL Open Font License 1.1 is the norm for community and minority-script fonts. It helps adoption, and it helps any future Unicode case [I].
  - A closed licence is also possible. The Unicode Script Encoding Working Group (SEWG) requires an available font, not an open one [V, earlier].
- Robin's Magar vocabulary joins the dataset under the same CC BY 4.0 contributor licence as everyone else's.

### 0.3 Vercel [V for the terms, I for the advice]

- If the app is on **Hobby**, its terms are "non-commercial, personal use only". A public community app with paid certificates doesn't fit.
- Move to **Pro** (Developer seats are $20 per user per month) **before billing ships**, or before public launch if you want to be strict.

### 0.4 Accounts from age 8: what it requires

This was my earlier recommendation of 13+ for accounts, now changed by Robin's choice.

**What applies:**

- **COPPA.** A US operator collecting personal information from under-13s, including children outside the US, needs **verifiable parental consent** (VPC) and direct notice to parents. Parents get review and deletion rights. The amended rule (compliance date 22 Apr 2026) adds a written information-security programme and a written retention policy, and it treats voice as personal information [V, earlier research].
- **UK Children's Code (AADC):** applies to UK users of a service likely to be accessed by under-18s, educational sites included [V].
  - It requires high-privacy defaults, no nudges, profiling and geolocation off, and a DPIA [I — confirm the standards list].
- **EU GDPR Art. 8:** parental consent is needed below the member state's age, which ranges from 13 to 16 [S].

**Recommended design: family accounts [I]**

1. **Only adults create logins.** The magic-link email is the parent's. Children get no email and no password.
2. **The parent adds child profiles:** nickname, age band and avatar only.
3. **Verifiable consent happens once,** when the first child profile is added.
   - COPPA allows methods such as a payment-card transaction, an ID check or a video call. That makes it natural to do at the certificate purchase [I — confirm the method list with the FTC FAQ before building; my fetch of it timed out].
4. **What child profiles hold:**
   - progress only;
   - no voice upload, no photos, no free text;
   - any pronunciation practice stays **on the device**.
5. **Certificates for children:**
   - the name on the certificate is set by the parent;
   - the `/verify/[cert_id]` page is **off by default** for children, or shows the certificate ID and an initial only.
6. **Email** goes only to the parent. **Payment** is by the parent only.
7. **Contribute mode is never reachable from a child profile** (18+ only). This also creates the family loop: elders contribute, children learn.
8. **Write a DPIA, a security programme and a retention policy.** Short documents are fine, but they must exist.

**Simpler alternative:**

- Every lesson stays free **without an account** from age 8.
- Accounts (progress, certificates) start at 13.
- This removes most of the COPPA work.
- Robin's call; both are workable.

### 0.5 Kham

- No extra Akkha letters are needed. The repertoire is stable, which is one of SEWG's criteria [V].
- The glottal stop and breathy vowels won't show in spelling, so record **audio and IPA** for Kham entries. Otherwise that pronunciation is lost [I].

## 1. What the README tells us

- **Stack:**
  - Next.js 16 + React 19, Tailwind 3.4.
  - Supabase: magic-link and OAuth login, per-user progress, certificates.
  - Resend for email.
  - Puppeteer and @react-pdf for exports.
  - A service worker for offline use [R].
- **Content:**
  - 8 script units: consonants, vowels, matras, subjoined consonants, numerals, punctuation.
  - 11 vocabulary units with **269 items**, each with `deva`, `rom`, `ak` (e.g. `a+A+m+A`), `ipa`, `en`, and an `imagePrompt` [R].
  - Search over 523 entries [R].
- **Deferred content:** stories, songs, Buddhist verses, conversations and dialogues, simple sentences (SOV order), question words, opposites.
  - Per the README, it exists in `/home/claude/build/pages_extras.js` [R].
- **Audio:** recorded clips are dropped into `public/audio/` with the same file stem as the glyph, with browser text-to-speech as the fallback [R].
  - The README itself says text-to-speech gives Nepali/Hindi phonology, not Magar, so real recordings are needed.
- **Akkha rendering:** 99 **SVG glyph images**, "derived from the GurbachhanAkkhaRik typeface source files", plus a Latin → Akkha export page [R].
- **Business model:**
  - Courses are free; the **completion certificate download is the paid feature**.
  - Audience: the **Magar diaspora first, US and UK especially**, with Nepal second [R].
- **Licence:** "Content © Akkha-Rik Project" [R].
- **Engineering:** check scripts (contrast, data, bilingual, workbooks, read-only routes, row-level security) and a documented dependency-floor policy [R]. This is a solid base to extend.

## 2. Verdict

**Feasible. The web app already provides about half of what the crowdsourcing app needs [I].** The AI plan in `docs/AI_FEASIBILITY.md` still holds. What this repo changes is where the data comes from and where it ends up, and it surfaces some conflicts with earlier decisions (section 5).

## 3. The question that decides a lot

**Is the 269-item vocabulary, and the deferred sentence content, in Magar Dhut, in Nepali, or mixed?**

- The README says search covers "Romanized Nepali (`Aamaa`, `mother`)". It also says recordings are needed for "correct Magar pronunciation". That's ambiguous [R].

| If it's... | Then... |
|---|---|
| **Nepali words in Akkha script** | The app teaches the *script*, and holds no Magar *language* data yet. The 269 items become **wordlist v1 for crowdsourcing**, with English + Nepali + image prompts already written. The deferred sentences become **translation prompts**. |
| **Magar Dhut** (which variety? who supplied it?) | It's a **seed dictionary**: 269 entries with IPA, to be validated by crowd speakers. If the dialogues and simple sentences include translations, they are the high-value parallel sentences (MTOB / Aycock). A retrieval prototype in mrig could start right away. |

**Urgent either way:** `/home/claude/build/pages_extras.js` is a path inside a Claude cloud sandbox. Those environments are ephemeral. **Check that the file is committed to the repo.** If it only existed in a past session, it may be gone. Its stories, dialogues and sentences are the most valuable AI material on the list [I].

## 4. What can be reused

| Need (crowdsourcing / AI) | Existing piece | Fit |
|---|---|---|
| Bilingual UI and checks | `check-bilingual`, en/ne pairs | Direct |
| Offline / low-bandwidth | Service worker, audio precaching under 150 KB | Direct |
| Show answers in Akkha | Glyph pipeline, `akkha-export` | Direct now; switches to the font later (5.4) |
| Item list + images | `data-vocab.ts` (269 items with `imagePrompt`) | Direct (section 3) |
| Audio playback of validated recordings | `public/audio/` drop-in + `SpeakButton` | Direct. **Contributed clips can become the app's Magar pronunciation**, with consent (5.3) |
| Database security | Supabase + `check-rls` against a throwaway Postgres | Direct pattern for the contribution tables |
| Dictionary search | Fuse.js index | Direct, later |
| Data schema → CLDF export | `deva`/`rom`/`ipa`/`en` fields | Straightforward mapping [I] |
| **Still missing** | contributor consent (18+), contribution and validation tables, moderation and reports, admin, CLDF export, backups | New work |

## 5. Conflicts and gaps the README reveals

### 5.1 Keep the community dataset separate from the paid product [I]

**Recommendation:** a separate repo and a **separate Supabase project** for contributions, owned by the project GitHub organization and project email. The learning app then **uses the published CC BY releases, the same as anyone else could.**

Why:

- **Handover.** An organization can take over the community dataset without taking over the certificate business.
- **Trust.** The community's words aren't locked inside a paid product.
- **Different terms and audiences:**
  - Contributors: 18+, fluent speakers, mostly in Nepal, CC BY grant.
  - Learners: diaspora, any age, an account, a paid certificate.
- **Cost fits the free tier.** Supabase Free allows 2 active projects, 500 MB of database and 1 GB of storage. It has **no automatic backups**, so a nightly `pg_dump` is needed. Projects pause after about a week of inactivity [S].

Sharing code (Akkha rendering, bilingual strings) is fine. Share data only through releases. The learning app links to "Contribute".

### 5.2 UK/EU: GDPR already applies to the learning app

- The crowdsourcing decision was "no UK/EU outreach at launch". The learning app's own strategy is the opposite: **UK and EU first, with accounts, email and progress tracking.**
- So the project's GDPR / UK GDPR exposure doesn't depend on the crowdsourcing app.
- **Needs** [V for applicability, earlier research; I for the list]:
  - a privacy policy for the learning app;
  - data processing agreements with Supabase and Resend;
  - EU and UK Art. 27 representatives, since ongoing processing is unlikely to count as "occasional".
- **Once the representatives exist,** diaspora outreach for crowdsourcing can open too. That matters: diaspora families include fluent elders (facilitator mode).

### 5.3 Children

- The image prompts say "kid-friendly" [R], so children are likely users.
- **UK Children's Code:** applies to services outside the UK that offer services to UK users and are likely to be accessed by under-18s, **including educational and not-for-profit sites** [V, ICO].
- **COPPA:** applies to under-13s, including outside the US, for a US-based operator [V, earlier].
- **For the learning app [I]:**
  - Set an account age policy, e.g. accounts at 13+, with younger learners using the site without an account. Under-13 accounts would need verifiable parental consent.
  - Use high-privacy defaults.
  - Don't make certificate verification pages public for minors.
  - Collect minimal data.
- **Contributions stay 18+** (already decided).

### 5.4 Encoding: the app runs on ASCII-slot codes and glyph images

- The `ak: 'a+A+m+A'` field and the Latin → Akkha export are the ASCII-slot encoding that was retired on Sept 23 [R].
- No documents need migrating, but **269 entries carry it as data.**
- **Fix [I]:**
  - Generate `ak` from `deva` with the transliteration tool, and add a `check-data` assertion that the two agree. Today they are two sources of truth that can drift apart.
  - Once the Brahmi-encoded font passes its test, render real Unicode text with a web font instead of SVG images. The text becomes selectable, searchable and readable by screen readers, and it also builds the "plain-text use" evidence a Unicode case needs.
  - Keep the familiar key layout as the input method; only the output changes.

### 5.5 Rights

- **Content © Akkha-Rik Project.** Who is that legally? RT? For any book content (vocabulary, sentences, stories) to join the CC BY dataset or AI training, the rights holder has to licence it explicitly.
- **GurbachhanAkkhaRik typeface.** Who made it, and under what licence? Re-encoding it to Brahmi and shipping a web font is a derivative. If it isn't RT's own, it needs the author's permission or an open licence such as OFL [I].

### 5.6 Monetization: compliance the paid certificate triggers [I unless marked]

- **Hosting:** if the app is on Vercel Hobby, a paid feature breaks its "non-commercial, personal use only" terms [V]. Move to Pro or another host before billing.
- **VAT:** a seller with no EU/UK establishment owes **EU VAT (non-Union OSS) and UK VAT from the first consumer sale, with no threshold** [S].
  - A **merchant of record** becomes the legal seller and handles VAT [S]. A plain payment processor leaves it with you.
  - Choose a merchant of record when billing ships.
- **Contributor transparency:** if validated words or recordings appear in the learning app, contributors should know that the app is free to learn but sells an optional certificate. Added to the consent draft (`docs/related/wordlist-pilot-docs.md`).

## 6. Updated path

1. **Answer:**
   - The language of the vocabulary and the sentence content (section 3).
   - Who owns the content and the font (5.5).
   - Where the app is hosted.
   - The account age policy.
2. **Recover and commit `pages_extras.js`** (section 3).
3. **Wordlist v1 = the 269 vocabulary items** (or a 200-item subset), using their English, Nepali and image prompts.
   - Use photos for natural items. Accept AI images only after community review: a wrong-looking image gets the wrong word [I].
4. **Community data lane:** separate repo + Supabase project under the project org; nightly backups; CLDF releases. The learning app consumes the releases.
5. **Learning-app compliance lane** (separate from crowdsourcing):
   - privacy policy and children's policy;
   - data processing agreements;
   - EU/UK representatives;
   - hosting plan;
   - merchant of record before billing.
6. **AI:** unchanged from `docs/AI_FEASIBILITY.md`. If the content turns out to be Magar with translations, phase C (the retrieval prototype in mrig) can start now on the book data.

## Sources

- ICO Children's Code scope: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/services-covered-by-this-code/
- EU/UK VAT for digital services: https://avask.com/blog/vat-for-digital-services/
- Supabase free tier: https://mykavo.app/blog/supabase-free-tier-limits
- Vercel Hobby: https://vercel.com/docs/plans/hobby
- BAMA website: https://bhutanesemagar.org/home
- BAMA nonprofit record: https://projects.propublica.org/nonprofits/organizations/871933591
- FTC COPPA FAQ: https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions
- Amended COPPA rule: https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule
