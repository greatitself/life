# Use this checkout while improving Life

For the full native application in your laptop's browser, including SSH, terminal, and provider controls, use the [private Electron desktop feedback workflow](live-desktop-feedback.md). It runs real Electron on a private display and streams that display through a forwarded local port.

## Open the browser preview from your laptop

On the machine holding this checkout, run:

```bash
node scripts/live-preview.mjs
```

The renderer listens on `127.0.0.1:5173` with Vite and React hot updates. Forward port **5173** through your editor's Ports panel, then open its local address. With an SSH connection, run this command on your laptop instead:

```bash
ssh -N -L 5173:127.0.0.1:5173 your-user@your-host
```

Then open [http://localhost:5173](http://localhost:5173). Keep the server and forwarding connection running. If your laptop already uses port 5173, use `-L 5174:127.0.0.1:5173` and open `http://localhost:5174`.

This previews the actual repository interface for visual feedback. Native SSH connections, terminal sessions, provider execution, and Electron permissions require the desktop application below. The preview does not expose those native services through HTTP.

## Use the full Electron application

Run Life from this repository on a machine with a desktop session and Node.js 22.12 or newer. The terminal, checkout, and Electron window must be on that machine. A headless SSH terminal can run the smoke fixture under Xvfb, but that does not display a window on your desktop.

Finish active agent work and close any other Life instance before changing to this development workflow. Then, from the checkout:

```bash
npm ci
npm run build
npm run dev -- --rendererOnly
```

Keep the last command running while using the Electron window. It starts the repository's Vite renderer and the built Electron host and preload bridge. Connect your SSH machine, select your project, and use your authenticated Codex or Claude Code CLI as usual. Changes must reach this checkout to appear in its window; editing a different local or remote copy does not update it.

CSS edits update the open window through Vite. Component edits use React Fast Refresh where its component boundary remains valid. This is the feedback loop for adjusting renderer appearance and component behavior while using Life. Report the steps you took, what happened, and what you expected; include the screen and provider when relevant.

React Fast Refresh can preserve component state, but an edit that changes a component's hook structure, a shared module, the bootstrap, or the Vite configuration may reset state or reload the document. Finish active provider work before those changes. A full renderer reload stops current agent work; saved history retains the provider session identity so you can select the thread and continue with a new message. Draft persistence helps recovery, but it is not a guarantee that every arbitrary hot edit preserves a running session.

Native changes under `src/main`, changes to `src/preload`, and dependency changes need a controlled restart:

1. Finish or stop active provider work, then close the Life window normally so its conversation checkpoint can finish.
2. Stop the development command if it remains running.
3. Run `npm run build`.
4. Run `npm run dev -- --rendererOnly` again, then reconnect and select your saved thread.

The renderer-only command keeps native rebuilding explicit. Do not add `--watch` to this workflow: electron-vite restarts Electron automatically after main-process edits, which can interrupt active work. Stopping the development terminal can also terminate Electron, so close the window normally first.

## Verify the feedback loop

After building, run the dedicated fixture when no one else is editing renderer source:

```bash
node tests/live-feedback-smoke.cjs
```

The fixture runs on Linux using the actual repository Vite configuration, built Electron host and preload, an isolated application profile, and the existing loopback SSH server with deterministic provider programs. It temporarily edits one stylesheet and one React component, verifies both updates without a new Electron process, a replacement window, or document navigation, and checks the exact draft, submitted prompt, provider session, workspace ownership, and native history. It restores the original source bytes and closes its own Electron, Vite, and SSH resources. It uses Xvfb if no display is available.

The proof and screenshots go under `output/playwright/live-feedback/`. Timing observations compare the same fixture before and after the hot edits. These checks exercise Electron, IPC, SSH, and provider protocol fixtures; authenticated upstream inference still requires your real remote machine.
