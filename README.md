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

```sh
mrig init                    # writes a starter ~/.mrig/config.json (never overwrites one)
```

The starter picks Claude when `ANTHROPIC_API_KEY` is set, OpenAI when `OPENAI_API_KEY` is, and
Ollama otherwise. It holds no key: profiles read keys from those variables. Everything below also
works without it.

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

stdout holds only the answer; tool lines, notices and the summary go to stderr. Two flags change
what reaches stdout:

- `--output-last` prints only the final answer, not text the model wrote between tool calls.
- `--json` prints one JSON object when the run ends, shaped like this:

  ```sh
  mrig -p "what does src/agent.ts do?" --json | jq -r .text
  ```

  ```json
  {"text":"…","stop":"done","steps":3,"sessionId":"20261105-…","provider":"claude",
   "model":"claude-sonnet-5","usage":{"inputTokens":5120,"outputTokens":310,
   "cacheReadTokens":4096,"cacheWriteTokens":0,"requests":3},"cost":0.0042}
  ```

  `stop` is `done`, `max-steps`, `aborted` or `error`, and an `error` field explains the last one.
  `cost` is `null` when the profile has no pricing. Errors are JSON too, so a script can always
  parse stdout.

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
  "maxToolOutputChars": 30000,
  "cacheTtl": "5m",
  "compaction": { "threshold": 0.7, "keep": 4 }
}
```

Built-in profiles: `claude`, `opus`, `fable`, `haiku` (Anthropic), `openai`, `ollama`,
`lmstudio`, `llamacpp`. Any OpenAI-compatible server works with `kind: "openai-compatible"`.

### Project configs and trust

A project's `.mrig/config.json` arrives with the repo, so someone else may have written it. By
default it may only set `defaultProvider` (naming one of your profiles), `maxSteps`,
`maxToolOutputChars`, `cacheTtl` and `compaction`. Everything else comes from
`~/.mrig/config.json` only:

- `permissions` (`yolo` and `allow`). A cloned repo can't skip your prompts.
- `providers`. A cloned repo can't point `claude` at another server along with your API key.
- `mcpServers`. A cloned repo can't run a command when mrig starts.

mrig names whatever it ignored in a one-line notice at startup. For your own projects, list them
in the global config and their project config then applies in full, subfolders included:

```json
{ "trustedProjects": ["~/code/mrig", "/work/api"] }
```

Paths must be absolute (a leading `~/` is your home folder). Only the global config can trust a
folder. `MRIG_YOLO=1` and `--yolo` are your own choice and still work anywhere outside an
offline zone.

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

## Context compaction

Long sessions are compacted automatically before the next step once the request would pass
70% of the model's context window. Two tiers, cheapest first:

1. **Prune.** Old tool calls, their results and old reasoning are dropped; the last ten
   messages keep theirs. Often enough on its own.
2. **Summarize.** If pruning is not enough, everything except the last few messages is replaced
   by a model-written summary. The cut never separates a tool call from its result.

Claude models that bind thinking blocks to the conversation (Fable 5.1, Opus 5.5, Sonnet 5.5)
skip straight to the summary, because editing earlier turns can be rejected for them. Each
compaction invalidates the prompt cache, so it is kept rare; if the window is so small that it
would run on almost every step, mrig says so once and suggests a larger context.

```json
{
  "compaction": { "enabled": true, "threshold": 0.7, "keep": 4, "compactModel": "ollama" }
}
```

`threshold` is a fraction of the window, or a token count such as `90000`. `keep` is how many
messages stay verbatim after a summary. `compactModel` is optional: another profile, such as
a local one, writes the summaries.

The context window comes from the profile's `contextWindow`. For Ollama profiles without one,
the REPL uses the context length Ollama reports; otherwise local profiles assume 32,768 tokens
and hosted ones 128,000. Set `contextWindow` to match your server for the best timing.
`/context` shows how full the context is and where it compacts; `/compact` summarizes now.
Summaries written by a separate `compactModel` are not added to `/cost`.

## MCP servers

mrig is an MCP client. Servers listed in `~/.mrig/config.json` start with mrig, and their tools
appear as `mcp__<server>__<tool>`:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"] },
    "github": { "command": "github-mcp-server", "args": ["stdio"], "env": { "GITHUB_TOKEN": "ghp_…" } },
    "docs": { "url": "https://mcp.example.com/mcp" }
  }
}
```

