# Roadmap: Local AI first, Akkha second

Date: November 3, 2026 (reconciled with the repo's JUMPSTART the same day). Robin's decision: **local AI (mrig) is track 1. Akkha integration is track 2, built as part of it.** This supersedes every earlier backlog table (the handoff's revision-4 and "re-ordered" tables). **Track 3, modes and media, was added on November 5, 2026 at Robin's request.**

Labels: **[V]** verified · **[S]** secondary · **[I]** inference or recommendation. Effort: S = under a day, M = a few days, L = a week+ of evenings.

## Track 1 — Local AI (mrig)

Goal: a dependable agent that runs **fully offline** on Robin's Mac, with Claude as an optional online profile. Hardware: an M4 Pro with 24 GB today; **target 128 GB**, with 64 GB as the backup (Robin, November 5, 2026: "plan for abundance"). See **Hardware plan and backups** below.

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
  - Gemma 4 26B-A4B at Q4 (tight fit at 24 GB, comfortable from 64 GB)
- **Second wave at 64 GB [I]:** the largest Qwen3.5 and Gemma 4 dense variants at Q6/Q8, Gemma 4 26B-A4B at Q8, and one 70B-class model at Q4 as a ceiling test.
- **Third wave at 128 GB, the target [I]:** 100B-class mixture-of-experts models at Q4–Q6, 70B-class dense models at Q6/Q8, and **pairs** of models loaded together (a fast routine model plus a large hard-task model), evaluated as a pair.
- Confirm exact tags on ollama.com before pulling any wave; the names here are families, not tags.
- **Memory budget [I]:** leave 6–8 GB for macOS and apps at 24–64 GB, and 10–12 GB at 128 GB. That gives roughly 16–18 GB for models at 24 GB, 48–52 GB at 64 GB and 105–115 GB at 128 GB. macOS limits how much memory the GPU may use by default; the `iogpu.wired_limit_mb` sysctl raises it [I, verify on the machine before relying on it]. Context grows memory use too: default to 64k and go to 128k where the model supports it.
- **Speed, not memory, is the ceiling from 64 GB up [I].** Decode speed is bounded by memory bandwidth divided by the model's size in memory. For a 40 GB model that is about 7 tok/s on the M4 Pro (about 273 GB/s), 15 on an M5 Max (614 GB/s [S]) and 30 on an M5 Ultra (up to 1.2 TB/s [V]). Mixture-of-experts models read only their active experts per token, so they stay fast while knowing more: the sweet spot at every size. The eval harness records real tokens/s; treat these as upper bounds.
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
| T7 | **Model routing** (unranked; only when asked): send easy work to a local model and hard work to a frontier model by rule. From 64 GB the hard-task model can be a large local one, and at 128 GB both stay loaded, so routing works fully offline | S–M | — |
| T8 | **Akkha tutor mode**: the language tutor, built on `learn` mode, language memory and corpus search | S–M | T1, T2, A3, A4 |

**Notes:**

- **Quality ceiling [I].** mrig cannot be smarter than the model it calls. Profiles for Claude, OpenAI and anything reachable through OpenRouter already give frontier quality; T7 would make the choice automatic. Training a local model to match Claude is not planned.
- **Media tools.** The installed `ai` package exports image, speech, transcription and experimental video functions [V]. Read their `.d.ts` files before building, per the repo rule. Whether Claude models can generate images, audio or video is to be confirmed when building; assume not, so these tools need other providers [I].
- **Shared rules for T3–T6.** Files go on disk and sessions store paths, not bytes. Each call asks permission unless an allow rule such as `image:*` matches. Costs go through the same pricing table. Under the L5 offline guarantee only local generators are allowed. No telemetry.
- **T2 is the one that needs design first.** Do not write code until the decision note exists.

## Hardware plan and backups

Robin's direction (November 5, 2026): plan for abundance, **target 128 GB**, and keep backup plans. Everything here is an estimate [I] unless marked.

**Memory cannot be added later** on Apple silicon, the DGX Spark or the Ryzen AI Max boxes [I]: buy the final size once.

### The 128 GB machine

| Option | Memory | Bandwidth | Fit for mrig |
|---|---|---|---|
| **Mac Studio, M5 Max, 128 GB** (recommended) | 128 GB | 614 GB/s [S] | macOS is where mrig is developed and hand-tested; MLX for fine-tuning; quiet |
| Mac Studio, M5 Ultra | 96–512 GB [V] | up to 1.2 TB/s [V] | Twice the speed for big models; much higher price |
| NVIDIA DGX Spark | 128 GB [S] | 273 GB/s [S] | Linux and CUDA: strongest for fine-tuning and image or video generation; mrig not hand-tested on Linux |
| AMD Ryzen AI Max+ 395 box | 128 GB, about 96–120 GB usable by the GPU [S] | about 256 GB/s [S] | Cheapest 128 GB; Linux preferred; mrig not hand-tested |

**Decision needed (Robin):** which machine. Recommendation [I]: the M5 Max at 128 GB. Move to the Ultra only if the eval shows the hard-task model too slow to use.

### The full setup at 128 GB

Loaded at the same time:

| Role | Example | Memory |
|---|---|---|
| Routine model, always loaded | a fast mixture-of-experts model, such as Gemma 4 26B-A4B at Q8 | about 28 GB |
| Hard-task model | a 70B-class dense or 100B-class mixture-of-experts model at Q4 | about 40–60 GB |
| Embeddings for A4 corpus search | a small local embedding model | about 1–2 GB |
| Speech for T5 | local speech-to-text and text-to-speech | about 2–4 GB |
| Context for both models | 64k–128k each | about 10–20 GB |
| macOS and apps | — | about 10–12 GB |

The upper ends do not all fit at once; trim the hard-task model or its context to stay under 128 GB.

What this setup gives:

- **Hybrid, fully offline.** T7 routes routine work to the fast model and hard work to the large one. Claude stays optional, for the hardest problems or a second opinion.
- **Two defaults instead of one.** L3 picks `local` (routine) and `local-hard` from the matrix, both by the same rule.
- **Track 3 locally.** Speech and image generation run on the machine where a good local model exists; video probably stays hosted at first.
- **Fine-tuning at home.** MLX fine-tunes (A8) on larger bases, and trials of the "saved knowledge" and fine-tuning routes for making local models better at your own work.

### Backup plans

**Hardware ladder.** The plan degrades gracefully; nothing in mrig depends on having the target machine.

| If the machine has | Local handles | Claude handles |
|---|---|---|
| 128 GB, the target | routine and hard tasks, fully offline; speech and images | only the hardest problems, optionally |
| 64 GB, the backup | routine tasks on a strong mixture-of-experts model; one large model at a time, swapped in when needed | hard tasks when speed matters |
| 24 GB, today | routine tasks on first-wave models | planning, hard bugs, big refactors |
| any size, but no local model passes L3's 70% bar | private and simple tasks only | the default for coding until a model passes |

**Other fallbacks:**

- **Runtime.** Ollama first. LM Studio and llama.cpp profiles already exist if Ollama mishandles a model's tool calling.
- **Tool calling.** `toolMode: "minimal"` for models that cannot juggle six tools.
- **Model families.** If a family's licence or quality changes, re-run the eval; nothing in mrig is tied to one family.
- **Cloud provider.** If Anthropic is unavailable or too costly, OpenAI and OpenRouter profiles take the online role. L5 keeps sensitive projects local either way.
- **Media (Track 3).** A local generator first, a hosted provider if no local one is good enough; L5 refuses the hosted ones in offline zones.
- **Improving local models.** If fine-tuning on another provider's outputs is not allowed by its terms, or does not move the eval scores, fall back to saved knowledge and retrieval (T2, A4).
- **Buying a non-Apple machine.** Hand-test mrig on Linux first; CI covers Linux, but nobody has used it there yet. Windows last.
- **Supply and price.** The 512 GB and 256 GB Mac Studio options were pulled for months in 2026 during a memory shortage [S]. If 128 GB is unavailable or too expensive, take 64 GB and follow the ladder rather than wait.

**Data backups.** Back up `~/.mrig`: config, sessions, and learner memory once T2 exists. Eval results and the matrix live in git. Models can be pulled again, so record exact tags with every eval run to keep results reproducible.

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
