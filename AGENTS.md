# mrig — instructions for agents working on this repo

mrig is a personal, local, model-agnostic terminal agent (think Claude Code, but yours):
one provider layer (Vercel AI SDK) over Anthropic, OpenAI, and any OpenAI-compatible server
(Ollama, LM Studio, llama.cpp, vLLM), six tools, a permission gate, JSONL sessions, and a
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
- `src/session.ts` — JSONL under `~/.mrig/sessions`; `sync()` appends, rewrites on shrink.
- `src/ui/repl.ts` — readline REPL and slash commands. `src/index.ts` — CLI + headless `-p`.

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

Phase 2: auto-compaction at a token threshold, MCP client (`@modelcontextprotocol/sdk`),
web fetch/search tools, `/verbose` reasoning display, per-model edit formats for weak local
models. Phase 3: richer TUI (Ink/OpenTUI), subagents, evals harness, auto-update.
