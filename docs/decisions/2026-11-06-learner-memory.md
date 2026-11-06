# Learner memory (T2) decision

Date: November 6, 2026. Status: **decided by RT, November 6, 2026**, with the recommended answer to each open question (see **Answers** below).

Labels: **[V]** verified against the code or a primary source · **[I]** inference or recommendation.

## The problem

`learn` mode (T1) quizzes you and keeps a running list of what you covered, but only inside the conversation [V]. Start a new session and mrig has forgotten everything. Learner memory is what mrig keeps between sessions about what you've learned, so the next quiz starts where the last one stopped. The Akkha tutor (T8) is built on it.

T2's acceptance asks four things of this note: what is stored, where it is stored (local only), how you inspect it (`/learned`), and how you delete it (`/forget`). The roadmap also requires that nothing leaves the machine and that the offline guarantee (L5) holds.

## Proposed decisions

### 1. What is stored: topics and scores, nothing else

One record per topic you've practised [I]:

| Field | Example | Why |
|---|---|---|
| `topic` | `git rebase`, `Magar numerals 1–10` | What was practised; a short label, at most 80 characters |
| `variety` | `mgp` | Required for language topics, absent otherwise. Varieties are never pooled (`docs/LANGUAGE.md`) |
| `status` | `introduced`, `practising`, `known` | Where you are with it |
| `asked`, `right` | `12`, `9` | Simple counts; no per-answer history |
| `box` | `3` | A Leitner box (1–5) for spaced review: right moves up a box, wrong goes back to 1 |
| `due` | `2026-11-09` | When it should come up again; worked out from the box |
| `lastSeen` | `2026-11-06` | The date of the last question |
| `note` | `confuses ङ and ञ` | Optional, at most 200 characters: the one thing to watch |

**Not stored:**
- your answers or the questions;
- transcripts;
- audio;
- names, ages or anything about you or other people.

The transcript already lives in the session file. Learner memory is the small summary that outlives it.

### 2. Where: one local file, inside the offline zone when there is one

- **Normally:** `~/.mrig/learner.json` [I]. It's one human-readable JSON file with a `version` field, so you can open it in an editor and diff it. A wordlist of a few hundred topics is a few tens of kilobytes. SQLite or embeddings would add a dependency and hide the data.
- **Inside an offline zone:** `<zone>/.mrig/learner/learner.json`, next to that zone's sessions, in a folder with a `.gitignore` like theirs. It never mixes with the global file. That's the same rule L5 already applies to zone transcripts [V: `zoneSessionsDir()` in `src/zone.ts`].
- **Written atomically:** a temporary file is renamed over the old one, so a crash never leaves half a file.
- **No sync, upload or telemetry.** mrig never sends the file anywhere.

### 3. What reaches the model: a short summary, to local models only by default

