# Magar language and culture platform: feasibility and plan

Date: October 14, 2026 (updated November 2). Status: **licence and partner decided; a signed partner agreement is the remaining gate.**

## Update, Nov 2: decisions

**Licence: open (CC BY 4.0) for now**, which is model A in §8.

- **Every release is open for good.** CC BY can't be withdrawn [V].
- A paid API stays possible, but only as a **service** (hosting, convenience, custom models). The data itself stays free, and others may also serve it.
- The consent drafts now say exactly this (`docs/related/wordlist-pilot-docs.md`, updated).
- **Keeping options open:**
  - Consent allows publication but doesn't require it.
  - Hold back anything sensitive: sacred or restricted cultural items stay **unpublished**, under community use only.
  - A future restricted tier (model B or C) would apply only to **new** material collected under a new consent version.

**Community partner: Bhutanese American Magar Association (BAMA)**, bhutanesemagar.org [V]:

- a **501(c)(3)**, Harrisburg, PA;
- tax exemption issued Sept 2024;
- files the 990-N (gross receipts under $50k) [V, ProPublica];
- its site hosts a members-only "Akkha-Rik Project" page [V].

What this unlocks [I unless marked]:

- **KoboToolbox's free Community plan** is open to nonprofits [V]. The pilot can run free under BAMA's account.
- **Handover recipient:** a US nonprofit in the same jurisdiction as Robin. The cleanest path is to name it as successor steward in the agreement.
- **A Local Contexts community account** for applying TK Labels. Only communities can hold one [V].
- **Grants and donations** through a 501(c)(3).

**Representation gap [I].**

- BAMA represents the **Bhutanese-American** Magar diaspora.
- **Kham and Kaike speakers live in Nepal.** Cultural knowledge from Nepal should be governed with Nepal-based voices too.
- **Recommendation:** BAMA as lead partner, plus advisory seats for Kham and Kaike speakers from Nepal. Possible sources:
  - a Nepal Magar organisation, e.g. Nepal Magar Association or Magar Studies Center;
  - the KU language lab (`docs/AI_FEASIBILITY.md`).

**The partner agreement should cover [I]:**

- roles: steward, reviewers, the Local Contexts account;
- decision rights over sensitive items and labels;
- use of names and logos;
- **Robin's font and content licence to BAMA** (see `docs/related/akkha-rik-integration.md` §0.2);
- successor-steward and handover terms;
- what happens if the partnership ends.

**Kham:** no extra Akkha letters are needed, so the repertoire is stable. Capture pronunciation with audio and IPA instead [I].


Labels: **[V]** verified against a primary source · **[S]** secondary · **[I]** inference or recommendation.

## What RT wants

1. One PWA (the Akkha-Rik app), not a separate native app.
2. Everything in the PWA feeds the LLM.
3. Adult users get a few questions a day: the meaning of an object, a verb, a noun, and so on.
4. The most common or most-voted answer is selected, verified as final, and stored in the local LLM.
5. Users can add a voice answer to show pronunciation.
6. Images of traditional Magar tools and cultural objects feed the app. The goal is to collect as much Magar cultural knowledge as possible.
7. Storage on an external NAS.
8. The data is audited, managed and securely stored, with a paid API later.

## 1. Verdict

| Part | Feasible? | The catch |
|---|---|---|
| One PWA for learning and contributing | **Yes** on Android. **Yes, with conditions**, on iPhone | The iPhone limits are in section 2. Wrap with Capacitor later if they hurt |
| Daily questions + voting + verification | **Yes** | Votes must be counted **within** each variety, and differing variants kept (section 4) |
| Voice answers | **Yes** | The iPhone installed app asks for the microphone again on every launch (open WebKit bug) [V] |
| Cultural images + knowledge | **Yes, technically.** **Governance is required** | It's collective heritage: Magar is a recognized Adivasi Janajati [V], and UNDRIP Art. 31 applies [V] (section 6) |
| "Store the final answer in the local LLM" | **Not as described** | Facts belong in a database. The LLM reads them (section 3) |
| NAS storage | **Yes, as archive and training store** | It must not be the public server (section 7) |
| Paid API | **Technically easy** | **It contradicts the current consent and licence** (CC BY + "never sold"). This must be decided first (section 8) |

