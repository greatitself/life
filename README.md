# Life

Life is an Electron workspace for running **Codex and Claude Code over SSH**, with a compact interface inspired by [T3 Code](https://github.com/pingdotgg/t3code). Connect to a Linux or macOS machine, open an existing project, and work with either agent using its login on that machine.

![Life desktop workspace](docs/images/life.png)

Download installers from [GitHub Releases](https://github.com/greatitself/life/releases). Initial releases are unsigned. On macOS, you may need to use **Open Anyway** in System Settings; Windows may display an unrecognized publisher prompt.

## Run the desktop app

Use Node.js 22.12 or later and npm on your local computer.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm start
```

The browser preview is available with `npm run dev:web` at `http://localhost:5173`. SSH, key selection, and remote agents require the Electron app.

## Connect a workspace

1. Click **Connect a machine**.
2. Enter the hostname or IP, SSH port, username, and an existing remote project directory, such as `~/projects/my-app`.
3. Choose a local SSH private key, your local SSH agent, or an SSH password. Encrypted private keys accept a passphrase.
4. Verify and accept the machine’s SSH host key fingerprint on its first connection.
5. Select **Codex** or **Claude Code**, choose a model and permission mode, and send a message.

Connection profiles save the hostname, username, port, project directory, authentication method, and private key **path**. Passwords, passphrases, and private key contents are not saved. Host keys are pinned; a changed host key fails the connection. Confirm a legitimate change out of band before removing that machine’s entry from `knownHosts` in the local `connections.json` file.

Life uses a direct SSH connection. This version accepts hostnames and IP addresses; it does not import `~/.ssh/config` aliases, `ProxyJump`, or SSH tunnels. Each saved workspace identifies one machine and one project directory. One SSH connection is active at a time; multiple agent threads can run on that connection.

## Prepare the remote agents

Install and authenticate one or both CLIs **on the remote machine**. Life detects the installed versions when connecting. If you install a CLI while connected, reconnect to refresh its availability.

For Codex:

```bash
npm install -g @openai/codex
codex login --device-auth
```

For Claude Code:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude auth login
```

The CLIs must be available to the remote login shell. Life also checks the standard `~/.local/bin`, `~/.npm-global/bin`, and `/opt/homebrew/bin` locations. The integrated terminal lets you finish setup and sign in. Account access and model availability follow each remote CLI’s configuration.

Codex is controlled through its [app-server protocol](https://developers.openai.com/codex/app-server/). Claude Code is controlled through its [streaming CLI](https://code.claude.com/docs/en/headless) and the bidirectional control protocol used by Anthropic’s Agent SDK. No agent runtime is uploaded to your machine; Life starts the installed CLI through an SSH channel.

## Working in Life

- **Threads:** Separate conversations per workspace and provider. Saved history resumes the remote provider session after reconnecting. A thread keeps its original provider; start a new thread to switch.
- **Models:** Codex models are fetched from the remote CLI. Claude supports its default model and the `sonnet`, `opus`, and `haiku` aliases.
- **Permissions:** Review actions surfaces provider approval requests. Allow edits permits workspace edits while retaining other approval checks. Plan only uses the provider’s planning or read-only mode.
- **Files:** Browse the remote directory over SFTP, read text files up to 1 MB, and add a file reference to your prompt. File previews are confined to the connected workspace, including resolved symbolic links.
- **Changes:** Review tracked changes against `HEAD`, including staged changes. Untracked files appear in the status list and can be read in Files.
- **Terminal:** Use an interactive remote shell alongside the chat.
- **History:** Search, export, or delete local conversation history. Chat history and displayed command output are stored locally in the app’s browser storage.

| Action              | Shortcut            |
| ------------------- | ------------------- |
| New thread          | Ctrl/Cmd + N        |
| Search threads      | Ctrl/Cmd + K        |
| Connections         | Ctrl/Cmd + ,        |
| Toggle terminal     | Ctrl/Cmd + backtick |
| Toggle sidebar      | Ctrl/Cmd + B        |
| Send message        | Enter               |
| Insert a line break | Shift + Enter       |

## Build installers

```bash
npm run dist
```

Electron Builder creates installers in `release/`: AppImage and Debian packages on Linux, DMG on macOS, and NSIS on Windows. Build on the target platform for the most reliable packaging. `npm run dist:dir` produces an unpacked app. Release signing and notarization credentials are not configured.

Pushing a version tag such as `v0.1.0` runs the release workflow: it verifies the project, builds Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel installers, then publishes them with SHA-256 checksums.

## Verify changes

```bash
npm run typecheck
npm test
npm run build
```

The integration suite uses a loopback SSH server and deterministic provider fixtures to test transport and protocol behavior without making paid model requests. Real agent inference requires a remote machine with an authenticated CLI.

## Project structure

```text
src/main/        Electron lifecycle, SSH/SFTP, provider protocols, profile storage
src/preload/     Typed IPC bridge with context isolation
src/renderer/    React interface, remote terminal, local conversation state
src/shared/      IPC types and input validation
tests/          Unit and SSH integration coverage
build/          Application icon
```

The renderer has no Node integration. SSH credentials and local key access stay in the main process. The preload bridge exposes specific operations, and incoming IPC requests validate their arguments and sender.
