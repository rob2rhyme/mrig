# mrig — jumpstart prompt

Paste everything below this line into a fresh Claude Code / Cowork / mrig session opened in the repo root. It assumes no memory of previous sessions.

---

You are continuing development of **mrig**, my personal, local, model-agnostic terminal agent — my own Claude-Code-style tool. Read `AGENTS.md` first; it holds the architecture rules and is loaded automatically by Claude Code via `CLAUDE.md`. Priorities live in `docs/ROADMAP.md`; language rules live in `docs/LANGUAGE.md`. This message gives you the state of the project, the working agreement, and what to build next.

## What mrig is

A Bun + TypeScript CLI (`mrig`) that writes and modifies software, runs commands, works with files, and answers general questions. One provider layer (Vercel AI SDK 7) serves Anthropic (`claude-sonnet-5` default, `claude-opus-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001`), OpenAI, and any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter). It is for me alone: private repo, no telemetry, no analytics, no third-party scripts, ever. It compiles to a single binary per OS with `bun build --compile`.

## Current state — v0.1 plus Track 1 items L0–L5

Everything below is v0.1 (Phase 0 + 1). On top of it, L0–L5 are built:

- **L0 prompt caching:** request-level automatic caching plus a system-block breakpoint for Anthropic profiles, cache-write pricing, a minimum-prefix table that `/cost` uses to explain a miss, and `cacheTtl`.
- **L1 hygiene:** `mrig doctor` checks model ids against each provider's model list, the REPL runs the same check at startup, session meta is rewritten in place, and CI runs macOS and Windows only where it matters.
- **L2 hardening:** an Ollama context-length warning, `toolMode: "minimal"` (bash only), and one guided retry on empty tool arguments. Model trials wait on Robin; see `docs/LOCAL_MODELS.md`.
- **L3 eval harness:** `bun run eval` runs ten tasks against profiles and writes `docs/COMPATIBILITY.md`. The real matrix waits on Robin's runs.
- **L4 compaction:** `src/compaction.ts` plus `Agent.maybeCompact()`. Before each step, past `compaction.threshold` (70% of the window), old tool activity is pruned; if that is not enough, all but the last `compaction.keep` messages are summarized, by `compaction.compactModel` if set. Preserved-thinking Claude models skip pruning. `/context` shows the numbers.
- **L5 offline guarantee:** `src/zone.ts` holds the rules; the Runtime applies them at startup, `/model`, `/provider`, the compaction model, `/yolo`, resume and the tool set. Triggered by `--offline` or a `.mrig-zone` marker (same upward search as AGENTS.md). Local profiles only (`isLocalProfile`, shared with the eval harness); prompts always on and bash rules ignored; tools marked `remote` dropped; zone sessions under `<zone>/.mrig/sessions` with a `.gitignore`; no resume across a zone boundary.
- **L6 MCP client:** `src/mcp.ts` (`McpManager`, built on `@ai-sdk/mcp`). `Runtime.startMcp()` connects the servers in `mcpServers` from `~/.mrig/config.json` (a project config's servers are ignored, with a notice) and adds their tools as `mcp__<server>__<tool>`: never read-only, JSON Schema passed through via `MrigTool.parameters`, remote ones marked `remote`. `/mcp` shows status. Test server: `tests/fixtures/mcp-echo-server.ts`.
- **L6 fetch tool:** `src/tools/fetch.ts`, the seventh built-in tool. Asks unless `fetch:<domain-glob>` matches the host; refuses non-public addresses after DNS and on every redirect (`isBlockedAddress`); 20 s, 2 MB download, 100 KB text; HTML converted with Bun's `HTMLRewriter`; `remote`, so offline mode drops it. Residual risk: DNS rebinding between the check and the connection.
- **L6 TUI:** `mrig --tui`. `src/ui/tui-controller.ts` holds all state and behaviour with no React (testable without a terminal); `src/ui/tui.tsx` is the Ink view. Slash commands, the banner and startup checks live in `src/ui/commands.ts`, shared with the readline REPL. Ink loads React DevTools only with `DEV=true`; `stubs/react-devtools-core` stands in for it so the single binary builds. The readline REPL stays the default.

v0.1 in detail:


- `src/agent.ts` — the loop. One `streamText` per step with tools defined **without** `execute`; the loop collects tool calls, gates them through `PermissionManager`, runs them, appends a `role: 'tool'` message, repeats until the model answers with no tool calls or `maxSteps` (default 40). The SDK validates tool names/inputs itself and emits `tool-error` parts; the loop treats those as "continue" so the model can self-correct. `repairJson()` salvages fenced/trailing-comma JSON from weak local models. Usage and estimated cost are tracked per session.
- `src/tools/` — `read` (numbered lines, offset/limit, dir listing, binary guard), `edit` (exact string replace, must match once or `replace_all`), `write`, `bash` (bash/sh on POSIX, PowerShell on Windows; timeout default 120 s, output truncated middle-out to `maxToolOutputChars`), `glob` (Bun.Glob, newest first, skips node_modules/.git/dist), `grep` (ripgrep with `--glob !node_modules` etc., pure-JS fallback). Tools are `defineTool({ name, description, inputSchema (zod), readOnly, summarize, execute })` and throw `ToolError` for model-facing failures.
- `src/permissions.ts` — read-only tools always run; write/edit/bash ask unless `--yolo` or an allow rule matches: `bash:<prefix>`, `write:<glob>`, `edit:<glob>`, `<tool>:*`. Answering "always" learns a rule for the session (`bash:` first two words; path tools → directory glob).
- `src/config.ts` / `src/providers.ts` — defaults → `~/.mrig/config.json` → `./.mrig/config.json` → env (`MRIG_PROVIDER`, `MRIG_YOLO=1`, `MRIG_HOME`) → CLI flags. An untrusted project config may only set `PROJECT_KEYS` (`defaultProvider`, `maxSteps`, `maxToolOutputChars`, `cacheTtl`, `compaction`); `permissions`, `providers` and `mcpServers` are dropped and named in a notice, unless the global `trustedProjects` lists the folder. Named profiles; pricing table for Claude models; `formatModelError()` turns connection/auth/404/429 errors into one actionable line.
- `src/session.ts` — JSONL under `~/.mrig/sessions/<id>.jsonl`; `sync()` appends new messages, rewrites when the transcript shrinks (compaction/clear). `-c` resumes latest in cwd, `-r <id>` a specific one.
- `src/prompt.ts` — system prompt under ~1k tokens (identity, environment, how-to-work rules) plus memory from `AGENTS.md`/`MRIG.md` found from cwd up to the git root, nearest last, plus `~/.mrig/AGENTS.md`.
- `src/ui/repl.ts` — readline REPL: streaming text, `⚙ tool` lines with ✓/✗ and timing, permission prompts (y/n/a), Ctrl+C aborts a run (twice at the prompt exits), slash commands `/model /provider /providers /cost /compact /clear /yolo /sessions /resume /tools /memory /help /exit`. `src/index.ts` — CLI (`src/cli/args.ts`) and headless `-p "prompt"` mode (auto-denies non-read-only tools when there is no TTY; `--yolo` allows). Exit codes 0 done / 1 error / 2 max-steps / 130 aborted.
- Tests: 116 in `tests/` (47 at v0.1) with `bun test`, no network — the loop is tested against `MockLanguageModelV4` via `tests/helpers.ts` (`mockModel`, `textTurn`, `toolTurn`). `scripts/fake-openai-server.ts` is a fake OpenAI-compatible model on :8089 for end-to-end runs (`mrig -P fake -p "what is in README.md"`, or `run <cmd>` to exercise the bash permission path).
- CI: `.github/workflows/ci.yml` runs lint/typecheck/test/build on ubuntu for every push and PR; macos and windows only on PRs to `main`, `v*` tags and manual runs; all four binaries are uploaded on `main` and tags.
- Quality gate: `bun run check` = Biome lint (zero warnings) + `tsc --noEmit` + `bun test` + `bun run build`. It must be green before any change is called done.

## Known gaps and caveats (do not "fix" silently — mention them when relevant)

- Prompt caching (L0) is implemented for Anthropic profiles, but the live acceptance check still has to be run against the API by hand: `cacheReadTokens > 0` from the second request on, once the prompt is longer than the model's minimum cacheable prefix.
- Automatic compaction (L4) needs the right context window: set `contextWindow` on local profiles, or let the REPL read it from Ollama. Headless runs on local profiles without one assume 32,768 tokens.
- No web search, no reasoning display, no subagents. The TUI (`--tui`) is new and not yet hand-tested on macOS or Windows terminals.
- A cloned repo's `AGENTS.md` / `MRIG.md` still goes into the system prompt, so it can try to talk the model into things. The permission prompts are the guard: project configs can no longer grant permissions (2026-11-05), so every write, edit, bash, fetch and MCP call from such a repo still asks.
- The offline guarantee (L5) does not sandbox the shell: an approved bash command can still reach the network. Offline mode keeps every command behind a prompt instead.
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

The source of truth for order is `docs/ROADMAP.md`. It has three tracks: **local AI first, Akkha second, modes and media third.** Item IDs match it. Do **one item per commit**, with `bun run check` green.

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
  - Models to trial on the M4 Pro: first wave at 24 GB: Qwen3.5-9B (Q4/Q6), Gemma 4 12B (Q4/Q6), Gemma 4 26B-A4B (Q4, tight). Second wave at 64 GB, the backup size: the largest Qwen3.5 and Gemma 4 variants at Q6/Q8, and one 70B-class model at Q4 as a ceiling test. Third wave at 128 GB, the target: 100B-class mixture-of-experts and 70B-class dense models, and pairs of a fast routine model with a large hard-task model. Memory, speed, machine choice and backup plans are in ROADMAP "Hardware plan and backups".
  - Set the context length to fit the GPU memory budget, and record tokens/s.
  - Hardening:
    - with an Ollama profile, query `POST /api/show` at startup and warn when the context is under 32k;
    - add `toolMode: "minimal"` (bash-only) for models that can't do multi-tool calling;
    - retry once on empty tool arguments.
  - **Acceptance:** each candidate model completes a read → edit → bash task, and the hardening behaviours have tests.
- **L3. Agent eval harness (M).**
  - A mini-SWE-agent-style script that runs about 10 repo tasks headless (`-p`) against every profile: read, edit, write, grep/glob, bash, and a multi-step fix.
  - Report per profile: pass rate, tool-call validity, how often `repairJson` was used, tokens/s, and cost.
  - **Acceptance:** a compatibility matrix is committed, and the default `local` profile is chosen from it. Track 2 later adds chrF + human review for language tasks.
  - **Follow-up (S):** no `local` profile exists yet. Add it to the built-in profiles once Robin's first matrix exists, plus `local-hard` at 128 GB. This waits on Robin's run; do L4 and L5 meanwhile.
- **L4. Two-tier compaction (M).**
  - **Tier (a):** cheap pruning of old tool results and reasoning (AI SDK 7 `pruneMessages`).
  - **Tier (b):** an LLM summary when the estimated transcript tokens exceed a threshold.
    - Estimate tokens as chars/4, or use provider usage when available.
    - The threshold defaults to 70% of `profile.contextWindow`, or of 128k if unset, and is configurable as `compaction.threshold`.
    - It runs before the next step, through the existing `Agent.compact()`, with a configurable `compactModel` (the local model when offline).
    - It keeps the last 4 messages verbatim after the summary, and emits `onNotice`.
    - Cut at a turn boundary: the kept tail must never start with a tool result whose call was summarized away.
  - **Preserved thinking:** for Claude models that keep thinking blocks (Fable 5.1, Opus 5.5, Sonnet 5.5), tier (a) edits history ahead of kept thinking blocks, which newer accounts can see rejected. Check Anthropic's current docs; for those profiles prefer tier (b), which replaces the whole history.
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
  - **Keep the harness working:** the harness runs with permissions off in temp folders that carry no zone marker and does not pass `--offline`, so the `--yolo` refusal must not apply to it.
  - **One loopback check:** move the harness's `isLocalProfile` into `src/config.ts` and use it for the zone rule too.
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

- **A1. Font spike (S, font repo, not mrig).** Brahmi re-encode, `brah` script tag, `hb-shape` → Safari / Word / Chrome. Run it during v1.0: it touches no mrig code, and A2 waits for it, because a failed Brahmi spike moves the encoding to the PUA fallback.
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

### Track 3 — Modes and media (mrig, after v1.0)

Added November 5, 2026. Starts after Local AI v1.0. Estimates are inferences, not commitments.

- **T1. Modes (S).**
  - `/mode default|teach|learn` and `--mode <name>`.
  - A mode is a named preset of system-prompt text and permission defaults, defined in code.
  - `teach` explains before acting, works in small steps, and asks the user to try the next step first. `learn` quizzes the user and records what was covered.
  - **Acceptance:** mock-model tests show the prompt and the permission behaviour change per mode; the mode is saved in the session meta and survives `-c`; each mode's prompt stays under ~1,000 tokens before memory.
- **T2. Learner memory (S–M).**
  - Write a decision note in `docs/decisions/` first: what is stored, where (local only), how the user inspects it (`/learned`) and deletes it (`/forget`).
  - **Acceptance:** Robin approves the note before any code; then read, write and delete are tested; nothing is sent over the network; the offline guarantee (L5) is respected.
- **T3. Vision input (S).**
  - An image path in a prompt reaches vision-capable models as an image part. Add a profile flag for vision support.
  - **Acceptance:** a mock-model test shows the image part reaching the model; a profile without vision gets a clear message, not a crash.
- **T4. Image generation (S–M).**
  - An `image` tool with a configurable provider. It saves the file, returns the path, asks permission unless an `image:*` rule allows it, and prices each image.
  - **Acceptance:** mock tests for the tool, the permission gate and the price math; a manual live check with one real provider.
- **T5. Speech (M).**
  - `speak` (text to speech) and `transcribe` (speech to text), with a local option.
  - **Acceptance:** as T4, plus a local round trip that passes with networking disabled.
- **T6. Video (M–L).**
  - A `video` tool that starts a job, polls it and downloads the result. The SDK marks video as experimental, so read its types first.
  - **Acceptance:** a short clip is generated end to end; a per-job cost cap stops an over-budget job.
- **T7. Model routing (unranked; only when asked).** Send easy work to a local model and hard work to a frontier model by rule.
- **T8. Akkha tutor mode (S–M).** The language tutor, built on `learn` mode, language memory (A3) and corpus search (A4). **Acceptance:** defined when T1, T2, A3 and A4 have landed.

Shared rules for T3–T6: files on disk, sessions store paths not bytes; every call asks permission unless a rule allows it; costs use the same pricing table; only local generators are allowed under L5; no telemetry. Read the `.d.ts` files for each media function before using it.

## Start now

Run the checks and confirm green. Then read **Build order and status** at the top of `docs/ROADMAP.md` and implement the first item in the agent's queue that is not marked ✅, end to end: code, tests, README section if user-facing, the roadmap mark, `bun run check`. Skip parts marked ⏳: they wait on Robin and never block the next item. Stop for review after one item.
