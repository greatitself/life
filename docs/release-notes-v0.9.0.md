# Life 0.9.0

Life 0.9.0 brings the latest Research interface and provider controls to the Electron desktop application.

- **Real provider conversations:** Messages, streamed replies, approvals, questions, steering, queues, and stop controls use the installed provider CLIs. Saved conversations retain their provider session IDs across reloads.
- **A complete desktop workspace:** Project files, Git, an interactive terminal, SSH connections, Research, runtime extensions, and source customization are available in Electron.
- **Simpler Research:** Removed duplicate goal navigation, introductory banners, the approach selector, the sidebar attachment button, and the sidebar message finder. Describe the research approach in your prompt.
- **A cleaner Research composer:** The input sits against the sidebar borders with square corners, without the goal/branch footer or duplicate borders. Composer actions stay on the same row as the controls as the sidebar resizes.
- **Native provider permissions:** Codex offers Ask for approval, Read-only, Approve for me, and Full access. Claude Code offers Manual, Accept edits, Auto, Don't ask, and Bypass permissions. The permission menus omit Plan.
- **Quiet settings changes:** Controls update immediately and send native settings requests for idle and running chats without routine status notices in Agents or Research. Supported live changes do not interrupt the turn or insert a message. Providers retain their own timing for running-turn permission boundaries.
- **Reliable Research messages:** Goal and problem conversations use their selected machine and workspace, retain file-backed Research records, and remain separate from Agents.
- **Refined steering:** The Steer arrow uses yellow text with a transparent background, matching the Send control's shape.

## Desktop update

Installers are included for Windows x64, Linux x64 (AppImage and Debian), and macOS on Intel and Apple Silicon. Update through Life's **Updates** controls where supported, or download the installer for your platform. The release includes updater metadata, blockmaps, and SHA-256 checksums. Existing connections, conversations, Research, and customizations remain in Life's data directory.

The Research layout, prompt-driven approaches, native permission menus, quiet settings changes, and steering controls described above are included in Electron. Installers remain unsigned.

The v0.9.0 installers were rebuilt to include the latest Research interface. If you already installed the earlier 0.9.0 build, download and run the replacement installer below; the in-app updater does not install another build with the same version number. The build source is linked at the end of these release notes.
