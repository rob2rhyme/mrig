# mrig — handoff summary, revision 11 (with feasibility analysis)

Paste everything below the line into a fresh Cowork/Claude session. It assumes no memory of any previous conversation. It is for strategy, research and decisions, not implementation. Implementation happens in Claude Code inside the repo, driven by `docs/JUMPSTART.md`.

Last updated: September 23, 2026 (revision 4 — see the Revision 4 section first).

- Revision 2 added re-verified facts, corrections, a feasibility pass on every backlog item, and a re-ordered backlog.
- **Revision 3** adds the hardware (M4 Pro, 24 GB) and the fact that the script is **Akkha**, a Brahmi-derived abugida.
- It also records that the current font is an **ASCII-slot font, not PUA**.
- As a result, canonical text moves to **Devanagari**, and display encoding options are re-opened. See `docs/decisions/2026-09-23-akkha-encoding.md`, which travels with this document.

## Priority (rev 11, Nov 3): local AI first, Akkha second

**The current backlog is `docs/ROADMAP.md`. It supersedes both backlog tables in this file.**

- **Track 1 — Local AI (mrig).** Done when it runs fully offline on the M4 Pro, with Claude as an optional profile.
  - L0 prompt caching
  - L1 hygiene
  - L2 local runtime bring-up (Ollama or LM Studio; Qwen3.5-9B / Gemma 4 12B)
  - L3 agent eval harness
  - L4 compaction
  - L5 offline guarantee
  - L6 MCP / fetch / TUI
  - **Local AI v1.0 = L0–L5.**
- **Track 2 — Akkha, built on mrig.** Starts after v1.0. The font spike is the one exception: it may run earlier in the font repo.
  - A1 font spike
  - A2 transliteration
  - A3 language memory
  - A4 CLDF corpus search
  - A5 app data fixes
  - A6 pilot
  - A7 Contribute mode
  - A8 language evaluation, then NLLB / speech recognition
- **Not blocked by either track:**
  - the BAMA agreement
  - the font licence
  - children's accounts in the live app (current obligation if under-13 accounts already exist)
  - Vercel Pro before billing

## Revision 4 — RT's answers (overrides anything below that conflicts)

- **Varieties:** all three use the Akkha script.
  - "Akkha" = Magar Dhut ("dhut" = language), which covers Eastern Magar `mgp` and Western Magar `mrd` [V].
  - Kham covers `kgj`, `kip`, `kif` and `kjl`; the four are mutually unintelligible [S].
  - Kaike is `kzq`; it is Tamangic, with about 50 native speakers in 2011 [S].
  - Tag all data with these codes.
  - **Open question:** Kham has a glottal stop and breathy vowels that Nepali Devanagari lacks [S]. How are they written today, and does Akkha need extra signs for them?
- **Encoding:**
  - **Decided: Unicode Brahmi block**, since Akkha derives from Brahmi. Community sign-off comes before publishing.
  - **ASCII-slot encoding retired now.** No ASCII text exists, so no legacy converter is needed.
- **Monastic punctuation:** needs its own characters; not restricted.
  - Reuse an existing character if one fits.
  - Otherwise use SPUA-A in the interim and write a 2-character proposal; the Brahmi block has 13 reserved slots [V].
- **Dictionary:** not restricted, parked.
  - Nothing current is closed-zone material, so the **closed-zone guard drops down the backlog**. Build it before the first restricted material arrives, not now.
  - All present language work can use API models, which are much stronger at Nepali than a 9B local model [I]. Local fine-tuning becomes less urgent. Compare the options on the eval set first.
- **Full detail:** `docs/decisions/2026-09-23-akkha-encoding.md`.

### Backlog after revision 4 (superseded by `docs/ROADMAP.md`, Nov 3)

| # | Item | Effort | Gate |
|---|---|---|---|
| 0 | Prompt caching + cache-write pricing | S | Live test shows cache reads |
| 0.5 | Hygiene: model-id check, session sync, CI trim | S | — |
| 1 | Font spike: Brahmi re-encode, `brah` tag, hb-shape → Safari/Word/Chrome (**font repo**) | S | Blocks 2 |
| 2 | Transliteration: Devanagari hub ↔ Brahmi + romanization, lossy-set report, round-trip tests | S/M | After 1 |
| 3 | Font commands in `AGENTS.md` + hb-shape golden tests (font repo) | S | — |
| 4 | Language memory layer: `lang/*.md` conventions, variety tags, `/lang` (no lexicon yet — parked) | S | — |
| 5 | Two-tier compaction | M | Before heavy corpus sessions |
| 6 | Corpus search | S→L | After 5 |
| 7 | Closed-zone guard | M | **Before the first restricted material arrives** |
| 8 | MCP → fetch → TUI | S–M each | — |

Outside mrig, in parallel:

- A punctuation-character check, and a 2-character proposal draft if needed.
- Eval sets per variety.
- **Rev 6 decisions (Sept 24), for the wordlist app:**
  - RT is the operator personally, with a documented handover path to an organization.
  - Contributors must be 18+.
  - Dataset licence CC BY 4.0; code licence AGPL-3.0.
  - No UK/EU outreach at launch, no ads, hosting on Cloudflare, 200 items.
  - Kobo's free plan is nonprofit-only; as an individual, RT would need Starter (~$25/month).
  - Pilot documents are drafted in `docs/related/wordlist-pilot-docs.md`.
