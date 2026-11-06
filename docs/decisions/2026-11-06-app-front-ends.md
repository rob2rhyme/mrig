# App front ends (Track 4) decision

Date: November 6, 2026. Status: **proposed; waiting on RT's answers** (see **Open questions for RT**). No front-end code is written until RT approves this note, the same rule T2 followed.

Labels: **[V]** verified against the code or a primary source · **[S]** secondary source · **[I]** inference or recommendation.

## The problem

mrig runs only in a terminal: the plain REPL, or the Ink TUI with `--tui` [V]. RT wants it to feel like a real app, and asked for all three kinds:

- **a web app** that opens in the browser and runs on the Mac;
- **a desktop app** with its own window, starting with macOS, then Windows and Linux;
- **a VS Code extension** that sits inside the editor.

This note plans all three so that the first one built makes the other two cheap.

## What "feels like an app" means

The target experience, in all three front ends:

- **It opens like an app.** A window or tab of its own, a project picker (open a folder; recent projects), and it remembers where you were.
- **Conversations in a sidebar,** grouped by project: start a new one, resume an old one, see each one's title and date.
- **Replies stream in as formatted text:** headings, lists, tables, code blocks with highlighting and a copy button.
- **Tool activity as compact cards:** one line per tool call (`read src/agent.ts`, `bash bun test`). Click to see the output. Edits show as a diff.
- **Permission requests as a clear panel** with **Allow once / Always allow / Deny** buttons, plus the `y` / `a` / `n` keys, and the diff or command in full.
- **A Stop button** while a turn runs.
- **Pickers in the header** for the model (claude, opus, ollama…) and the mode (default, teach, learn, tutor).
- **A status bar** with tokens, cost, how full the context is, MCP servers, and offline or yolo.
- **Images:** drag or paste one into the message box for vision models (T3). Generated images, audio and video (T4–T6) show and play inline.
- **A command palette** (Cmd+K or `/`) for every slash command.
- **Notifications** when a long turn finishes or a permission request is waiting (desktop and VS Code).
- **Light and dark themes,** following the system.

## Proposed decisions

### 1. One core, one protocol, one web front end, three shells

The terminal UI already proves the shape [V]:
- the `Runtime` runs turns and emits events (`onText`, `onReasoning`, `onToolStart`, `onToolEnd`, `onStepEnd`, `onNotice`);
- permission questions arrive through an `ask` callback;
- slash commands are one shared implementation (`src/ui/commands.ts`);
- `TuiController` turns all of that into state with no UI code in it, which keeps the TUI testable without a terminal.

The plan adds one more adapter of the same kind, over a local network connection instead of a terminal:

```
                    ┌──────────────── mrig (one binary) ────────────────┐
 browser tab  ──┐   │  mrig serve: local server (127.0.0.1 only)        │
 desktop app  ──┼──►│    WebSocket protocol v1 ── Runtime per session ──┼──► models, tools
 VS Code panel ─┘   │    + the web front end, built into the binary     │
                    └───────────────────────────────────────────────────┘
```

- **`mrig serve`** is a new command. It is a local server that runs one `Runtime` per open conversation and speaks a small, versioned WebSocket protocol (§2). Business logic stays in the core, as AGENTS.md requires; the server is a translator, like `TuiController`.
- **The web front end** is one React app, in a new `web/` folder. Bun can bundle an HTML entry point into a compiled executable (Bun 1.2.17 and later [S]; the repo uses Bun 1.4 [V]). So the front end ships **inside the existing single `mrig` binary**: no second download and no Node install.
- **The three shells are thin wrappers** around that same front end:
  - the **web app** is `mrig app`, which starts the server and opens the browser;
  - the **desktop app** is a native window showing the same front end, with `mrig serve` running behind it;
  - the **VS Code extension** is a panel showing the same front end, with `mrig serve` running behind it, plus editor features.