## 2. One PWA or a native app

| Need | Android (Nepal) | iPhone (diaspora) |
|---|---|---|
| Daily reminder | Web Push works; send with `Urgency: high` because of Doze [V]. Installed web apps are exempt from Chrome's automatic permission revocation [V] | Push **only after installing to the Home Screen** (iOS 16.4+, also in the EU since 17.4) [V] |
| Voice recording | MediaRecorder, webm/opus [S] | Supported, MP4/AAC (WebM/Opus since 18.4) [V]. **The installed app re-asks for the mic on every launch** (WebKit 327237, filed Oct 12, 2026) [V] |
| Offline queue | Background Sync supported [V] | **No Background Sync** [V]. Flush the queue when the app opens or comes back online |
| Local storage | Persistent storage is granted by heuristics [V] | Exempt from the 7-day deletion only when installed [V] |
| Photos | The Android photo picker strips location by default [S] | The camera strips GPS; the library picker lets the user choose [V] |
| Store listing | A TWA wrapper adds a Play listing, but not more reliable reminders [V]. Personal Play accounts need a 12-tester, 14-day closed test [V] | Apple rejects "repackaged websites" (4.2) [V] |

**Decision [I]: one PWA with two modes, Learn and Contribute.**

- Push installation hard from the start.
- Email reminders (Resend is already in the stack) as an opt-in fallback.
- **Wrap with Capacitor** (both stores; local notifications that repeat daily without push [V]) only if iPhone reminder completion or the mic re-prompt measurably hurts participation.
- No separate native app now.

**How this fits the earlier "keep data separate" rule:**

- The separation is in the data, not the interface.
- Contribute mode has an 18+ gate and its own consent, and writes to the **community database**.
- Learn mode writes learner progress to the **app database**.
- Learner data (quiz answers, progress) **never** feeds the LLM: those are learners' attempts, they're personal data, and children may be among them.

## 3. "All PWA content feeds the LLM": how, exactly

**Answers are not stored "in" the LLM.**

- Model weights are lossy and can't be audited.
- **Data can't be reliably removed from weights.** Unlearning "is not a general-purpose solution" [V, Cooper et al. 2025]. Exact removal means retraining [V].
- So consent withdrawal would be impossible to honour.

**Instead [I]:**

```
Contribute mode → community DB (source of truth, audited)
                    ↓ verified only
                 versioned release snapshot (CLDF + JSONL + media manifest)
                    ↓                              ↓
   retrieval index for the local LLM      periodic fine-tune (NLLB / LoRA)
   (mrig / Ollama on the Mac)             with a training manifest:
   deletion is real                       dataset version → model version
```

| Feeds the LLM | Never feeds it |
|---|---|
| Verified words, meanings, sentences, pronunciations | Unverified submissions, except as clearly flagged candidates in internal tools |
| Lesson content, once its rights are cleared ("© Akkha-Rik Project") | Learner answers, progress, anything from accounts under 18 |
| Cultural notes whose label allows it | Items labelled Secret/Sacred, Community Use Only or restricted [V labels] |

**Withdrawal:** delete the data from the database → it's excluded from the next snapshot and retrieval index. Models trained earlier keep their old weights. The consent must say so up front.

## 4. Daily questions, voting and verification

**The daily set** [I]: about 5 questions, mixed:

- **2 elicitation:** a new item in your variety.
- **2 validation:** "Is this how your variety says it?"
- **1 recording or cultural:** record a validated word, or describe or photograph an object.

