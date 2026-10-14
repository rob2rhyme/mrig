# Feasibility: crowdsourced data → AI for Magar Dhut, Kham, Kaike

Date: October 14, 2026. Status: analysis for RT's decision.

Labels: **[V]** verified against a primary source · **[S]** secondary · **[I]** inference or recommendation.

> I could not open `github.com/rob2rhyme/akkha-Rik-BookAndWebApp`. It's private, and this session has no access to it. Section 6 says what I need from it.

## 1. Verdict

| Goal | Feasibility | Why |
|---|---|---|
| Train an LLM from scratch on these languages | **Not feasible** | Pretraining needs billions of tokens; a crowdsourcing project yields thousands to tens of thousands of entries [I]. |
| Crowdsourced **wordlist** (200 items) | **High** for Magar Dhut, **medium** for Kham (4 mutually unintelligible varieties), **low by crowd** for Kaike (~50 speakers; needs direct work with speakers) | — |
| Crowdsourced **parallel sentences** (Nepali ↔ language), 2k–6k per variety | **Medium** for Magar Dhut, **low–medium** for Kham, **very low** for Kaike | — |
| **Akkha learning app** (script lessons, flashcards, dictionary, audio) | **High** | Doesn't need an LLM at all. |
| **AI tutor/translator** using an existing model + your data in its context | **Medium.** Expect a drafting aid, not fluency | See section 2. |
| **Your own fine-tuned translation model** | **Medium**, once you have ≥2k sentence pairs per variety | Fine-tuning NLLB-1.3B is the best offline option. LoRA on a 4–9B LLM is weak. |
| **Speech recognition** (pronunciation practice) | **Medium** for Magar Dhut: about 1–2 hours of transcribed audio per variety gives a usable start | None of the 7 language codes is in Meta's MMS or Omnilingual speech recognition [V]. |

**The short answer.** "Feed the AI" is feasible if it means *an existing model that looks up your validated data while it answers*, plus later a small translation model you fine-tune. Training a Magar LLM is not feasible. The bottleneck is data, not compute: your Mac can fine-tune on 10k examples in about an hour per epoch [I, from documented mlx-lm speeds].

## 2. What the research shows

- **Kalamang, a language with ~200 speakers, learned from one grammar book (MTOB).**
  - Inputs: a 573-page grammar, a 2,531-word wordlist and ~400 parallel sentences.
  - Claude 2 reached chrF ~45. A human learner given the same materials reached 52–57.
  - Gemini 1.5 Pro with the whole book scored English→Kalamang chrF 59, about the human level.
  - With no materials in context, the models couldn't translate at all [V].
- **Parallel sentences drive the gains; grammar explanations barely matter** (Aycock et al., ICLR 2025).
  - Adding the grammar explanations changed scores by under ±1 chrF. Removing the parallel sentences cost up to 8 points.
  - The best predictor was how much of the test set's vocabulary the provided sentences covered.
  - Fine-tuning NLLB-1.3B on ~1.6k sentences beat Gemini working from the whole book.
  - LoRA on Llama-3.1-8B with 1.2k sentences reached only chrF 18–23 [V].
- **Dictionary entries are the next most useful input after sentences.**
  - Manchu: dictionary entries in context lifted BLEU from 3.1 to 7.4 [V].
  - Zhuang: a 16k-word dictionary plus 4.9k sentences took GPT-4 from 0 to 16–32 BLEU [V].
  - Light fine-tuning of 2–7B models is "generally ineffective" for languages nearly absent from the model [V, EMNLP 2025].
- **How many sentences are needed.**
  - About 2k sentence pairs can give a useful fine-tuned translation system, even for unseen languages (MAFAND) [V].
  - NLLB-Seed used about 6k sentences per language [V].
  - Google's SMOL used about 863 sentences per language; fine-tuning added only +3–4 chrF, and retrieving 10 similar examples into the prompt did nearly as well [V].
- **Hallucination and pollution.**
  - Models produce wrong-language output or invented words much more often in low-resource languages [V].
  - 40–60% of some African-language Wikipedias is uncorrected machine translation, which then feeds back into model training [S].
  - **A learning app that shows invented Magar to learners does real harm.**

**What this means for you [I]:**