**Why this shape [I]:**
- **One UI to build and test,** not three. Each feature (a diff view, a picker) lands in all three at once.
- **One protocol to secure** (§3).
- **The terminal stays first-class:** the REPL and TUI are unchanged and remain the default for `mrig` with no arguments.

### 2. The protocol (v1)

JSON messages over one WebSocket at `ws://127.0.0.1:<port>/ws`. Every message is validated with zod on arrival, as tool inputs already are. Both ends import the types from one file (`src/server/protocol.ts`), so they cannot drift. A `protocol: 1` field lets a newer front end refuse an older server politely.

**Front end → server:**

| Message | What it does |
|---|---|
| `hello {token, protocol}` | The first message; anything else first closes the connection (§3) |
| `projects.list`, `sessions.list {cwd}` | The project picker and the sidebar (`Session.list()` already exists [V]) |
| `session.open {cwd, resume?}` | Start or resume a conversation; the server answers with a full `snapshot` |
| `turn.send {session, text, images[]}` | Send a message (images are file paths, as in T3) |
| `turn.abort {session}` | The Stop button |
| `ask.answer {askId, answer: yes/no/always}` | Answer a permission request |
| `command.run {session, text}` | Any slash command (`/mode learn`, `/cost`); output comes back as text |
| `model.set`, `mode.set` | The header pickers; the same code paths as `/model` and `/mode` |

**Server → front end:**

