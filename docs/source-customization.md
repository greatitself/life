# Edit Life from its own conversation

Life 0.4 can change its built-in React application from an ordinary Codex or Claude Code thread. Ask with `/life`, `@life`, or a request addressing Life itself. Follow-up questions and implementation work stay in that conversation and provider session. Use `/project` or the composer’s scope control to return to your connected project.

Examples:

- `/life replace the model dropdown with a shadcn Select and keep the current keyboard behavior.`
- `/life add a research-review page with sortable experiments and saved notes.`
- `/life change the composer layout and add an advanced provider option.`

The current select controls have not been replaced in advance. Requests for component libraries can add real React source and npm dependencies, which Life builds on your computer.

## How a change reaches the interface

1. Life supplies a source index, the current revision, and relevant existing code to the connected agent. The agent can request exact additional files automatically.
2. The agent returns a source proposal containing file contents or exact find/replace edits and, when needed, npm package versions. Settings and executable extensions have their own proposal formats.
3. Life checks the revision and file paths, copies the current source into a staging revision, installs added dependencies, and runs its bundled esbuild compiler.
4. A successful build becomes the active source revision. Life saves the conversation and reloads the interface while retaining its local data.
5. Compiler or proposal errors return actual diagnostics and refreshed context to the same agent. The prior working build stays active. A request allows up to two automatic repair attempts and six automatic source-read round trips.

Questions and explanations need no proposal. Concurrent changes cannot silently apply an older source revision over newer work. Compilation checks source syntax and import resolution; an agent still needs to preserve the application’s behavior.

## Editable source and dependencies

The editable application includes `src/renderer/**` and `src/shared/**`. The recovery bootstrap and `index.html` remain protected. Native `src/main/**`, `src/preload/**`, and the packaged `package.json` are available as read-only reference so the agent can understand the host’s contracts.

Life ships its compiler, baseline dependencies, and npm tooling. Customization does not need a separate Node.js or npm installation. New packages come from the public npm registry and require a network connection. Proposals accept explicit semver versions with optional `^` or `~`; Git, file, and arbitrary download URLs are not dependency specifications.

Dependency installation runs with lifecycle scripts disabled. Browser-compatible packages and source components are supported; packages requiring native compilation or install scripts need additional packaging work. The compiler supports TypeScript/TSX, React imports, CSS, images, SVGs, and fonts. A component library’s styles must be included in the proposed source; adding its package name alone does not replace a control.

Tailwind v4 generation is available when a proposal adds `tailwindcss`, `@tailwindcss/postcss`, and `postcss` alongside stylesheet directives such as `@import "tailwindcss"`, `@theme`, or `@apply`. Life processes these styles in an isolated, cancellable compiler worker before bundling. This supports actual shadcn component source with generated utilities; invalid utilities fail the candidate build and return diagnostics for repair. The default application does not add these dependencies or replace existing selects in advance.

Backend extensions remain available for local files, commands, modules, and worker-based behavior. Advanced agent calls can pass validated `providerOptions`: Codex `thread`/`turn` fields or Claude `settings`/`args`. Reserved session, directory, permission and stream-format options remain managed by Life. The provider’s real CLI, account and model capabilities determine which additional options work.

## Inspect, restore, and recover

Click **Source code** below **Ports** in the sidebar to open the **Life source** dialog. Browse the current files and revision, manually edit or add source files, **Compile & reload**, **Restore previous**, **Use built-in interface**, or **Open folder**. Local files live under Life’s data directory in `source-code`, with separate revision builds and a dependency cache.

Press **Ctrl/Cmd + Shift + L** to restore the built-in interface through the native host. That shortcut and the recovery loader are separate from the editable React code. Startup failure recovery also restores the built-in interface and retains source files for inspection and repair.

Installers preserve this local data directory and the application’s existing installation identity. If an update changes the built-in source baseline, Life disables the custom interface and retains its source edits. Ask `/life update my customization for this Life version` to rebuild. The agent can read your modified files alongside the new originals; the next build refreshes unchanged files and adds new baseline files while retaining modified and intentionally deleted files. Successful compilation records the new baseline. Conflicting edits or changed host contracts can still require repair; this is not an automatic semantic merge.

The installed native host, preload bridge and Electron binaries stay intact during source customization. New React features, imported components and supported backend-worker behavior can change live. Changes to native binaries, base Electron behavior or installer signing belong in a packaged release.