- **Rev 10 (Nov 2): Robin's decisions**:
  - Licence open (CC BY 4.0) for now; any API is a service only.
  - Partner: the Bhutanese American Magar Association (BAMA), a 501(c)(3) in Harrisburg, PA. Add Nepal advisory seats for Kham and Kaike.
  - Vocabulary is mixed Nepali and Magar, so tag each item's language.
  - Robin Thapa owns the content and the GurbachhanAkkhaRik font.
  - Hosting on Vercel (Hobby → Pro before billing).
  - Learner accounts from age 8: a family-account design is needed for COPPA and the UK Children's Code.
  - Kham needs no extra letters.
  - Details: `docs/related/akkha-rik-integration.md` §0, `docs/related/magar-knowledge-platform.md` (Nov 2 update), `docs/PROJECT_OVERVIEW.md`.
- **Rev 9 (Oct 14): Magar language and culture platform** (`docs/related/magar-knowledge-platform.md`):
  - One PWA with two modes and two data stores.
  - Daily questions with per-variety voting and reviewers; voice answers; a cultural objects module that needs a community partner.
  - The LLM reads verified data by retrieval; nothing goes into the weights.
  - Storage: cloud → NAS → off-site, 3-2-1.
  - **The licence is reopened** for the paid API: the recommendation is a hybrid with a tiered benefit-sharing licence. The pilot consent is marked do-not-use until this is decided.
- **Rev 8 (Oct 14): Akkha-Rik web app integration** (`docs/related/akkha-rik-integration.md`):
  - Next.js 16 + Supabase, 269 vocabulary items, paid certificates, UK/EU-first.
  - Plan: a separate community-data repo + Supabase project, with the learning app consuming the CC BY releases.
  - Open questions: is the vocabulary Nepali or Magar? Who owns the content and the GurbachhanAkkhaRik font? Recover `pages_extras.js`.
  - GDPR, the Children's Code and VAT apply to the learning app.
- **Rev 7 (Oct 14): AI feasibility** (`docs/AI_FEASIBILITY.md`):
  - Training an LLM from scratch is not feasible.
  - The near-term AI is retrieval over validated data with Claude via the API. Fine-tune NLLB-1.3B once there are ≥2k sentences per variety.
  - New mrig items: corpus search over the CLDF export, and an evaluation harness (chrF + human review).
- **Nearest priority (rev 5): the crowdsourced wordlist app.**
  - It is a separate repo, built by Claude Code.
  - It collects item names per language (picture + English/Nepali prompt) and exports a CLDF Wordlist that seeds the dictionary.
  - Plan: `docs/related/wordlist-app-plan.md`. Suggested order: Kobo pilot → MVP → validation and audio → Akkha rendering.
  - Undecided: license, minimum age, hosting (Vercel Hobby is personal/non-commercial only [V]), item count.

## Revision 3 — what's now known

- **Hardware:** Mac mini (2024), Apple M4 Pro, 24 GB unified memory.
- **Script:** Akkha ("Akkha-Rik"), a Brahmic abugida that tracks Nepali Devanagari:
  - an inherent "a", independent and dependent vowels, halant, rakar and anusvara;
  - three subjoined consonants (य, व, ह) that stack under the base;
  - e/ai drawn to the left of the base but typed after it.
  - It is **not** a full 1:1 map: there is no श, ष, visarga, chandrabindu or nukta [V, from the chart].
- **Current encoding:** an ASCII-slot font, with text in logical order [I from glyph names; confirm against the cmap]. The earlier "PUA" premise was wrong.
- **Unicode status:**
  - Pandey's 2011 L2/11-144 calls Magar Akkha a Brahmi variant and recommends unification [V].
  - SEI's 2024 liaison report lists it as "Work Awaiting More Information" [V].
  - A public Magar Akkha web keyboard already encodes Akkha as **Unicode Brahmi**, using Noto Sans Brahmi [V].
- **Language tasks:** all four — dictionary, glossing, translation and learning materials.

Labels used below: **[V]** = verified today against a primary source (vendor docs, registry, standards body). **[S]** = secondary source only. **[I]** = my inference or recommendation, not a fact.

---

I'm RT. I'm building mrig, my own personal terminal AI agent, and using it for a language and font project. You are picking up an ongoing effort, and this message is the full state. Your role in this session is research, architecture and decisions, not writing code. Code gets written by Claude Code running inside the repo on my Mac.

## What mrig is

mrig is a command-line AI agent I own outright: my code, my machine, my choice of model. I type a request in the terminal. It reads and edits files, runs commands, searches the codebase, and answers general questions. It has the same shape as Claude Code, but I control every line and can point it at any model.

- **Repo:** `github.com/rob2rhyme/mrig` (private).
- **Stack:** Bun + TypeScript, Vercel AI SDK 7 as the provider layer, Biome, `bun test`.
  - Bun 1.4.2 (2026-09-05) is the current stable release [V].
  - AI SDK 7 was released 2026-06-25. `ai@7.0.112` and `@ai-sdk/anthropic@4.0.61` are the current `latest` tags [V].