| Message | When |
|---|---|
| `snapshot {session, items[], status}` | On open and on reconnect, so a reloaded tab or a reopened window picks up exactly where it was |
| `text.delta`, `reasoning.delta` | As the reply streams |
| `tool.start {id, name, summary, display}`, `tool.end {id, status, output, ms}` | Tool cards |
| `ask {askId, summary, preview, alwaysRule}` | A permission request (the same fields as today's `AskRequest` [V]) |
| `notice`, `status`, `turn.end {result: ok/error/aborted}`, `error` | Everything else |

**One core change is needed first:** tool events carry only a one-line summary today [V]. A card wants structure, so `ToolCallInfo` gains an optional `display`: `diff` for `edit` and `write`, `command` for `bash`, `path` for `read`, `media {path, kind}` for `image`, `speak` and `video`. It is computed in the tools, where the knowledge is, and the REPL and TUI simply ignore it. Tool output sent to the front end is capped like everything else (`maxToolOutputChars`).

**One turn at a time per conversation,** as today. Several conversations can run at once in separate tabs or windows, each with its own `Runtime`.

### 3. Security: a local server that can run commands must be locked down

`mrig serve` exposes an agent that can edit files and run shell commands, so this section is the part that must not be cut [I].

1. **Loopback only.** It binds to `127.0.0.1`, and v1 has no option to bind anywhere else. Your phone or another machine on the network cannot reach it.
2. **A new random token every launch** (32 bytes from the system's secure random source). Nothing works without it:
   - the WebSocket's first message must carry it;
   - so must every HTTP request other than the static app files, which contain no secrets.

   The token is passed in the URL **fragment** (`http://127.0.0.1:PORT/#t=…`). Browsers never send the fragment to a server, so it stays out of logs and `Referer` headers. It is never written to disk.
3. **Host and Origin checks.** The `Host` header must be `127.0.0.1:PORT` or `localhost:PORT`, which defeats DNS-rebinding attacks. On the WebSocket upgrade, `Origin` must be the server's own origin or a known shell origin (the desktop app's or VS Code's webview). That stops any website open in your browser from connecting to mrig. No CORS headers are ever sent.
4. **Permissions are unchanged.** The same `PermissionManager` decides, and a request waits for an answer from a connected window. If none is connected, it waits, and after 10 minutes it counts as **deny**. A front end can never set yolo or allow rules on its own: the existing commands, typed by you, do that.
5. **Files are served only from the media folders** (`images/`, `audio/`, `videos/` under the project) and attached images. It is never "any path you ask for".
6. **The model's output is untrusted when rendered:**
   - markdown is sanitized and raw HTML is never rendered;
   - **remote images in replies are blocked**, because a prompt-injected reply could otherwise leak data through an image URL;
   - links open in the system browser only after a click.
7. **A strict Content Security Policy:**
   - scripts and styles load only from the app itself;
   - the WebSocket connects only to its own server;
   - images load only from the app, `blob:` and the media route.
8. **No remote assets at all:** no CDNs, web fonts or analytics. Everything is bundled, so the app works offline and leaks nothing, and the offline guarantee (L5) still holds. `mrig serve --offline` and `.mrig-zone` behave exactly as in the terminal.
9. **Tests prove each rule fails closed:** a wrong token, a foreign `Origin`, a rebinding `Host`, a path outside the media folders, a malformed message.

### 4. The web app (`mrig app`)

- **Start it:** `mrig app [folder]` starts the server on a free port and opens your default browser at it. `mrig serve` does the same without opening a browser. It prints one JSON line (`{"url":…,"token":…}`) for the desktop app and VS Code to read.
- **Stack [I]:**
  - **React**, which mrig already depends on for the TUI, so the team writes one framework;
  - **plain CSS** with design tokens and light and dark themes, so there is no CSS framework to learn or update;
  - a **small markdown renderer** with sanitizing, and a **lightweight code highlighter**, picked by size and bundled.
- **Layout:**
  - **Sidebar:** projects, then conversations.
  - **Main column:** the transcript and the message box.
  - **Header:** the model picker, the mode picker, and the Stop button.
  - **Status bar:** the same fields the TUI shows [V].
- **Testable without a browser:** a pure `ChatViewModel` turns protocol messages into transcript state, as `TuiController` does today. `bun test` covers it with no DOM, and React only renders it.
- **Testable in a browser:** one Playwright smoke test (Chromium is preinstalled in CI images) drives a real page against `mrig serve` with the mock model. It covers sending a message, seeing the stream, answering a permission request with Allow, seeing the diff card, and pressing Stop.

### 5. The desktop app

- **Framework: Tauri v2 (recommended) [I].**
  - It shows the app in the operating system's own web view, so a build is small, megabytes rather than Electron's ~100 MB.
  - It has first-class support for shipping a separate program alongside the app (a "sidecar"), declared in `bundle.externalBin` [S]. That program is the `mrig` binary itself, running `mrig serve`.
  - It has been stable on macOS, Windows and Linux for years, with documented signing and notarization.
  - **Cost:** building the desktop app needs the Rust toolchain. Only that build does; `bun run check` stays as it is.
- **Alternatives:**
  - **Electrobun** is attractive because it is Bun and TypeScript only. It reached v1 in February 2026, and a March 2026 review called it early-stage, with documentation gaps [S]. Its Windows packaging still leans on third-party tools [S]. Revisit it at U5.
  - **Electron** gives the most consistent rendering, but it is large and adds Node next to Bun.
- **What the shell adds over the browser:**
  - a dock icon and window;
  - a native menu bar (File → Open Folder…, recent projects, Cmd+N for a new conversation);
  - window size and position remembered;
  - system notifications ("Turn finished", "mrig wants to run `bun test`") with a dock badge;
  - drag and drop of files and images onto the window;
  - opening links in the default browser;
  - optional launch at login and a global shortcut to bring it forward;
  - auto-update later (U5).
- **Lifecycle:**
  - the app starts `mrig serve` as a sidecar, reads its URL and token from stdout, and loads the front end;
  - quitting the app stops the server;
  - if the server crashes, the window says so and offers to restart it.
- **macOS first, unsigned for your own use.**
  - Gatekeeper asks once; you right-click the app and choose Open.
  - Before the app goes to anyone else, it needs the Apple Developer Program ($99 a year) for signing and notarization.
  - Windows signing is a separate certificate. Both are RT's decision (§ Open questions).

### 6. The VS Code extension

- **The approach: a custom panel, not a chat participant [I].**
  - VS Code's AI extensibility overview lists chat participants as deprecated, and they plug into the Copilot chat harness [S].
  - mrig calls its own models, so the extension instead hosts mrig's own front end in a webview view: a panel in the sidebar or the secondary side bar.
  - This also works in VS Code forks that don't support the participant API [S].
- **The same front end,** with the workspace folder as the project. The extension starts `mrig serve` (from your `PATH`, or the `mrig.path` setting) and connects. One server per window.
- **Editor features the panel can't do alone:**
  - **"Ask mrig about this" on a selection,** which sends the file path and line range into the message box;
  - **the active file as optional context;**
  - **clickable `file:line` references** in replies, which open in the editor;
  - **an edit permission request shown in VS Code's own diff editor,** with Allow and Deny there as well as in the panel;
  - **a status bar item** with the model, the cost, and a spinner while a turn runs;
  - **a notification** when a permission request is waiting and the panel is hidden.
- **Distribution:**
  - v1 is a `.vsix` file you install with *Extensions → Install from VSIX*;
  - publishing to the Marketplace, which is public and needs a publisher account, is RT's decision.
  - The extension does not bundle `mrig` in v1. It uses the one you installed, so there is one copy to update.

### 7. What stays the same

- **The terminal** (`mrig`, `mrig --tui`, `mrig -p`) is unchanged and stays the default.
- **One binary** for mrig; the web front end is inside it. The desktop app and the VS Code extension are separate downloads that use it.
- **Config, sessions, permissions, modes, routing, offline zones and costs** all work as they do now. A conversation started in the terminal can be resumed in the app, and the other way round, because they are the same session files.
- **No telemetry,** in any front end.

### 8. Akkha in the front ends

- Akkha text from `translit` is Unicode Brahmi [V], and showing it needs a Brahmi font.
- The app bundles **Noto Sans Brahmi** (SIL Open Font License) as the fallback.
- The GurbachhanAkkhaRik font is RT's and is not public. It **must not be bundled** (the Akkha-Rik app repo has the same rule [V]). A setting can point the app at a font you've installed, once A1 has produced the Brahmi-encoded font.

## Build order (Track 4)

All sizes are estimates [I]. Each item gets its own branch, tests, README section and PR, as usual.

| # | Item | Effort | Depends on |
|---|---|---|---|
| U1 | **Local app server:** `mrig serve`, protocol v1, the security rules (§3), structured tool `display` in the core, one `Runtime` per conversation, reconnect snapshots | M | this note |
| U2 | **Web app v1:** `mrig app`; the front end built into the binary; everything in "What feels like an app" except notifications and the editor features; `ChatViewModel` tests and one Playwright smoke test | L | U1 |
| U3 | **Desktop app for macOS:** a Tauri v2 shell with the `mrig` sidecar; menus, notifications, dock badge, drag and drop, remembered window; an unsigned `.dmg` built in CI on a macOS runner | M | U2 |
| U4 | **VS Code extension:** a webview panel on the same front end; selection and active-file context, clickable file references, edits in VS Code's diff editor, a status bar item; a `.vsix` built in CI | M | U2 |
| U5 | **Desktop for Windows and Linux,** plus signing and auto-update where RT decides to pay for certificates | M | U3 |
| U6 | **Later, only when asked:** a settings editor, an MCP panel, a learner and tutor view (T2, T8), push-to-talk with `transcribe` (T5), several projects in one window | — | U2 |

**Suggested order:** U1 → U2 → U3 → U4 → U5. U3 and U4 are independent once U2 lands. If you spend more time in VS Code than in a separate window, swap them.

**How this fits the other work:**
- Track 4 runs **in parallel with the live checks**. Nothing in it waits on them, and they don't wait on it.
- It touches the core in one place: the tool `display` field in U1.
- If a live check finds a bug, that fix comes first.

## Acceptance (per item)

- **U1:**
  - mock-model tests drive a real `mrig serve` on a free loopback port with a test client. They cover a turn streaming `text.delta`, then `turn.end`; a permission round trip (`ask` → `ask.answer`); abort; reconnect with a full `snapshot`; and two conversations at once.
  - Each security rule in §3 has a test that it refuses.
  - The REPL and TUI tests are unchanged and pass.
- **U2:**
  - `mrig app` opens a working page on macOS, Windows and Linux. CI runs the Playwright smoke test on Linux, and the build checks that the binary serves the page on all three.
  - The `ChatViewModel` is tested without a browser.
  - The page loads nothing from the internet, which the CSP test asserts.
  - RT uses it for a real session and lists what feels wrong; those fixes are part of U2.
- **U3:**
  - A `.dmg` from CI installs on RT's Mac and opens a project.
  - Quitting stops the server, with no orphan `mrig serve` left in Activity Monitor.
  - A notification appears when a turn finishes in the background.
  - The sidecar crash path is tested.
- **U4:**
  - The `.vsix` from CI installs in VS Code on RT's Mac.
  - A selection reaches the message box.
  - An `edit` request opens VS Code's diff editor, and Allow there applies it.
  - Clicking `src/agent.ts:42` in a reply opens that line.
- **U5:** installers for Windows and Linux built in CI and opened on each OS; signing as decided.

## Risks

- **Security mistakes in U1 matter most.** Mitigated by §3, tests that each rule fails closed, and a security review of the U1 PR before merging.
- **Scope creep in U2.** "App feel" has no natural end. Mitigation: the list in "What feels like an app" is the scope, and anything else goes to U6.
- **Binary size.** React and a highlighter add an estimated 0.3–1 MB to a binary of tens of megabytes [I]. Measure it in U2.
- **Desktop toolchains.** Tauri needs Rust, and signing needs paid accounts. Mitigation: build in CI only; unsigned until RT decides.
- **The VS Code API changes.** Mitigation: use only the stable webview, command, diff and status bar APIs; no proposed APIs.
- **Two front ends to keep in step** (TUI and web). Mitigation: shared commands and one core, with the web view model mirroring `TuiController`.

## Alternatives considered

- **Three separate native UIs** (SwiftUI on Mac, a VS Code-native chat, a web page): three codebases, triple the work, and they drift apart.
- **Running the core inside the desktop shell** (Electrobun's Bun main process could import mrig directly): one process fewer, but a second integration path that VS Code and the browser can't use. The protocol keeps one path.
- **A VS Code chat participant:** deprecated, and tied to Copilot's chat harness [S].
- **Exposing the server on the network for phone access:** rejected for v1 on security grounds. If wanted later, it needs its own note (TLS, pairing, its own token rules).
- **Server-rendered pages instead of a front-end app:** simpler at first, but streaming, diffs and pickers need client state anyway, and the desktop app and VS Code want the same app.

## Open questions for RT

1. **Architecture (§1).** Approve one local server plus one web front end, reused by the desktop app and the VS Code extension (recommended)?
2. **Desktop framework (§5).** Tauri v2 (recommended), Electrobun (Bun-only, newer), or Electron (largest, most consistent rendering)?
3. **Order.** Web → desktop (Mac) → VS Code → Windows and Linux (recommended)? Or VS Code before the desktop app?
4. **Signing (§5).** Unsigned for your own Mac now, and decide on the Apple Developer Program ($99 a year) before sharing the app (recommended)? Or sign from the start?
5. **VS Code distribution (§6).** A `.vsix` you install yourself (recommended for now), or publish to the Marketplace?
6. **Look.** A clean, neutral design that follows the system's light or dark mode (recommended), or something branded? If branded, which colors or logo?
7. **Network access.** Confirm loopback only, with no phone access, in v1 (recommended)?
