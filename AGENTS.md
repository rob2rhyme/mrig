# mrig — instructions for agents working on this repo

mrig is a personal, local, model-agnostic terminal agent (think Claude Code, but yours):
one provider layer (Vercel AI SDK) over Anthropic, OpenAI, and any OpenAI-compatible server
(Ollama, LM Studio, llama.cpp, vLLM), seven tools, a permission gate, JSONL sessions, and a
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
  (`--tui`); `src/ui/commands.ts` — slash commands both share. `src/index.ts` — CLI + headless `-p`.
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
