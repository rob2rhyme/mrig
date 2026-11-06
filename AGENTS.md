# mrig — instructions for agents working on this repo

mrig is a personal, local, model-agnostic terminal agent (think Claude Code, but yours):
one provider layer (Vercel AI SDK) over Anthropic, OpenAI, and any OpenAI-compatible server
(Ollama, LM Studio, llama.cpp, vLLM), nine tools, a permission gate, JSONL sessions, and a
plain streaming REPL. Bun + TypeScript. Single-binary builds for macOS, Windows, Linux.

## Architecture (keep it this shape)

- `src/agent.ts` — the loop. One `streamText` call per step with tools defined WITHOUT
  `execute`; the loop collects tool calls, gates them through `PermissionManager`, runs them,
  appends a `role: 'tool'` message, repeats. The SDK validates tool names/inputs and emits
  `tool-error` parts; the loop treats those as "continue" so the model can self-correct.
- `src/tools/*.ts` — each tool is `defineTool({ name, description, inputSchema (zod),
  readOnly, summarize, execute })`. Tools return text for the model and throw `ToolError`
  for failures (the message is sent to the model). Output is capped by `maxToolOutputChars`.
- `src/permissions.ts` — read-only tools always run; write/edit/bash ask unless yolo or an
  allow rule matches (`bash:<prefix>`, `write:<glob>`, `edit:<glob>`, `<tool>:*`).
- `src/providers.ts` + `src/config.ts` — named profiles; add providers here, never in the loop.
  A project's `.mrig/config.json` may only set `PROJECT_KEYS` unless the global
  `trustedProjects` lists it; security-relevant keys never come from an untrusted repo.
- `src/session.ts` — JSONL under `~/.mrig/sessions`; `sync()` appends, rewrites on shrink.
- `src/ui/repl.ts` — readline REPL; `src/ui/tui.tsx` + `tui-controller.ts` — the Ink TUI
  (`--tui`); `src/ui/commands.ts` — slash commands both share. `src/index.ts` — CLI;
  `src/headless.ts` — `-p` with `--json` / `--output-last`; `src/init.ts` — `mrig init`.
- `src/lang/tables.ts` + `src/lang/translit.ts` — Akkha transliteration (A2): pure,
  table-driven, Devanagari (NFC) hub; the `translit` tool wraps it. Change mappings in the
  tables only, and keep the lossy set reported. `src/lang/memory.ts` — language memory (A3):
  `lang/*.md` read once per session into the system prompt; `/lang` reports it.
  `src/lang/corpus.ts` + `src/lang/csv.ts` — corpus search (A4) over a CLDF Wordlist and text
  files; the `corpus` tool wraps it. Plain search only; embeddings need a decision first.
- `src/modes.ts` — modes (T1): each is prompt text plus a permission policy (`normal`,
  `ask-every-time`, `read-only`) that `PermissionManager` and `Runtime.currentTools()` apply.
  The session meta stores the mode. `tutor` (T8) needs a variety (`assertModeVariety`); the
  runtime passes it to `corpus` (default variety) and `learned` (fills it in, refuses others).
