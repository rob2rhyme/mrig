# mrig — jumpstart prompt

Paste everything below this line into a fresh Claude Code / Cowork / mrig session opened in the repo root. It assumes no memory of previous sessions.

---

You are continuing development of **mrig**, my personal, local, model-agnostic terminal agent — my own Claude-Code-style tool. Read `AGENTS.md` first; it holds the architecture rules and is loaded automatically by Claude Code via `CLAUDE.md`. Priorities live in `docs/ROADMAP.md`; language rules live in `docs/LANGUAGE.md`. This message gives you the state of the project, the working agreement, and what to build next.

## What mrig is

A Bun + TypeScript CLI (`mrig`) that writes and modifies software, runs commands, works with files, and answers general questions. One provider layer (Vercel AI SDK 7) serves Anthropic (`claude-sonnet-5` default, `claude-opus-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001`), OpenAI, and any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter). It is for me alone: private repo, no telemetry, no analytics, no third-party scripts, ever. It compiles to a single binary per OS with `bun build --compile`.

## Current state — v0.1 (Phase 0 + 1 complete)

- `src/agent.ts` — the loop. One `streamText` per step with tools defined **without** `execute`; the loop collects tool calls, gates them through `PermissionManager`, runs them, appends a `role: 'tool'` message, repeats until the model answers with no tool calls or `maxSteps` (default 40). The SDK validates tool names/inputs itself and emits `tool-error` parts; the loop treats those as "continue" so the model can self-correct. `repairJson()` salvages fenced/trailing-comma JSON from weak local models. Usage and estimated cost are tracked per session.
- `src/tools/` — `read` (numbered lines, offset/limit, dir listing, binary guard), `edit` (exact string replace, must match once or `replace_all`), `write`, `bash` (bash/sh on POSIX, PowerShell on Windows; timeout default 120 s, output truncated middle-out to `maxToolOutputChars`), `glob` (Bun.Glob, newest first, skips node_modules/.git/dist), `grep` (ripgrep with `--glob !node_modules` etc., pure-JS fallback). Tools are `defineTool({ name, description, inputSchema (zod), readOnly, summarize, execute })` and throw `ToolError` for model-facing failures.
- `src/permissions.ts` — read-only tools always run; write/edit/bash ask unless `--yolo` or an allow rule matches: `bash:<prefix>`, `write:<glob>`, `edit:<glob>`, `<tool>:*`. Answering "always" learns a rule for the session (`bash:` first two words; path tools → directory glob).
- `src/config.ts` / `src/providers.ts` — defaults → `~/.mrig/config.json` → `./.mrig/config.json` → env (`MRIG_PROVIDER`, `MRIG_YOLO=1`, `MRIG_HOME`) → CLI flags. Named profiles; pricing table for Claude models; `formatModelError()` turns connection/auth/404/429 errors into one actionable line.
- `src/session.ts` — JSONL under `~/.mrig/sessions/<id>.jsonl`; `sync()` appends new messages, rewrites when the transcript shrinks (compaction/clear). `-c` resumes latest in cwd, `-r <id>` a specific one.
- `src/prompt.ts` — system prompt under ~1k tokens (identity, environment, how-to-work rules) plus memory from `AGENTS.md`/`MRIG.md` found from cwd up to the git root, nearest last, plus `~/.mrig/AGENTS.md`.
- `src/ui/repl.ts` — readline REPL: streaming text, `⚙ tool` lines with ✓/✗ and timing, permission prompts (y/n/a), Ctrl+C aborts a run (twice at the prompt exits), slash commands `/model /provider /providers /cost /compact /clear /yolo /sessions /resume /tools /memory /help /exit`. `src/index.ts` — CLI (`src/cli/args.ts`) and headless `-p "prompt"` mode (auto-denies non-read-only tools when there is no TTY; `--yolo` allows). Exit codes 0 done / 1 error / 2 max-steps / 130 aborted.
- Tests: 47 in `tests/` with `bun test`, no network — the loop is tested against `MockLanguageModelV4` via `tests/helpers.ts` (`mockModel`, `textTurn`, `toolTurn`). `scripts/fake-openai-server.ts` is a fake OpenAI-compatible model on :8089 for end-to-end runs (`mrig -P fake -p "what is in README.md"`, or `run <cmd>` to exercise the bash permission path).
- CI: `.github/workflows/ci.yml` runs lint/typecheck/test/build on ubuntu for every push and PR; macos and windows only on PRs to `main`, `v*` tags and manual runs; all four binaries are uploaded on `main` and tags.
- Quality gate: `bun run check` = Biome lint (zero warnings) + `tsc --noEmit` + `bun test` + `bun run build`. It is green at v0.1.

## Known gaps and caveats (do not "fix" silently — mention them when relevant)

