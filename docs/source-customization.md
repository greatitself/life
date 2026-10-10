# Life Studio and source customization

Open **Customize**, the paintbrush button in Life's header, to change the application by prompting. Studio has its own conversations, saved history, provider controls, and proposal inspector. Agents and Research conversations keep their original purpose: Life does not interpret `/life`, `@life`, or an answer containing a Life proposal there as permission to modify the application.

Examples to send in Studio:

- “Replace the model dropdown with a shadcn Select and keep its keyboard behavior.”
- “Add a research-review page with sortable experiments and saved notes.”
- “Change the composer layout and add an advanced provider option.”
- “Adapt my existing customization to this Life version.”

## Start and manage a customization

1. Open **Customize** and create a new customization conversation, or continue a saved one.
2. Choose Codex or Claude Code, model, reasoning effort, and speed. The provider stays associated with that conversation once it starts.
3. Describe the desired change normally. There is no slash-command prefix to add.
4. Review progress and the **Details**, **Changes**, **Build**, and **Recovery** inspector tabs. Source proposals expose their file changes and dependencies; runtime proposals expose their code and capabilities; settings proposals expose their changed values.
5. With **Apply valid changes automatically** enabled, Life applies a validated proposal after the provider completes. Turn it off to choose **Apply** or **Discard** yourself after reviewing a proposal.

Studio stores separate conversations, supports renaming and removal, and can export a conversation. Its inspector opens the existing extension manager, source inspector, and settings controls. No Agents project needs to be selected. A recognized local setting request, such as switching theme or changing font size, works without a machine connection. Source work and unfamiliar requests need an authenticated provider on the connected machine.

A plain answer, clarification question, or already-satisfied request stays a normal response. An empty settings proposal is a no-op rather than an invalid customization. Life reports a change as applied only after validation and, for source changes, a successful build.

From 0.11.0, Life keeps bundled dependencies in its application archive so installation does not create thousands of compiler files. Source inspection and ordinary settings changes use that archive directly. The first source build prepares a verified local compiler cache; later builds and releases with unchanged dependency bytes reuse it. An interrupted or damaged cache is repaired before compilation. npm and esbuild remain bundled, so a separate Node.js installation is still unnecessary. Adding new packages still requires network access.

## Exact messages and separate instruction files

Life sends the text you submitted unchanged. It does not turn your request into a larger prompt containing source code, schemas, repair instructions, or a hidden preamble.

For provider-backed Studio work, Life stages a private workspace at `~/.life/customization/<session-hash>` on the connected machine. Its `AGENTS.md` and `CLAUDE.md` contain the customization workflow and actual host contracts. Nine app-owned JSON files hold the data the provider needs:

| File                            | Contents                                                          |
| ------------------------------- | ----------------------------------------------------------------- |
| `.life/configuration.json`      | Active Life settings                                              |
| `.life/source-context.json`     | Source index, selected complete files, revision, and dependencies |
| `.life/extensions.json`         | Installed runtime extensions                                      |
| `.life/bridge.json`             | Available bridge capabilities and method contracts                |
| `.life/settings-schema.json`    | Valid settings proposal format                                    |
| `.life/source-schema.json`      | Valid source proposal format                                      |
| `.life/source-read-schema.json` | Valid additional-source request format                            |
| `.life/extension-schema.json`   | Valid runtime extension format                                    |
| `.life/diagnostics.json`        | Current source-read continuation or repair diagnostics            |

These files are separate from the connected coding project. Life does not overwrite that project's instructions to implement a Studio change. Local native snapshot paths are removed from the source context. Context has a 3 MB total limit; an oversized context returns an explicit error rather than silently truncating code.

When the agent requests another source file or needs a compiler repair, Life refreshes these context files and continues with the original user request unchanged. A request allows up to six automatic source-reading rounds and two automatic repair attempts. These bounds apply to the automatic continuation; a further user message can continue the discussion.

Providers still load their own configured instruction files and account policies. Preserving the submitted user text does not disable the provider's normal instruction system.

## How source changes reach the interface

1. The provider reads the current source revision and relevant complete files from the Studio workspace. It can request additional exact files when needed.
2. It returns a source proposal with file contents or exact find/replace edits, and explicit npm versions when required. Settings and runtime extensions have separate proposal formats.
3. Life validates the revision and paths, records the change as a source extension, and composes enabled extensions over the installed source. It stages the result, installs added dependencies, and runs its bundled compiler.
4. A successful build commits the extension and becomes the active source revision. Life saves Studio's conversation before reloading the interface and retains local workspace data.
5. A failed proposal or build leaves the working interface active. Actual diagnostics and refreshed context become available to the same provider for bounded repair.

Concurrent changes cannot silently apply a proposal based on stale source. Compilation checks syntax, imports, and build compatibility; the provider still needs to preserve the requested application behavior.

Each successful change becomes its own extension layer. A request to add a real component library can add React source, dependencies, and styles. Changing CSS alone does not install shadcn or replace a control with that component.

## Manage custom and built-in extensions

Open **Customize → Manage and share extensions** to manage source and runtime extensions. Source extensions contain file changes, dependency specifications, and descriptive metadata. Enable or disable a change, edit its code, export it, or remove it. The Import tab accepts portable files, pasted JSON, or public Gist links. Enabled source layers compose in creation order against the installed base.

Custom changes can depend on an earlier layer. Disabling or removing a component another layer imports can make the combined source fail to compile. Each extension should declare the dependencies its feature needs. Overlapping patches can conflict, and the later enabled layer supplies a shared package's version. An unsuccessful composition or build retains the prior working interface. Use Studio to adapt the affected layers; arbitrary combinations are not guaranteed to work.

