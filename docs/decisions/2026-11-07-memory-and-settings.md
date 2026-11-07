# Memory and settings (Track 5) decision

Date: November 7, 2026. Status: **proposed, waiting for RT's answers** (see **Open questions**). Nothing here is built until RT approves it.

Labels: **[V]** verified against the code · **[S]** secondary source · **[I]** inference or recommendation.

## The problem

RT asked two things on November 7, 2026:

1. **Memory across conversations.** Can mrig carry context from earlier conversations, have project sections and instructions, and fetch from prior conversations?
2. **Settings.** Plan every settings feature mrig should have.

### What mrig has today [V]

- **Instruction files.** Every session reads `~/.mrig/AGENTS.md`, plus `AGENTS.md` and `MRIG.md` from the working folder up to the repo root, nearest last. Up to 24,000 characters go into the system prompt (`src/prompt.ts`). `/memory` lists them.
- **Sessions per folder.** JSONL files under `~/.mrig/sessions`, or the zone's own folder in an offline zone (`src/session.ts`, `zoneSessionsDir()` in `src/zone.ts`). They come back with `-c`, `-r`, `/resume`, and the web app's sidebar.
- **Compaction inside one conversation.** At 70% of the context window, old tool output is dropped, then older turns are summarized (`src/compaction.ts`).
- **Language memory and learner memory.**
  - Language memory: `lang/*.md` (A3).
  - Learner memory: `~/.mrig/learner.json` (T2), with its own decision note.

### What it lacks

- **No recall across conversations.** A new conversation knows only the instruction files.
- **No way to save a note** without editing a file by hand.
- **Settings are a hand-edited JSON file** (`~/.mrig/config.json`) with no editor, no list of what each key does, and no app screen. The web app has no settings at all. U5 listed "settings editor" as a later idea.

## Proposed decisions: memory

Three pieces, from least to most automatic. Each stays local and readable, and you can always see and delete what it holds.

### M1. Notes: `/remember`

- `/remember <text>` saves a dated note for **this project**. `/remember --global <text>` saves one for every project.
- **Where:** a project's notes go in **`~/.mrig/projects/<project-id>/notes.md`**, not in the repo [I]. The project id is the folder's path, made into a safe name. Inside an offline zone they go in the zone's own `.mrig/`, like its sessions. Global notes go in `~/.mrig/notes.md`. **Open question 1** asks whether the repo's `MRIG.md` is better.
- **Loaded** like instruction files: once per session, into the system prompt, after `AGENTS.md`, within the same 24,000-character budget. Being read once keeps it inside the cached prefix (L0).
- **See and delete:**
  - `/notes` lists them, numbered;
  - `/notes forget <n>` removes one;
  - `/notes edit` opens the file in `$EDITOR`.

  The file is plain Markdown you can edit yourself.
- **The model can suggest a note,** but only you save one. There is no tool that writes notes, so nothing is stored without you typing `/remember` or answering a permission request.

### M2. Recall: search earlier conversations

- **A read-only `recall` tool** searches this project's earlier sessions. It returns the matching lines, each with the session's date, title and id, at most 20 hits and 8,000 characters. With no query, it lists recent conversations with their titles and first messages.
- **Plain text search only,** like corpus search (A4). Embeddings need their own decision [I].
- **Reach:**
  - **This project only** by default: sessions whose folder is the project's folder or inside it [I]. **Open question 2.**
  - An offline zone searches only its own sessions, and a session outside a zone never searches a zone's.
- **Read-only and local,** so it runs without asking, like `read` and `grep`. What it returns reaches the model in use, like a file the model reads.
- **The current session is excluded,** since its own text is already in context.
- **The user's way in:** `/recall <words>` shows the same results in the terminal and the app, without asking the model.
- **Off switch:** `"memory": { "recall": false }` in the config.

### M3. Automatic project summaries

