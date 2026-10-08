# Edit Life from its own conversation

Life 0.5 can change its built-in React application from an ordinary Codex or Claude Code thread. Each source change becomes an independently managed extension over the installed application. Ask with `/life`, `@life`, or a request addressing Life itself. Follow-up questions and implementation work stay in that conversation and provider session. Use `/project` or the composer’s scope control to return to your connected project.

Examples:

- `/life replace the model dropdown with a shadcn Select and keep the current keyboard behavior.`
- `/life add a research-review page with sortable experiments and saved notes.`
- `/life change the composer layout and add an advanced provider option.`

The current select controls have not been replaced in advance. Requests for component libraries can add real React source and npm dependencies, which Life builds on your computer.

## How a change reaches the interface

1. Life supplies a source index, the current revision, and relevant existing code to the connected agent. The agent can request exact additional files automatically.
2. The agent returns a source proposal containing file contents or exact find/replace edits and, when needed, npm package versions. Settings and executable extensions have their own proposal formats.
3. Life checks the revision and file paths, records the proposed change as a source extension, and composes enabled extensions over the immutable installed source. It stages the result, installs added dependencies, and runs its bundled esbuild compiler.
4. A successful build commits the extension and becomes the active source revision. Life saves the conversation and reloads the interface while retaining its local data.
5. Compiler or proposal errors return actual diagnostics and refreshed context to the same agent. The prior working build stays active. A request allows up to two automatic repair attempts and six automatic source-read round trips.

Questions and explanations need no proposal. Concurrent changes cannot silently apply an older source revision over newer work. Compilation checks source syntax and import resolution; an agent still needs to preserve the application’s behavior.

## Manage individual changes

Open **Live extensions** in the sidebar to open **Manage extensions**. Its **Installed** tab lists both source and runtime extensions. Source extensions contain file patches, additions or deletions, dependency specifications, and descriptive metadata. Enable or disable a change, **Edit code**, export it, or remove it using the delete action and **Remove** confirmation. The **Import** tab accepts portable extension files, JSON, or public Gist links. Life rebuilds enabled source layers in creation order against its installed base instead of copying one extension’s whole workspace over another.

Changes can depend on earlier layers. For example, a later extension may import a component created by an earlier one. Disabling or removing the earlier change can make the combined source fail to compile. Each extension should declare the npm packages its own feature needs, even when another extension currently supplies them. Overlapping edits can also conflict. When multiple enabled layers name the same npm package, the later layer supplies its version; the resulting code still needs to work with that dependency. An unsuccessful composition or build retains the prior working interface; review the error and ask `/life` to adapt the affected changes. Layers are not promised to work in every combination.

Existing 0.4 source edits and added dependencies migrate into one **Legacy customization** source extension. The original customization files remain available. This preserves the existing work while allowing subsequent changes to become separate layers.

## Editable source and dependencies

The editable application includes `src/renderer/**` and `src/shared/**`. The recovery bootstrap and `index.html` remain protected. Native `src/main/**`, `src/preload/**`, and the packaged `package.json` are available as read-only reference so the agent can understand the host’s contracts.

Life ships its compiler, baseline dependencies, and npm tooling. Customization does not need a separate Node.js or npm installation. New packages come from the public npm registry and require a network connection. Proposals accept explicit semver versions with optional `^` or `~`; Git, file, and arbitrary download URLs are not dependency specifications.

Dependency installation runs with lifecycle scripts disabled. Browser-compatible packages and source components are supported; packages requiring native compilation or install scripts need additional packaging work. The compiler supports TypeScript/TSX, React imports, CSS, images, SVGs, and fonts. A component library’s styles must be included in the proposed source; adding its package name alone does not replace a control.

Tailwind v4 generation is available when a proposal adds `tailwindcss`, `@tailwindcss/postcss`, and `postcss` alongside stylesheet directives such as `@import "tailwindcss"`, `@theme`, or `@apply`. Life processes these styles in an isolated, cancellable compiler worker before bundling. This supports actual shadcn component source with generated utilities; invalid utilities fail the candidate build and return diagnostics for repair. The default application does not add these dependencies or replace existing selects in advance.

Backend extensions remain available for local files, commands, modules, and worker-based behavior. Advanced agent calls can pass validated `providerOptions`: Codex `thread`/`turn` fields or Claude `settings`/`args`. Reserved session, directory, permission and stream-format options remain managed by Life. The provider’s real CLI, account and model capabilities determine which additional options work.

## Export and public sharing

Portable bundles carry one selected source or runtime extension: its code, required dependencies, and metadata. They do not include Life’s saved connection settings, conversation history, or unrelated local files. Source patches also include their original code context so another installation can validate and compose them. Review that context and the complete code for anything private before publishing.

Choose **Share publicly** for an extension to open its full bundle preview. Enter a GitHub token with permission to create Gists, then explicitly choose **Publish publicly**. Life creates a public GitHub Gist containing `extension.life-extension.json` and a generated README. Anyone can read this code. The token is used for that publication only and is neither saved nor exported. Life does not automatically publish new customizations.

To import a shared extension, open **Manage extensions → Import**, paste a public Gist link or ID, and choose **Preview public extension**. Inspect its file list, dependencies, and complete code. Fetching a preview does not install or execute it. Choose **Install extension** only after review; runtime extensions use manifest validation, while source extensions are composed and compiled before activation. Local extension files also open a preview; pasted JSON uses **Preview extension**. Importing public Gists needs no token. A portable bundle must be smaller than 8 MB; invalid or incompatible source keeps the previous working interface active.

## Inspect, restore, and recover

Click **Source code** in the sidebar to open the **Life source** dialog. Browse the current files and revision, manually edit or add source files, **Compile & reload**, **Restore previous**, **Use built-in interface**, or **Open folder**. Local files live under Life’s data directory in `source-code`, with separate revision builds and a dependency cache.

Press **Ctrl/Cmd + Shift + L** to restore the built-in interface through the native host. That shortcut and the recovery loader are separate from the editable React code. Startup failure recovery also restores the built-in interface and retains source files for inspection and repair. Automatic startup repair updates the failed source layer in place rather than stacking another change over broken code.

Installers preserve this local data directory and the application’s existing installation identity. If an update changes the built-in source baseline, Life disables the custom interface and retains its source extensions. Ask `/life update my customization for this Life version` to rebuild against the new installed source. The agent can read your modified files alongside the new originals. Source patches must still compose and compile; overlapping edits or changed host contracts can require repair. Life does not promise an automatic semantic merge across app versions.

An unrelated request cannot silently overwrite a conflicting new app file. An upgrade repair can explicitly replace that file with adapted content; the existing conflicting extension then owns that adapted file. Keep separate new features in their own follow-up requests to preserve independent controls.

The installed native host, preload bridge and Electron binaries stay intact during source customization. New React features, imported components and supported backend-worker behavior can change live. Changes to native binaries, base Electron behavior or installer signing belong in a packaged release.
