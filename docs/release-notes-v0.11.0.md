# Life 0.11.0

Life 0.11.0 reduces installation work and makes the desktop workspace more responsive during streaming, conversation navigation, and map interaction. It retains the Research interface, usage tracking, provider update notices, and native protocol fixes from 0.10.0.

- **Fewer files to install:** JavaScript dependencies stay inside Electron's archive instead of being extracted and copied as thousands of loose files. Unnecessary dependency source maps and a duplicate compiler executable are omitted. Native binaries remain available where they need real filesystem paths.
- **Studio stays fully bundled:** npm, esbuild, renderer dependencies, and editable source still ship with Life. The first source compilation prepares a verified local compiler cache. Ordinary startup, source inspection, and settings changes do not extract that cache. Unchanged dependency payloads reuse it across Life releases; incomplete or damaged caches are repaired.
- **Updates ready before you restart:** Supported Windows and AppImage installations check shortly after startup and periodically while running. Updates download and verify in the background by default, using differential downloads and the existing installer cache. Turn off **Download updates automatically** in **Updates** to choose when to download. Restart remains explicit and waits for active agents to finish or stop. Windows uses a silent installer after you choose **Restart**.
- **Clear download progress:** Updates shows transfer speed, remaining time, and a separate verification state. A completed download percentage does not claim that checksum validation has finished.
- **Less repeated rendering:** Streaming keeps unchanged conversation output and sidebar rows stable. Closed thread search avoids scanning saved message bodies. Completed Markdown can reuse a bounded parse cache when returning to a conversation.
- **Less startup work:** Independent dialogs load when first opened and retain their drafts and subscriptions after closing. The native updater loads after the initial window, and source baseline validation reads a small batch of files in parallel while retaining identical hashes.
- **Responsive maps:** Panning and zooming update the camera once per animation frame without rebuilding unchanged nodes and edges. Wheel deltas, zoom anchors, keyboard controls, fit, and node focus retain their behavior.

## Verification

See the [performance measurements](https://github.com/greatitself/life/blob/v0.11.0/docs/performance-v0.11.0.md) for local before/after fixtures and their measurement limits.

Windows CI tests only the latest preceding release, **0.10.0 → 0.11.0**. It measures the previous version's fresh installation, the upgrade, and a fresh 0.11.0 installation on the same disposable runner. Installation identity and saved connection, history-storage, and source-extension files must survive the upgrade. The generated benchmark below records measured installer-process time separately from downloads and assertions; a single runner sample does not establish every machine's installation time.

Browser checks cover streaming, long histories, composer/sidebar interactions, maps, update preferences, and existing native request flows. Packaged Electron verification checks source compilation with bundled tools, restart and recovery, conversation persistence, and provider behavior. Release assembly validates installer metadata and checksums before publication. All installers and release notes use one verified source commit.

Installers remain available for Windows x64, Linux x64, and macOS on Intel and Apple Silicon. They remain unsigned. Existing data directories are preserved during an upgrade. See the [0.10.0 alignment audit](https://github.com/greatitself/life/blob/v0.11.0/docs/frontier-alignment-v0.10.0.md) for provider compatibility scope and the distinction between deterministic protocol checks and paid inference.
