# Life 0.9.0

Life 0.9.0 adds a complete localhost web application with real Codex and Claude Code conversations, alongside updated Electron desktop installers.

- **Real provider conversations:** Messages, streamed replies, approvals, questions, steering, queues, and stop controls use the installed provider CLIs. Saved conversations retain their provider session IDs across reloads.
- **A complete local workspace:** Project files, Git, an interactive terminal, SSH connections, Research, runtime extensions, and source customization are available through the web backend.
- **Simpler Research:** Removed duplicate goal navigation, introductory banners, the approach selector, the sidebar attachment button, and the sidebar message finder. Describe the research approach in your prompt.
- **A cleaner Research composer:** The input sits against the sidebar borders with square corners, without the goal/branch footer or duplicate borders. Composer actions stay on the same row as the controls as the sidebar resizes.
- **Native provider permissions:** Codex offers Ask for approval, Read-only, Approve for me, and Full access. Claude Code offers Manual, Accept edits, Auto, Don't ask, and Bypass permissions. The web menu omits Plan.
- **Quiet settings changes:** Controls update immediately and send native settings requests for idle and running chats without routine status notices in Agents or Research. Supported live changes do not interrupt the turn or insert a message. Providers retain their own timing for running-turn permission boundaries.
- **Reliable Research messages:** Research follows the connected machine even when an older browser-preview cache is restored. Goal and problem conversations use the correct workspace and remain separate from Agents.
- **Refined steering:** The web Steer arrow uses yellow text with a transparent background, matching the Send control's shape.

## Desktop update

Installers are included for Windows x64, Linux x64 (AppImage and Debian), and macOS on Intel and Apple Silicon. Update through Life's **Updates** controls where supported, or download the installer for your platform. The release includes updater metadata, blockmaps, and SHA-256 checksums. Existing connections, conversations, Research, and customizations remain in Life's data directory.

The Research layout and permission-menu changes described above apply to the web interface. Desktop retains its existing interface and receives the shared provider-control and validation fixes. Installers remain unsigned.

## Run the web application

Download and extract either `Life-0.9.0-web.zip` or `Life-0.9.0-web.tar.gz`. The backend uses Linux or macOS (WSL on Windows), with Node.js 22.12 or newer, Bash, Git, and Python 3. Run these commands inside the extracted folder:

```bash
npm ci
npm run start:web
```

Open [Life on localhost](http://localhost:5173/life/). Install and sign in to Codex and/or Claude Code on the server before sending messages. The app uses those accounts and their provider permissions.

The bundles contain the built frontend, Node.js backend, and source needed for customization. Saved conversations, Research data, credentials, and private extension backups are excluded. SHA-256 checksums are supplied in `SHA256SUMS-web.txt`.

For development, use `npm run dev:web`. See [web app setup](https://github.com/greatitself/life/blob/v0.9.0/docs/web-app.md) for production configuration and persistence. The [public browser demo](https://greatitself.github.io/life/) remains a static demo; real provider execution uses the localhost application.