- **Local servers** use `command`, `args`, optional `env` and `cwd`, and talk over stdin and
  stdout. They get only a safe subset of your environment (`PATH`, `HOME` and the like), so pass
  what a server needs in `env`. **Remote servers** use `url`, with `"transport": "sse"` for
  older servers and optional `headers`. `"disabled": true` keeps an entry without starting it.
- **Every MCP tool asks before it runs**, like write, edit and bash. Allow rules work the same
  way, one per tool: `"mcp__github__list_issues:*"` lets that tool run without asking, and
  answering "always" at the prompt adds that rule for the session.
- **Only the global config starts servers.** A project's `.mrig/config.json` cannot, unless the
  folder is in `trustedProjects` (see [Project configs and trust](#project-configs-and-trust)): in
  a cloned repo that would run any command the moment mrig starts. mrig tells you when it ignores
  one.
- **Failures don't stop mrig.** A server that does not start becomes a one-line notice; `/mcp`
  lists every server, its state and its tools.
- **Offline mode** does not contact remote servers. Local servers still run.
- Bash-only profiles (`toolMode: "minimal"`) leave MCP tools out.

## Offline mode and zones

For sensitive work, mrig can guarantee that nothing leaves your machine through it. Turn it on
for one run with `--offline`, or for a whole project by creating an empty `.mrig-zone` file in
its root. mrig finds the marker the same way it finds `AGENTS.md`: from the current folder up
to the git root.

```sh
touch .mrig-zone           # this project is now an offline zone
mrig -P ollama             # works: the model runs on this machine
mrig                       # refused: the default profile is Claude's cloud API
```

In offline mode:

- **Only local models.** A profile is allowed only if its server is on this machine
  (`localhost`, `127.x.x.x`, `[::1]`). That covers `/model`, `/provider` and
  `compaction.compactModel` too. A GPU box on your network is refused.
- **Prompts stay on.** `--yolo`, `MRIG_YOLO`, `permissions.yolo` and `/yolo` are refused, and
  bash allow-rules are ignored: every write, edit and shell command asks, and "always" means
  this once for shell commands.
- **No network tools.** Tools that reach other hosts, such as web fetch and remote MCP once
  they exist, are left out.
- **`mrig doctor`** only contacts local servers.

Inside a zone, also:

- **Transcripts stay in the zone,** under `.mrig/sessions/` in the zone's root, with a
  `.gitignore` so they are never committed. `--list-sessions`, `/sessions` and `-c` see only
  the zone's sessions.
- **No resuming across the boundary.** A zone's session cannot be opened outside it, an outside
  session cannot be opened inside, and sessions cannot move between zones.

What it does not do: sandbox the shell. A command you approve can still reach the network, so
read shell commands before you approve them.

## Tools and permissions

| Tool   | What it does                                            | Prompts? |
|--------|---------------------------------------------------------|----------|
| read   | File with line numbers, or directory listing            | never    |
| glob   | Find files by pattern (skips node_modules, .git, dist)  | never    |
| grep   | Regex search (ripgrep when available)                   | never    |
| edit   | Exact string replacement; must match once               | asks     |
| write  | Create/overwrite a file                                  | asks     |
| bash   | Run a shell command (bash/sh; PowerShell on Windows)    | asks     |
| fetch  | Read a public web page or API as text (100 KB max)      | asks     |
| translit | Devanagari ↔ Akkha (Brahmi) ↔ ISO 15919, by fixed tables | never    |
| corpus | Search the language corpus (CLDF wordlist + text files)  | never    |

At a prompt answer `y` (once), `n` (deny — the model is told and asked to adapt), or `a`
(always — adds a rule for this session, e.g. `bash:npm test` or `edit:src/**`). Copy rules
you like into `permissions.allow` to make them permanent. `--yolo` or `/yolo` skips prompts.

**fetch** reads public web pages and APIs as text: HTML becomes readable text with links, up to
100 KB, with a 20-second timeout and a 2 MB download limit. It refuses private, loopback and
link-local addresses (your router, localhost services, cloud metadata), checked again on every
redirect. Allow hosts with rules such as `fetch:docs.python.org` or `fetch:*.github.io`.
Offline mode removes it.

## Akkha transliteration

`translit` converts text between Devanagari, Akkha and romanization with fixed tables, so the
model never writes Brahmi or romanization from memory. It is local and read-only, so it never
asks and works offline. The rules are in [`docs/LANGUAGE.md`](docs/LANGUAGE.md).

- **Devanagari (NFC) is the hub.** Akkha-Brahmi and romanization are converted to and from it.
- **Akkha is the Unicode Brahmi block** (U+11000–1107F), one code point per Devanagari one.
  This is **provisional** until the font spike (A1) passes and BAMA signs off; don't publish
  Akkha text before then. You need a font with Brahmi glyphs to see it (the GurbachhanAkkhaRik
  re-encode, or Noto Sans Brahmi for now).
- **The lossy set is reported, never silent.** Akkha has no form for श, ष, visarga,
  chandrabindu or nukta. श and ष become स; chandrabindu becomes anusvara; visarga and nukta
  are dropped. Each conversion lists what it substituted and how often:

  ```
  𑀲𑀺𑀓𑁆𑀲𑀸
  lossy (no Akkha form): श sha → स ×1; ष ssa → स ×1
  ```

  Characters with no mapping at all (ॐ, for example) are left as they are and listed too.
- **Romanization is strict ISO 15919-style.** The inherent a is always written (नमस्ते →
  namaste, मगर → magara), so it converts back exactly. ए and ओ are e and o. `:` separates letters
  that would otherwise merge (क्ह → k:ha, कइ → ka:i). Dandas are `|` and `‖`; digits become
  ASCII digits.
- **Varieties.** Pass a variety tag (`mgp`, `mrd`, `kgj`, `kip`, `kif`, `kjl`, `kzq`) to get its
  caveats: the Kaike table isn't frozen yet, and Kham spelling doesn't show the glottal stop or
  breathy vowels, so keep audio and IPA with each entry.

### Language memory

Notes about each variety, in Markdown, go into the model's system prompt:

```
~/.mrig/lang/shared.md          rules for every variety
~/.mrig/lang/mgp-lexicon.md     Eastern Magar
.mrig/lang/kgj-grammar.md       Gamal Kham, for this project only
```

The name starts with a variety tag (`mgp`, `mrd`, `kgj`, `kip`, `kif`, `kjl`, `kzq`) or `shared`,
optionally followed by `-<topic>`. Each file is labelled with its variety in the prompt so the
model keeps them apart. The files are read once per session, so the cached prompt stays the
same from turn to turn. `/lang` lists what is loaded and roughly how many tokens it costs;
`/lang reload` reads the files again after you edit them. The total is capped at 32,000
characters, and a file that doesn't fit is skipped, not cut. Conventions are in
[`docs/LANGUAGE.md`](docs/LANGUAGE.md#language-memory-files-langmd). The files go to whichever
model is active, so keep consent-bound material out of them or work in an offline zone.

### Corpus search

`corpus` searches a language corpus and answers with `file:line` hits, so the model can cite
the data instead of inventing words. It reads a [CLDF](https://cldf.clld.org) Wordlist (the
`*-metadata.json` says which file is which table) and any text files next to it (`.csv`, `.tsv`,
`.txt`, `.md`, `.json`, `.jsonl`).

```
corpus: ~/data/magar-cldf (CLDF Wordlist-metadata.json · 6 forms, 3 languages, 3 concepts)
searched: आमा (as typed) · āmā (iso 15919) · 𑀆𑀫𑀸 (akkha); case and Latin diacritics ignored
forms.csv:2  mgp  MOTHER  आमा
forms.csv:3  kgj  MOTHER  आमा
notes/sentences.md:3  untagged  आमाको घर ठूलो छ।
```

- **Every form of the query is searched**: the Devanagari, its romanization (also without the
  final a, as `magar` for मगर), the Akkha form, and the text as typed, so an English gloss
  (`house`) finds the concept and lists its forms.
- **Matching** ignores case and Latin diacritics (`ama` finds `āmā`), normalizes Devanagari to
  NFC, and only counts matches at the start of a word (`आमा` finds `आमाको`; `ama` skips `Kamala`).
- **Varieties are labelled**, from the LanguageTable's ISO 639-3 codes. `variety: "kgj"` keeps
  only Gamal Kham forms and says how many forms in other varieties it left out.
- **Where:** the tool's `path`, else `"corpus"` in the config (a project's config may set it),
  else a `cldf/` folder from the working directory up to the git root.
- It is read-only and local, so it never asks and works offline. There are no embeddings; plain
  search comes first, and local embeddings come only if it proves not to be enough.

## Sessions and memory

Every conversation is saved to `~/.mrig/sessions/<id>.jsonl`. `mrig -c` resumes the latest
session in the current directory; `mrig -r <id>` a specific one; `mrig --list-sessions` lists.
New messages are appended; the meta line (title, `updatedAt`) is rewritten in place, so long
sessions stay cheap to save and always list with the right timestamp.

mrig reads `AGENTS.md` (or `MRIG.md`) from the current directory up to the git root, plus
`~/.mrig/AGENTS.md`, into the system prompt — the same idea as Claude Code's `CLAUDE.md`.
Put project conventions, commands, and rules there.

## Terminal UI (experimental)

`mrig --tui` starts a terminal UI instead of the plain line-by-line REPL:

- **Transcript:** your messages, the model's replies as they stream, and one line per tool call
  with its result. Finished output stays in your terminal's scrollback, so you scroll it the
  usual way.
- **Permission prompts** appear in a box: press `y`, `n` or `a`.
- **Status line** at the bottom: model, tokens in and out, estimated cost, how full the
  context is, MCP servers, and offline or yolo mode.
- Slash commands are the same as in the REPL (they share one implementation). Up and down
  recall earlier input; Ctrl+C stops a running turn, and twice quits; Ctrl+D quits too.

It needs an interactive terminal; without one mrig falls back to the plain REPL. The plain REPL
stays the default until the TUI has had more real use.

## Images

Put an image's path in a prompt and models that can see get the image itself:

```
❯ what is wrong with this layout? screenshots/home.png
❯ compare "~/Desktop/before.png" and ~/Desktop/after\ fix.png
```

- **Which paths:** existing `.png`, `.jpg`, `.jpeg`, `.gif` and `.webp` files, relative to the
  working directory, absolute, or under `~/`. Quote a path with spaces, or escape the spaces as a
  terminal does when you drag a file in. A path that doesn't exist is plain text, so
  "make logo.png" attaches nothing. The path also stays in the text, so the model knows the name.
- **Which models:** profiles with `"vision": true`. The built-in Claude and OpenAI profiles have
  it; local profiles don't, because the default local models read text only. Set it on a profile
  whose model reads images (for example a vision model on Ollama).
- **Without vision**, mrig says which images it didn't attach and sends the text alone. After a
  switch to such a model, earlier images become a short note in the conversation.
- **Limits:** 5 MB per image and 20 images per message; larger or extra ones are skipped with a
  notice.
- **Sessions keep paths, not bytes.** The file is read again for each request. If it has been
  deleted, the model is told it's gone.

### Generating images

Add an `image` block to `~/.mrig/config.json` and the model gets an `image` tool:

```json
{
  "image": { "profile": "openai", "model": "gpt-image-1", "size": "1024x1024", "pricePerImage": 0.04 }
}
```

- **`profile`** names the profile whose provider makes the images (default `openai`): OpenAI's
  image API, or any OpenAI-compatible server with `/images/generations`. Anthropic models don't
  make images. **`model`** is the image model id. **`size`** is the default `WIDTHxHEIGHT`.
- **`pricePerImage`** is what you pay per image, in US dollars. Image prices depend on the model,
  size and quality and change often, so mrig has no built-in table: set it from your provider's
  price page. Without it, the cost shows as unknown.
- **It asks first**, showing the prompt, the count, the size and the price:
  `image "a red fox" (1 × 1024x1024, ~$0.04)`. Allow it permanently with `"image:*"`.
- **Files:** images are saved under `images/` (set `"dir"` to change it), named from the date and
  the prompt, and never overwrite an existing file. The tool answers with the paths, so the
  session stores paths, not image data.
- **Cost:** `/cost` lists the images and their cost, and `--json` includes them in `cost` and
  `media`.
- **Offline mode** drops the tool unless the image server is on this machine.
- Only your global config can set `image`. A project's config can't, since it spends money.

### Speech

Two more blocks give the model `speak` (text to speech) and `transcribe` (speech to text):

```json
{
  "speech": { "profile": "openai", "model": "gpt-4o-mini-tts", "voice": "alloy", "pricePerMillionChars": 15 },
  "transcription": { "profile": "openai", "model": "whisper-1", "pricePerMinute": 0.006 }
}
```

- **`speak`** saves an audio file under `audio/` (set `"dir"`; `"format"` is `mp3` by default,
  or `wav`) and returns the path. Up to 4,096 characters per call.
- **`transcribe`** sends an audio file (up to 25 MB) and returns the text, with the duration and
  language when the provider reports them.
- **Local and offline:** point `profile` at an `openai-compatible` profile whose `baseURL` is a
  local server that serves OpenAI's `/v1/audio/speech` and `/v1/audio/transcriptions` (several
  open-source servers do, with Whisper for transcription and a local voice model for speech).
  Such a profile counts as local, so both tools keep working in offline mode. Cloud ones are
  dropped there.
- **Both ask first**, with the price: `speak "Hello" (5 characters, voice alloy, ~$0.0001)` and
  `transcribe note.wav (whisper-1, ~$0.006/min)`. Allow them with `"speak:*"` and
  `"transcribe:*"`. Transcription is priced once the provider reports the duration.
- **Prices** come from your config, as for images. `/cost` lists speech and transcriptions.
- Recordings can be personal or consent-bound (Kaike recordings especially). Transcribe those
  with a local server, or in an offline zone, so the audio never leaves the machine.
- Only your global config can set `speech` and `transcription`.

### Video

A `video` block gives the model a `video` tool, through the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway). One key reaches many providers' video
models (Google Veo, Kling, Seedance, Wan and others), so trying another model is a one-line
change:

