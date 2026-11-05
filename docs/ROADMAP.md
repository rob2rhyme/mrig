# Roadmap: Local AI first, Akkha second

Date: November 3, 2026 (reconciled with the repo's JUMPSTART the same day). Robin's decision: **local AI (mrig) is track 1. Akkha integration is track 2, built as part of it.** This supersedes every earlier backlog table (the handoff's revision-4 and "re-ordered" tables). **Track 3, modes and media, was added on November 5, 2026 at Robin's request.**

Labels: **[V]** verified · **[S]** secondary · **[I]** inference or recommendation. Effort: S = under a day, M = a few days, L = a week+ of evenings.

## Track 1 — Local AI (mrig)

Goal: a dependable agent that runs **fully offline** on the M4 Pro (24 GB today, **64 GB planned**; Robin, November 5, 2026: "plan for abundance"), with Claude as an optional online profile.

| # | Item | Effort | Done when |
|---|---|---|---|
| L0 | **Prompt caching** for Claude profiles: automatic caching + one system/tools breakpoint; price cache writes | S | A live 2-step run shows `cacheReadTokens > 0` |
| L1 | **Hygiene**: model-id check via `/v1/models`; session meta sync fix; CI on Linux for every push, macOS/Windows on PRs to `main` only | S | `mrig doctor` flags an unknown model; CI minutes drop |
| L2 | **Local runtime bring-up and hardening** (see notes below) | S–M | Each candidate model completes a read → edit → bash task in mrig. The hardening items below are merged |
| L3 | **Agent eval harness**: a scripted task suite run headless (`-p`) against every profile | M | A compatibility matrix exists, and the default `local` profile is chosen from it |
| L4 | **Two-tier compaction**: prune old tool results (AI SDK `pruneMessages` [V]), then a summary by a configurable `compactModel` (the local model when offline) | M | A 100-step local session never overflows context |
| L5 | **Offline guarantee** (the old "closed-zone guard", generalized) | M | The harness passes with networking disabled |
| L6 | **MCP client** → **local fetch tool** → **TUI** | S / S / M | — |
| L7 | **Quality of life** (unranked; only when asked): `/verbose`, `--json`, `--output-last`, `mrig --init` | S each | — |

**L2 notes:**

- **Runtime:** Ollama or LM Studio. Both have tool calling [V].
- **Not `mlx_lm.server` for the agent.**
  - It documents no tool-calling API.
  - Its docs say it is "not recommended for production" [V].
  - Keep MLX for fine-tuning.
- **Models to trial, first wave at 24 GB** (all Apache 2.0 [V]):
  - Qwen3.5-9B at Q4/Q6
  - Gemma 4 12B at Q4/Q6
  - Gemma 4 26B-A4B at Q4 (tight fit at 24 GB, comfortable at 64 GB)
- **Second wave at 64 GB [I]:** the largest Qwen3.5 and Gemma 4 dense variants at Q6/Q8, Gemma 4 26B-A4B at Q8, and one 70B-class model at Q4 as a ceiling test. Confirm exact tags on ollama.com before pulling; the names here are families, not tags.
- **Memory budget [I]:** leave about 6–8 GB for macOS and apps. That is roughly 16–18 GB for models at 24 GB and 48–52 GB at 64 GB. Context grows memory use too: default to 64k and go to 128k where the model supports it.
- **Speed, not memory, is the ceiling at 64 GB [I].** Decode speed is bounded by memory bandwidth (about 273 GB/s on the M4 Pro) divided by the model's size in memory: a 5 GB model tops out near 50 tok/s, 20 GB near 13, 40 GB near 7. Mixture-of-experts models such as Gemma 4 26B-A4B read only their active experts per token, so they stay fast while knowing more: the sweet spot. The eval harness records real tokens/s; treat these as upper bounds.
- **What 64 GB unlocks:** two models resident at once (a small fast one for routine work, a large one for hard tasks), so T7 routing can be local-to-local and fully offline; a local embedding model alongside for A4 corpus search; local speech models for T5; and headroom for MLX fine-tunes (A8) on larger bases.
- **Hardening** (carried over from the JUMPSTART "local-model hardening" item):
  - with an Ollama profile, query `GET /api/show` at startup and warn when the context is under 32k;
  - add `toolMode: "minimal"` (bash-only) for models that can't do multi-tool calling;
  - retry once on empty tool arguments.

**L3 notes:**

- **Tasks:** read, edit, write, grep/glob, bash, and a multi-step fix.
- **Metrics:** pass rate, tool-call validity, how often `repairJson` was needed, tokens/s, and cost.
- **Reuse:** track 2 later adds chrF scoring plus human review for language tasks.

**L5 notes.** With `--offline`, or a zone marker file, mrig must:

- refuse any provider that isn't on loopback;
- disable web and remote MCP tools;
- keep transcripts inside the zone;
- forbid `--yolo`.

**L6 notes:**

- **MCP library:** `AGENTS.md` names `@modelcontextprotocol/sdk`. `@ai-sdk/mcp` (`createMCPClient`, stable [V]) plugs straight into AI SDK tools. Pick one when L6 starts, by reading both `.d.ts` files, per the repo rule against guessing APIs.
- **Fetch tool:** 100 KB cap, 20 s timeout, blocks private and loopback ranges, asks unless a `fetch:<domain-glob>` rule allows it, and is disabled under `--offline`.

**Milestone "Local AI v1.0" = L0–L5.** L6 and L7 can follow or interleave.

**Target date:** the earlier JUMPSTART goal was compaction, MCP and web tools merged before **January 14, 2027**. Under this order, MCP and web are L6, after v1.0. **Robin to confirm** whether the date now applies to Local AI v1.0.

## Track 2 — Akkha, as part of the local AI

**Order:** starts after Local AI v1.0.

**Exception:** the font spike (A1) lives in the font repo and touches no mrig code. It may run earlier if there's spare time, but nothing in track 1 waits for it.

| # | Item | Effort | Depends on |
|---|---|---|---|
| A1 | **Font spike**: the GurbachhanAkkhaRik font re-encoded to Brahmi, `brah` script tag, `hb-shape` → Safari / Word / Chrome (font repo) | S | — |
| A2 | **Transliteration tool in mrig**: Devanagari (NFC) hub ↔ Akkha-Brahmi + romanization; lossy-set report; round-trip tests | S/M | A1 |
| A3 | **Language memory**: `lang/*.md`, variety tags, `/lang`; font commands in `AGENTS.md`; `hb-shape` golden tests | S | A2 |
| A4 | **Corpus search over the CLDF export** + retrieval for the local LLM | S→M | L4, A3 |
| A5 | **Akkha-Rik app data fixes**: `lang` tag on all 269 vocabulary items; `ak` generated from `deva`; then real Unicode rendering via the web font | S/M | A1, A2 |
| A6 | **Wordlist pilot** (on BAMA's free Kobo Community plan) | S | BAMA agreement |
| A7 | **Contribute mode + dataset releases** (`docs/related/magar-knowledge-platform.md`) | L | A6 |
| A8 | **Language evaluation** (chrF + human review) on the private test sets, then an NLLB fine-tune and speech recognition for pronunciation (MLX / sibling directory) | M–L | L3, A7 data volume |

## Track 3 — Modes and media

Robin's request: teaching and learning modes, a path to image, sound and eventually video generation, and the best answers available from the models mrig can call.

**Order:** starts after Local AI v1.0 (L0–L5). T8 also waits for A3 and A4. Sizes and dependencies here are estimates [I], not commitments.

| # | Item | Effort | Done when |
|---|---|---|---|
| T1 | **Modes**: `/mode` and `--mode` switch named presets of system prompt and permission defaults. `default` is today's behaviour; `teach` explains before acting, works in small steps and asks you to try the next step first; `learn` quizzes you and tracks what you have covered | S | Mock-model tests show each mode changes the prompt and the permission behaviour; the mode is saved in the session; each prompt stays under ~1k tokens before memory |
| T2 | **Learner memory**: what mrig remembers about what you have learned. A decision note first (what is stored, where, how you inspect and delete it), then `/learned` and `/forget` | S–M | Robin approves the decision note; read, write and delete are tested; nothing leaves the machine |
| T3 | **Vision input**: an image path in a prompt reaches vision-capable models as an image part; other models get a clear message | S | A mock-model test shows the image part; a profile without vision is refused politely |
| T4 | **Image generation**: an `image` tool with a configurable provider. It saves a file, returns the path, asks permission and prices each image | S–M | Mock tests for the tool and the price math; one live check with a real provider |
| T5 | **Speech**: `speak` (text to speech) and `transcribe` (speech to text), with a local option for offline use | M | As T4, plus a local round trip with networking disabled |
| T6 | **Video**: a `video` tool that starts a job, polls it and downloads the result, with a cost cap per job | M–L | A short clip is generated end to end; the cap stops an over-budget job |
| T7 | **Model routing** (unranked; only when asked): send easy work to a local model and hard work to a frontier model by rule. At 64 GB the hard-task model can be a large local one, so routing works fully offline | S–M | — |
| T8 | **Akkha tutor mode**: the language tutor, built on `learn` mode, language memory and corpus search | S–M | T1, T2, A3, A4 |

**Notes:**

- **Quality ceiling [I].** mrig cannot be smarter than the model it calls. Profiles for Claude, OpenAI and anything reachable through OpenRouter already give frontier quality; T7 would make the choice automatic. Training a local model to match Claude is not planned.
- **Media tools.** The installed `ai` package exports image, speech, transcription and experimental video functions [V]. Read their `.d.ts` files before building, per the repo rule. Whether Claude models can generate images, audio or video is to be confirmed when building; assume not, so these tools need other providers [I].
- **Shared rules for T3–T6.** Files go on disk and sessions store paths, not bytes. Each call asks permission unless an allow rule such as `image:*` matches. Costs go through the same pricing table. Under the L5 offline guarantee only local generators are allowed. No telemetry.
- **T2 is the one that needs design first.** Do not write code until the decision note exists.

## Not blocked by any track

These are decisions or paperwork, not engineering.

- **BAMA agreement**, plus Nepal advisory seats for Kham and Kaike. The agreement covers Robin's font and content licence to BAMA.
- **Font licence** (SIL OFL recommended) and the "© Robin Thapa" line.
- **Children's accounts** in the live learning app.
  - **If under-13 accounts already exist, this is a current obligation (COPPA, UK Children's Code), not a track 2 item.**
  - Decide between family accounts and accounts at 13+ with lessons open to all (`docs/related/akkha-rik-integration.md` §0.4).
- **Vercel Pro** before certificate billing goes live.

## Sources

- Ollama Anthropic compatibility: https://docs.ollama.com/api/anthropic-compatibility
- LM Studio OpenAI compatibility: https://lmstudio.ai/docs/developer/openai-compat
- mlx-lm server: https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md
- Gemma 4 model card: https://ai.google.dev/gemma/docs/core/model_card_4
- Qwen: https://github.com/QwenLM/Qwen3.6
- AI SDK MCP package: https://registry.npmjs.org/@ai-sdk/mcp