- **What:** at the end of a conversation, mrig asks a model for a short summary of decisions, open threads and facts worth keeping, at most 150 words. It is saved beside the notes in `~/.mrig/projects/<project-id>/summaries/`, one file per conversation. The newest few, up to 1,500 characters, load into the next session's system prompt under "Earlier conversations".
- **"End of a conversation"** means `/clear`, `/exit`, Ctrl+C at the prompt, or closing a conversation in the app. Only conversations of at least 3 turns count. Nothing runs in the middle of a turn [I].
- **Which model:** the conversation's own model, so nothing reaches a model that hadn't already seen the conversation [I]. In an offline zone it is always a local model.
- **Cost:** one small call per conversation (about 2,000 input tokens and 200 output). It shows in `/cost`, and on the next run's start-up line.
- **Off by default.** It is the first memory mrig would write without being asked, so it needs `"memory": { "summaries": true }` in the global config, or `/notes summaries on` for one project (`/notes summaries off` stops it). **Open question 3.**
- **See and delete:**
  - `/notes` shows the summaries too;
  - `/notes forget <n>` deletes one;
  - `/notes clear` deletes all of a project's notes and summaries, after a confirmation.

  Deleting a summary does not delete the session file.

## Proposed decisions: settings

### S1. One settings core, used by every surface

- **One description of every setting:** `src/settings.ts`. For each key it gives the name, a one-line explanation, the type and allowed values, the default, and where it may be set.

  The places a key may be set:
  - global only;
  - project too;
  - this device only, for the app's appearance.

  Every surface (CLI, terminal command, app) reads this one list, so they can't drift [I].
- **Every change is validated by the same parser that loads the config** (`loadConfig`), before anything is written. A change that wouldn't load is refused, with the parser's message.
- **Atomic writes** (a temporary file, then rename) keep the previous version as `config.json.bak`. Every change is logged to `~/.mrig/settings.log`: the time, the key and where it came from, never a value that could be a secret.
- **The project rule still holds.** An untrusted project's `.mrig/config.json` may set only `PROJECT_KEYS` [V], and the settings tools refuse to write anything else there.

### S2. `mrig config` in the terminal

- **`mrig config`** lists every setting with its current value, its source (default, global, project) and its one-line explanation.
- **`mrig config get <key>`, `set <key> <value>`, `unset <key>`** read and change one setting. `--project` targets the project's config, within the rule above. JSON values are accepted for objects and lists.
- **`mrig config edit`** opens the file in `$EDITOR`, then validates it. On an error it offers to reopen the file or restore the backup.
- **`mrig config path`** prints the file paths.
- **`mrig config check`** validates the file and prints what `mrig doctor` would check.
- **`/settings` in a session** shows the same list, read-only, with what this session is using.

### S3. A Settings screen in the web app (and the VS Code panel)

Sections, each mapped to keys that exist today [V] or that this note adds:

| Section | What it shows and changes |
|---|---|
| **Models** | Profiles: model, kind, base URL, which key variable each uses and whether it is set (never the key), context window, tool mode, vision, pricing. The default profile. Add, copy or remove a profile. **Test** runs `mrig doctor` for one profile. |
| **Routing** | On or off; the easy and hard profiles; the default tier; the long-message threshold; the rules list (T7). |
| **Permissions** | Allow rules (add, remove, with what each form matches); yolo as a default; trusted projects. |
| **Project** | This project's instruction files (`AGENTS.md`, `MRIG.md`) in an editor. Its project config. Its corpus folder and language memory files. Whether the project is trusted, and which keys were dropped because it isn't. |
| **Memory** | Notes and summaries (M1, M3): view, edit, delete. Recall on or off (M2). Summaries on or off. Learner memory (T2): the list, forget a topic, and `shareWithCloud`. |
| **Context** | Max steps; tool output cap; compaction (on, threshold, turns kept); prompt-cache lifetime (`cacheTtl`). |
| **Media** | Image, speech, transcription and video: provider, model, price, the per-job cost cap (T4–T6). |
| **MCP servers** | Servers, whether each is connected, the tools it adds; add, remove, turn off. |
| **Offline** | Offline mode as a default; whether this folder is in a zone, and what the zone allows (L5). |
| **App and devices** | Port and Tailscale name. Allowlisted devices, when each was last seen, its login pin, recent failed attempts. **Revoke** from the Mac. The background service: installed or not. |
| **Sessions** | Where they're stored; delete a conversation; delete conversations older than a chosen age. |
| **Keys** | Each key variable the profiles use, and whether it's set in mrig's environment. Never the value, never an input box for one; the README's steps for setting it. |
| **Appearance** (this device only) | Theme (system, light, dark), text size, Enter or ⌘Enter to send, notifications, show reasoning (`/verbose`) by default. Kept in the browser, not in `config.json`. |
| **About** | Version, the config and session paths, the last `mrig doctor` result. |

