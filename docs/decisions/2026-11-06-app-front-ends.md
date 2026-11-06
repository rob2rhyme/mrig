# App front ends (Track 4) decision

Date: November 6, 2026. Status: **decided by RT, November 6, 2026**, then **revised the same day**: an installable web app (PWA) with an allowlist login, plus a VS Code extension. Native desktop apps are dropped (see **Answers**). Building starts with U1.

Labels: **[V]** verified against the code or a primary source · **[S]** secondary source · **[I]** inference or recommendation.

## The problem

mrig runs only in a terminal: the plain REPL, or the Ink TUI with `--tui` [V]. RT wants it to feel like a real app. After weighing three kinds (web, native desktop, VS Code), RT chose two, because native apps cost a lot of work and disk space:

- **A PWA** (progressive web app). It installs from the browser into the Dock on the Mac and onto the home screen on a phone, and opens in its own window like an app. **Only devices on an allowlist can log in.** Other devices reach the Mac over Tailscale.
- **A VS Code extension** that sits inside the editor.

## What "feels like an app" means

The target experience, in both front ends:

- **It opens like an app.** On the Mac, the PWA has a Dock icon and its own window (Chrome, Edge or Safari's *Add to Dock*). On a phone, it has a home-screen icon and opens full screen. It has a project picker (open a folder, recent projects) and remembers where you were.
- **Conversations in a sidebar,** grouped by project: start a new one, resume an old one, see each one's title and date. On a phone, the sidebar is a drawer.
- **Replies stream in as formatted text:** headings, lists, tables, code blocks with highlighting and a copy button.
- **Tool activity as compact cards:** one line per tool call (`read src/agent.ts`, `bash bun test`). Tap to see the output. Edits show as a diff.
- **Permission requests as a clear panel** with the diff or command in full:
  - on the Mac: **Allow once / Always allow / Deny**, plus the `y` / `a` / `n` keys;
  - on other devices: **Allow once / Deny** only (§5).
- **A Stop button** while a turn runs.
- **Pickers in the header** for the model (claude, opus, ollama…) and the mode (default, teach, learn, tutor).
- **A status bar** with tokens, cost, how full the context is, MCP servers, and offline or yolo.
- **Images:** drag, paste or (on a phone) take a photo into the message box for vision models (T3). Generated images, audio and video (T4–T6) show and play inline.
- **A command palette** (Cmd+K or `/`) for every slash command.
- **In-app alerts** when a turn finishes or a permission request is waiting, while the app is open. Push notifications to a closed app are later (U5).
- **Light and dark themes,** following the system; **a layout that works from phone to desktop width.**

## Proposed decisions

### 1. One core, one protocol, one web front end, two shells

The terminal UI already proves the shape [V]:
- the `Runtime` runs turns and emits events (`onText`, `onReasoning`, `onToolStart`, `onToolEnd`, `onStepEnd`, `onNotice`);
- permission questions arrive through an `ask` callback;
- slash commands are one shared implementation (`src/ui/commands.ts`);
- `TuiController` turns all of that into state with no UI code in it, which keeps the TUI testable without a terminal.

The plan adds one more adapter of the same kind, over a network connection instead of a terminal:

```
 PWA on the Mac ──────────────── http://127.0.0.1:4747 ──┐
 PWA on a phone ── Tailscale ── https://mac.<tailnet>.ts.net ─┤   mrig serve (listens on 127.0.0.1 only)
                                (tailscale serve → 127.0.0.1)  ├─► protocol v1 ── Runtime per conversation
 VS Code panel ── its own mrig serve, launch token ────────────┘     + the web front end, built into the binary
```

- **`mrig serve`** is a new command. It is a local server that runs one `Runtime` per open conversation and speaks a small, versioned WebSocket protocol (§2). Business logic stays in the core, as AGENTS.md requires; the server is a translator, like `TuiController`.
- **The web front end** is one React app, in a new `web/` folder, with a web app manifest and a service worker so it installs as a PWA. Bun can bundle an HTML entry point into a compiled executable (Bun 1.2.17 and later [S]; the repo uses Bun 1.4 [V]). So the front end ships **inside the existing single `mrig` binary**: no second download and no Node install.
- **Two shells:**
  - the **PWA**, served by `mrig app`;
  - the **VS Code extension**, which shows the same front end in a webview panel, plus editor features.
- **The terminal stays first-class:** the REPL and TUI are unchanged and remain the default for `mrig` with no arguments.

### 2. The protocol (v1)

JSON messages over one WebSocket at `/ws`. Every message is validated with zod on arrival, as tool inputs already are. Both ends import the types from one file (`src/server/protocol.ts`), so they cannot drift. A `protocol: 1` field lets a newer front end refuse an older server politely.

**Front end → server:**

| Message | What it does |
|---|---|
| `hello {protocol}` | The first message, on a connection that is already authenticated (§3) |
| `projects.list`, `sessions.list {cwd}` | The project picker and the sidebar (`Session.list()` already exists [V]) |
| `session.open {cwd, resume?}` | Start or resume a conversation; the server answers with a full `snapshot` |
| `turn.send {session, text, images[]}` | Send a message (images are uploaded to the session's folder, then passed as paths, as in T3) |
| `turn.abort {session}` | The Stop button |
| `ask.answer {askId, answer: yes/no/always}` | Answer a permission request; `always` is refused from other devices (§5) |
| `command.run {session, text}` | Any slash command (`/mode learn`, `/cost`); output comes back as text |
| `model.set`, `mode.set` | The header pickers; the same code paths as `/model` and `/mode` |

**Server → front end:**

| Message | When |
|---|---|
| `snapshot {session, items[], status}` | On open and on reconnect, so a reloaded or reopened app picks up exactly where it was |
| `text.delta`, `reasoning.delta` | As the reply streams |
| `tool.start {id, name, summary, display}`, `tool.end {id, status, output, ms}` | Tool cards |
| `ask {askId, summary, preview, alwaysRule, alwaysAllowed}` | A permission request (today's `AskRequest` fields [V], plus whether this device may choose Always) |
| `notice`, `status`, `turn.end {result: ok/error/aborted}`, `error` | Everything else |

**One core change is needed first:** tool events carry only a one-line summary today [V]. A card wants structure, so `ToolCallInfo` gains an optional `display`:
- `diff` for `edit` and `write`;
- `command` for `bash`;
- `path` for `read`;
- `media {path, kind}` for `image`, `speak` and `video`.

It is computed in the tools, where the knowledge is, and the REPL and TUI simply ignore it. Tool output sent to the front end is capped like everything else (`maxToolOutputChars`).

**One turn at a time per conversation,** as today. Several conversations can run at once, each with its own `Runtime`. Two devices viewing the same conversation see the same stream, and the first answer to a permission request wins.

### 3. Security basics: a server that can run commands must be locked down

`mrig serve` exposes an agent that can edit files and run shell commands, so this section and §4 and §5 are the parts that must not be cut [I].

1. **It listens on `127.0.0.1` only, always.** Nothing on your Wi-Fi or the internet can reach the port. Other devices come in only through Tailscale Serve, which runs on the Mac and forwards to `127.0.0.1` (§5). Tailscale itself recommends this setup [S].
2. **Every connection is authenticated, in one of two ways:**
   - **A device login** (§4) for browsers and the PWA, the Mac's included. This is the allowlist.
   - **A launch token** for a client that started the server itself: the VS Code extension. The token is 32 random bytes, new each launch, passed on stdout and never written to disk.

   The static app files (HTML, JS, CSS, icons) load without a login, since they hold no secrets. Everything else needs one: the WebSocket, uploads, media, and the session list.
3. **Host and Origin checks.**
   - `Host` must be one of the known addresses: `127.0.0.1:PORT`, `localhost:PORT`, or the Mac's Tailscale name. That defeats DNS-rebinding attacks.
   - The WebSocket upgrade and every state-changing request must come from one of those origins, or from VS Code's webview. That stops any website open in your browser from talking to mrig.
   - No CORS headers are ever sent.
4. **Permissions are unchanged.** The same `PermissionManager` decides, and a request waits for an answer from a connected device. If none is connected, it waits, and after 10 minutes it counts as **deny**. No device can set yolo or allow rules except as §5 allows.
5. **Files are served only from the media folders** (`images/`, `audio/`, `videos/` under the project) and attached images. It is never "any path you ask for".
6. **The model's output is untrusted when rendered:**
   - markdown is sanitized and raw HTML is never rendered;
   - **remote images in replies are blocked**, because a prompt-injected reply could otherwise leak data through an image URL;
   - links open in a new tab only after a click.
7. **A strict Content Security Policy:**
   - scripts and styles load only from the app itself;
   - the WebSocket connects only to its own origin;
   - images load only from the app, `blob:` and the media route.
8. **No remote assets at all:** no CDNs, web fonts or analytics. Everything is bundled, so the app works offline on the Mac and leaks nothing, and the offline guarantee (L5) still holds. `mrig serve --offline` and `.mrig-zone` behave exactly as in the terminal.
9. **Tests prove each rule fails closed:** no login, a revoked device, a wrong launch token, a foreign `Origin`, a rebinding `Host`, a path outside the media folders, a malformed message, `always` from another device.

### 4. Login: only allowlisted devices, paired once

RT's rule: **only devices saved in advance on an allowlist can log in.**

- **The allowlist lives on the Mac:** `~/.mrig/app/devices.json`, readable only by your user (mode 600). It is edited **only from a terminal on the Mac**. A project's `.mrig/config.json` cannot touch it, and in v1 the web app has no "add a device" button. Being at the Mac's keyboard is the proof.
  - `mrig app allow add <name>` creates an entry (`phone`, `ipad`, `mac`) and shows a one-time pairing code and QR code.
  - `mrig app devices` lists the entries, with when each was paired and last seen.
  - `mrig app revoke <name>` removes an entry at once and closes that device's open connections.
- **Pairing, once per device.** Open the app's address on the device and enter the code or scan the QR. The code is 8 characters long, single-use, and expires after 10 minutes; five wrong tries burn it. The device then gets a device key: 32 random bytes in an `HttpOnly`, `SameSite=Strict` cookie, plus `Secure` over HTTPS. The Mac stores only a hash of the key, never the key itself.
- **Staying logged in.** A paired device stays logged in until it's revoked, or until it hasn't been seen for 90 days. There are no passwords to guess, reuse or leak.
- **The Mac's own browser pairs automatically.** `mrig app` run in a terminal adds the Mac's entry if it's missing and opens the browser with a one-time code in the URL fragment. The fragment is never sent to the server and never logged. Installing the PWA after that keeps the login, because the app opens at a fixed address (port 4747 by default; `app.port` in the global config).
- **Optional second lock: the Tailscale login.** An entry can pin the Tailscale user it must come from (for example `you@example.com`). Tailscale Serve adds the requester's login to each request and removes any copy a device tries to fake [S]. A stolen cookie on a device outside your tailnet then gets nothing.
- **Rate limits and an audit log.**
  - Pairing and login attempts are rate-limited per address.
  - Every pairing, login, failure and revocation is appended to `~/.mrig/app/access.log`, with the time, device name and address, and never the key.
  - `mrig app devices` shows the last few failures.
- **Later, if wanted:** passkeys (Face ID or Touch ID) on top of pairing, in U5. Not in v1.

### 5. Other devices through Tailscale

- **Why Tailscale:** it is a private network between your own devices. It works from anywhere, not just home Wi-Fi. It gives the Mac a real HTTPS address (`https://<mac>.<tailnet>.ts.net`), which phones require before they install a PWA. And mrig is never exposed to the internet or the local network.
- **Setup, once, documented in the README:**
  1. Install Tailscale on the Mac and the phone, signed in to the same account.
  2. Turn on HTTPS certificates for the tailnet in Tailscale's admin page, which Serve requires [S].
  3. On the Mac, run `tailscale serve --bg 4747`. It forwards the HTTPS address, inside the tailnet only, to `127.0.0.1:4747` [S].
  4. Run `mrig app allow add phone`, open the HTTPS address on the phone, and pair.
  5. Add the app to the home screen.
- **mrig refuses Tailscale Funnel.** Funnel would put the address on the public internet. If mrig sees a request that came through Funnel, it refuses it and says why.
- **What another device may do:**
  - answer permission requests with **Allow once** or **Deny**, never **Always** (RT, November 6, 2026), so a lost or borrowed phone can't widen what mrig may do;
  - no `/yolo` and no command that changes config or allow rules; those are Mac-only;
  - everything else works as on the Mac: chat, switching models and modes, resuming conversations, `/cost`, stopping a turn.
- **"Another device" means anything that isn't the Mac:** a request that arrives through Tailscale Serve, with a `.ts.net` `Host` and Tailscale's identity headers. A request straight to `127.0.0.1` comes from the Mac itself.
- **The Mac must be on and awake,** with mrig running. `mrig app service install` adds a login item (a macOS LaunchAgent) that keeps `mrig serve` running in the background. `mrig app service remove` takes it out.
- **To check in U3:** that Tailscale Serve passes WebSocket upgrades through. A third-party setup reports that it does [S], but Tailscale's own docs don't say. U3 tests it first; if it fails, the protocol falls back to server-sent events plus HTTP posts, with no other change to this plan.

### 6. The PWA (`mrig app`)

- **Start it:** `mrig app [folder]` starts the server on port 4747 (or `app.port`), pairs the Mac's browser the first time, and opens it. `mrig serve` does the same without opening a browser. With `--launch-token`, it prints one JSON line (`{"url":…,"token":…}`) for VS Code to read.
- **Installable:**
  - a web app manifest with name, icons, theme color and `display: standalone`;
  - a service worker that caches only the app shell: HTML, JS, CSS and icons. It never caches conversations or media, and with no server it shows a "mrig isn't running on your Mac" page.
  - On the Mac, Chrome and Edge show an install button for `http://127.0.0.1:4747`, which counts as secure [I]. Safari has *File → Add to Dock*. On a phone, use *Add to Home Screen* over the Tailscale HTTPS address.
- **Stack [I]:**
  - **React**, which mrig already depends on for the TUI;
  - **plain CSS** with design tokens and light and dark themes, so there is no CSS framework;
  - a **small markdown renderer** with sanitizing, and a **lightweight code highlighter**, picked by size and bundled.
- **Layout:**
  - **Sidebar:** projects, then conversations. It becomes a drawer on narrow screens.
  - **Main column:** the transcript and the message box.
  - **Header:** the model picker, the mode picker, and the Stop button.
  - **Status bar:** the same fields the TUI shows [V].
  - **Touch:** targets of at least 44 points, iPhone safe areas respected, and the message box clear of the on-screen keyboard.
- **Testable without a browser:** a pure `ChatViewModel` turns protocol messages into transcript state, as `TuiController` does today. `bun test` covers it with no DOM, and React only renders it.
- **Testable in a browser:** Playwright smoke tests (Chromium is preinstalled in CI images) drive real pages against `mrig serve` with the mock model:
  - pair, send a message, see it stream, Allow a permission request, see the diff card, Stop;
  - the same at phone width;
  - the manifest and service worker register.

### 7. The VS Code extension

- **The approach: a custom panel, not a chat participant [I].**
  - VS Code's AI extensibility overview lists chat participants as deprecated, and they plug into the Copilot chat harness [S].
  - mrig calls its own models, so the extension instead hosts mrig's own front end in a webview view: a panel in the sidebar or the secondary side bar.
  - This also works in VS Code forks that don't support the participant API [S].
- **The same front end,** with the workspace folder as the project. The extension starts its own `mrig serve --launch-token` (from your `PATH`, or the `mrig.path` setting), reads the URL and token, and connects. It needs no pairing, because it started the server itself. There is one server per VS Code window, on a free port, and it stops when the window closes. Permissions there are the Mac's: VS Code runs on the Mac.
- **Editor features the panel can't do alone:**
  - **"Ask mrig about this" on a selection,** which sends the file path and line range into the message box;
  - **the active file as optional context;**
  - **clickable `file:line` references** in replies, which open in the editor;
  - **an edit permission request shown in VS Code's own diff editor,** with Allow and Deny there as well as in the panel;
  - **a status bar item** with the model, the cost, and a spinner while a turn runs;
  - **a notification** when a permission request is waiting and the panel is hidden.
- **Distribution:**
  - v1 is a `.vsix` file you install with *Extensions → Install from VSIX* (RT, November 6, 2026);
  - publishing to the Marketplace is a later decision.
  - The extension does not bundle `mrig`. It uses the one you installed, so there is one copy to update.

### 8. What stays the same

- **The terminal** (`mrig`, `mrig --tui`, `mrig -p`) is unchanged and stays the default.
- **One binary** for mrig; the web front end is inside it. The VS Code extension is a small separate download that uses it.
- **Config, sessions, permissions, modes, routing, offline zones and costs** all work as they do now. A conversation started in the terminal can be resumed in the app or in VS Code, and the other way round, because they are the same session files.
- **No telemetry,** in any front end.

### 9. Akkha in the front ends

- Akkha text from `translit` is Unicode Brahmi [V], and showing it needs a Brahmi font.
- The app bundles **Noto Sans Brahmi** (SIL Open Font License) as the fallback.
- The GurbachhanAkkhaRik font is RT's and is not public. It **must not be bundled or served** (the Akkha-Rik app repo has the same rule [V]). A setting can point the app at a font installed on the device, once A1 has produced the Brahmi-encoded font.

## Build order (Track 4)

All sizes are estimates [I]. Each item gets its own branch, tests, README section and PR, as usual.

| # | Item | Effort | Depends on |
|---|---|---|---|
| U1 | **Local app server:** `mrig serve` on `127.0.0.1`, protocol v1, the security basics (§3), launch-token auth, structured tool `display` in the core, one `Runtime` per conversation, reconnect snapshots | M | this note |
| U2 | **The PWA on the Mac:** `mrig app`; the front end built into the binary; the allowlist, pairing and device login (§4); manifest and service worker; everything in "What feels like an app" except push notifications and the editor features | L | U1 |
| U3 | **Other devices through Tailscale:** the Tailscale `Host` and identity headers, the Funnel refusal, the limits on other devices (§5), the phone layout, the background service, and the README setup guide; the WebSocket-through-Serve check comes first | M | U2 |
| U4 | **VS Code extension:** a webview panel on the same front end; selection and active-file context, clickable file references, edits in VS Code's diff editor, a status bar item; a `.vsix` built in CI | M | U2 |
| U5 | **Later, only when asked:** push notifications to a closed PWA (Web Push); passkeys; a settings editor; an MCP panel; a learner and tutor view (T2, T8); push-to-talk with `transcribe` (T5); several projects in one window | — | U2 |

**Order:** U1 → U2 → U3 → U4. U3 and U4 are independent once U2 lands. If you'd rather have VS Code before the phone, swap them.

**How this fits the other work:**
- Track 4 runs **in parallel with the live checks**. Nothing in it waits on them, and they don't wait on it.
- It touches the core in one place: the tool `display` field in U1.
- If a live check finds a bug, that fix comes first.

## Acceptance (per item)

- **U1:**
  - mock-model tests drive a real `mrig serve` on a free loopback port with a test client. They cover a turn streaming `text.delta`, then `turn.end`; a permission round trip (`ask` → `ask.answer`); abort; reconnect with a full `snapshot`; and two conversations at once.
  - Each rule in §3 that applies to U1 has a test that it refuses.
  - The REPL and TUI tests are unchanged and pass.
- **U2:**
  - Tests for pairing (a used or expired code, five wrong tries), login (no cookie, a revoked device, a device unseen for 90 days), and allowlist edits from the CLI only.
  - The `ChatViewModel` is tested without a browser.
  - The Playwright smoke tests pass in CI on Linux, and the build checks that the binary serves the app on macOS, Windows and Linux.
  - The page loads nothing from the internet, which the CSP test asserts.
  - RT installs the PWA on the Mac, uses it for a real session, and lists what feels wrong; those fixes are part of U2.
- **U3:**
  - WebSocket through Tailscale Serve is checked first.
  - Tests for the `.ts.net` `Host`, the identity-header pin, refusing Funnel, refusing **Always** and `/yolo` from another device, and closing a revoked device's connection.
  - The phone-width Playwright test passes.
  - RT pairs a phone over Tailscale, installs the PWA, and runs a turn with one permission request.
- **U4:**
  - The `.vsix` from CI installs in VS Code on RT's Mac.
  - A selection reaches the message box.
  - An `edit` request opens VS Code's diff editor, and Allow there applies it.
  - Clicking `src/agent.ts:42` in a reply opens that line.
  - Closing the window stops its `mrig serve`.

## Risks

- **Remote access is the biggest risk.** A phone can approve commands that run on the Mac. Mitigations:
  - loopback-only listening;
  - Tailscale's private network, never Funnel;
  - an allowlist edited only on the Mac;
  - pairing codes, hashed device keys and the optional login pin;
  - no **Always** or `/yolo` from other devices;
  - rate limits and an audit log;
  - a test for every rule that it refuses, and a security review of the U1, U2 and U3 PRs before merging.
- **Scope creep in U2.** "App feel" has no natural end. Mitigation: the list in "What feels like an app" is the scope, and anything else goes to U5.
- **Browser differences in PWAs.** Install prompts, service workers and cookies on `localhost` vary by browser, Safari most of all. Mitigation: the Playwright tests in Chromium, plus RT's hands-on checks in Safari on the Mac and the iPhone in U2 and U3.
- **WebSocket through Tailscale Serve** isn't documented by Tailscale [S]. Mitigation: U3 checks it first, with a fallback (§5).
- **Binary size.** React and a highlighter add an estimated 0.3–1 MB to a binary of tens of megabytes [I]. Measure it in U2.
- **The VS Code API changes.** Mitigation: use only the stable webview, command, diff and status bar APIs; no proposed APIs.
- **Two front ends to keep in step** (TUI and web). Mitigation: shared commands and one core, with the web view model mirroring `TuiController`.

## Alternatives considered

- **Native desktop apps** (Tauri v2, Electrobun or Electron). They were planned first, then dropped by RT on November 6, 2026 for the work and disk space. The PWA installs into the Dock and opens in its own window, which covers most of what they offered. Revisit only if the PWA falls short, for example for global shortcuts or launching at login without a terminal.
- **Exposing the server on the local network or the internet,** for phone access without Tailscale. On the local network it needs a certificate installed on every device and works only at home. On the internet it puts a command-running agent in reach of anyone. Rejected.
- **Names and passwords** instead of pairing. Passwords can be guessed and reused, and need lockout logic. Pairing codes give each device its own revocable key. Passkeys can come later.
- **Three separate native UIs** (SwiftUI, a VS Code-native chat, a web page): three codebases, triple the work.
- **A VS Code chat participant:** deprecated, and tied to Copilot's chat harness [S].
- **Server-rendered pages instead of a front-end app:** simpler at first, but streaming, diffs and pickers need client state anyway, and VS Code wants the same app.

## Open questions for RT

Answered below; kept as asked.

First round:

1. **Architecture.** One local server plus one web front end, reused by every shell?
2. **Desktop framework.** Tauri v2, Electrobun or Electron?
3. **Order.** Web, then desktop, then VS Code, then Windows and Linux?
4. **Signing.** Unsigned for your own Mac now?
5. **VS Code distribution.** A `.vsix` for now, or the Marketplace?
6. **Look.** Clean and neutral, following the system's light or dark mode, or branded?
7. **Network access.** Loopback only, with no phone access, in v1?

Second round, after RT chose a PWA with an allowlist plus VS Code:

8. **What "allowlist only" means.** Answer: only devices saved in advance can log in.
9. **How other devices reach the Mac.** Tailscale, the same Wi-Fi with a local certificate, or the Mac only?
10. **How a device logs in.** Pair once with a code, a name and password, or a passkey?
11. **"Always allow" from other devices.** Allow once and Deny only, or the same as on the Mac?

## Answers (RT, November 6, 2026)

- **First round:** RT approved every recommendation: one server and one front end; a `.vsix` for VS Code; a clean, neutral look following the system's light or dark mode.
- **Revision, the same day:** **drop the native desktop apps** (questions 2 to 4 no longer apply). Build **a PWA where only allowlisted devices can log in**, plus **the VS Code extension**. This reverses question 7: other devices may connect, through Tailscale.
- **Second round:** RT chose each recommendation:
  - **Tailscale** for other devices;
  - **pair once with a code** to log in;
  - **Allow once and Deny only** from devices other than the Mac.
