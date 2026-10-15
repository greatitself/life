# Renderer performance checks

The browser renderer checks exercise shipped components in local Chromium fixtures. They
exclude Electron startup, remote connections, upstream agent inference, and
authenticated Codex or Claude Code use. Machine load can affect timings; operation
counts provide a separate check that unchanged histories avoid repeat work.
The native history sections below state the scope of their real Electron,
preload, IPC, worker, and disk checks, including separate application reloads.

## Sidebar history

The fixture renders the shipped `SidebarProjects` component with 200 threads,
248,800 messages (1,000–1,495 per thread), both providers, and 2× CPU throttling. It compares
the same 12 streaming updates before and after caching conversation counts and
search results by immutable message-array identity. The baseline loads the three
changed sidebar files and `ThreadRunStatus` from commit
`a1b3facb8bc3c07b1521ed21965f4f8b88acd268`; other dependencies and the fixture stay
identical.

| Measurement                                                  |     Before |  After |
| ------------------------------------------------------------ | ---------: | -----: |
| Conversation-turn sort, streaming commit median              |   259.1 ms | 3.2 ms |
| Conversation-turn sort, streaming commit p95                 |   326.4 ms | 9.8 ms |
| Conversation-turn sort, history role reads across 12 updates | 37,106,088 | 12,000 |
| Open sidebar search, streaming commit median                 |   227.9 ms | 2.6 ms |
| Open sidebar search, streaming commit p95                    |   282.8 ms | 8.7 ms |
| Open sidebar search, history body reads across 12 updates    |      2,400 |     12 |
| Elapsed run clock, historical turn reads across two ticks    |      2,000 |      0 |

Search in this fixture matches the first message in every history, so the body
read comparison establishes invalidation behavior, rather than worst-case search
duration. Both sort modes operate on the complete thread list. The fixture checks
exact ordering against an uncached implementation, appended prompt counts,
streamed search matches, title changes, clearing search, and the running timer.
The caches hold no copies of message bodies and use weak keys, allowing removed
histories and older streamed snapshots to be collected. Only the latest query is
retained for each history.

Run the matched comparison with:

```sh
node tests/sidebar-history-performance.cjs renderer-baseline
node tests/sidebar-history-performance.cjs renderer-optimized
```

JSON reports are written to `output/playwright/sidebar-history-performance/`.
Correctness and bounded repeat work are also checked by
`tests/sidebar-history.test.ts`. Run browser timing comparisons serially on the
same machine.

## Message navigation

The navigation regression mounts all 3,000 message anchors and 1,500 turn buttons
with development React and StrictMode. The finder scans message bodies only while
open; its matches stay cached across scroll/current-message updates. Previewing
one turn reads that turn's latest reply. Memoized buttons receive primitive props
and stable handlers, including when the App supplies a new inline jump callback.

| Change                                                     | Committed turn-button renders |
| ---------------------------------------------------------- | ----------------------------: |
| Unrelated parent render, memo disabled in the same fixture |                         1,500 |
| Unrelated parent render, memo enabled                      |                             0 |
| Streamed assistant reply                                   |                             0 |
| Updated user prompt                                        |                             1 |
| Current visible turn changes                               |                             2 |
| Hover preview and nearby wave                              |                            13 |

The regression also verifies case-insensitive search across the full history,
the 200-result render cap, opening collapsed activity, focus restoration,
query reset, live preview updates, unusual message IDs, and IntersectionObserver
callbacks that contain only changed entries. It counts committed React work;
it does not establish a frame-rate guarantee.

```sh
node tests/thread-message-navigator-smoke.cjs --without-tick-memo
node tests/thread-message-navigator-smoke.cjs
```

Reports are `output/playwright/thread-message-navigator-baseline.json` and
`output/playwright/thread-message-navigator-proof.json`.