- **Where changes may come from:** settings change only from the Mac itself (a local request, as `requestFrom` defines it [V]). Other devices see the Settings screen read-only, apart from Appearance, which is per device. **Open question 4.**
- **Security-relevant changes ask first.** These are permissions, yolo, trusted projects, provider base URLs, MCP servers, `learner.shareWithCloud` and the app's network settings. A confirmation shows the old and new value, as a permission request does.
- **Devices:** the Mac's app may **revoke** a device. **Adding** a device stays in the Mac's terminal (`mrig app allow add`), as U2 decided [V]. **Open question 5.**
- **API keys are never stored by mrig.** They stay in your shell environment, as now. `apiKey` in a profile (a key written in plain text) still loads, but the Settings screen and `mrig config check` warn about it [I]. **Open question 6** asks about the macOS Keychain.
- **Instruction files edited from the app** are files in your project, so saving one goes through the same confirmation as an edit, with a diff [I].
- **When changes apply:** new conversations use them at once. A running conversation picks up what it can between turns (allow rules, max steps); a profile's model changes on its next turn. The screen says which.
- **Protocol:** `settings.get` and `settings.set` messages, zod-validated like the rest of protocol v1, answered with the same list `mrig config` prints [I].

## Alternatives considered

- **Notes in the repo's `MRIG.md` by default.** Visible and shareable, but every `/remember` changes the repo. A note meant for you can end up in a commit, and it doesn't work in a folder you don't own. Kept as open question 1.
- **Embeddings for recall.** Better at "something like this", but it needs a model, an index and a store, and it's harder to inspect. A4 made the same call. Plain search first.
- **Summaries on by default.** Most convenient, but it would write memory nobody asked for and spend a model call on every conversation.
- **A settings editor that writes JSON text.** It's what `mrig config edit` already gives; the app should edit settings one at a time and validate each.
- **Storing API keys in `config.json` from the Settings screen.** Refused: keys stay out of mrig's files, as the README and the project rules say.

## Open questions for RT

1. **Where project notes live (M1).** In mrig's own folder, `~/.mrig/projects/…`, private and never in the repo (recommended)? Or in the repo's `MRIG.md`, where you can commit and share them?
2. **How far recall reaches (M2).** This project's conversations only (recommended), or every project's?
3. **Automatic summaries (M3).** Off unless you turn them on (recommended)? On by default? Or not built at all?
4. **Settings from other devices (S3).** Read-only on other devices, with changes from the Mac only (recommended)? Or should an allowlisted phone change the non-security settings too?
5. **Revoking devices from the app (S3).** Allow the Mac's own app to revoke (recommended), with adding still terminal-only? Or keep both in the terminal?
6. **API keys (S3).** Keep them in the shell environment only, and warn about plain-text `apiKey` (recommended)? Or add macOS Keychain support as a later item?

## The build (Track 5), once approved

Order: **M1 → M2 → S1 → S2 → S3 → M3**. The notes and recall are small and useful on their own; the settings core comes before its surfaces; summaries come last, once notes exist to sit beside them.

- **M1 (S):** `src/notes.ts` (paths, including the zone's; append; list; forget; atomic writes), `/remember`, `/notes`, loading into the prompt within the budget.
  - Tests: zone separation, the budget, a byte-identical prompt across turns, forget and edit.
- **M2 (S–M):** the `recall` tool and `/recall`.
  - Tests: this project only; zones never mixed; the current session excluded; the caps; the off switch.
- **S1 (M):** `src/settings.ts`, with every key described, validated through `loadConfig`, written atomically with a backup, and logged.
  - Tests: every key in `MrigConfig` is described (a test fails when one is added without a description); an invalid value is refused and nothing is written; an untrusted project write is refused; nothing secret reaches the log.
- **S2 (S):** `mrig config` and `/settings`.
  - Tests: get, set, unset, `--project`, edit with a bad file, check.
- **S3 (L):** the Settings screen, plus the `settings.get` and `settings.set` protocol messages.
  - Tests: every section renders from the list; another device can't write (refused by the server, not just hidden); security-relevant changes need confirmation; no key value is ever sent; the Mac can revoke a device. Browser tests at desktop and phone width.
- **M3 (M):** summaries at the end of a conversation, `/notes summaries on|off`, loading the newest summaries.
  - Tests: off by default; at least 3 turns; the conversation's model is used, and a local one in a zone; the cost is recorded; delete.