**Choosing questions:** prioritize items with the fewest agreed answers *in the contributor's own variety*. Never repeat an item to the same person.

**Question types:**

- **Nouns:** a picture plus English and Nepali.
- **Verbs:** Magar verbs inflect, so collect a citation form **plus one example sentence**, using a frame or a short video clip ("How do you say 'I am ploughing the field'?").
- **Parts of speech:** a reviewer assigns them, not the contributor.

**Status ladder** [I]:

1. **Submitted**
2. **Candidate:** has one answer.
3. **Community-agreed:** at least 3 independent agreements **from the same variety**, holding at least 70% of that variety's votes.
4. **Verified:** a named reviewer from that variety signs off.
5. **Published.**

**Rules:**

- **Never count votes across varieties.** "Most common overall" would erase Kham's four varieties and Kaike's ~50 speakers.
  - Minority-language judgements vary by gender, region and mother tongue, and "judgements from a single social group may be misrepresentative" [V, Sheehan et al. 2019].
- **Keep variants.** Several forms can all be verified: synonyms, local forms. Disagreement is signal, not noise [V, Uma et al. 2021].
- **Anti-gaming:**
  - one vote per person per item;
  - a new contributor's votes count after a few of their answers match agreed forms;
  - rate limits;
  - reviewer spot-checks.
- **Later:** weight contributors by estimated reliability (Dawid–Skene [V]).

**Reviewers:** 1–2 per variety, ideally paid honoraria. Without them, "verified" means nothing.

**Engagement:** streaks, a coverage map for your village or variety, and opt-in credits.

## 5. Voice answers

- Record one short clip per validated form. Accept Opus and AAC, and normalize on the server [I].
- **Audio consent is separate** (already in the checklist).
- **Strip all metadata on the server**, whatever the browser did [I].
- Volume: 100k clips × ~30 KB ≈ 3 GB [I]. Storage isn't the problem.
- **Bonus:** about 1–2 transcribed hours per variety makes speech recognition for pronunciation practice possible (`docs/AI_FEASIBILITY.md`).

## 6. Cultural images and knowledge

- **Wording:** in community-facing text, say "traditional tools and cultural objects" rather than "primitive". The latter can read as disparaging [I].
- **Image sources, in order of preference:**
  1. Field photography with the owner's consent.
  2. Contributors' own photos, with a licence grant, consent from anyone pictured, and EXIF stripped on the server.
  3. Museum open-access images, with the licence checked per item.
  4. AI images for prompts only. **Never as cultural record.**
- **Metadata per object:**
  - the name in each variety;
  - function and materials;
  - region;
  - who uses it, including any gender or clan restrictions;
  - photo credit;
  - consent reference;
  - **sensitivity label**.
- **Collective heritage.**
  - Magar is item 36 in the NFDIN Act 2002's list of Adivasi Janajati [V].
  - Nepal ratified ILO Convention 169 in 2007 [V].
  - UNDRIP Art. 31: indigenous peoples have the right to "maintain, control, protect and develop their cultural heritage, traditional knowledge…" and the intellectual property over it [V].
  - **Individual adult consent is not enough for collective cultural knowledge** by the field's norms [I].
  - So: a Magar community body must be the governing partner before the cultural module starts.
  - Local Contexts **TK Labels** (e.g. *Secret/Sacred*, *Culturally Sensitive*, *Community Use Only*, *Non-Commercial*, *Women/Men Restricted*) can be applied **only by a community account** [V]. That's one more reason a community body is needed.
- **Default to photos of objects, not people.** Shamanic and ritual items, and Buddhist monastic items, go through community review before publication.

## 7. Storage and security (NAS)

```
Live tier (cloud)        Supabase community project + R2 media
                         TLS, auth, row-level security, public API later
      │ nightly encrypted sync (pull from the NAS side)
Archive tier (home)      NAS: master archive + training data for the Mac's local LLM
      │ weekly encrypted copy
Off-site tier            a second cloud bucket or a rotated offline drive
```