The actual Timeline finder has a separate regression using the App's visible
navigation projection plus full history for open search. It reveals completed
reasoning/progress and live folded activity, waits for their lazy anchor to mount,
then focuses the exact message and keeps its 20px offset after layout settles.
Cancelled requests release their temporary observer without calling the jump
handler or moving focus. Closed completed history retains two mounted anchors;
revealing the matching section mounts five, while unrelated activity stays lazy.

```sh
node tests/thread-finder-timeline-smoke.cjs
```

Its five checks also cover nested disclosures, query reset, latest callbacks,
native Find/selection, exact raw-output copy, and cancellation on close, query
change, or unmount. Proof is
`output/playwright/thread-finder-timeline-proof.json`.

## Workspace surfaces

The production React fixture has 50 threads across two workspace scopes and an
active history with 1,200 settled messages plus one streaming message. It uses a
mocked native bridge, no CPU throttling, and the same pinned baseline as the
sidebar comparison. Getter probes establish which histories are read while
Agents and pull-request tabs are hidden.

| Work across updates                                       | Before | After |
| --------------------------------------------------------- | -----: | ----: |
| Hidden mounted tabs, body reads over 8 updates            | 19,224 |     0 |
| Hidden mounted tabs, role reads over 8 updates            |  9,608 |     0 |
| Hidden mounted tabs, workspace scope reads over 8 updates |    400 |     0 |
| Visible linked list, body reads over 12 updates           | 28,836 |    12 |
| Visible linked list, settled body reads over 12 updates   | 28,812 |     0 |

Agents retains expanded detail state while hidden and refreshes native status,
selection, and project scope when reopened. PR links are projected only for the
visible linked list; settled messages reuse weakly cached URL matches. The helper
retains the small URL result without keeping a previous full transcript alive.

All ten browser workflow checks pass against both versions, with identical ARIA
snapshots and no browser errors. They cover workspace ownership, pending/busy
statuses, hidden updates, expanded detail, URL uniqueness/order, the exact native
`gh pr view` request, Back navigation, switching threads, and feature re-enabling.

```sh
node tests/workspace-surfaces-performance.cjs baseline --baseline-ref=a1b3facb8bc3c07b1521ed21965f4f8b88acd268
node tests/workspace-surfaces-performance.cjs current
```

Reports and accessibility snapshots are under
`output/playwright/workspace-surfaces-performance/`. Unit invariants are in
`tests/pull-request-links.test.ts`.

## Conversation scrolling

The pinned baseline/current fixture uses 2× CPU throttling with 5,000 flat
message anchors and a separate 250-turn layout with 500 anchors inside settled
`content-visibility` wrappers. It separates the first DOM-index/geometry capture
from repeated warm captures, and records Chrome layout/style counters.

| Measurement                                               |   Before |   After |
| --------------------------------------------------------- | -------: | ------: |
| 5,000 flat anchors, warm capture median                   | 11.26 ms | 0.03 ms |
| 5,000 flat anchors, warm capture p95                      | 12.46 ms | 0.05 ms |
| 5,000 flat anchors, first capture including index build   |  18.2 ms | 13.0 ms |
| Flat geometry reads per capture                           |    4,497 |      15 |
| 250 settled wrappers, first capture including index build |  58.9 ms |  2.5 ms |
| Settled-wrapper geometry reads per capture                |      449 |      12 |
| Settled-wrapper cold forced layouts                       |      223 |       0 |
| Settled-wrapper cold layout time                          |  50.9 ms |    0 ms |

The controller indexes anchor membership separately from geometry, searches turn
wrappers before descendants, and updates the index when lazy activity mounts,
message IDs change, or anchors are removed. It retains every existing transcript
element; no viewport virtualization is used. The initial index remains linear in
mounted anchor count and is reported separately from warm scrolling work.

The browser regressions verify exact deep offsets during streamed updates,
prepended history, and thread switches; simultaneous 220px prepended/400px
appended growth while following; native Find, text selection, and focus; lazy
expanded anchors; ID changes/removal; outside selections; and listener cleanup.
The existing seven scroll and fourteen presentation smoke checks also pass.
The separate correctness run verifies repeated native Find while already paused:
the exact second match remains inside the viewport after its settled wrapper
activates, and the temporary visibility override is removed after stabilization.

