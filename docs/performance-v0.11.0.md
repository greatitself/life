# Life 0.11.0 performance measurements

Each row compares the same local fixture before and after its relevant optimization. These component measurements exclude complete desktop launch time.

| Measurement                                         |     Before |     After |
| --------------------------------------------------- | ---------: | --------: |
| Files on the filesystem, final local Linux package  |     15,613 |       290 |
| Streaming commit time, p95                          |    37.4 ms |    5.6 ms |
| Warm conversation switch, median                    |   910.6 ms |  306.0 ms |
| Canvas React rendering work, total                  | 1,183.1 ms |   54.6 ms |
| Fresh-store source baseline hashing, median         |  20.286 ms |  7.408 ms |
| Initial JavaScript bytes, dialog-loading comparison |  1,602,169 | 1,511,864 |
| Renderer ready, dialog-loading comparison median    |   243.3 ms |  209.2 ms |
| Sidebar/composer React work, typing 11 characters   |   2,801 ms |    185 ms |

The package comparison uses `/opt/Life` files in the preserved local 0.10.0 Debian installer and the final optimized Linux directory build. Summed file sizes fell from 563,207,110 to 439,040,735 bytes. npm, esbuild, and Studio dependencies remain bundled. These counts exclude user data and do not establish Windows installation time or counts on every platform.

The transcript fixture uses production React/Chromium, 2× CPU throttling, 250 completed turns, 80 tool outputs of 350,034 characters each, and 20 reasoning summaries. Streaming p95 measures synchronous commits; warm switches exclude the first visit. Output, anchors, selection, Find, drafts, and copy behavior remain checked. The baseline is pinned to 0.10.0 commit `475a014`.

The canvas retains all 400 nodes and 1,500 relationships, with 960 wheel events across 120 frames. The metric is aggregate development-profiling React work, not gesture duration or frame rate. Unchanged-scene geometry reads fell from 768,000 to zero; production and StrictMode interaction checks also pass.

The actual App sidebar/composer fixture retains 408 conversations and 32,000 messages while typing 11 characters with search closed. Unchanged row renders fell from 8,976 to zero; historical text reads fell from 704,198 to zero. Observed typing wall time fell from 3,959 to 531 ms, including browser automation and scheduling. Checks cover background rows, open-search invalidation, current handlers, and the shared clock.

Source hashing uses fresh `SourceCodeStore` instances, 169 files, a warm filesystem, alternating order, one warm-up, and ten measured rounds per variant. Every file hash and fingerprint remain identical. This measures uncached store state, not cold disk access or source compilation.

Dialogs use the actual production-minified App, a simulated native API, six fresh Chromium contexts per variant, and no CPU throttling for these values. Only eager/deferred imports change; Studio stays eager. Readiness excludes Electron startup, remote connections, and inference. Deferred dialogs load on first opening.

## Windows installation and upgrade

Release CI measures only **0.10.0 → 0.11.0**. On one disposable Windows runner it installs the previous version fresh, upgrades to 0.11.0, removes only the verified test-owned installation and data, then installs 0.11.0 fresh. `System.Diagnostics.Stopwatch` records each NSIS process from launch through exit. Downloads, hashes, registration checks, file counts, and cleanup have separate timings.

Each operation has one sample; later operations can benefit from warm OS/filesystem caches. Defender exclusions and security settings stay unchanged. The upgrade must preserve the installation identity and all five saved-data fixture hashes. Fixtures check file preservation; packaged desktop tests separately cover actual history persistence.

The paired Windows measurements will be attached to the published release. The CI artifact contains `windows-upgrade-proof.json` and `windows-installation-benchmark.md`, including installer hashes, installed file counts and byte totals, runner metadata, and partial evidence on failure. No Windows speed figure is inferred from the Linux package count or these local renderer timings.

## Evidence and reproduction

- Transcript: `node tests/transcript-performance.cjs before` and `node tests/transcript-performance.cjs after`; JSON and screenshots under `output/playwright/transcript-performance-v011/`.
- Canvas: `node tests/graph-canvas-smoke.cjs --profile`; comparison snapshots under `output/playwright/graph-canvas-baseline-profile-final/` and `output/playwright/graph-canvas-optimized-profile-final/`.
- Sidebar/composer: `node tests/app-live-controls-smoke.cjs --fluidity`; JSON under `output/playwright/app-fluidity/`.
- Source hashing and dialog comparisons: local reports `life-baseline-batch4-benchmark.json` and `life-deferred-dialogs-production-benchmark.json`; correctness checks in `tests/source-code-baseline.test.ts` and `tests/deferred-dialogs-smoke.cjs`.
- Windows: `tests/windows-upgrade.ps1` and `scripts/windows-installation-report.cjs`, run by the release workflow with the latest preceding installer.
