# mrig for VS Code

[mrig](https://github.com/rob2rhyme/mrig), your local, model-agnostic agent, in a VS Code panel.
The panel is mrig's own web app, so it looks and works the same as `mrig app`, plus:

- **Ask mrig about this.** Select some code, then right-click → **Ask mrig about this**
  (or press Cmd+Alt+M; Ctrl+Alt+M on Windows and Linux). The file and lines go into the message
  box, for example `` `src/agent.ts:10-24` ``.
- **Edits open in the diff editor.** When mrig asks to edit or write a file, VS Code shows the
  change in its diff editor, with **Allow** (✓) and **Deny** (✕) in the editor's title bar. The
  buttons in the panel work too.
- **File links.** A file reference in a reply, like `src/agent.ts:42`, opens that line.
- **Status bar.** The model and the session's cost; a bell when mrig is waiting for you, and a
  notification when the panel is hidden.

## Setup

1. Install mrig and set it up for a model (see mrig's README). The extension looks for the
   `mrig` program on your PATH, then in `~/.local/bin`, `/opt/homebrew/bin` and
   `/usr/local/bin`. If yours is elsewhere, set **mrig.path** in Settings.
2. Install the extension from the `.vsix` file:

   ```bash
   code --install-extension mrig-vscode.vsix
   ```

   Or, in VS Code: the Extensions view → the **…** menu → **Install from VSIX…**.
3. Click the mrig icon in the activity bar. The panel opens the workspace folder.

API keys come from your environment, as in the terminal. On macOS, VS Code reads your login
shell's environment, so a key exported in `~/.zshrc` works.

## How it works

The extension starts its own `mrig serve --with-app` for each VS Code window, in the workspace
folder. It listens on `127.0.0.1` only, with a new launch token each time, and the panel shows
the app from it. Closing the window stops it. The app only listens to messages from the panel
that holds it, and accepts only "put this text in the message box" and "Allow or Deny this
request". Nothing is sent anywhere else, and there is no telemetry.

**Restart mrig** in the Command Palette starts a fresh server, for example after you change
mrig's config.

MIT licensed.