- Prompt caching (L0) is implemented for Anthropic profiles but the live acceptance check (step 2 of a 2-step run reports `cacheReadTokens > 0`) still has to be run against the API by hand.
- No automatic context compaction yet; only manual `/compact`. Long sessions on 64k-context local models will eventually overflow.
- No MCP client, no web tools, no reasoning display, no subagents, plain readline UI.
- No offline guarantee yet (L5): nothing stops a remote profile from being used in a sensitive directory.
- `openai` profile default model id `gpt-5` is unverified; `lmstudio` model id is a placeholder. `mrig doctor` (L1) checks both against the server's model list instead of guessing.
- Windows support is compiled and CI-tested but not hand-tested; bash timeout kills the shell process, not the whole tree.

## Working agreement

1. Start every session with `bun install && bun run check` and report the result before changing anything.
2. Never guess an SDK API. Read `node_modules/ai/dist/index.d.ts`, `node_modules/@ai-sdk/provider-utils/dist/index.d.ts`, and `node_modules/@ai-sdk/provider/dist/index.d.ts` before using a type, option, or stream part. AI SDK is v7; tool results use `output: { type: 'text' | 'error-text' | ..., value }`; mock stream parts use `delta` and usage is `{ inputTokens: { total, … }, outputTokens: { total, … } }`.
3. Business logic stays out of the UI. Every behavior change gets a test using the mock-model helpers; no network in tests.
4. Cross-platform always: `node:path`, `detectShell()`, PowerShell variants for any shell-running test.
5. Keep the system prompt under ~1k tokens before memory. Keep the tool set small; prefer improving a tool over adding one.
6. Small, reviewable changes. One feature per commit. Run `bun run check` before declaring anything done; if it is red, it is not done.
7. Never commit `.env`, keys, or `~/.mrig` contents. Never read or reuse Claude Code's leaked source. Never add telemetry.
8. When a task is ambiguous or touches shared config/data, ask one short question first; otherwise proceed and state assumptions.
9. End each session with: what changed (files), what was verified (commands + results), what to commit (suggested message), and what is next.

## Backlog — in priority order, with acceptance criteria

The source of truth for order is `docs/ROADMAP.md`. It has two tracks: **local AI first, Akkha second.** Item IDs match it. Do **one item per commit**, with `bun run check` green.

### Track 1 — Local AI (mrig)

**Local AI v1.0 = L0–L5.**

- **L0. Prompt caching + cache-write pricing (S).**
  - For Anthropic profiles, set request-level automatic caching (`providerOptions.anthropic.cacheControl`) on every `streamText` call.
  - Add one explicit breakpoint, on the last tool definition or the system block.
  - Price `cacheWriteTokens` at 1.25× for 5-minute writes and 2× for 1-hour writes.
  - Add a per-model minimum-prefix table, so `/cost` can explain a miss.
  - Add a `cacheTtl` config option: `5m` default, `1h` optional.
  - Skip local providers.
  - **Acceptance:** manual, against the live API: in a 2-step run, step 2 reports `cacheReadTokens > 0`, and `/cost` shows the write premium. Unit tests cover the pricing math with the mock model.
- **L1. Hygiene (S).**
  - A `mrig doctor` / startup model-id check against the provider's `/v1/models`. It replaces guesswork for the unverified `gpt-5` default and the LM Studio placeholder.
  - Fix session `sync()` so meta is rewritten on long transcripts too.
  - CI trim: Linux on every push; the macOS + Windows matrix only on PRs to `main`, tags and `workflow_dispatch`.
- **L2. Local runtime bring-up and hardening (S–M).**
  - Runtime: Ollama or LM Studio (both support tool calling). **Not `mlx_lm.server`:** it documents no tool calling and is "not recommended for production". MLX is for fine-tuning only.
  - Models to trial on the M4 Pro (24 GB): Qwen3.5-9B (Q4/Q6), Gemma 4 12B (Q4/Q6), Gemma 4 26B-A4B (Q4, tight).
  - Set the context length to fit the GPU memory budget, and record tokens/s.
  - Hardening:
    - with an Ollama profile, query `GET /api/show` at startup and warn when the context is under 32k;
    - add `toolMode: "minimal"` (bash-only) for models that can't do multi-tool calling;
    - retry once on empty tool arguments.
  - **Acceptance:** each candidate model completes a read → edit → bash task, and the hardening behaviours have tests.
- **L3. Agent eval harness (M).**
  - A mini-SWE-agent-style script that runs about 10 repo tasks headless (`-p`) against every profile: read, edit, write, grep/glob, bash, and a multi-step fix.
  - Report per profile: pass rate, tool-call validity, how often `repairJson` was used, tokens/s, and cost.
  - **Acceptance:** a compatibility matrix is committed, and the default `local` profile is chosen from it. Track 2 later adds chrF + human review for language tasks.