- **Local path:** `~/code/mrig` (moving out of `~/Downloads`).
- **Status:** v0.1 shipped and working against live Claude.
  - Lint, typecheck, 47 tests and build are all green on macOS with Bun 1.4.2.
  - CI runs the same checks on Ubuntu, macOS and Windows.

## Architecture as built

- **`src/agent.ts` — the loop.**
  - One `streamText` per step, with tools defined without `execute`.
  - The loop collects tool calls, gates them through the permission manager, runs them, and appends a `role: 'tool'` message. It repeats until the model answers with no tool calls or hits `maxSteps` (default 40).
  - SDK `tool-error` parts are treated as "continue", so the model can correct itself.
  - `repairJson()` salvages fenced or trailing-comma JSON from weak local models.
- **`src/tools/` — six tools:**
  - `read`.
  - `edit`: exact string replace; the string must match exactly once.
  - `write`.
  - `bash`: bash/sh on POSIX, PowerShell on Windows; has a timeout and middle-out truncation.
  - `glob`.
  - `grep`: uses ripgrep when present, with a pure-JS fallback.
- **`src/permissions.ts`:**
  - Read-only tools always run.
  - `write`/`edit`/`bash` ask first, unless `--yolo` is set or an allow rule matches (`bash:<prefix>`, `write:<glob>`, `edit:<glob>`, `<tool>:*`).
  - Answering "always" learns a rule for the rest of the session.
- **`src/config.ts` / `src/providers.ts`:**
  - Named profiles and layered config: defaults → `~/.mrig/` → `./.mrig/` → env → flags.
  - Profiles: `claude`, `opus`, `fable`, `haiku`, `openai`, `ollama`, `lmstudio`, `llamacpp`, plus anything OpenAI-compatible.
- **`src/session.ts`:** JSONL transcripts in `~/.mrig/sessions/`; resume with `-c` / `-r <id>`.
- **`src/prompt.ts`:** a system prompt under ~1k tokens, plus `AGENTS.md` memory found from the cwd up to the git root.
- **`src/ui/repl.ts`:** readline REPL with slash commands.
- **`src/index.ts`:** CLI and headless `-p` mode.
- **Tests:** use `MockLanguageModelV4`, which is exported from `ai/test` in v7 [V]. No network.
- **`scripts/fake-openai-server.ts`:** a fake model on :8089 for end-to-end runs.

Repo docs that carry the durable detail:

- `AGENTS.md`: architecture rules.
- `docs/JUMPSTART.md`: the prompt for a coding session.
- `docs/LANGUAGE.md`: language and script strategy.

## Decisions already made — don't relitigate without new information

- **Build my own** rather than adopt OpenCode, pi or Goose.
  - The reasons are understanding every line, shaping it to my workflow, and extending it for the language work.
  - Borrowing specific solutions from those projects is fine and encouraged.
- **Provider layer, not hardcoded Anthropic.** One config line switches models.
- **Prompt caching before everything else.** (Revision 2 finds this is now much cheaper to build; see the feasibility section.)
- **Claude cannot be fine-tuned** in any practical sense.
  - The only offering is Claude 3 Haiku on Bedrock, listed as "preview – contact AWS" [V].
  - Any training happens on an open-weight model with MLX locally.
- ~~Romanization is canonical; PUA is a rendering target.~~ **Superseded in revision 3 (proposed):**
  - Canonical text is **Devanagari, NFC-normalized**.
  - Romanization is derived mechanically when needed.
  - Display encoding: prototype **Unicode Brahmi** first, keep **Supplementary PUA-A** as the fallback, and treat ASCII-slot as legacy only.
  - The Brahmi choice has a political dimension the community must weigh in on. See `docs/decisions/2026-09-23-akkha-encoding.md`.
  - The PUA findings below still apply if option B is chosen.
- **Two-zone data separation, not a second machine.**
  - Open zone (`~/code/`): API-backed agents are fine.
  - Closed zone: local model only, no remote access, never in any GitHub repo.
  - **Revision 2 change:** this was discipline; it becomes a technical guard. See backlog item 1.
- **Personal use, not a product.**
  - Never use leaked Claude Code source.
  - Don't name it or skin it as Claude Code if it's ever shared.
  - **Revision 2 addition:** never add Claude subscription (Pro/Max OAuth) login to mrig. See the Terms section.

## What changed in revision 2 (corrections to the previous summary)

1. **Caching is now close to a one-line change.**
   - Anthropic now supports **automatic caching**: a single top-level `cache_control` that the API places on the last cacheable block and moves forward as the conversation grows [V].
   - In AI SDK 7, you pass `providerOptions.anthropic.cacheControl` to `streamText`. This works in the provider source, but the docs page doesn't mention it [V].
   - Per-part `cacheControl` on system, message parts and tools is documented [V].
   - The SDK enforces the 4-breakpoint limit and ignores extras with a warning [V].