- **3-2-1:** three copies, on two kinds of media, one off-site. RAID is not a backup. Use immutable or versioned NAS snapshots against ransomware. Test a restore every quarter [I].
- **Never expose the NAS to the internet** (no port forwarding, UPnP off). For remote admin, use Tailscale/WireGuard or a Cloudflare Tunnel. Keep firmware updated, and encrypt at rest [I].
- **Don't serve the public app or API from home.** Home upload speed, uptime and attack surface rule it out. The cloud serves; the NAS keeps [I].
- Estimated volume: ~3 GB audio + ~5 GB photos per 100k clips / 10k photos [I]. The cost is in governance, not disks.

## 8. Paid API: the decision that has to come first ⚑

**The conflict:**

- The current drafts license contributions under **CC BY 4.0** and promise **"data never sold"**.
- CC BY lets anyone, including big tech, resell the data or serve it through an API. The licence is irrevocable [V, CC FAQ].
- So the promise can't be enforced, and your paid API would only be a convenience others can copy.

**Options:**

| Model | What it means | Precedent |
|---|---|---|
| **A. Open commons** (CC BY / CC0) | Charge for *services* (hosting, uptime guarantees, custom models), not data. Most reach, least control | Mozilla Common Voice (CC0) [V], Google WAXAL (CC BY 4.0) [V] |
| **B. Tiered benefit-sharing licence** | Free for the community, Nepal, researchers and non-commercial use. Commercial users in high-income countries pay or give back | NOODL (Pretoria/Strathmore, 2026) [V]. Esethu (Lelapa AI): proceeds go "solely" to producing more datasets [V] |
| **C. Permission-only** | No commercial use without explicit grant; use only for the community's benefit | Te Hiku Media's Kaitiakitanga License [V] |
| **D. Hybrid** | An open basic dictionary (CC BY) + a restricted tier (sentences, audio, cultural knowledge) under B or C, served by API key | [I] |

**Recommendation [I]: D, with B for the restricted tier.**

- A Magar community body holds a **veto on commercial licences**.
- **Revenue is shared:**
  - Karya returns *all* resale revenue to the workers who made the data: ~$116k to ~4,000 workers [V].
  - Royalties are reported as "thin" [S].
- Mozilla Data Collective lets data owners set custom licences and prices [V]. It could be the sales channel instead of building billing yourself.

**Market reality [I]:**

- Buyers will be few: NGOs, researchers, language technology firms, and possibly AI labs.
- Labs mostly do partnerships or grants rather than royalties [V for the examples found].
- Treat API revenue as a sustainability bonus, not a business plan.

**What changes:**

- The "never sold" wording goes.
- The consent must describe:
  - the tiered licence;
  - revenue sharing;
  - community approval of commercial licences;
  - AI training;
  - that published releases can't be recalled.
- **This must be decided before the pilot.** Re-consenting contributors later is expensive and loses people.
- Voice is personal data, so commercial licensing needs a contract for each licensee. Get a lawyer's review.
- **Unchanged:** don't train distributed models on Claude outputs.

## 9. Audit and data management

- **Append-only event log** covering:
  - submissions, votes, reviewer decisions, edits, deletions;
  - exports, API access and licence grants;
  - with actor and timestamp for each.
- **Provenance on every item:** contributor pseudonym, variety, consent version, licence tier, TK/BC label, source.
- **Versioned releases** with a datasheet, plus **training manifests** linking dataset versions to model versions.
- **Roles:** contributor, reviewer, community steward, admin, API client. Least privilege.
- **Quarterly community audit:** a sample of verified items, access and export logs, and licence compliance.
- The withdrawal and retention rules follow `docs/related/wordlist-app-launch-checklist.md` (C2, C4, C8).

## 10. Changes to earlier decisions

