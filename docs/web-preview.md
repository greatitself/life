# Life browser preview

Open [Life on the web](https://greatitself.github.io/life/) to review the same interface used by the Electron application.

Research goals, problems, requirements, assumptions, evidence, candidate solutions, interactions, verification records and alternative research approaches are editable. Their files stay in this browser's local storage under its example `/browser/.life/research` environment. They are not uploaded to GitHub or synced with an SSH machine. The initial goal is clearly labeled example data; its proposed mechanisms and pending tests are illustrative.

The Research sidebar offers a local-edits export when sync needs attention. Theme and built-in feature choices persist in the browser too.

Map, Agents, Life Studio and the environment controls use the shared application components. A web preview does not connect to SSH, run Codex or Claude Code, compile local source extensions, open a terminal, read an existing host's chat history, or publish extensions. These actions require the desktop application and do not produce simulated provider output in the preview.

Interactive Research HTML maps run in documents served by a browser-only Service Worker. Their response uses an opaque sandbox policy and cannot access Life's browser bridge, parent document, or local storage. HTTPS is required for this feature; localhost also supports it during development. The worker does not cache or intercept ordinary application assets.

## Development

Run `npm run dev:preview` and open `http://localhost:5173/life/`. Run `npm run build:preview` to produce the static `dist-web` directory; `npm run test:web-preview` verifies that production artifact in Chromium. `LIFE_WEB_BASE` can change the deployment prefix from `/life/`. For the complete application with real Codex and Claude Code conversations, run `npm run dev:web`; see [Life web app](web-app.md).

The GitHub Pages workflow builds and verifies the preview after relevant main-branch changes, then deploys the artifact. It includes only repository source and public example records. Raw extension backups, machine credentials and private Research directories are excluded.