```json
{
  "video": {
    "model": "google/veo-3.1-fast-generate-001",
    "pricePerSecond": 0.15,
    "maxCostPerJob": 2
  }
}
```

- **Key:** set `AI_GATEWAY_API_KEY` (or name another variable with `"apiKeyEnv"`).
- **`pricePerSecond` is required.** Video is the most expensive tool by far, and the cost cap
  needs a price to work. Take it from the gateway's model page.
- **The per-job cap:** before a job starts, mrig estimates seconds × price. If that's over
  `maxCostPerJob` (default $2), the job is refused and nothing is sent. The model is told why,
  and can offer a shorter clip.
- **It asks first,** with the length, the estimate and the cap:
  `video "a fox runs through snow" (5 s, ~$0.75; cap $2.00)`. Allow it with `"video:*"`; the
  cap still applies.
- **Jobs take minutes.** mrig starts the job, checks it every `pollSeconds` (default 10), and
  saves the clip under `videos/` when it's done. After `timeoutMinutes` (default 20) it stops
  waiting and says the provider may still finish the job and bill for it. Ctrl+C stops the wait
  the same way.
- Other settings: `duration` (default 5 seconds), `aspectRatio` (e.g. `"16:9"`), `resolution`
  (e.g. `"1280x720"`) and `dir`.
