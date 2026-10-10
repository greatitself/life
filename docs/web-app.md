# Life web app

The web backend runs on Linux or macOS with Node.js 22.12 or newer, Bash, Git, and Python 3 for the interactive terminal. On Windows, run the web backend in WSL; the Electron Windows installer runs natively.

Run `npm run dev:web` and open [Life on localhost](http://localhost:5173/life/). The web app connects to **This machine** and selects the repository as its initial project. Choose a different folder with the project picker, or add an SSH connection through the machine dialog.

Messages run through the installed Codex and Claude Code CLIs. Replies, progress, tool calls, approvals, questions, stop controls, and follow-ups use the same provider runner as the desktop application. Provider credentials remain on the server. Codex's integration uses its [official app-server protocol](https://developers.openai.com/codex/app-server/).

Install and sign in to each CLI on the server before using it. For Codex, run `codex login`; for Claude Code, run `claude auth login`. The app's **Terminal** surface provides an interactive shell for these commands. Selecting a provider that is installed but signed out reports the authentication error and keeps the message draft.

The web access menu uses each provider's native permissions. Codex offers **Ask for approval**, **Read-only**, **Approve for me**, and **Full access**. Claude Code offers **Manual**, **Accept edits**, **Auto**, **Don't ask**, and **Bypass permissions**. These choices configure the provider at startup and when changed in an existing conversation. Auto availability depends on the provider account and model. Plan is omitted from the web menu. See [Codex permission modes](https://learn.chatgpt.com/docs/permission-modes) and [Claude Code permissions](https://code.claude.com/docs/en/permissions).

Web controls update immediately and send native settings requests for both running and idle conversations. Routine settings changes show no status messages in Agents or Research. Codex supports live model, effort, speed, and reviewer changes; its running-turn API keeps the sandbox and approval policy fixed until the next turn.

Project files, Git changes, Research records, and attachments use the real server filesystem. Settings, saved connections, conversation history, runtime extensions, and source customizations are persisted under `.life/web-app` in the repository. Research uses the connected host's `.life/research` folder. Browser conversation caches also remain available; opening a new browser loads the server's saved history.

Research messages use the approach described in the user's prompt. The web app has no next-message approach selector and adds no selected operation to new or queued messages. Context files still identify the goal, problem, and research files; stored legacy selections do not guide new web requests.

The web Research panel follows the active machine connection, including when a browser restores an older preview cache. Connecting another host opens that host's Research workspace. Cached work from other hosts remains saved separately.

Runtime extension views and interactive Research HTML maps run in sandboxed documents. Source customizations compile on the server and load their built assets over HTTP. The web app does not require Electron.

## Production

The [v0.9.0 release](https://github.com/greatitself/life/releases/tag/v0.9.0) includes ZIP and tar.gz bundles with the built frontend, backend, and customization source. Extract a bundle, install dependencies with `npm ci`, then run `npm run start:web`. Use Node.js 22.12 or newer. These bundles exclude local Research, saved conversations, credentials, and extension backups.

Run `npm run build:web`, then `npm run start:web`. The build creates `dist-web` and `out/web/server.cjs`. Keep the repository source and installed dependencies alongside these artifacts so source customization remains available. `PORT` changes the port; `LIFE_WEB_ROOT` changes the repository root; `LIFE_WEB_BASE` changes the URL prefix and must match the value used during the frontend build.

The application is a single-user localhost server, listening on `127.0.0.1`. Browser requests use a server session, same-origin validation, and an HTTP-only cookie. Do not expose this server as a public multi-user service.

Run `npm run test:web-app` against a running server to verify files, Git, terminal, model discovery, and layout. `npm run test:web-app -- --real-agents` also sends two read-only Codex messages and checks conversation continuity and persistence. These real-agent checks use the signed-in account.

The public static demo remains available separately through `npm run dev:preview` and `npm run build:preview`; see [browser preview](web-preview.md).