2. **Cache-read discounts vary by model.** Cache read is 10% of input on Sonnet 5, 5% on Opus 5.5, and 2.5% on Fable 5.1 [V].
   - Cache **writes cost extra**: 1.25× input for the 5-minute TTL, 2× for the 1-hour TTL [V].
   - `estimateCost` must price `cacheWriteTokens` as well as reads.
   - AI SDK 7 reports both under `usage.inputTokenDetails` [V].
3. **Minimum cacheable prefix per model** [V]. Below the minimum, the request is silently not cached.
   - Sonnet 5: 1,024 tokens.
   - Opus 5.5 / Fable: 512 tokens.
   - Haiku 4.5: 4,096 tokens.
4. **Sonnet 5 pricing: $2 input / $10 output per MTok** is now the standard price. The planned increase to $3/$15 on 1 Sep 2026 was cancelled [V].
   - Your ~$0.03 per question checks out: 12.3k input × $2/M ≈ $0.025, plus output.
   - Models from 4.7 onward use a tokenizer that produces ~30% more tokens for the same text [V]. Keep that in mind when estimating corpus costs.
5. **Server-side compaction exists** (`compact_20260112`, beta) and is reachable through AI SDK 7 `providerOptions.anthropic.contextManagement` [V].
   - It is Claude-only, not supported on Haiku, and invalidates the cache.
   - It does **not** remove the need for our own compaction. See backlog item 6.
6. **The `openai` profile default `gpt-5` is now a legacy model** [V]. The current OpenAI flagship is the GPT-6 family (`gpt-6-astra` / `-sol` / `-luna`) [V].
7. **LM Studio** serves on `http://localhost:1234/v1`, and model ids come from `GET /v1/models` [V]. Replace the placeholder with a lookup, not a guess.
8. **GitHub Actions billing changed on 2026-01-01** [V].
   - The docs now list per-OS per-minute prices (Linux $0.006, Windows $0.010, macOS $0.062) instead of 2×/10× multipliers.
   - Included minutes: Free plan 2,000/month, Pro 3,000.
   - How Windows and macOS minutes count against the included quota isn't stated in the docs [unverified]. Your "~39 min per push" figure assumed the old multipliers, so check the real number on the repo's billing page.
9. **Unicode 18.0 was released 2026-09-16** [V].
   - SEWG guidelines state explicitly that it "will not recommend any proposals to the UTC without an appropriate font in place" [V]. This confirms the font is a required artifact of any proposal.
10. **New font findings that change the design.** See the PUA section: move to Supplementary PUA-A, expect only default shaping, and test each engine separately.

## Costs, verified

- $20 of API credits bought, with auto-reload off so the balance is a hard ceiling.
- Sonnet 5 costs $2 / $10 per MTok. Cache read $0.20, 5-minute cache write $2.50, 1-hour cache write $4 [V].
- Haiku 4.5 costs $1 / $5 [V]. It is the natural model for cheap subtasks such as compaction summaries [I].
- Anthropic web search costs $10 per 1,000 searches plus tokens. Web fetch costs tokens only [V].
- Claude Code runs on my Pro/Max subscription, so development doesn't touch the credits. Agent SDK and `claude -p` usage counts against subscription limits [V].
- **Data retention:**
  - Consumer accounts: 30 days with the training opt-out, 5 years if you opt in [V]. Confirm the setting at claude.ai/settings/data-privacy-controls.
  - API: inputs and outputs are deleted within 30 days and not used for training by default [V].
  - Flagged content can be kept up to 2 years [V].
  - Fable requires at least 30-day retention [V].
- **Illustrative caching savings** [I], for a 20-step session on Sonnet 5 whose context grows from 6k by 1.5k tokens per step:
  - Uncached: ≈ 405k input tokens ≈ $0.81.
  - Cached: ≈ $0.16, about an 80% cut on input.
  - A 2-step question saves only ~25–30%, because the first write costs 1.25×.
  - Idle pauses over 5 minutes expire the cache, so consider a `cacheTtl: "1h"` config option for long interactive sessions.

## Terms (re-verified)

- **Subscription OAuth is off-limits for mrig.**
  - Claude Code's legal page says subscription OAuth is "exclusively" for Claude Code and native Anthropic apps, and that developers "should use API key authentication" [V].
  - There have been enforcement actions against third-party harnesses in 2026 [S].
  - mrig's API-key path is the sanctioned one. Keep it that way.
- **No building competing products or training competing models.**
  - Commercial Terms §D.4 [V] and Consumer Terms (effective 8 Oct 2025) [V] both say so.
  - A personal tool on an API key is fine [I, consistent with the terms].
  - The line is crossed if mrig were distributed as a Claude Code substitute, or if Claude outputs were used to train a model offered to others. Treat the MLX fine-tunes as personal/community artifacts, and don't train them on Claude-generated data if they might ever be distributed [I — ask a lawyer if distribution ever becomes real; I'm not one].

## Font and PUA findings (new, important)