1. Collect **validated parallel sentences**, not just words.
2. Build the AI as **retrieval over validated data** first, using Claude via the API (open zone).
3. Fine-tune NLLB-1.3B once you have ≥2k sentences per variety, and compare it against (2) on a **private** test set.
4. Never show model-generated Magar to learners as authoritative.

## 3. What already exists

| Resource | Covers | Size | Licence / access |
|---|---|---|---|
| **KU Information & Language Processing Research Lab** | Magar | Kathmandu Post, Aug 22 2026: the Magar community "pledged to provide more than 25,000 sentences and words" [V] | **Most important partner to contact.** Avoid duplicating their work; possible data sharing; possible future handover home |
| Watters 2004, *Dictionary of Kham (Taka)* | Kham | ~6,300 entries, Roman spelling + Devanagari, English glosses | © Watters, free PDF, no licence [V]. Ask permission |
| Wilde 2016, Gamale Kham lexicon | kgj | ~1,400 headwords, Devanagari + IPA, Nepali/English | **CC BY** [V]. Usable now |
| Csépe 2018, Western Magar dictionary | Western Magar (Nawalparasi) | 1,196 entries | **CC BY-NC-ND** [V]. Can't be merged into a CC BY dataset (no derivatives); use as reference only |
| Regmi 2024, Magar Kaike–Nepali–English dictionary | Kaike | ~1,961 headwords | Commercial book [V]. Ask the author |
| ELAR 0481, Kaike (Meelen, SOAS) | Kaike | ~12 h audio/video, ~6 h transcribed and translated | ELAR access terms; cite the depositor [V]. **The richest Kaike source** |
| TU Linguistic Survey of Nepal (2013) | Magar Dhut (7 sites), Kham (5), Kaike (5) | 210-item IPA wordlists | Free PDFs, no licence [V]. Ideal for cross-checking crowd answers |
| SIL Nepal archive (Hale 1973, McAlpine 2000) | mgp, kjl, kzq | Wordlists, texts | Free PDFs, © SIL [V] |
| Bible / New Testament texts | All seven codes (some partial) | Large | **All rights reserved** [V]. Not usable without permission; religious domain |
| Google SMOL, GATITOS, FLORES+, NLLB, MADLAD, Google Translate | — | **None of these languages** [V] | SMOL's English–Nepali source sentences (CC BY 4.0) make good translation prompts |
| Meta MMS language ID | mgp, mrd, kgj, kif, kjl, kzq | — | Can already detect these languages [V] |

**Consequence:**

- Kham and Kaike have more expert-documented data than Magar Dhut.
- Magar Dhut has the most speakers and the KU community pledge.
- Plan collection per variety accordingly.

## 4. Changes to the crowdsourcing plan

1. **Add a sentence task:** "How would you say this in your language?" with short, everyday Nepali sentences.
   - Seed prompts from SMOL's sentences (CC BY 4.0), so the data is comparable with SMOL's 100+ languages [I].
   - Add your own culturally specific sentences.
   - Use FLORES+ only for a private test set. It is CC BY-SA and intended for evaluation, not training [V/I].
2. **Validation applies to sentences too:** at least 3 same-variety speakers agree before a sentence counts.
3. **Collect read-aloud audio of validated words and sentences.** About 1–2 hours of transcribed audio per variety is enough to start speech recognition for pronunciation practice [V].
4. **Keep a private test set from day one:** ~200 sentences per variety, never published, never used in training (contamination [V]).
5. **Kaike:** don't rely on the crowd.
   - Ask ELAR / Meelen and Regmi for permission.
   - Work directly with the few speakers, using facilitator mode.
6. **Consent must name AI training.**
   - The current pilot consent says "dictionary and learning materials" only.
   - **Updated Oct 14** (`docs/related/wordlist-pilot-docs.md`) to add AI training. Because the data is CC BY 4.0, the consent now also says that others, including companies, may use it for AI.
7. **⚑ Decision for RT and the community.**
   - CC BY 4.0 lets anyone, including large AI companies, train on the data.
   - The alternative is to release the dictionary openly but keep the sentence and audio corpus under controlled access (e.g. ELAR "User" or "Subscriber" levels [V]). That is less open, but the community keeps control. This is a CARE / data-sovereignty choice, not a technical one.
8. **Synthetic data:** don't train a distributed model on Claude-generated Magar.
   - Anthropic's terms bar using outputs to train competing models [V, earlier].
   - Machine output in these languages is unreliable anyway.
   - If synthetic augmentation is ever tested, use open-weight models and label the output.

