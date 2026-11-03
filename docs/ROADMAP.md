# Roadmap: Local AI first, Akkha second

Date: November 3, 2026 (reconciled with the repo's JUMPSTART the same day). Robin's decision: **local AI (mrig) is track 1. Akkha integration is track 2, built as part of it.** This supersedes every earlier backlog table (the handoff's revision-4 and "re-ordered" tables).

Labels: **[V]** verified · **[S]** secondary · **[I]** inference or recommendation. Effort: S = under a day, M = a few days, L = a week+ of evenings.

## Track 1 — Local AI (mrig)

Goal: a dependable agent that runs **fully offline** on the M4 Pro (24 GB), with Claude as an optional online profile.

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
- **Models to trial** (all Apache 2.0 [V]):
  - Qwen3.5-9B at Q4/Q6
  - Gemma 4 12B at Q4/Q6
  - Gemma 4 26B-A4B at Q4 (tight fit)
- **Context:** set the context length to fit the GPU memory budget (about 16–18 GB by default [I]), and record tokens/s for each model.
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

## Not blocked by either track

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