- Video is cloud-only, so offline mode removes the tool. Only your global config can set `video`.

## Modes

A mode changes how mrig works with you. Switch with `/mode <name>`, or start in one with
`--mode <name>`. The session remembers its mode, so `mrig -c` and `/resume` bring it back.

| Mode | What it does | Permissions |
|------|--------------|-------------|
| `default` | Does the work. | As usual: allow rules and `--yolo` apply. |
| `teach` | Explains before acting, works one small step at a time, and asks you to try each next step first, then reviews your attempt. | Every change asks, even with `--yolo` or a matching allow rule; "always" counts once. |
| `learn` | Quizzes you one question at a time, adjusts the difficulty, keeps a running list of what you covered, and remembers it between sessions (learner memory, below). | Only read-only tools are offered: it reads and searches to make questions, and changes nothing. |
| `tutor` | The Akkha language tutor for one variety: `/mode tutor mgp` (below). | As `learn`. |

The banner and the TUI status line show the mode when it isn't `default`.

### The Akkha tutor

`/mode tutor <variety>` (or `mrig --mode tutor --variety mgp`) starts a tutor for **one** of the
varieties: `mgp`, `mrd`, `kgj`, `kip`, `kif`, `kjl` or `kzq`. Without one it's refused, so
varieties never get mixed.