## 5. Roadmap with gates

| Phase | Work | Gate to move on |
|---|---|---|
| A (now–Q1 2027) | Wordlist pilot → MVP. **Contact the KU lab.** Ask permission from Watters, TU LSN, ELAR/Meelen and Regmi. Load the Wilde CC BY lexicon. | Pilot assumptions confirmed; partner response |
| B | Add the sentence task and validation. Build the private test sets (200 per variety). | ≥500 validated sentences for Magar Dhut |
| C | **Retrieval prototype in mrig**: corpus search over the CLDF lexicon + sentences, Claude API, open zone. Score chrF on the test set; native-speaker review. Compare local Qwen3.5-9B / Gemma 4 12B. | chrF and human ratings recorded per variety |
| D | Fine-tune NLLB-1.3B (Mac MPS, or a few dollars of cloud GPU [I]) once ≥2k sentences per variety. | Beats C on the test set, or don't ship it |
| E | Learning-app AI features **built only on validated data**: explain, quiz, example lookup. Generated Magar is clearly marked or not shown. | Community review |
| F | Speech: read-aloud corpus → MMS adapter fine-tune for pronunciation feedback | ≥1–2 h transcribed audio per variety |

**mrig's role:**

- Backlog item 6 (corpus search) becomes retrieval over the CLDF export.
- Add a small **evaluation harness** (chrF + a human-review sheet) as a new backlog item [I].

## 6. What I need from the akkha-Rik book/web app repo

Grant this session access or paste the README. The key questions:

- **Does the book contain example sentences with Nepali/English translations?** Per MTOB and Aycock, those are the most valuable AI input you already own.
- What's in it: script lessons, grammar, vocabulary? Which varieties?
- Its licence and authorship. Can its content join the CC BY dataset?
- Its tech stack. Can the wordlist app share code, auth or the Akkha web font with it?

## 7. Notes

- The ELDP 2026 deadline (Oct 1) has passed. Target the next round with the Kaike/Kham audio documentation pitch [I].
- Western Magar's `mrd` code may have been merged into `mgp` (per Wikipedia citing Ethnologue 27) [S]. SIL and Bible.com still use `mrd`. Keep both tags until checked.

## Sources

- MTOB: https://ar5iv.labs.arxiv.org/html/2309.16575
- Gemini 1.5 report: https://arxiv.org/pdf/2403.05530
- Aycock et al.: https://arxiv.org/html/2409.19151v2
- Manchu: https://arxiv.org/html/2502.11862v1
- Li et al., EMNLP 2025: https://aclanthology.org/2025.emnlp-main.1502.pdf
- Zhuang: https://arxiv.org/html/2402.19167v2
- MAFAND-MT: https://arxiv.org/pdf/2205.02022
- NLLB-Seed: https://aclanthology.org/2023.acl-long.154
- SMOL: https://arxiv.org/html/2502.12301v2 · https://huggingface.co/datasets/google/smol
- FLORES+: https://huggingface.co/datasets/openlanguagedata/flores_plus
- MMS: https://huggingface.co/facebook/mms-1b-all
- Speech-recognition data needs: https://aclanthology.org/2025.fieldmatters-1.3.pdf
- Low-resource hallucination: https://ar5iv.labs.arxiv.org/html/2303.16104
- KU lab: https://kathmandupost.com/science-technology/2026/08/22/ku-info-lab-leads-efforts-to-digitise-and-preserve-nepal-s-indigenous-languages
- Watters, Kham dictionary: https://www.sil.org/system/files/reapdata/87/99/38/87993827156821364547273905654085575544/Kham_dictionary.pdf
- Wilde, Gamale Kham lexicon: https://openresearch-repository.anu.edu.au/bitstream/1885/109195/8/Wilde2016Gamale-lexicon.pdf
- Csépe, Western Magar dictionary: https://www.webonary.org/wmagar/
- Regmi, Kaike dictionary: https://linguistlist.org/issues/36/1685
- ELAR Kaike: https://eldp.access.preservica.com/dk0481/
- TU LSN wordlists: https://portal.tu.edu.np/downloads/Magar-Dhut_2023_09_20_21_28_58.pdf
- Google Translate languages: https://docs.cloud.google.com/translate/docs/languages