- **In `learn` and `teach` mode:** mrig adds a short block to the system prompt at session start. It holds the topics due for review and the weakest ones, at most 30 lines (about 400 tokens), labelled by variety [I]. Like language memory (A3), it is read once per session, so it stays inside the cached prompt prefix [V: `src/lang/memory.ts` does the same].
- **In `default` mode,** nothing is sent.
- **Only to local models by default.** "Nothing leaves the machine" means a cloud model, Claude included, doesn't get the summary either. With a cloud profile, `learn` mode still works, starts without memory, and says so once.
- **Opt-in for cloud models:** `"learner": { "shareWithCloud": true }` in the **global** config (a project config can't set it) sends the same summary to cloud models too. It's off unless you turn it on. **Open question 1.**
- **Never sent in full:** the whole file never goes to any model, local or cloud.

### 4. How it is written: one tool, offered only while learning

- A `learned` tool lets the model record a result: `{ topic, variety?, result: "right" | "missed" | "introduced", note? }`. It's offered only in `learn` and `teach` mode [I].
- It writes mrig's own file, never your project files. So it counts as read-only for the permission gate, and learn mode, which refuses tools that change things [V: `src/modes.ts`], can still use it.
- Every write shows as a tool line (`⚙ learned "Magar numerals 1–10" (mgp) right`), so nothing is recorded silently.
- **Per-write prompts:** asking before each write would interrupt every quiz question, so the proposal is not to ask. **Open question 2** offers a once-per-session confirmation instead.
- **Topic labels** are normalized (trimmed, NFC), so `Git rebase` and `git rebase ` are one topic.

### 5. How you inspect it: `/learned`

- `/learned` lists your topics grouped by variety (non-language topics under "general"), with status, score and the next review date.
- `/learned due` lists what is due today.
- `/learned <words>` shows the topics matching those words, with their notes.
- `/learned where` prints the file's path, so you can open it yourself.

### 6. How you delete it: `/forget`

- `/forget <topic>` removes one topic.
- `/forget --variety mgp` removes every topic of one variety.
- `/forget all` deletes the file. It asks first, naming how many topics will go.

Deletion is real: the record is gone from the file, and mrig keeps no copy of its own. Two things are outside `/forget`'s reach, and `/forget` says so when it runs:

- **Session transcripts.** The quiz conversation is still in its session file. Delete that session to remove it.
- **Your backups.** The roadmap advises backing up `~/.mrig`, learner memory included [V: `docs/ROADMAP.md`, Data backups]. Copies already in a backup (Time Machine, for example) are not touched.

### 7. Who it is for: one learner, you

- **One learner per operating-system account** [I]. A family sharing a computer uses separate accounts, so each has their own `~/.mrig`.
- **Not designed for children's data.** mrig is a personal tool. The rules for children's accounts (COPPA, the UK Children's Code) belong to the Akkha-Rik learning app, which keeps its own records [V: `docs/ROADMAP.md`, Not blocked by any track]. mrig's learner memory is not that app's database and doesn't feed it.

### 8. How long it is kept

Until you forget it [I]. Topics don't expire, and status never decays on its own; the Leitner box handles review timing.

## Alternatives considered

- **Keep coverage only in transcripts** (today). Simple, but each session starts from nothing, and T8 needs more.
- **SQLite.** Faster queries, but one more dependency and data you can't open in an editor. The data is small.
- **Embeddings over past sessions.** Overkill for a list of topics, opaque to inspect, and A4 already decided on plain search first.
- **Sync across machines.** Rejected: it would send the data off the machine. Copy the file by hand if you want it elsewhere.
- **Store per-answer history.** More detail for statistics, but it's personal data the tutor doesn't need. Counts and a box are enough.

## Open questions for RT

Answered below; kept as asked.


1. **Cloud models (§3).** Keep the default "local models only" and allow the global `shareWithCloud` opt-in? Or never send the summary to cloud models at all?
2. **Confirmation (§4).** Record each result as it happens, with a visible tool line and no prompt (recommended)? Or ask once at the end of a learning session, "Save 6 updates to learner memory?"
3. **Teach mode (§4).** Should `teach` mode record what it taught as `introduced`, or should only `learn` mode write?
4. **Review spacing (§1).** Is a simple 5-box Leitner schedule (1, 2, 4, 8, 16 days) enough, or do you want a different rhythm for language practice?

## Answers (RT, November 6, 2026)

1. **Cloud models:** local models only by default; the global `learner.shareWithCloud` opt-in sends the summary to cloud models too.
2. **Confirmation:** each result is recorded as it happens, with a visible tool line and no prompt.
3. **Teach mode:** `teach` records what it taught as `introduced`; `learn` records right and missed answers.
4. **Review spacing:** the 5-box Leitner schedule, 1, 2, 4, 8 and 16 days.

## The build (T2)

- `src/learner.ts`: load, save (atomic), record, forget, the summary block, and the zone-aware path.
- `src/tools/learned.ts`: the recording tool, offered in `learn` and `teach` mode only.
- `/learned` and `/forget` in `src/ui/commands.ts`.
- The global-only config key `learner` (`shareWithCloud`), kept out of `PROJECT_KEYS`.
- **Tests (no network):**
  - reading, writing and deleting each case;
  - an atomic write surviving a failed write;
  - the zone file kept separate from the global one;
  - no summary sent to a cloud profile by default;
  - the summary stable across turns (byte-identical prompt);
  - normalization merging topic labels;
  - varieties never pooled in the summary.