```sh
node tests/conversation-scroll-performance.cjs --baseline
node tests/conversation-scroll-performance.cjs
node tests/conversation-scroll-performance.cjs --correctness
```

Matched timing reports and the separate correctness report are under
`output/playwright/conversation-scroll-performance/`.

## Settled Markdown and thread switching

The transcript fixture uses production React, 2× CPU throttling, 250 completed
turns, 80 active tool outputs, and a 350,034-character output. Completed messages
compile escaped Markdown to a cached HTML description, reducing the number of
React elements allocated when mounting history. Live messages keep the established
React renderer through completion, preserving selection and focus. Images,
task lists, footnotes, and carriage-return text retain that renderer for exact
compatibility. Every history anchor and native Find target remains mounted.

In the matched current-before/current-after sample, the first unseen thread
switch changed from 982.1 ms to 748.1 ms and the warm switch median from 194.5 ms
to 125.1 ms. Total task duration across six switches changed from 2.008 s to
1.408 s. The initial load remained about 1.1 s; this sample does not establish a
meaningful cold-start improvement or an absence of long tasks. Reports are
`output/playwright/transcript-performance-v011/markdown-current-before.json` and
`markdown-current-after.json`. The runner's `--markdown-baseline-ref` option
substitutes only the established MessageView and output CSS while retaining the
other current components.

```sh
node tests/transcript-performance.cjs current
node tests/settled-markdown-smoke.cjs
```

The Markdown smoke compares 28 DOM examples against the established renderer,
including unsafe HTML/URLs, links, tables, nested structures, decoded fence
languages, and blank code blocks. Native clipboard checks verify code-copy
bytes, carriage-return character references, Unicode, and independent controls
for identical cached descriptions. Streaming completion preserves existing
selection and focused code blocks.

The compiler also reuses independent Markdown blocks across different completed
messages when at least half of the document's characters belong to previously
seen blocks. Unique content keeps whole-document compilation. Definitions,
containers, indented code, and HTML that can connect across blank lines keep that
path too. This avoids paying for a separate parser for every new paragraph while
retaining the established renderer's output. The focused Markdown suite has 85
tests covering fresh and cached bodies,
block boundaries, whitespace, reference definitions, fence parsing, safe HTML,
and structured-renderer fallbacks.

