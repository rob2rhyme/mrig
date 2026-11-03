# mrig — jumpstart prompt

Paste everything below this line into a fresh Claude Code / Cowork / mrig session opened in the repo root. It assumes no memory of previous sessions.

---

You are continuing development of **mrig**, my personal, local, model-agnostic terminal agent — my own Claude-Code-style tool. Read `AGENTS.md` first; it holds the architecture rules and is loaded automatically by Claude Code via `CLAUDE.md`. This message gives you the state of the project, the working agreement, and what to build next.

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
- CI: `.github/workflows/ci.yml` runs lint/typecheck/test/build on ubuntu, macos, windows and uploads all four binaries on `main`.
- Quality gate: `bun run check` = Biome lint (zero warnings) + `tsc --noEmit` + `bun test` + `bun run build`. It is green at v0.1.

## Known gaps and caveats (do not "fix" silently — mention them when relevant)

- No automatic context compaction yet; only manual `/compact`. Long sessions on 64k-context local models will eventually overflow.
- No MCP client, no web tools, no reasoning display, no subagents, plain readline UI.
- `openai` profile default model id `gpt-5` is unverified; `lmstudio` model id is a placeholder.
- Windows support is compiled and CI-tested but not hand-tested; bash timeout kills the shell process, not the whole tree.
- Session `sync()` rewrites meta only when the transcript is ≤4 messages; `updatedAt`/`title` can lag on long sessions.

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

This follows the "Backlog after revision 4" table in `docs/HANDOFF.md`, with the two mrig items added in revision 7. Item numbers match HANDOFF. Language rules for items 2 and 4 are in `docs/LANGUAGE.md`.

0. **Prompt caching + cache-write pricing (S).** For Anthropic profiles, set request-level automatic caching (`providerOptions.anthropic.cacheControl`) on every `streamText` call. Add one explicit breakpoint on the last tool definition or the system block. Price `cacheWriteTokens` at 1.25× for 5-minute writes and 2× for 1-hour writes. Add a per-model minimum-prefix table so `/cost` can explain a miss, and a `cacheTtl` config option (`5m` default, `1h` optional). Skip local providers. Acceptance (manual, live API): in a 2-step run, step 2 reports `cacheReadTokens > 0` and `/cost` shows the write premium. Unit tests for the pricing math with the mock model.
0.5. **Hygiene (S).** A `mrig doctor` / startup model-id check against the provider's `/v1/models`, which fixes the unverified `gpt-5` default and the LM Studio placeholder. Fix session `sync()` so meta is rewritten on long transcripts too. CI trim: Linux on every push; the macOS + Windows matrix only on PRs to `main`, tags and `workflow_dispatch`.
1. **Font spike (S, font repo, not mrig).** Brahmi re-encode, `brah` script tag, `hb-shape` → Safari/Word/Chrome. Blocks item 2.
2. **Transliteration (S/M, after 1).** Devanagari (NFC) hub ↔ Akkha-Brahmi and ISO 15919-style romanization, as a table-driven character map of pure functions. Tests: round-trip property tests on the Akkha-representable subset, plus an explicit lossy-set report (श, ष, visarga, chandrabindu, nukta) that never maps silently.
3. **Font commands (S).** Document fontTools, fontmake, `hb-shape` and fontspector in `AGENTS.md`, with bash allow-rules for them. The `hb-shape` golden tests live in the font repo.
4. **Language memory layer (S).** `lang/*.md` conventions, variety tags, and `/lang`, which reports what's loaded, its token count and the zone it came from. Keep loaded content stable across turns so it stays inside the cached prefix. No lexicon yet; that's parked.
5. **Two-tier compaction (M, before heavy corpus sessions).** Tier (a) is cheap pruning of old tool results and reasoning (AI SDK 7 `pruneMessages`). Tier (b) is an LLM summary when the estimated transcript tokens exceed a threshold (default 70% of `profile.contextWindow`, or of 128k if unset; configurable as `compaction.threshold`). It uses a configurable `compactModel` via the existing `Agent.compact()`, keeps the last 4 messages verbatim after the summary, and emits `onNotice`. Trigger rarely, because every compaction invalidates the cache. Tests: the threshold triggers with the mock model; below the threshold it doesn't; the transcript after compaction still round-trips through `Session`.
6. **Corpus search over the CLDF export (S→L, after 5).** Ripgrep first: a corpus-aware wrapper over `grep` that searches both the NFC Devanagari and the romanized forms and returns the source file and line. Embeddings only if plain search fails, and only local embeddings in the closed zone.
6.5. **Evaluation harness (chrF + human-review sheet).** Score model output per variety with chrF, and export a human-review sheet. Never pool varieties.
7. **Closed-zone guard (M, before the first restricted material arrives).** A `.mrig-zone` marker found by the same upward search as `AGENTS.md`. Inside a closed zone, mrig refuses non-loopback profiles, `--yolo` and bash allow-rules; disables web and MCP; keeps transcripts inside the zone; and refuses cross-zone resume. Pure config logic with unit tests.
8. **MCP → fetch → TUI (S–M each).** MCP via `@ai-sdk/mcp` `createMCPClient`, with config `mcpServers: { name: { command, args, env } | { url } }`. Tools are exposed as `mcp__<server>__<tool>` (readOnly false by default; allow rules work unchanged), and `/mcp` lists them. A server that fails to start produces a notice, not a crash. Tests use an in-process stdio echo server. `fetch` converts a URL to readable text with a 100 KB cap and a 20 s timeout, blocks private/loopback ranges, asks unless a `fetch:<domain-glob>` rule allows it, and is disabled in the closed zone. TUI (Ink or OpenTUI) comes last.

Not in the revision 4 table and unranked, so do them only when asked: local-model hardening (Ollama context-length warning, `toolMode: "minimal"`, retry on empty tool arguments) and quality-of-life items (`/verbose`, `--json`, `--output-last`, `mrig --init`).

Target (set before the reorder): compaction, MCP and web tools merged before **January 14, 2027**. After that date the plan is to simplify and harden, not expand.

## Start now

Run the checks, confirm green, then implement backlog item 0 (prompt caching + cache-write pricing) end to end — code, tests, README section, `bun run check` — and stop for review before starting item 0.5.
