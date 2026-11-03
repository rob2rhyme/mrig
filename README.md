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

**Check your setup:**

```sh
mrig doctor                  # every profile: is its model id served by the provider?
mrig doctor -P ollama        # one profile; -m <id> to try another model id
```

`doctor` asks each provider's `/v1/models` and prints ✓ (listed), ✗ (not listed, wrong key, or
unreachable; exit code 1) or · (skipped: no key, or the server does not list models). The
interactive REPL runs the same check for the active profile in the background at startup and
prints a one-line warning when the model id is not served; headless mode does not.

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
  "maxToolOutputChars": 30000
}
```

Built-in profiles: `claude`, `opus`, `fable`, `haiku` (Anthropic), `openai`, `ollama`,
`lmstudio`, `llamacpp`. Any OpenAI-compatible server works with `kind: "openai-compatible"`.

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
New messages are appended; the meta line (title, `updatedAt`) is rewritten in place, so long
sessions stay cheap to save and always list with the right timestamp.

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
bun run eval --list    # the model eval suite; see "Evaluating models"
bun run scripts/fake-openai-server.ts   # fake model on :8089 for end-to-end smoke tests
```

To try mrig end to end without any model, add a profile
`"fake": { "kind": "openai-compatible", "baseURL": "http://localhost:8089/v1", "apiKey": "x", "model": "fake" }`
to `~/.mrig/config.json`, start the fake server, and run `mrig -P fake -p "what is in README.md"`.

Layout: `src/agent.ts` (loop) · `src/tools/` · `src/permissions.ts` · `src/providers.ts` ·
`src/config.ts` · `src/session.ts` · `src/prompt.ts` · `src/ui/repl.ts` · `src/index.ts`.
See `AGENTS.md` for the architecture rules that keep it this simple.

CI runs the full check on Linux for every push and pull request. The macOS and Windows matrix
runs only on pull requests to `main`, `v*` tags and manual runs, which is where it earns its
minutes; binaries for all targets are built on `main` and tags.

## Notes on local models

The harness is the same for every backend; the model is what differs. Frontier Claude models
make near-zero malformed tool calls; local 27B–120B models make some, and mrig handles the
common failure modes (invalid JSON is repaired when possible, invalid calls are bounced back
to the model to retry). Give local models ≥64k context and prefer models trained for agentic
tool use (Qwen3-Coder / Qwen3.x, GLM-Flash, DeepSeek-Flash, Devstral). Use `/model` to hand a
hard task to Claude mid-session — the conversation carries over.

Hardening for weak local models (L2):

- **Context check.** For Ollama profiles, mrig asks `POST /api/show` at startup (and in
  `mrig doctor`) and warns when the model runs with under 32k context, or when Ollama reports
  none (the server default is 4,096 unless `OLLAMA_CONTEXT_LENGTH` is set). Fix:
  `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`, or `PARAMETER num_ctx 65536` in a Modelfile.
- **`"toolMode": "minimal"`** on a profile exposes only `bash`. Models that cannot juggle six
  tools read and edit files through shell commands instead, and the system prompt tells them how.
  `/model` and `/provider` switch tool sets along with the profile.
- **Empty arguments.** When a model calls a tool with `{}`, the first time it is told exactly
  which fields the tool takes and asked to retry; a second empty call in a row gets the plain
  validation error. Invalid calls always produce exactly one tool result, so the transcript
  stays valid for strict APIs.

The trial procedure and results for candidate models live in `docs/LOCAL_MODELS.md`.

## Evaluating models

`bun run eval` runs a fixed suite of ten small repo tasks against your provider profiles and
reports how well each model works as an agent. It is how you pick a local model with evidence
instead of vibes.

```sh
bun run eval --list                          # the ten tasks
bun run eval -P ollama                       # one profile
bun run eval -P ollama,claude --matrix docs/COMPATIBILITY.md
bun run eval --report --matrix docs/COMPATIBILITY.md   # re-render from saved results, run nothing
```

Without `-P` it tries every profile in your config. A profile is skipped, with the reason, when
it has no API key, the server is unreachable, or the model id is not served (the same check as
`mrig doctor`; `--no-check` skips it). Useful flags: `-t id,id` for a subset, `--max-steps`
(default 20), `--timeout` seconds per task (default 300), `--out` for the results directory
(default `evals/results`).

**The tasks:** two read, two edit, one write, one grep, one glob, one bash and two multi-step
fixes. Each runs in a fresh temp directory with a fresh in-memory session, using the same agent
loop as `mrig -p --yolo`. Verifiers look at the result afterwards (exact file contents, the
final answer, `bun test`) and never call a model. The fix tasks fail if the model edits the
tests.

**What is reported per profile:**

| Column | Meaning |
|---|---|
| Pass | tasks whose verifier passed |
| Valid calls | share of tool calls valid on the first try (known tool, valid arguments, not empty) |
| Repaired | tool calls whose malformed JSON mrig salvaged |
| tok/s | output tokens per second after the first token, when the provider reports it |
| Cost | estimated from the pricing table; `free` for local models |

Raw results are saved per run as JSON under `--out`; the matrix is always rebuilt from the
newest run of each profile and model, so you can evaluate profiles on different days or machines
and merge by copying the files. The matrix also names the best local profile (full task set,
at least 70% passed, ranked by pass rate, then valid calls, then speed). Results from an older
task set are ignored; bump `TASK_SET_VERSION` in `scripts/eval/tasks.ts` whenever a task or
verifier changes.

**Safety:** tasks run with permissions off in a temp directory, and the model can still run any
shell command. Run models you do not trust in a container or VM. Your global
`~/.mrig/AGENTS.md` memory is part of every run, equally for all profiles.

The matrix lives in `docs/COMPATIBILITY.md` and stays empty until the suite has been run on real
models.

## Status

v0.1 — Phase 0 + 1: loop, six tools, providers, permissions, sessions, memory, REPL, headless
mode, cross-platform builds, tests. L1 hygiene: `mrig doctor`, in-place session meta, leaner CI.
L2 local-model hardening: Ollama context warning, bash-only `toolMode`, empty-argument retry.
L3 eval harness: `bun run eval`. Next (see `docs/ROADMAP.md`): prompt caching, model trials and
the first real matrix, compaction, offline guarantee. Licensing is yours to choose before publishing (add a `LICENSE` file).