- `src/vision.ts` — vision input (T3): image paths in a prompt become `file` parts with an
  image/* type when the profile has `vision`; the transcript keeps a file:// URL, and
  `resolveImages()` reads the bytes just before each request.
- `src/tools/image.ts` — image generation (T4); `src/tools/speech.ts` — `speak` and
  `transcribe` (T5); `src/tools/video.ts` — `video` (T6), through the AI Gateway
  (`@ai-sdk/gateway`), with the per-job cost cap checked before a job starts. Built per runtime from the global `image`, `speech` and `transcription`
  config by `Runtime.buildMediaTools()`; never read-only; remote unless the profile is local.
  `src/tools/media.ts` holds the shared file naming, saving and price display.
  Tools report media cost through `ctx.recordMedia`, which `Agent.cost()` adds in.
- `src/learner.ts` — learner memory (T2): one local JSON file (the zone's own in an offline
  zone), atomic writes, a Leitner schedule, the summary for learn and teach mode (local models
  only unless the global `learner.shareWithCloud`); `src/tools/learned.ts` records results and
  is offered only in learn and teach mode. `/learned` and `/forget` read and delete it.
- `src/routing.ts` — model routing (T7): `classify()` picks `easy` or `hard` by rules only (prefix,
  images, user rules, length, hard words, default). `Runtime.runTurn()` routes each message and
  then runs it; the REPL, TUI and headless all call it. A manual model switch turns routing off.
- `src/mcp.ts` — MCP client: servers from the global config only, tools named
  `mcp__<server>__<tool>`, never read-only. `src/zone.ts` — offline mode rules (L5).
- `scripts/eval.ts` + `scripts/eval/` — the model eval harness (`bun run eval`). Not part of the
  binary. Changing a task or verifier means bumping `TASK_SET_VERSION`; every task needs a
  `reference` solution (the tests prove the verifier fails before it and passes after it).

## Language and script

Language rules live in `docs/LANGUAGE.md`: Devanagari is canonical, the display encoding
is Unicode Brahmi, and transliteration is hub-and-spoke. The decision behind them is
`docs/decisions/2026-09-23-akkha-encoding.md`. Read both before touching language or
transliteration code.

## Akkha font tools

The font work (A1, the `hb-shape` golden tests) lives in the GurbachhanAkkhaRik font repo, not
here. Copy this section into that repo's `AGENTS.md`, which mrig loads when it runs there. Get
test strings from the `translit` tool rather than typing Brahmi by hand. Check each tool's
`--help` before using a flag not shown here.

- **fontTools** (`pip install fonttools`): `fonttools ttx -l Font.ttf` lists the tables;
  `fonttools ttx -t cmap -t GSUB -o - Font.ttf` dumps the cmap and GSUB as XML to stdout.
- **fontmake** (`pip install fontmake`): builds binaries from the sources, for example
  `fontmake -g Source.glyphs -o ttf` or `fontmake -u Source.ufo -o ttf`. It writes into
  `master_ttf/`, so it stays behind a prompt.
- **HarfBuzz** `hb-shape` shows the glyphs and positions a string shapes to:
  `hb-shape --script=brah Font.ttf '𑀓𑁆𑀬𑀸'`. Use `--script=brah` so the Brahmi lookups (the
  `brah` script tag) are the ones tested. `hb-view Font.ttf '𑀓𑁆𑀬𑀸' -o word.png` draws it.
- **fontspector** (the Rust successor to Font Bakery): `fontspector Font.ttf` runs the
  quality checks; `fontspector --help` lists the profiles.

Suggested allow rules for `~/.mrig/config.json`, read-only commands only:

```json
{ "permissions": { "allow": ["bash:hb-shape ", "bash:fonttools ttx -l ", "bash:fontspector "] } }
```

A `bash:` rule matches the start of the command, so it also allows anything chained after it
(`hb-shape … && rm …`). Use these rules only in folders you trust.

## Rules

- Never guess an SDK API: read `node_modules/ai/dist/index.d.ts` (and
  `@ai-sdk/provider-utils`, `@ai-sdk/provider`) before using a type or option.
- Keep the system prompt under ~1,000 tokens before AGENTS.md memory.
- Business logic stays out of the UI. New behavior gets a test in `tests/` using the mock
  model helpers (`tests/helpers.ts`) — no network in tests.
- Cross-platform always: paths via `node:path`, shell via `detectShell()`, no bash-isms in
  tool implementations. Tests that run shell commands need a PowerShell variant.
- Definition of done for every change: `bun run check` (lint zero warnings, typecheck,
  tests, build) is green.
- Never commit `.env`, API keys, or `~/.mrig` contents. Never use Claude Code's leaked source.

## Roadmap

Priorities and backlog live in `docs/ROADMAP.md`. It has three tracks:

- **Track 1, local AI first.** Prompt caching, hygiene, local runtime bring-up and
  hardening, an agent eval harness, two-tier compaction, an offline guarantee, then MCP,
  fetch and TUI. "Local AI v1.0" is L0–L5.
- **Track 2, Akkha** (font, transliteration, language memory, corpus search), built on
  mrig after v1.0.
- **Track 3, modes and media** (teach and learn modes, learner memory, vision input, image,
  speech and video generation), after v1.0.

`docs/JUMPSTART.md` carries the acceptance criteria. Later ideas, unranked: per-model edit
formats for weak local models, subagents, auto-update.