| Earlier | Now |
|---|---|
| Dataset licence: CC BY 4.0 (Sept 24) | Reopened Oct 14. **Decided Nov 2: open (CC BY 4.0) for now.** Any API is a service, not a sale of data |
| Consent: "never sold" | **Rewritten Nov 2:** the data stays free, and only services may be charged for |
| Community governance: an advisory contact | **A precondition** for the cultural module and the restricted tier |
| Separate crowdsourcing app | **One PWA, two modes, two data stores** |
| Handover conditions | Add: the licence tiers, revenue sharing, and the community veto carry over |

## 11. Phases (replaces the wordlist P0–P5 for this scope)

| Phase | Work | Gate |
|---|---|---|
| 0 | ~~Licence model~~ (open) ✅; ~~partner~~ (BAMA) ✅; consent rewritten ✅; **signed BAMA agreement + Nepal advisory seats** | Signed community agreement |
| 1 | Words-only pilot (Kobo or MVP) | Pilot assumptions confirmed |
| 2 | Contribute mode in the PWA: daily questions, per-variety voting, reviewers, voice | ≥3 agreements on core items per variety |
| 3 | Cultural objects module: photos, notes, TK labels via the community account | Community review process running |
| 4 | Archive pipeline: cloud → NAS → off-site; releases; retrieval index for the local LLM | A restore test has passed |
| 5 | Restricted-tier API under the agreed licence (or via Mozilla Data Collective) | Community-approved licence terms |

## Sources

- **PWA platform behaviour**
  - Apple web push: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers.md
  - EU home-screen web apps (DMA): https://developer.apple.com/support/dma-and-apps-in-the-eu/
  - WebKit mic re-prompt bug: https://bugs.webkit.org/show_bug.cgi?id=327237
  - Background Sync support: https://caniuse.com/background-sync
  - Safari storage eviction: https://webkit.org/?p=10218
  - Chrome notification-permission revocation: https://blog.google/chromium/automatic-notification-permission/
  - Capacitor local notifications: https://capacitorjs.com/docs/apis/local-notifications
- **App stores**
  - Play closed-testing requirement: https://support.google.com/googleplay/android-developer/answer/14151465
  - Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- **Indigenous rights and data governance**
  - NFDIN Act: https://faolex.fao.org/docs/pdf/nep202214.pdf
  - Nepal ratifies ILO 169: https://www.ilo.org/resource/news/nepal-ratifies-ilo-convention-indigenous-and-tribal-peoples-rights
  - UNDRIP: https://www.un.org/development/desa/indigenouspeoples/wp-content/uploads/sites/19/2018/11/UNDRIP_E_web.pdf
  - Kaitiakitanga License: https://raw.githubusercontent.com/TeHikuMedia/Kaitiakitanga-License/master/LICENSE.md
  - NOODL report: https://openfuture.eu/wp-content/uploads/2026/04/260421_NOODL-An-innovation-in-open-data-licensing.pdf
  - Esethu licence: https://arxiv.org/html/2502.15916v1
  - Local Contexts TK Labels: https://localcontexts.org/label/tk-non-commercial/
  - Local Contexts taxonomy: https://localcontexts.org/support/taxonomy/
  - CARE principles: https://datascience.codata.org/articles/dsj-2020-043
  - Karya (TIME): https://tech.yahoo.com/ai/articles/workers-behind-ai-rarely-see-104446022.html
  - Mozilla Data Collective: https://www.mozillafoundation.org/en/meet-mozilla/press-center/mozilla-data-collective-launches
  - CC FAQ: https://creativecommons.org/faq/
- **Machine learning and annotation**
  - Unlearning: https://arxiv.org/abs/2412.06966v2
  - Dawid–Skene: https://ideas.repec.org/a/bla/jorssc/v28y1979i1p20-28.html
  - Annotator disagreement: https://jair.org/index.php/jair/article/view/12752
  - Minority-language speaker variation: https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.01157/