- **L4. Two-tier compaction (M).**
  - **Tier (a):** cheap pruning of old tool results and reasoning (AI SDK 7 `pruneMessages`).
  - **Tier (b):** an LLM summary when the estimated transcript tokens exceed a threshold.
    - Estimate tokens as chars/4, or use provider usage when available.
    - The threshold defaults to 70% of `profile.contextWindow`, or of 128k if unset, and is configurable as `compaction.threshold`.
    - It runs before the next step, through the existing `Agent.compact()`, with a configurable `compactModel` (the local model when offline).
    - It keeps the last 4 messages verbatim after the summary, and emits `onNotice`.
  - Trigger rarely, because every compaction invalidates the prompt cache.
  - **Tests:** the threshold triggers with the mock model; below it nothing happens; the transcript after compaction still round-trips through `Session`. A 100-step local session never overflows.
- **L5. Offline guarantee (M).**
  - Triggered by `--offline` or a `.mrig-zone` marker, found by the same upward search as `AGENTS.md`.
  - Behaviour:
    - refuse any profile that isn't on loopback;
    - disable web and remote MCP tools;
    - refuse `--yolo` and bash allow-rules;
    - keep transcripts inside the zone;
    - refuse cross-zone resume.
  - Pure config logic with unit tests.
  - **Acceptance:** the L3 harness passes with networking disabled.
- **L6. MCP → fetch → TUI (S / S / M).**
  - **MCP:**
    - Library: `@modelcontextprotocol/sdk` or `@ai-sdk/mcp` (`createMCPClient`). Choose by reading both `.d.ts` files.
    - Config key: `mcpServers: { name: { command, args, env } | { url } }`.
    - Tools are exposed as `mcp__<server>__<tool>` through the same `MrigTool` interface. They're readOnly false by default, and allow rules work unchanged.
    - `/mcp` lists servers and tools. A server that fails to start produces a notice, not a crash.
    - Tests use an in-process stdio echo server.
  - **Fetch:**
    - Converts a URL to readable text/markdown, with a 100 KB cap and a 20 s timeout.
    - Blocks private and loopback ranges.
    - Asks unless a `fetch:<domain-glob>` rule allows it.
    - Disabled under L5.
    - Web `search` is optional (provider-configurable, one free option).
  - **TUI:** Ink or OpenTUI, with a scrolling transcript and a status line.
- **L7. Quality of life (unranked; only when asked).** `/verbose` toggles reasoning display; `--json` for headless (final text + usage + session id); `--output-last`; `mrig --init` writes a starter `~/.mrig/config.json`.

**Target:** the earlier goal was compaction, MCP and web tools merged before **January 14, 2027**, then simplify and harden rather than expand. Under the new order, MCP and web are L6, after v1.0. **Robin to confirm** whether the date now applies to Local AI v1.0. Until then, treat it as the v1.0 target.

### Track 2 — Akkha, built on mrig (after v1.0)

Language rules: `docs/LANGUAGE.md`. Details: `docs/ROADMAP.md` and `docs/related/`.

- **A1. Font spike (S, font repo, not mrig).** Brahmi re-encode, `brah` script tag, `hb-shape` → Safari / Word / Chrome. It may run earlier, because it touches no mrig code.
- **A2. Transliteration (S/M, after A1).**
  - A Devanagari (NFC) hub ↔ Akkha-Brahmi and ISO 15919-style romanization.
  - A table-driven character map, as pure functions.
  - **Tests:** round-trip property tests on the Akkha-representable subset, plus an explicit lossy-set report (श, ष, visarga, chandrabindu, nukta) that never maps silently.
- **A3. Language memory + font commands (S).**
  - `lang/*.md` conventions, variety tags, and `/lang`, which reports what's loaded and its token count. Keep loaded content stable across turns, so it stays inside the cached prefix.
  - Document fontTools, fontmake, `hb-shape` and fontspector in `AGENTS.md`, with bash allow-rules.
  - The `hb-shape` golden tests live in the font repo.
- **A4. Corpus search over the CLDF export (S→M, after L4).**
  - Ripgrep first: a corpus-aware wrapper over `grep` that searches both the NFC Devanagari and the romanized forms, and returns the source file and line.
  - Embeddings only if plain search fails, and only local embeddings under L5.
- **A5–A8 live outside or alongside mrig:**
  - A5: Akkha-Rik app data fixes.
  - A6: the wordlist pilot.
  - A7: Contribute mode.
  - A8: language evaluation (chrF + human review), then NLLB / speech recognition.
  - See `docs/ROADMAP.md`.

## Start now

Run the checks, confirm green, then implement **L0 (prompt caching + cache-write pricing)** end to end: code, tests, README section, `bun run check`. Stop for review before starting L1.