The **37 built-in extensions** appear in Installed with their original names and source IDs. Their controls persist enabled, disabled, or deleted choices without recompiling historical backup snapshots. Disabling a functional feature stops its optional controls and background work; appearance features use the corresponding simpler presentation. The manager explains each entry's effect.

**Delete** records a removal choice and removes the Installed card. A private recovery copy of the built-in choices is saved first. Open **Deleted built-ins** and select **Restore** to bring an entry back. Deleting a built-in removes its active behavior and record; the shipped code remains in the installed baseline for recovery. Chats, attachments, projects, and Research files are retained. Model controls, steering, thread continuity, Studio, and native recovery remain available.

Several historical extensions contribute to the same feature. A disabled or deleted contributor keeps that shared feature off until all its contributing controls are enabled. The manager lists those dependencies and explains when another contributor keeps a feature paused.

Exact matching incorporated source bundles remain exportable **Built into Life** archives. Matching checks the entire bundle, not just an ID or name. Edited and unrelated bundles are preserved for adaptation. A built-in card can export or share its original source when that archive is present. Removing an archive deletes the saved archive record; built-in feature controls manage the installed behavior separately. Existing 0.4 source changes remain preserved as a **Legacy customization** layer.

## Editable source and dependencies

Live editable source includes `src/renderer/**` and `src/shared/**`. The recovery bootstrap and `index.html` remain protected. Native `src/main/**`, `src/preload/**`, and the packaged `package.json` are read-only reference so the provider can understand the host's contracts.

Life ships its compiler, baseline dependencies, and npm tooling. Local compilation inside an installed Life does not need a separate Node.js or npm installation. New packages require access to the public npm registry. Proposals accept explicit semver versions with optional `^` or `~`; Git, file, and arbitrary download URLs are not dependency specifications.

Dependency installation disables lifecycle scripts. Browser-compatible packages and source components are supported; packages needing native compilation or install scripts require packaging work. The compiler supports TypeScript/TSX, React imports, CSS, images, SVGs, and fonts. A component library's styles must accompany its source.

Tailwind v4 generation is available when the proposal includes `tailwindcss`, `@tailwindcss/postcss`, and `postcss` plus actual stylesheet directives such as `@import "tailwindcss"`, `@theme`, or `@apply`. Life processes these styles in an isolated, cancellable compiler process before bundling. A native compiler failure returns diagnostics while the working interface remains active. This supports actual shadcn component source with generated utilities.

## Runtime extensions and native limits

Runtime extensions can add views, change existing CSS, or replace the workspace. Renderer extensions run in isolated frames and use the declared Life bridge for connections, agents, files, settings, and their own backend. Backend extensions run in terminable Node workers with local user permissions and can use files, commands, and Node modules. They can be enabled, disabled, edited, reloaded, and rolled back without rebuilding the application.

Advanced agent calls accept validated `providerOptions`: Codex thread/turn fields or Claude settings/arguments. Life retains control of session IDs, directory, permission handling, and streaming format. Actual availability follows the remote CLI, account, model, and policy.

The installed native host, preload bridge, recovery loader, and Electron binaries stay unchanged during source customization. React features, supported components, settings, and backend-worker behavior can change live. Changes to native contracts, base Electron behavior, or installer signing require a packaged release.

## Export and public sharing

Portable bundles contain one selected source or runtime extension's code, dependencies, and metadata. They exclude Life's saved connections, conversations, and unrelated local files. Source patches include their original code context for composition, so review the complete bundle for information included in the extension itself.

Choose **Share publicly** to inspect a full bundle preview. Enter a GitHub token with permission to create Gists, then explicitly select **Publish publicly**. Life creates a public Gist containing `extension.life-extension.json` and a README. The token is used only for that publication and is not saved or exported. New customizations stay local unless you choose to publish them.

To import, use **Manage extensions → Import**, paste a public Gist link or ID, and select **Preview public extension**. Inspect the files, dependencies, and complete code before choosing **Install extension**. A preview does not execute code. Public Gist import needs no token. Portable bundles must be smaller than 8 MB; incompatible source keeps the previous working interface active.

## Inspect, restore, and recover

Studio's **Recovery** tab offers the previous source revision and the installed interface. The **Life source** inspector also supports manual editing, **Compile & reload**, **Restore previous**, **Use built-in interface**, and **Open folder**. Local source revisions live in Life's data directory under `source-code`, with separate build revisions and a dependency cache. Settings can be undone or reset independently; external edits to `life.config.json` reload.

**Ctrl/Cmd + Shift + L** invokes native recovery even if editable React code stops responding. Startup repair can restore the installed interface while retaining custom files for review. Emergency recovery opens one extension-review dialog and leaves SSH disconnected; normal thread selection can reconnect afterward.

Installer updates preserve the existing data directory and installation identity. From 0.11.1, Life automatically rebuilds compatible enabled source layers against the newly installed source, including after a version-only update. Original edit preimages drive the merge, so untouched files receive Life's updates while independent user edits, extension order, and declared dependencies remain preserved. A new immutable revision becomes active only after composition and compilation succeed. The existing fingerprint and bundle integrity checks still apply.

Layers disabled by the user or by crash recovery stay disabled. Previously working layers that an older release disabled solely because the source baseline changed can be rebuilt automatically. Original bundles remain available for export and recovery, including changes already present in the installed source. Conflicts, missing trusted preimages, or a failed build keep the installed interface active with the saved edits intact and an error identifying the reason. Open Studio to adapt those affected layers; automatic compilation does not establish semantic compatibility for conflicting edits. Keep unrelated new features in separate requests for independent controls.