- **Words come from your data**, never from the model's imagination: the corpus (see
  [Corpus search](#corpus-search)) and your language memory (`lang/*.md`). If they have nothing on
  a topic, the tutor says so and moves on. Without any corpus, it tells you at the start.
- **Every word in three forms:** Akkha, Devanagari (the canonical spelling) and romanization.
  The Akkha form and the romanization come from the `translit` tool, never typed by hand. Each
  answer comes with its source, `file:line`.
- **It quizzes** from meaning to word, word to meaning, or reading Akkha aloud. It starts with
  what's due, and records each answer in learner memory.
- **The variety is enforced, not just asked for:** corpus searches default to it, results are
  recorded under it, and a result for another variety is refused. The learner summary it starts
  with lists only that variety's topics.
- The mode and its variety are saved with the session, so `mrig -c` picks the tutor back up.
- It's a learn-style mode: read-only tools only, and the learner summary goes to local models
  only, as in `learn`.

### Learner memory

In `learn` and `teach` mode, mrig remembers what you've practised between sessions, so the next
quiz picks up where the last one stopped. The design is in
[`docs/decisions/2026-11-06-learner-memory.md`](docs/decisions/2026-11-06-learner-memory.md).

- **What's kept:** one line per topic. It records the variety for language topics, a status
  (introduced, practising, known), how many you got right, when it's due for review, and an
  optional short note such as "mixes up 7 and 8". Your answers, the questions and the
  conversation are not kept here.
- **Reviews** follow a simple schedule: a right answer pushes the next review further out (1, 2,
  4, 8, then 16 days), and a miss brings it back to tomorrow.
- **Where:** `~/.mrig/learner.json`, a plain JSON file you can open. Inside an offline zone, the
  zone keeps its own (`<zone>/.mrig/learner/`, never committed).
- **Recording:** the model records each answer with the `learned` tool as you go. You see a line
  for each, such as `⚙ learned "Magar numerals 1-10" (mgp) missed`, and it never asks first. It
  only writes this file. `teach` mode records what it taught as "introduced".
- **What the model sees:** at the start of a learn or teach session, a short summary of what's due
  and what's weak (at most 30 topics). By default **only local models** get it, so it never
  leaves your machine. With a cloud model, mrig says once that the session starts without it.
  To share it with cloud models too, set `"learner": { "shareWithCloud": true }` in
  `~/.mrig/config.json`; a project's config can't.
- **`/learned`** lists everything, by variety. `/learned due` shows what's due today,
  `/learned <words>` searches, and `/learned where` prints the file's path.
- **`/forget <topic>`**, `/forget --variety mgp`, or `/forget all` (which asks you to confirm with
  `/forget all --yes`). Forgetting removes it from the file. Session transcripts and your own
  backups of `~/.mrig` still hold what was said; delete those yourself if you need to.

## Slash commands

`/model <id>` · `/provider <name>` · `/providers` · `/cost` · `/context` · `/compact` · `/mcp` · `/clear` ·
`/yolo` · `/mode <name>` · `/learned` · `/forget <topic>` · `/verbose` · `/lang` · `/sessions` · `/resume <id>` · `/tools` · `/memory` · `/help` · `/exit`.
Ctrl+C aborts a running turn; press it twice at the prompt to quit.

`/verbose` (or `/verbose on`, `/verbose off`) shows the model's reasoning, dim, before each answer.
Only models that stream their reasoning have any to show: reasoning models on a local server,
such as Qwen3 or DeepSeek, do. mrig does not turn on Claude's extended thinking, so Claude
profiles show none. Reasoning is display only; it is never quoted in summaries.

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

v0.1 — Phase 0 + 1: loop, six tools (now nine, with fetch, translit and corpus), providers, permissions, sessions, memory, REPL, headless
mode, cross-platform builds, tests. L0 prompt caching for Claude profiles. L1 hygiene: `mrig doctor`,
in-place session meta, leaner CI. L2 local-model hardening: Ollama context warning, bash-only
`toolMode`, empty-argument retry. L3 eval harness: `bun run eval`. L4 two-tier compaction. L5 offline mode and zones. L6: MCP client, fetch tool, `--tui`. L7: `/verbose`, `--json`, `--output-last`, `mrig init`. Track 2 A2: Akkha transliteration (`translit`, provisional until A1); A3: language memory (`lang/*.md`, `/lang`); A4: corpus search (`corpus`). Track 3 T1: modes (`/mode`, `--mode`: default, teach, learn); T3: image paths in prompts reach vision models (`vision` on a profile); T4: image generation (`image`); T5: speech (`speak`, `transcribe`, with a local option); T6: video through the AI Gateway with a per-job cost cap; T2: learner memory (`/learned`, `/forget`); T8: the Akkha tutor (`/mode tutor <variety>`). Next (see `docs/ROADMAP.md`):
model trials and the first real matrix, then Track 2 or Track 3. Licensing is yours to choose before publishing (add a `LICENSE` file).
