# Life 0.11.1

Life 0.11.1 fixes source-customization migration after an application update, shows remaining provider account allowance prominently, and verifies the optimized Windows upgrade path from 0.11.0.

- **Compatible customizations survive updates automatically.** A change to the installed source fingerprint previously disabled every saved customization, even when only the application version changed. Life now rebuilds compatible enabled layers against the installed source and activates a new revision only after successful compilation. Untouched files receive current Life code; user edits, extension ordering, dependencies, and original exportable bundles remain preserved.
- **Recovery remains protective.** Explicitly disabled and crash-recovered customizations stay disabled. Conflicting edits, unavailable historical preimages, and compiler failures preserve the source revisions and use the installed interface with a specific diagnosis. The migration does not bypass fingerprint checks or run an old compiled bundle against new native contracts.
- **Usage means allowance left.** Usage leads with provider-reported remaining account allowance and reset times for Codex and Claude Code. Retained-session token and cost statistics remain separate. Values are scoped to the connected machine and provider account; unavailable quotas remain unavailable rather than being inferred from conversation tokens.
- **Providers can initialize together.** Opening a Codex transport no longer cancels Claude model discovery or a queued Claude turn on the same connected machine. Machine and workspace changes still cancel obsolete operations.
- **Windows deployment avoids redundant copying.** When the installation folder is confirmed empty and supports direct extraction, the installer writes the payload there once and verifies every packaged file against trusted SHA256 hashes. Other supported folders retain the staged copy and retry path, with verification before copying and before registration or launch. Unrelated existing files remain preserved, and unsafe or unreadable installation paths stop before writing.
- **A measured Windows upgrade limit.** Release verification checks only **0.11.0 → 0.11.1** and requires the complete installer process to finish in less than 10 seconds on its Windows runner. The test retains installation identity, saved-data checks, synchronous cleanup, bundled compiler verification, and installer metadata validation.

## Verification

The benchmark appended below reports the observed installer-process time, installer hashes, installed file counts, and saved-data preservation checks. Downloads and verification are recorded separately. One runner sample does not establish a speed guarantee on every computer, and later operations may benefit from warm operating-system caches. Customization rebuilding occurs on application startup and is checked separately from the installer-process timer.

Source tests exercise successful migration, preservation, idempotent restart, disabled layers, crash recovery, conflicts, and failed compilation. Packaged runtime checks use the actual bundled Electron executable, npm, and native compiler. Provider quota checks use native protocol responses and read-only account queries; paid inference is not part of the release verification.

Windows x64, Linux x64, and both macOS architectures remain supported. Existing data directories remain preserved; installer signing is unchanged. All release assets are assembled from one verified source commit.