A separate retained parser probe uses the 652 examples in the
[CommonMark 0.31.2 corpus](https://spec.commonmark.org/0.31.2/spec.json) with original,
prefix, suffix, and repeated-body variants: 2,608 HTML comparisons pass. The
reference is whole-document micromark with GFM, using the same dependencies as
the block compiler. This establishes equivalence between those compiler paths;
browser behavior, timing, and official expected CommonMark HTML are separate
validation scopes. The script and report are
`output/playwright/transcript-performance-v011/commonmark-probe.{cjs,json}` and
record compiler, corpus, script, and dependency hashes.

The matched block-cache fixture keeps production React, 2× CPU throttling,
250 completed turns, 502 mounted messages, and 80 expanded tool outputs. Its
baseline disables only block reuse; both versions retain the existing settled
Markdown renderer and the other current components.

| Content and measurement                     | Before block reuse | After block reuse |
| ------------------------------------------- | -----------------: | ----------------: |
| Repeated blocks, cold load                  |           1,112 ms |            590 ms |
| Repeated blocks, first unseen thread switch |           743.4 ms |          262.6 ms |
| Repeated blocks, warm switch median         |           145.8 ms |          145.4 ms |
| Unique blocks, cold load median (3 runs)    |           1,164 ms |          1,096 ms |
| Unique blocks, first unseen switch median   |           758.2 ms |          789.4 ms |
| Unique blocks, warm switch median           |           151.3 ms |          152.2 ms |

The repeated-content comparison is one matched run per version. The three unique
runs span 1,004–1,183 ms before and 1,028–1,164 ms after for cold load, and
636.8–783.4 ms before versus 644.4–821.3 ms after for the first unseen switch.
Those noisy unique-content observations do not establish an improvement.
All anchors, expanded tool cards, exact drafts, history offsets, selectable and
findable prose, and independent code-copy controls remain in the fixture.

```sh
node tests/transcript-performance.cjs final-block-baseline --whole-markdown-baseline
node tests/transcript-performance.cjs final-block-after
node tests/transcript-performance.cjs final-unique-block-baseline --whole-markdown-baseline --unique-markdown
node tests/transcript-performance.cjs final-unique-block-after --unique-markdown
npx vitest run tests/settled-markdown.test.ts tests/markdown-block-cache.test.ts
```

The summary and the named before/after runs are under
`output/playwright/transcript-performance-v011/`; the summary is
`block-cache-comparison.json`. The DOM/clipboard proof remains
`output/playwright/settled-markdown-proof.json`.

## Native history loading

The matched Electron fixture loads 80 threads with 400 messages each through the shipped
preload, IPC handler, native worker, and browser parser. Its complete version 1
history is 36,274,420 UTF-8 bytes, approximately 35 MiB. The same application
alternates legacy object loads and encoded loads three times after a production
save, with no CPU throttling. This measures return transport and normalization
from a warm native worker snapshot; it does not measure a cold disk read. A
renderer App reload is checked separately while the native process stays running.

The native worker validates history before encoding it and reuses one current
revision's JSON or UTF-8 byte cache. It transfers copied bytes in an
`ArrayBuffer`; the renderer transfers that buffer into its owned inline worker.
The browser worker parses JSON and
transmits raw metadata and all raw message records in durable order. The renderer
normalizes a separate display while retaining that complete source. Delivery allows
four unacknowledged packets, targets at most 256 messages and 254 × 1024 serialized
JavaScript UTF-16 code units per message batch, and fragments long scalar
strings into 64 × 1024-code-unit pieces. These string-length budgets are not hard
UTF-8 packet byte limits, and an oversized individual value can exceed a batch
target. The complete parsed history still occupies worker memory during delivery.

| Source encoded load measurement     | Previous implementation | Final lossless restoration |
| ----------------------------------- | ----------------------: | -------------------------: |
| Standard load median, 3 samples     |                434.4 ms |                   512.2 ms |
| Standard renderer maximum lag range |            56.3–74.4 ms |               68.2–70.3 ms |
| Standard main maximum lag range     |            23.8–28.3 ms |               19.2–29.5 ms |
| Load with one 8 MiB message, total  |                649.9 ms |                   673.7 ms |
| Large-message renderer maximum lag  |                 86.9 ms |                    83.6 ms |
| Large-message main maximum lag      |                34.84 ms |                   28.76 ms |

The standard samples include first encoding and two warm native repeats, each
using a fresh browser parser. Their median is 17.9% higher after the change;
the large-message sample is 3.7% higher. The source runs preserve the same wire
bytes, packet counts, fixture input, and display output. Retaining the complete
raw source still carries transfer, parsing, normalization, and allocation costs.
Three standard observations and one large-message observation do not establish
a statistical latency guarantee or a universal loading improvement.

The actual source App reload, including the large-message case, separately
measures loading through its first automatic write:

| Source raw-history startup     | Previous implementation | Final lossless restoration |
| ------------------------------ | ----------------------: | -------------------------: |
| First automatic write payload  |        45,750,700 bytes |                1,918 bytes |
| Changed messages in that write |                  32,000 |                          0 |
| Renderer maximum timer lag     |                442.3 ms |                    92.2 ms |
| Main maximum timer lag         |               246.87 ms |                   19.67 ms |
| History loading gate ready     |                669.5 ms |                   692.4 ms |

The first write now checkpoints the exact raw durable base with zero thread
upserts, message upserts, field patches, or text properties. The raw history hash
stays unchanged while the display has its separately expected normalized hash.
Readiness is 3.4% slower in this sample; it measures closing the loading gate
before the first checkpoint acknowledgement. The timer observations continue
through that write. A separate raw message without a `turn` property keeps that
property absent on disk while the view shows turn 0 and retains the exact 8 MiB
body and provider input. Its renderer/main maximum lag changes from
432.5/232.13 ms to 72.2/22.55 ms, with readiness 920.7 ms versus 899.0 ms and the
same 1,918-byte order-only first checkpoint.

The final Linux packaged run reports raw-startup renderer/main maximum lag of
75.6/23.27 ms and loading-gate readiness of 647.4 ms, also with a 1,918-byte
zero-change first checkpoint. The separately retained previous packaged build
reported 428.1/197.0 ms for that raw-startup pause measurement; this comparison
uses two packaged builds, with their own retained artifact identities. Its
baseline report is
`output/playwright/history-restoration-baseline/previous-packaged-report.json`,
with provenance in `previous-packaged-artifact-hashes.json`.
The final packaged missing-turn case reports 82.6/23.81 ms and
887.8 ms readiness. The three packaged encoded loads complete in
638.0, 496.6, and 442.9 ms, with renderer maximum lag 70.3–75.2 ms and main
maximum lag 24.2–26.5 ms. The packaged large-message load takes 654.8 ms,
including 222.0 ms native transport and 432.6 ms browser decoding. These are
packaged observations; source timings above retain their source baseline.

The original raw native baseline survives display
restoration, so an unchanged raw-history startup sends its first order-only
checkpoint without first writing normalized values. Unique raw identities allow
that adoption even when the display pauses queued prompts, marks running
activity unknown, hides unreadable records, or shortens presentation metadata.
Startup with unidentified legacy records uses a complete save containing the
full raw source; later updates can replace a thread's complete message array
when its thread identity is usable.
The native engine preserves unknown root snapshot fields in both save paths.
Both source and packaged workflows hold the read-only gate until loading
succeeds, create/complete/terminate one parser worker, and retain raw and display
hashes across actual renderer App reloads.

Each of the three final standard encoded samples delivers all 32,000 messages, acknowledges 241 packets,
and terminates its one browser worker before resolving. A separate message with
8,388,609 characters recovers exactly through 129 string fragments. The fixture
also checks malformed input, cancellation without admitting partial history,
exact native/object and normalized equivalence, preserved provider session and
workspace ownership, paused restored queues, and unknown restored running turns.
An internal `WeakSet` admits only complete snapshots from the owned parser for
reconciliation. Cancellation terminates the browser parser and removes handlers;
an already dispatched native IPC read can still finish. StrictMode replay shares
the native read, with the last owner responsible for cancellation and retry
timers.

Timers sample every 4 ms and have no machine-dependent latency threshold.
Exact comparisons and hashes occur outside timed samples. Packet callbacks keep
private references and scalar counters; packet JSON sizing and automatic-write
payload inspection happen after timer observations finish. Earlier instrumented
reports and the first lossless candidate remain historical evidence rather than
final timings. The first candidate's source report is under
`output/playwright/history-restoration-candidate-source/`; its comparison with
the baseline and final source is
`output/playwright/history-restoration-optimized-source/three-revision-comparison.json`.

The final allocation refinement removes unused per-value snapshots while
retaining the raw references, occurrence tracking, and thread-level baseline
needed for recovery. A separate synchronous Node probe compares the earlier
lossless capture implementation with the refinement. Its 32,000-message capture
median changes from 180.8 ms to 49.7 ms; adding one 8 MiB scalar gives
178.5 ms versus 49.5 ms. Shallow snapshot calls change from 32,242 to 240 and
property visits from 771,854 to 3,843. These measure instrumented function work,
not CPU utilization, heap size, or Electron load time. The retained samples,
reproduction script, captured sources/bundles, method, and hashes are in
`output/playwright/history-restoration-source-capture/`, including
`cpu-comparison.json`, `reproduce.cjs`, `README.txt`, and `artifact-hashes.json`.
The reproduction bundles were reconstructed from captured implementations after
measurement; the method and manifest retain that provenance.

```sh
npm run test:loads
LIFE_TEST_PACKAGED=1 npm run test:loads
node tests/native-conversation-load-performance.cjs
```

The previous-version source baseline is
`output/playwright/history-restoration-baseline/conversation-load-electron-source-report.json`.
Final source and packaged reports are
`output/playwright/history-restoration-optimized-source/conversation-load-electron-source-report.json`
and
`output/playwright/history-restoration-optimized-packaged/conversation-load-electron-packaged-report.json`.
Their artifact manifests retain source, compiled output, helper, and package
hashes. The packaged archive stays identical before and after verification;
236 source files, 99 compiled files, and two extra resources match the final
build with zero mismatches.
The final packaged desktop fixture also passes 47 workflow groups with no
renderer errors. Its report and before/after artifact identities are under
`output/playwright/history-restoration-packaged-desktop/`. It uses real Electron,
SSH/SFTP and deterministic provider stand-ins; the local recovery-export browser
checks have their separate mocked boundaries.
Earlier object-only load probes are in
`output/playwright/history-load-baseline/{source,packaged}-report.json`.
The direct native cache fixture writes
`output/playwright/native-encoded-load/native-encoded-load-report.json`; it checks
exact bytes through the bundled native worker and excludes Electron IPC and
browser work. Source and Linux packaged load modes use the same workflow fixture;
they do not establish authenticated provider or cross-OS behavior.

## Native history checkpoints

The native disk fixture uses 80 threads with 400 messages each, approximately
35 MB of complete history, and six single-message streaming updates. The worker
handles canonicalization, full disk serialization, and atomic version 1 commits.
The renderer projects changes from the previous durable acknowledgement and
sends a compact packet rather than repeatedly cloning the complete history.
An initial save of new history and explicit resync remain proportional to history
size. A complete owned load can seed the exact raw native
baseline when all thread identities are unique and nonempty, independently
of display normalization. Its first unchanged checkpoint contains thread order
only, including opaque or ambiguous message records. Startup without usable thread
identities uses a full save containing all raw records and opaque source slots;
changes to an ambiguous message array replace that complete array without
assigning identities or dropping records. Newer browser recovery is compared against
the native source baseline, and a changed native base triggers complete-source
resync. Native bridges that explicitly advertise `supportsMessageFields` receive
own-property set/remove changes for existing messages, so unchanged body fields
stay out of a status-only patch. Checkpoint bridges without field support receive complete message
upserts. A separate explicit `supportsMessageAppends` capability permits exact
suffix packets for growing strings of at least 1,024 UTF-16 code units, when field
support is also enabled. Prefix replacements and truncation retain full changed
field values. Native validation checks the expected durable string length and
disjoint edits before any commit. Source-owned writes remain ordered; queued projections refresh after
the preceding request settles before their next delta is calculated. Successful
native or complete recovery-cache writes advance source acknowledgement, while
failed writes leave it unchanged.

Recovery JSON export contains a version 1 snapshot of one thread's complete
source records, metadata, and attachment references. Source-aware attachment
collection used by thread deletion, draft attachment removal, and queued-message
removal includes raw hidden messages and queue entries. Queue removal derives
retained references from the updated target history, scopes cancellation to the
thread/message pair, and refuses ambiguous duplicate thread IDs. Deletion of a
duplicate thread targets the selected source occurrence while preserving its
neighbors. Twelve local App recovery checks cover rename/reload, recovery
downloads, attachment protection, failed writes, and selected duplicate deletion;
35 queue browser checks include cross-thread cancellation and opaque attachment
references. These use production React with mocked provider/native boundaries
and real downloads/IndexedDB. Their proofs are
`output/playwright/conversation-recovery/report.json` and
`output/playwright/thread-queue/proof.json`. The earlier checkpoint measurements
below describe the previous worker migration.

```sh
node tests/native-checkpoint-performance.cjs
npm run test:checkpoints
LIFE_TEST_PACKAGED=1 npm run test:checkpoints
```

The direct Node fixture reports save-call time, timer delay, durable latency, and
payload bytes, and checks every saved thread and message. An optional first
argument supplies a prebuilt legacy store bundle for a matched comparison. That
comparison's local baseline is the pre-worker Effect store; it is not the older
pinned Git baseline used by the renderer fixtures.

The local matched sample in `output/native-checkpoint/{baseline,current}.json`
reported median save-call time of 101.54 ms versus 0.17 ms, median timer delay of
101.96 ms versus 0.52 ms, and median durable latency of 158.61 ms versus 139.22 ms.
Streaming payloads changed from 34,786,894 bytes to 2,241 bytes. This direct Node
comparison excludes Electron IPC and renderer projection; disk serialization
still writes the complete history in the worker.

The Electron fixture imports the shipped renderer client/projectors and uses the
actual preload, IPC handler, worker, and disk. It separately measures initial
full saves and incremental updates, samples main/renderer timers at 4 ms, and
checks exact recovery after streaming, coalescing, deletion, reordering, and an
unrelated base change. Packaged mode proves the live worker loads inside ASAR.
Timings are observations; the checks assert exact content and bounded repeated
work rather than hardware-dependent latency thresholds. Reports are under
`output/playwright/checkpoint-electron/`.

## Growing responses and opaque-message startup checkpoints

The streaming checkpoint candidate passes 2,275 tests across 116 files,
full typecheck, formatting, and production build. The unchanged Linux package
passes all 47 native desktop workflow groups using deterministic provider CLIs
through real SSH/SFTP. These checks do not establish authenticated inference.
The corrected desktop greeting assertion selects its actual turn and requires
one exact saved reply; the original ambiguous-selector failure is retained.

A matched native Electron fixture appends 2,048 UTF-16 code units to an existing
8 MiB response in an 80-thread, 32,000-message history. Four final source samples
have the following medians:

| Measurement                |   Frozen baseline | Candidate source |
| -------------------------- | ----------------: | ---------------: |
| Checkpoint packet          | 8,395,850.5 bytes |      4,179 bytes |
| Native invocation return   |           16.5 ms |          0.20 ms |
| Main timer maximum lag     |          20.23 ms |          2.91 ms |
| Renderer timer maximum lag |          14.10 ms |         21.85 ms |
| Submission call            |           17.4 ms |          25.2 ms |
| Durable acknowledgement    |          417.2 ms |         515.5 ms |

The packaged candidate sends the same 4,179-byte packet, with median invocation
0.10 ms and main lag 1.13 ms. Its renderer lag is 23.85 ms and durable
acknowledgement 548.15 ms. Compact transport reduces main-thread serialization;
these observations do not establish a renderer or total-latency improvement.
The timed operation includes constructing the immutable large response and
checking its exact prefix. The writer still serializes and atomically replaces
the complete version 1 snapshot.

An additional actual App case includes 32,008 raw message records with null,
scalar, missing, empty, and duplicate identities. The first unchanged write
changes from a 36,120,124-byte full save to a 1,598-byte checkpoint with no thread
updates. During the explicit three-second observation window, source main lag
falls from 124.64 to 22.24 ms and renderer lag from 135.10 to 78.40 ms. Packaged
lags are 21.37 and 68.2 ms. This window includes startup and autosave; it is not a
startup-latency measurement. All raw records retain the same exact hash.

Both source and ASAR fixtures verify split and unpaired UTF-16 surrogates, exact
provider input/session/workspace, full replacement after prefix changes or
truncation, six flushes coalescing to two writes, native-base resync, complete
atomic rejection of an invalid append, and recovery through fresh native workers.
Payload/hash inspection and deliberate resync preparation stay outside timer
probes. Zero renderer errors were observed.

Reports are under `output/playwright/streaming-checkpoints-{baseline,candidate,packaged}/`;
the candidate validation summary and complete unit JSON are retained alongside
the source report. Packaged workflow and before/after identity evidence are under
`streaming-checkpoints-packaged-desktop/`. The source graph contains 236 files;
the compiled graph contains 101 files, including two separately packaged extras.
The native worker SHA-256 is
`914299899da3143151183be4d7004204d136c9ff692804cdd570b8b7bd6460f4`.

Reproduce from an isolated checkout after its production build:

```sh
node tests/conversation-streaming-electron-smoke.cjs
LIFE_TEST_PACKAGED=1 node tests/conversation-streaming-electron-smoke.cjs
```

The live feedback desktop uses a separate verified native app directory. Its
renderer watches the main checkout through Vite, while isolated builds keep the
running desktop and other compiled instances stable.

## Owned streaming append operations

The renderer now constructs owned strings through a private append registry.
Actual ancestor identity proves their exact suffix, avoiding a repeated scan of
the complete previous body. Unowned strings retain the exact prefix comparison;
replacement, truncation, ambiguous records, and bridges without both capability
flags retain their established fallback. Lineage nodes hold suffixes and lengths,
with per-lineage logical bounds of 512 parent links and 1,048,576 UTF-16 suffix
units, without retaining previous message objects or accumulated previous bodies.
Endpoint WeakMap proofs retain their current text. These limits do not establish
a total registry or engine heap bound. Mutation recovery covers detected changes
to registered endpoints; arbitrary unobserved edits remain subject to the
immutable-input contract.

On the historical frozen owned-appends graph, eight alternating AB/BA pairs use
real Electron, preload, IPC, worker and disk,
with 80 threads, 32,000 messages and a 2,048-unit suffix on an 8 MiB response.
Each of the 16 samples produces one exact native checkpoint. Payload inspection,
native/disk equality and host observations remain outside timer probes.

| Measurement                | Baseline median | Owned-append median |
| -------------------------- | --------------: | ------------------: |
| Renderer submission call   |        26.15 ms |             1.90 ms |
| Renderer timer maximum lag |        23.45 ms |             1.60 ms |
| Checkpoint packet          |     4,183 bytes |         4,183 bytes |
| Total acknowledgement      |       539.40 ms |           535.50 ms |

Every paired submission and renderer-lag difference improves. Native invocation
measurements are quantized and have a paired median difference near zero. Total
acknowledgement and main-process lag remain variable; these measurements do not
establish faster disk completion, general rendering speed, or universal latency.
Substantial unrelated host load remained present and was recorded throughout.
The raw paired report SHA-256 is
`359ba1d2644dc90cdd8c1adfec9d682bc1b6a3ad913e594d75937a0c1bbb444b`.

The prior isolated Local integration passed 2,850 unit tests across 144 suites,
typecheck and build; a separate native functional run verified recovery.
Owned, unowned and mutated
large-body prefix scan counts are respectively 0, 1 and 0. Detected data-only
mutations of registered endpoints force exact full saves; accessor fields are
rejected without invocation. One conservative successor save establishes a new accepted
root, after which owned checkpoints resume. Exact Unicode, CRLF, split surrogates,
provider input, session/workspace identity, opaque records, held acknowledgements,
bridge rotation, atomic rejection and cold native restart survive. It uses
private provider stand-ins and makes no authenticated inference or new timing
claim. Native worker differences from the shipped Local baseline are dependency
path comments only; main and preload bytes match.

The paired result and prior Local acceptance are separate frozen graphs: their
source/build manifest hashes begin `f34b4332` (237 source files, 101 outputs) and
`f169e813` (243 source files, 101 outputs), respectively. The current final delivery
batch has no new paired timing measurement. Frozen source,
helper, compiled output and cleanup evidence are retained respectively under
`owned-stream-appends/output/playwright/owned-appends-alternating/` and
`local-owned-appends-integration/output/playwright/local-owned-appends-integration/`
in the isolated work directories. The streaming native fixture is
`tests/conversation-streaming-electron-smoke.cjs`; repeated timing comparisons
must use an explicit quiet-workload lease and retain every paired sample.