- **Default shaping only.** PUA characters have no Unicode properties, so HarfBuzz's Universal Shaping Engine can't classify them. They go through the default shaper: no syllable clustering and no reordering [V for USE's property dependence; I for the consequence].
- **Features still work if registered under `DFLT`.** HarfBuzz applies ccmp, locl, mark, mkmk, rlig, calt, clig, liga, kern and others for every script [V].
  - Any reordering (pre-base vowels, for example) must either be stored in visual order or done with contextual GSUB in the font [I].
  - Marks need the GDEF mark class, because PUA characters are General Category Co with combining class 0 [I, backed by harfbuzz#2401].
- **Consider moving the mapping to Supplementary PUA-A (U+F0000+).**
  - DirectWrite applies internal rules to BMP-PUA; one reported GSUB failure in Word went away after moving the characters to SPUA-A [S, TypeDrawers].
  - Cost: each character becomes 4 UTF-8 bytes and a UTF-16 surrogate pair [I].
- **Mixed Latin + PUA runs:** HarfBuzz and DirectWrite split PUA text into its own run, so lookups can't cross the boundary. CoreText behaves differently [S].
- **Browsers are not platform tests.**
  - Chrome, Edge and Firefox use HarfBuzz on every OS, including Windows and macOS [V, writingsystems.info].
  - Test CoreText with Safari or TextEdit, DirectWrite with Word or Notepad, and HarfBuzz with Chrome plus `hb-shape`.
  - Android uses HarfBuzz. Ordinary users can't install system fonts there, so plan on a web font or an app-bundled font [I].
- **Collision check:** look at the Under-ConScript registry (UCSUR) roadmap so the mapping doesn't collide with widely installed conscript fonts [I].
- **Tooling update:**
  - FontBakery is no longer actively developed; fontspector is its successor [V].
  - shaperglot tests language-level shaping but would need custom definitions for a PUA script [V].
  - diffenator3 compares two font builds [V].
  - The practical regression test is golden `hb-shape` output [I].
- **Romanization hygiene:**
  - Store all romanized data **NFC-normalized** and enforce it in the transliteration tool and the corpus loader [I, standard practice].
  - Prefer precomposed characters or ASCII digraphs where an existing convention allows, because they tokenize more cheaply [I].
- **Where to look for an existing romanization:**
  - ALA-LC tables (updated 2026-07-24, with an active proposal process) [V].
  - ISO 15919 (second edition at DIS stage, covers 10 Indic scripts) [V].
  - BGN/PCGN (80+ systems) [V].
- **Where to check encoding status:**
  - The Unicode Pipeline table (updated 2026-09-16) [V].
  - The SMP Roadmap [V].
  - SEI at UC Berkeley is active and gives proposal guidance [V].
- **Data sovereignty frameworks worth adopting for closed-zone metadata:**
  - Local Contexts TK/BC Labels, which travel with the data [V].
  - The CARE principles and OCAP® [S].

## Feasibility analysis of the backlog

Effort is S = under a day, M = a few days, L = a week or more of evenings [I].

### 0. Prompt caching — S, do first, low risk

- **Approach:**
  - Set request-level automatic caching with `providerOptions.anthropic.cacheControl` on every `streamText` call for Anthropic profiles.
  - Add one explicit breakpoint on the last tool definition or the system block, so the stable prefix survives transcript changes. That uses 2 of the 4 breakpoints.
- **Tool-heavy steps:** the 20-block lookback counts consecutive tool_use/tool_result blocks as one position, so long tool-heavy steps should be OK [V]. Still assert it in a live test.
- **Required alongside:**
  - Price `cacheWriteTokens`: 1.25× for 5-minute writes, 2× for 1-hour writes.
  - Add a per-model minimum-prefix table, so `/cost` can explain a miss.
  - Add a `cacheTtl` config option: `5m` default, `1h` optional.
- **Acceptance test (manual, live API):** in a 2-step run, step 2 reports `cacheReadTokens > 0`, and `/cost` shows the write premium.
- **Risk:** automatic caching is visible in the provider source but not in the SDK docs [V]. Fall back to explicit per-part breakpoints if it misbehaves.
- **Skip for:** local providers. Ollama's Anthropic-compatible API has no caching [V]; llama.cpp and LM Studio handle KV reuse themselves.

### 0.5 Hygiene batch — S, new

- **Model-id check:** a `mrig doctor` / startup check that queries the provider's `/v1/models` and flags an unknown model id. This covers Anthropic, OpenAI, Ollama and LM Studio [I].
  - It fixes the stale `gpt-5` default and the LM Studio placeholder without guessing future ids.
- **Session sync bug:** rewrite meta on every turn, or on exit and after N messages, not only when the transcript has ≤4 messages.
- **CI:**
  - Run Linux on every push.
  - Run the macOS + Windows matrix only on PRs to `main`, tags, and `workflow_dispatch`.
  - Check actual minutes on the billing page first.

### 1. Closed-zone guard — M, new, must come before the language memory layer

- **Why first:** item 2 loads `lang/*.md` and a lexicon subset into the prompt. If any of that is restricted, it would be sent to Anthropic the first time a Claude profile runs in that directory. Discipline isn't enough; make the tool refuse [I].
- **Mechanism:**
  - A marker file (e.g. `.mrig-zone` containing `closed`) at the closed-zone root, found by the same upward search as `AGENTS.md`.
  - When the marker is present, mrig:
    - refuses any profile whose base URL isn't loopback;
    - disables web and MCP tools;
    - refuses `--yolo` and bash allow-rules;
    - writes session transcripts inside the zone instead of `~/.mrig/sessions/`;
    - refuses to resume a session across zones.
  - This needs unit tests; it is pure config logic [I].
- **Claude Code side:** add a `permissions.deny` read rule for the closed-zone path in `~/.claude/settings.json`, so Claude Code can't read it even by accident [I — confirm the exact rule syntax in Claude Code's docs before relying on it].
- **Mac hygiene** [I]:
  - Keep the closed zone out of `~/Desktop` and `~/Documents` if iCloud "Desktop & Documents" sync is on.
  - Encrypt Time Machine backups.
  - FileVault on.
- **Residual risk:** a local model with bash can still reach the network. Mandatory per-command approval in the closed zone is the realistic mitigation. OS-level network sandboxing is possible but not worth it yet [I].

### 2. Language memory layer — S, depends on 1

- **Feasibility:** easy.
- **Additions:**
  - `/lang` should also report the token count of what's loaded and the zone it came from.
  - Keep the loaded lexicon subset small and **stable across turns**, so it sits inside the cached prefix. A lexicon that changes every turn defeats caching [I].

### 3. Encoding decision — partly settled in revision 3, blocks 4

- **Known now:**
  - Text is in logical order.
  - There is no reordering in the data; the font handles it.
  - The mapping is one-for-one per character, apart from the known gaps.
- **Remaining:**
  - Brahmi (C) vs SPUA-A (B) for display.
  - What to do with श, ष, visarga, chandrabindu and nukta. Map them lossily (e.g. श/ष → स) or flag them?
  - Whether the monastic punctuation needs codepoints.
- **Prerequisite:** a 1-day font spike (`brah` script tag, 10 test words, run through hb-shape → Safari → Word → Chrome) before choosing C [I].

### 4. Transliteration tool — S/M, depends on 3

- **Structure:** a hub-and-spoke design with Devanagari (NFC) as the hub.
- **Spokes:**
  - Akkha-ASCII (legacy converter)
  - Akkha-Brahmi
  - Akkha-PUA
  - ISO 15919-style romanization
- **Mapping:** a table-driven character map, since the data has no reordering. The earlier "rules + reorder pass" concern no longer applies [I].
- **Tests:** round-trip property tests on the Akkha-representable subset. Out-of-subset characters are reported as an explicit lossy set, never silently changed.
- **Scope:** pure functions, no model involvement.

### 5. Font commands and shaping golden tests — S

- **Docs:** document fontTools, fontmake, `hb-shape` and fontspector in `AGENTS.md`, with bash allow-rules for them.
- **Tests:** add a golden-file shaping test (`hb-shape` output for a fixed word list, checked against expected output) in the **font repo**, not in mrig.
- **CI:** run it on Linux only, which is cheap.
- **Manual testing:** CoreText and DirectWrite checks stay manual. Keep a short manual checklist [I].

### 6. Automatic compaction — M, higher priority than it looks

- **Key point:** corpus sessions happen in the **closed zone on local models**. Server-side compaction can't help there, and local context windows are effectively limited by RAM through the KV cache. Client-side, provider-agnostic compaction is mandatory [I].
- **Two tiers** [I]:
  - (a) Cheap pruning of old tool results and reasoning. AI SDK 7's `pruneMessages` does exactly this [V].
  - (b) An LLM summary once a token threshold is hit, using a configurable `compactModel`: Haiku 4.5 in the open zone, the local model in the closed zone.
- **Claude-only extra:** optionally enable `compact_20260112` for Claude profiles later. Not needed initially.
- **Caching interaction:** every compaction invalidates the cache, so trigger it rarely (high threshold), not continuously.

### 7. Corpus search tool — S (ripgrep) to L (embeddings)

- **Ripgrep first:** it already exists as `grep`. Add a corpus-aware wrapper that searches both the romanized form and the NFC-normalized form, and returns the source file and line.
- **Embeddings:** only if plain search fails. In the closed zone they must use a local embedding model [I].

### 8. MCP, web, TUI — S–M each, unchanged position

- **MCP:** `@ai-sdk/mcp` `createMCPClient` is now stable (2.0.56) [V], so MCP is S.
- **Web:** build a provider-agnostic `fetch` tool (HTML → text). Anthropic's server-side web fetch is cheaper to wire in, but only works for Claude [V]. Disabled in the closed zone.
- **TUI:** still last.

### Considered and deferred [I]

- **Migrating to AI SDK 7's `ToolLoopAgent`:** no. The hand-rolled loop is what makes permission gating straightforward.
- **Pointing `@ai-sdk/anthropic` at Ollama or LM Studio's new Anthropic-compatible `/v1/messages`:** no benefit over the OpenAI-compatible path, and no caching [V for the feature].
- **Batch API (50% off) for bulk open-zone processing:** useful later for one-off corpus-wide jobs, open zone only.
- **The free token-counting endpoint** [V]: nice for `/cost` estimates but adds a network call. Use response usage instead.

## Local model path (for when the RAM answer comes in)

- **Strongest open-weight families today** [V]:
  - **Qwen3.5 / 3.6:** Apache 2.0, 201 languages, strong tool calling. Dense 4B / 9B / 27B, plus 35B-A3B MoE.
  - **Gemma 4:** Apache 2.0, 140+ languages, native function calling. E4B, 12B, 26B-A4B MoE, 31B.
- **Rough fit** at Q4 inference and 4-bit QLoRA training [S/I]:

| Unified memory | Inference | Fine-tuning |
|---|---|---|
| 16 GB | 4–9B | 3–4B comfortably, 7–9B tight |
| 32 GB | 35B-A3B MoE, 27B tight | up to ~9B |
| 64 GB | 27–31B dense at Q6–Q8 | up to ~30B dense |
| 128 GB | 122B-A10B-class | 30B+ |

- Current versions: mlx-lm 0.31.3, mlx 0.32.2 [V].
- mlx-lm's own LoRA docs give only one hard data point: Mistral-7B LoRA on a 32 GB M1 Max [V]. Treat the table as planning figures, not guarantees.

### RT's machine: M4 Pro, 24 GB [I]

- **Memory budget:** by default macOS lets the GPU wire only part of unified memory, very roughly 16–18 GB of the 24. It can be raised with `sysctl iogpu.wired_limit_mb` at the cost of system headroom [I — measure it].
- **Inference, comfortable:**
  - Qwen3.5-9B at Q4–Q8.
  - Gemma 4 E4B or 12B at Q4–Q6.
- **Inference, tight:**
  - Gemma 4 26B-A4B at Q4.
  - Qwen3.5-27B at Q4 (slow).
- **Inference, too big:** Qwen3.6-35B-A3B at Q4 (~20 GB).
- **Fine-tuning:**
  - 4B QLoRA is comfortable.
  - 9B QLoRA works with short sequences, batch 1–2 and gradient checkpointing.
  - 12B is marginal.
- **Default local profile to start with:** Qwen3.5-9B or Gemma 4 12B for the language work; try both on the eval set before committing.

### What the language tasks imply [I]

- **Magar is very low-resource.** Expect models to know Nepali well and Magar barely.
  - Translation will lean on a Nepali pivot, plus lexicon entries and example sentences retrieved into the context.
  - Fine-tuning mostly teaches format and style, not the language, until the corpus is substantial.
- **Build an evaluation set before any fine-tuning:** ~100 held-out Magar↔Nepali/English sentence pairs, plus gloss lines.
  - It is the gate for every "is fine-tuning worth it" decision.
- **Store the lexicon as structured data, not markdown:** TSV or JSONL with these fields:
  - headword (Devanagari)
  - derived romanization
  - part of speech
  - Nepali and English glosses
  - examples
  - source
  - access label (TK/BC)
  - The `lang/*.md` memory files describe conventions; the lexicon is data that retrieval queries.
- **Glossing follows the Leipzig Glossing Rules** (interlinear: text / morphemes / glosses / free translation).
  - Evaluate SIL FieldWorks (FLEx) as the system of record for dictionary and glossing before building a custom one. Check that it runs on macOS; I haven't verified that.
- **Learning materials** render Akkha through the transliteration tool at the display edge.

## Known gaps and caveats (updated)

- No automatic compaction yet; only manual `/compact`.
- No prompt caching yet (item 0).
- `openai` default model is legacy and the `lmstudio` model id is a placeholder (item 0.5).
- Windows is CI-tested but not hand-tested.
- Font rendering needs per-engine testing: CoreText, DirectWrite and HarfBuzz. Browsers only exercise HarfBuzz.
- Claude Code (`~/.claude/projects/`) and mrig (`~/.mrig/sessions/`) store plaintext transcripts. FileVault matters, and closed-zone transcripts must stay in the zone (item 1).
- Session `sync()` meta lag on long sessions (item 0.5).
- The closed-zone boundary is procedural until item 1 ships.

## Re-ordered backlog (superseded by `docs/ROADMAP.md`, Nov 3)

| # | Item | Effort | Gate |
|---|---|---|---|
| 0 | Prompt caching + cache-write pricing | S | Live test shows cache reads |
| 0.5 | Hygiene: model-id check, session sync, CI trim | S | — |
| 1 | Closed-zone guard | M | Must land before any restricted data is touched |
| 2 | Language memory layer + `/lang` | S | After 1 |
| 3 | Encoding-model decision | decision | Blocks 4 |
| 4 | Transliteration (rules + NFC + round-trip tests) | M/L | After 3 |
| 5 | Font commands + hb-shape golden tests (font repo) | S | — |
| 6 | Compaction, two-tier, provider-agnostic | M | Before heavy corpus sessions |
| 7 | Corpus search | S→L | After 6 |
| 8 | MCP → fetch → TUI | S–M each | — |

Fine-tuning (MLX LoRA) stays outside mrig, in a sibling directory.

## Open questions — what I'd want to know that isn't in this summary

**Revision 3 status:**

- **Answered:**
  - Q1: M4 Pro, 24 GB; free disk still unknown.
  - Q2: Akkha, a Brahmic abugida.
  - Q3: ASCII-slot font, not PUA; confirm against the cmap.
  - Q4: logical order.
  - Q7: all four tasks.
  - Q8: a keyboard layout already exists (the ASCII chart), plus a third-party web keyboard on Brahmi codepoints.
- **Still open:** Q5 (community authority and whether the lexicon is closed zone), Q6, and Q9–Q14.
- **New questions:**
  - Which language(s): Eastern Magar, Western Magar, other?
  - Does ASCII-encoded Akkha text already exist?
  - What is the community's stance on Brahmi unification?

1. **Mac chip, unified memory and free disk space.** These decide local inference and fine-tuning. Run `sysctl hw.memsize | awk '{print $2/1073741824" GB"}'`, and also give the chip.
2. **Script structure** (placeholders are fine):
   - Alphabet, abugida, abjad or syllabary?
   - Writing direction?
   - Combining marks?
   - Any reordering or contextual forms?
   This decides how hard PUA shaping will be.
3. **Current PUA assignment:**
   - BMP or SPUA?
   - Who assigned it?
   - Does anyone else already have text, fonts or keyboards on it? If so, re-mapping breaks existing text.
4. **Storage order:** is existing PUA text stored in logical or visual order?
5. **Community authority:**
   - Who grants permission?
   - Is there a written protocol?
   - What exactly is restricted (lexicon, texts, audio, names)?
   - **Is the lexicon open zone or closed zone?** This decides whether item 2 can ever use a Claude profile.
6. **Corpus:** size and form (paper, scans needing OCR, digital, audio), and where it physically lives today.
7. **The actual language tasks:** dictionary building, glossing, translation, learning materials, OCR cleanup, text generation? This decides whether fine-tuning is needed at all or whether retrieval is enough.
8. **Input method:** how does the community type the script today? A keyboard layout (e.g. Keyman [I]) may matter as much as the font for real-world use.
9. **Existing romanization:** does one already exist (check the sources listed above)?
10. **Encoding intent:** does the community want Unicode encoding?
11. **GitHub plan and Actions usage:** Free or Pro, and the actual minutes used so far this month.
12. **Budget:** which model the `claude` profile defaults to, and a monthly spend target once the $20 is gone.
13. **Mac settings:** is iCloud "Desktop & Documents" sync on, and are Time Machine backups encrypted?
14. **Sharing:** will anyone besides me ever run mrig? That changes the terms and licensing picture.

## The three lanes

- **Claude Code in `~/code/mrig`:** all implementation, driven by `docs/JUMPSTART.md`. One backlog item per commit; `bun run check` must be green before anything is called done.
- **This session:** research, architecture, decisions and documents. No implementation.
- **mrig itself:** takes over more of both as it matures. That's the point.

## How I want you to work with me

- Be direct and concrete.
- Verify current facts by searching rather than answering from memory; model prices, API terms, tool versions and benchmark numbers all move.
- Flag when something I've assumed is wrong.
- Keep the [V]/[S]/[I] distinction.
- Don't produce code here. Produce decisions, research and documents I can hand to Claude Code.

## Key sources

- Anthropic:
  - Pricing: https://platform.claude.com/docs/en/about-claude/pricing
  - Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  - Threshold compaction: https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
  - Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
  - Commercial Terms: https://www.anthropic.com/legal/commercial-terms
  - API data retention: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- AI SDK Anthropic provider: https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- npm registry: https://registry.npmjs.org/ai, https://registry.npmjs.org/bun
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- MLX LoRA docs: https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md
- Open-weight models:
  - Qwen: https://github.com/QwenLM/Qwen3.6
  - Gemma 4 model card: https://ai.google.dev/gemma/docs/core/model_card_4
- Local servers:
  - Ollama Anthropic compatibility: https://docs.ollama.com/api/anthropic-compatibility
  - LM Studio OpenAI compatibility: https://lmstudio.ai/docs/developer/openai-compat
- Unicode:
  - Unicode 18.0 announcement: https://blog.unicode.org/2026/09/announcing-unicode-standard-version-180.html
  - SEWG guidelines: https://sew.unicode.org/guidelines
  - Pipeline table: https://www.unicode.org/alloc/Pipeline.html
  - SEI: https://sei.berkeley.edu/
- Shaping:
  - HarfBuzz default features: https://harfbuzz.github.io/shaping-opentype-features.html
  - Universal Shaping Engine: https://learn.microsoft.com/en-us/typography/script-development/use
  - Testing shaping engines: https://writingsystems.info/topics/fonts/testing-shaping-engines/
  - DirectWrite and the PUA: https://typedrawers.com/discussion/5014/directwrite-and-the-unicode-pua-can-they-work-together
- PUA registry: https://www.kreativekorp.com/ucsur/roadmap.shtml
- Font tools: https://github.com/fonttools/fontspector, https://github.com/googlefonts/shaperglot
- Romanization: https://www.loc.gov/catdir/cpso/roman.html, https://www.iso.org/standard/87130.html
- Data sovereignty: https://localcontexts.org/labels/about-the-labels/
