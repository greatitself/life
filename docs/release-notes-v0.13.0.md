# Life 0.13.0

Life 0.13.0 adds a native Local environment and improves conversation history, provider ownership, and controls used while work is running.

- Start in Local on POSIX systems, browse projects and files, use a real terminal, and run your installed Codex or Claude Code CLI. Saved SSH environments remain available.
- Keep native Codex app-server and Claude Code streaming protocols, provider session identity, exact prompts, workspace ownership, and permission responses.
- Load and checkpoint large histories through owned workers with bounded delivery and atomic disk commits. Restored queues remain paused.
- Reduce repeated work in streaming events, transcript rendering, history search, message navigation, sidebars, and workspace surfaces.
- Preserve conversation and draft ownership across Agents, Research, Studio, navigation, and reloads.

Asynchronous application services use Effect 4.0.0-rc.118 for typed failures, cancellation, resource ownership, and concurrency. Electron, SSH, worker, and React integration boundaries retain their native protocols.

## Recovery and platform limits

Active-session recovery is experimental. It records the original provider process, session, exclusive writer lease, committed output, and numbered native inputs. Uncertain delivery stays explicit; prompts and approvals are not automatically replayed. The recorded provider contracts are Codex 0.162.1 and Claude Code 2.1.278. See [native active-session recovery](native-active-recovery.md) for implementation limits.

Windows supports SSH environments. Native Local execution and native active-session recovery require POSIX facilities and are unsupported on Windows. Protected recovery data must remain readable and exportable without authorizing replacement work.

The complete integrated recovery matrix and a new matched performance comparison have not been certified. Historical measurements describe their original snapshots; this release makes no quantified performance guarantee. Controlled provider fixtures do not establish authenticated upstream-provider behavior. Authenticated Claude verification remains deferred.

## Release validation

The release pipeline runs typecheck, unit tests, formatting, the production build, browser and Electron checks, packaged platform compatibility checks, and Windows installation/upgrade checks before publishing installers. Its results are available in the repository's Release Life workflow; a running or failed check is not a pass.

Packages target Windows x64, Linux x64, macOS Apple silicon, and macOS Intel from the same source commit. Release assembly checks installer sizes and updater hashes and publishes SHA-256 checksums. Windows and macOS builds remain unsigned under the existing release policy.
