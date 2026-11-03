# mrig

A personal, local, model-agnostic agent for the terminal. It writes and changes software,
runs commands, works with files, and answers questions — using Claude through your API key,
or a model running on your own machine. Swap models by editing a config file, not code.

```
❯ mrig
mrig v0.1.0 · claude/claude-sonnet-5
~/code/shiftpay · memory: AGENTS.md

❯ why is the unpaid balance test failing?
⚙ grep /unpaid/ in *.test.ts ✓ 4 lines · 0.1s
⚙ read tests/balance.test.ts ✓ 88 lines · 0.0s
⚙ read lib/domain/balance.ts ✓ 41 lines · 0.0s
The test expects open shifts to be excluded, but `unpaidBalance` sums every shift …
⚠ edit lib/domain/balance.ts (replace 1 → 1 lines)
- const paid = shifts.filter(...)
+ const paid = shifts.filter((s) => s.endMin !== null && ...)
  Allow? yes / no / always (edit:lib/domain/**) › y
⚙ $ npm test ✓ 31 lines · 4.2s
Fixed. 12 tests pass.
— 6 steps · 14,802 in / 611 out · ~$0.0357
```

## Install

Requires [Bun](https://bun.sh) ≥ 1.3. [ripgrep](https://github.com/BurntSushi/ripgrep) is
optional (faster `grep`; a pure-JS fallback is built in).

```sh
git clone https://github.com/rob2rhyme/mrig.git && cd mrig
bun install
bun run build            # → dist/mrig (single binary for this machine)
cp dist/mrig ~/.local/bin/  # or anywhere on your PATH
```

Or run from source during development: `bun run dev` (alias for `bun run src/index.ts`).

## Quick start

**Claude (strongest):**

```sh
export ANTHROPIC_API_KEY=sk-ant-...
mrig                         # claude-sonnet-5 by default
mrig -P opus                 # claude-opus-5
mrig -P fable                # claude-fable-5-1
```

**Ollama (local, private, free):**

```sh
ollama pull qwen3-coder
OLLAMA_CONTEXT_LENGTH=65536 ollama serve     # agents need a large context; the default is too small
mrig -P ollama
mrig -P ollama -m qwen3.8:27b                # any model you have pulled
```

**LM Studio:** load a model, start the server (default `http://localhost:1234`), then
`mrig -P lmstudio -m <model identifier shown in LM Studio>`.

**llama.cpp:** `llama-server -m model.gguf -c 65536 --port 8080`, then `mrig -P llamacpp`.

**Headless / scripting:**

```sh
mrig -p "summarize what changed in the last 5 commits"
mrig -p "add input validation to src/api.ts and run the tests" --yolo
echo "explain this error: $(cat err.log)" | xargs -0 mrig -p
```

Exit codes: `0` done, `1` error, `2` stopped at max steps, `130` aborted.

## Configuration

`~/.mrig/config.json` (global) and `./.mrig/config.json` (per project) are merged over the
defaults; env vars (`MRIG_PROVIDER`, `MRIG_YOLO=1`, `MRIG_HOME`) apply last; CLI flags win.

```json
{
  "defaultProvider": "ollama",
  "providers": {
    "ollama": { "kind": "openai-compatible", "baseURL": "http://localhost:11434/v1",
                "apiKey": "ollama", "model": "qwen3.8:27b" },
    "gpu-box": { "kind": "openai-compatible", "name": "vllm", "baseURL": "http://10.0.0.5:8000/v1",
                 "apiKey": "none", "model": "Qwen/Qwen3.8-Flash-Next" },
    "router":  { "kind": "openai-compatible", "name": "openrouter",
                 "baseURL": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY",
                 "model": "deepseek/deepseek-v4-flash",
                 "pricing": { "input": 0.3, "output": 1.2 } }
  },
  "permissions": {
    "yolo": false,
    "allow": ["bash:git status", "bash:git diff", "bash:bun test", "edit:src/**"]
  },
  "maxSteps": 40,
  "maxToolOutputChars": 30000,
  "cacheTtl": "5m"
}
```

Built-in profiles: `claude`, `opus`, `fable`, `haiku` (Anthropic), `openai`, `ollama`,
`lmstudio`, `llamacpp`. Any OpenAI-compatible server works with `kind: "openai-compatible"`.

## Prompt caching (Claude)

Anthropic profiles send every request with automatic prompt caching on, plus one explicit
cache breakpoint on the system block. Tools and the system prompt stay cached for the whole
session, and the growing conversation is re-read from cache instead of re-billed. OpenAI and
local profiles are untouched: nothing is sent, nothing is priced.

- `cacheTtl`: `"5m"` (default) or `"1h"`. Writes cost 1.25× the input price at 5 minutes and 2×
  at 1 hour; reads cost 10% (2.5% on Fable 5.1). A read refreshes the timer, so `1h` only pays
  off when you regularly pause more than five minutes between turns.
- `/cost` shows cache reads and writes, prices writes at the TTL premium, and explains a miss:
  each model only caches prefixes above a minimum (512 tokens on Claude 5 models, up to 4,096
  on Haiku 4.5), so a short first turn can show no cache activity at all.
- Per-profile `pricing` accepts `cacheRead` and `cacheWrite` (USD per million) to override the
  defaults for models mrig does not know.

## Tools and permissions

| Tool   | What it does                                            | Prompts? |
|--------|---------------------------------------------------------|----------|
| read   | File with line numbers, or directory listing            | never    |
| glob   | Find files by pattern (skips node_modules, .git, dist)  | never    |
| grep   | Regex search (ripgrep when available)                   | never    |
| edit   | Exact string replacement; must match once               | asks     |
| write  | Create/overwrite a file                                  | asks     |
| bash   | Run a shell command (bash/sh; PowerShell on Windows)    | asks     |

At a prompt answer `y` (once), `n` (deny — the model is told and asked to adapt), or `a`
(always — adds a rule for this session, e.g. `bash:npm test` or `edit:src/**`). Copy rules
you like into `permissions.allow` to make them permanent. `--yolo` or `/yolo` skips prompts.

## Sessions and memory

Every conversation is saved to `~/.mrig/sessions/<id>.jsonl`. `mrig -c` resumes the latest
session in the current directory; `mrig -r <id>` a specific one; `mrig --list-sessions` lists.

mrig reads `AGENTS.md` (or `MRIG.md`) from the current directory up to the git root, plus
`~/.mrig/AGENTS.md`, into the system prompt — the same idea as Claude Code's `CLAUDE.md`.
Put project conventions, commands, and rules there.

## Slash commands

`/model <id>` · `/provider <name>` · `/providers` · `/cost` · `/compact` · `/clear` ·
`/yolo` · `/sessions` · `/resume <id>` · `/tools` · `/memory` · `/help` · `/exit`.
Ctrl+C aborts a running turn; press it twice at the prompt to quit.

## Development

```sh
bun run check          # lint (Biome, zero warnings) + typecheck + tests + build
bun test               # tests only — no network; the agent loop is tested with a mock model
bun run build:all      # dist/mrig-{linux-x64,darwin-arm64,darwin-x64,windows-x64.exe}
bun run scripts/fake-openai-server.ts   # fake model on :8089 for end-to-end smoke tests
```

To try mrig end to end without any model, add a profile
`"fake": { "kind": "openai-compatible", "baseURL": "http://localhost:8089/v1", "apiKey": "x", "model": "fake" }`
to `~/.mrig/config.json`, start the fake server, and run `mrig -P fake -p "what is in README.md"`.

Layout: `src/agent.ts` (loop) · `src/tools/` · `src/permissions.ts` · `src/providers.ts` ·
`src/config.ts` · `src/session.ts` · `src/prompt.ts` · `src/ui/repl.ts` · `src/index.ts`.
See `AGENTS.md` for the architecture rules that keep it this simple.

## Notes on local models

The harness is the same for every backend; the model is what differs. Frontier Claude models
make near-zero malformed tool calls; local 27B–120B models make some, and mrig handles the
common failure modes (invalid JSON is repaired when possible, invalid calls are bounced back
to the model to retry). Give local models ≥64k context and prefer models trained for agentic
tool use (Qwen3-Coder / Qwen3.x, GLM-Flash, DeepSeek-Flash, Devstral). Use `/model` to hand a
hard task to Claude mid-session — the conversation carries over.

## Status

v0.1 — Phase 0 + 1: loop, six tools, providers, permissions, sessions, memory, REPL, headless
mode, cross-platform builds, tests. L0 prompt caching for Claude profiles. Next (see
`docs/ROADMAP.md`): hygiene, local runtime hardening, eval harness, compaction, offline guarantee. Licensing is yours to choose before publishing (add a `LICENSE` file).
