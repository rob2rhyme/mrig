# Akkha-Rik web app × crowdsourcing × AI: integration analysis

Date: October 14, 2026. Based on the README of `akkha-Rik-BookAndWebApp`, which RT pasted. I couldn't access the repo itself.

Labels: **[V]** verified against a primary source · **[S]** secondary · **[I]** inference or recommendation · **[R]** stated in the README.

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
