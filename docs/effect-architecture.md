# Effect in Life

The 0.13.0 release candidate uses **Effect 4.0.0-rc.118**, pinned in `package.json`, for
native application services and asynchronous domain workflows. Electron still
renders React and speaks the providers' existing native protocols. Final merged
recovery verification and release publication remain pending. Historical
performance evidence retains the scope of its original frozen graphs.

## Application boundary

`ApplicationRuntime` builds one `ManagedRuntime` from the `NativeOperations`
service layer shared by Electron IPC and extension calls. Each request executes in an owned fiber,
checks renderer admission at dispatch, and creates a tracing span without
recording user prompts or credentials. Runtime disposal interrupts owned work
and waits for its scoped finalizers. Promise adapters unwrap Effect exits to
preserve domain Error objects and useful messages at integration boundaries.
This follows Effect's [managed runtime](https://effect.website/docs/v4/runtime),
[services](https://effect.website/docs/v4/requirements-management/services), and
[layer](https://effect.website/docs/v4/requirements-management/layers) model;
the installed rc.118 source is authoritative for the APIs used here.

Native profile mutations, conversation loading/checkpoints, and remote command
execution enter this runtime as Effects. Existing feature handlers can retain a
Promise interface at the bridge while their underlying native service work is
migrated. Pure React projections and streaming token transforms remain ordinary
TypeScript so they do not create a fiber for each token. Electron IPC/preload,
SSH library callbacks, worker ports, and React lifecycle adapters remain explicit
integration boundaries. Effect owns the asynchronous native workflows behind
them; rendering, synchronous state projection, and bounded browser assembly do
not need an application runtime.

## Domain workflows

| Area                 | Effect ownership and behavior                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH requests         | Callback Effects, typed request errors, bounded deadlines, cancellation, and disposal of late channel acknowledgements.                                                                                                                                                                                                                       |
| SSH command output   | Scoped channel acquisition/release, byte limits, total deadlines, typed command failures, independent UTF-8 decoders, and interruption cleanup.                                                                                                                                                                                               |
| Local environment    | Native process/file/PTY callbacks reuse the connection's scoped Effect requests, deadlines, byte bounds, and cancellation. Provider discovery runs in the background; typed provider admission waits for its owned result and rejects a changed machine. Local profile identity and selection use the same atomic Effect persistence service. |
| Remote commands      | Strict Schema decoding, scoped connection/workspace listeners, a Deferred cancellation signal, and a race with the owned SSH command.                                                                                                                                                                                                         |
| Codex RPC            | Deferred results, typed provider/transport/cancellation errors, Schema response decoding, and scoped request-map/timer cleanup. Deadlines count connected time so a durable SSH suspension does not incorrectly expire a live remote request.                                                                                                 |
| Profiles             | Semaphore serialization, typed persistence errors, scoped private staging files, flush-before-rename commits, and ownership rollback.                                                                                                                                                                                                         |
| Conversation history | Scoped worker transport, Schema validation, acknowledged message deltas, bounded coalescing, guarded initialization retries, scoped atomic writes, bounded healthy settlement and shutdown, and native Effect load/save/checkpoint/close entry points.                                                                                        |
| Provider releases    | A registry service/layer, scoped HTTP requests, bounded stream collection, Schema metadata/cache validation, network cancellation, and bounded concurrency across providers.                                                                                                                                                                  |
| Account usage        | Tolerant Schema field decoding retains valid partial provider data while rejecting invalid individual fields.                                                                                                                                                                                                                                 |

Expected request, provider, transport, command, and persistence failures stay in
typed error channels. Interruption and defects retain their runtime causes until
the Promise boundary unwraps the exit. The relevant Effect guides are
[expected errors](https://effect.website/docs/v4/error-management/expected-errors),
[defects](https://effect.website/docs/v4/error-management/unexpected-errors),
[scopes and finalizers](https://effect.website/docs/v4/resource-management/scope),
[fibers](https://effect.website/docs/v4/concurrency/fibers), and
[Deferred](https://effect.website/docs/v4/concurrency/deferred).

Only failed native history writes use the complete browser fallback cache.
Successful disk checkpoints avoid redundant synchronous serialization, hashing,
and localStorage writes in the renderer. Browser-only use retains its cache
path. Recovery preserves exact content, deliberate thread deletion, unreadable
originals, and newer fallback checkpoints.

The conversation worker owns canonicalization, complete disk serialization, and
atomic commits. Streaming checkpoints send changed messages and thread metadata
against the last durable acknowledgement. Message order is sent when membership
or order changes; thread order also represents deletion. Only one write and one
newest pending snapshot are retained. Accepted writes survive cancellation of
their waiting caller. Native lifecycle barriers wait for healthy acknowledgements
within the configured grace period before closing the worker scope. Disk storage
remains the existing version 1 `conversations.json`.
Legacy full-save callers and histories with opaque or duplicate IDs remain
supported. An unrelated durable base causes an explicit complete resync through
the existing save API. Failed writes retain the previous durable base and the
renderer keeps its exact browser recovery path.

The native engine retains unknown root-level snapshot fields through both full
saves and compact checkpoints. It replaces the version, checkpoint timestamp,
and requested thread membership while retaining the complete JSON fields owned
by other versions. Disk serialization and atomic replacement still cover the
complete snapshot.

### History settlement and shutdown

`ConversationStore.settledWithinEffect` waits for accepted writes while leaving a
healthy store open; `closeEffect` also releases its owned worker scope. The default
grace period is 10,000 ms, a configurable policy rather than a storage performance
measurement. If settlement expires, the store permanently fails with typed
`shutdown-uncertain`, rejects pending callers and future work, and waits for the
owned worker to exit. Late replies cannot establish an acknowledgement. A file
may already have committed before its reply was lost; timeout and worker
termination do not prove rollback. Native finalizers and operating-system file
operations have no hard completion bound.

Main captures the BrowserWindow, admission revision and native frame before a
history handoff. Effect owns the settlement barrier and admission pause; stale
continuations cannot flush or replace a fresh document. Healthy committed
documents can resume after settlement. Uncertainty remains sticky for that Main
process, so navigation, interface recovery and reopening a window cannot admit
new runs. The user message asks them to close and reopen Life to inspect saved
history. Shutdown observes each cleanup outcome and still releases later owned
resources after an earlier phase fails. Startup checks for quitting after every
awaited initialization step, preventing late resource or window publication.
These barriers confirm accepted native history work, not unsent renderer edits.

### History loading

The native worker validates disk history with Schema before exposing either
load API. `loadEncoded` returns an `ArrayBuffer`, transferred from the native
worker, instead of cloning the complete object graph into the main process.
The worker retains one serialization of the current revision: validated read or
commit JSON becomes UTF-8 bytes on the first encoded load, replacing the cached
string. Each response copies those bytes before transfer so the cache survives
buffer detachment. The legacy object load API remains supported.

The renderer transfers the returned buffer into an owned inline browser worker.
That worker parses UTF-8/JSON and sends original thread metadata and every raw
message record, including opaque records, in their durable order. The renderer
builds a separately normalized display using the established readers and retains
the complete raw source behind it. Display sorting, paused restored queues,
unconfirmed running activity, and normalized attachment presentation do not rewrite
that source. A four-packet acknowledgement window bounds queued delivery.
Batches target at most 256 messages
and 254 × 1024 serialized JavaScript UTF-16 code units; an oversized individual
message can exceed that target. Scalar strings longer than 64 × 1024 code units
travel in fragments of that size. These are string-length budgets, not UTF-8 byte
limits. Complete parsing still retains the history in worker memory. The renderer
validates packet order, fragment destinations, and final counts while applying
the existing message normalization in each batch. JSON-size accounting scans
plain data without allocating another serialized copy of each message body.

Only a complete snapshot assembled by this owned parser enters the private
`WeakSet` used to retain its display records during reconciliation. Persisted
fields and arbitrary IPC objects cannot claim that admission. Cancellation,
worker errors, malformed packets, and completion all terminate the worker and
remove its handlers; failed or partial loads are never admitted. React hydration
shares an outstanding read across synchronous StrictMode replay, cancels it when
its last owner detaches, and owns retry timers. Restored queues stay paused and
running turns remain unconfirmed until native ownership is reconciled. Exact
prompts, provider input, session IDs, workspace ownership, opaque records, and
source ordering survive recovery. Unsupported, corrupt, foreign, or uncertain
ownership remains preserved without authorizing replacement work or approvals.

The active-recovery candidate owns its protected registry and append journals
through a scoped Effect service. Exact numbered inputs are synced before
transmission; output chronology and parser tails commit before publication.
Broker acceptance and complete pipe delivery are separate receipts, and neither
alone proves that the provider parsed or applied a command. Native replies
establish protocol processing separately. Renderer replacement suspends delivery
while native ownership continues; source, settings, extension, and reload actions
retain their own receipts. Started actions are reconciled rather than blindly
executed again. See [native active-session recovery](native-active-recovery.md).

Final merged native counts (`PENDING_FINAL_MERGED_NATIVE_COUNTS`), matched
performance (`PENDING_MATCHED_PERFORMANCE`), Claude approval recovery
(`PENDING_CLAUDE_APPROVAL_RECOVERY`), and Windows directory-durability/native-recovery
compatibility (`PENDING_WINDOWS_NATIVE_RECOVERY_COMPATIBILITY`) remain pending.
The existing Linux Codex stream result does not establish those remaining gates.

A private weak map associates eligible complete loads with their exact raw
native source. Unique nonempty thread identities determine compact
checkpoint eligibility independently of display normalization and message identities. The persistence
client adopts that raw source using the actual native timestamp and bridge;
startup does not write normalized display defaults back to disk. An unchanged
first checkpoint carries thread order without message changes. Startup histories
with unidentified or duplicate thread records use a complete-source full save,
preserving raw records and opaque source slots. Opaque, unidentified, and duplicate
message records permit the unchanged order-only checkpoint; edits to their thread
replace its complete message array without assigning identities or dropping records. A changed
durable base uses the same complete-source resync. Browser recovery and deliberate workspace
binding changes compare against the native source instead of treating newer
cache state as already committed. Adoption refuses active or queued work.

Deliberate display edits are overlaid on the source by occurrence, preserving
unmodified optional fields, exact string content, and opaque neighbors. Native
bridges must explicitly advertise `supportsMessageFields` before the renderer
sends own-property set/remove patches for existing messages. This lets a status
or metadata change omit unchanged message text; checkpoint bridges without field
support retain complete message upserts. The native engine rejects overlapping
message-field edits and changes to message IDs. A separate explicit
`supportsMessageAppends` capability, together with field support, permits exact
UTF-16 suffix packets for strings whose previous value is at least 1,024 code
units. Strings constructed by the renderer's owned append operation use private
ancestor identity to prove the exact suffix without rescanning the complete
prefix. Unowned strings retain the exact prefix comparison. Native validation requires an
existing own string property and its expected length, and rejects overlapping
set/remove/append edits before committing. Replacement and truncation use full
field values. Older field-capable bridges retain full changed-string values.
Append lineage nodes retain only suffixes and lengths, with per-lineage logical
bounds of 512 parent links and 1,048,576 UTF-16 suffix units. Endpoint proofs retain
their current text; these limits do not bound total registry or engine heap usage.
Successful acknowledgements rebase captured exact endpoints; failed writes cannot
prune them. Detected data-only mutations of registered endpoints lose append
eligibility and force exact recovery; accessor fields are rejected without
invocation. After a mutated predecessor, one conservative successor
save establishes a fresh accepted root before subsequent owned checkpoints resume.
Arbitrary unobserved edits remain subject to the immutable-input contract.
Source-owned writes remain ordered even with an older
full-save bridge. Before calculating a queued request, the client refreshes its
source projection after the preceding request settles. Successful native or
complete recovery-cache writes advance source acknowledgement; failed writes
do not. Queued edit waves are calculated against that refreshed source.

Thread actions expose a version 1 recovery JSON snapshot containing one thread's
complete source records, metadata, and attachment references.
Source-aware collection used by thread deletion, draft attachment removal, and
queued-message removal examines raw message and queue records, so hidden records
continue to protect their blobs.
Queue removal checks the retained source references after removing its unique
target thread's selected message. Cancellation is scoped to the thread/message
pair, and ambiguous duplicate thread IDs refuse queue removal.
Duplicate-thread deletion targets the selected source occurrence; organizing
ambiguous duplicate IDs stays guarded. This does
not establish that every navigation or provider action supports duplicate IDs.

Startup admits native history writes only after a successful disk read and
reconciliation. Transient read failures retry before enabling edits. If reads
continue to fail, cached conversations remain available for browsing with a
visible retry action, while conversation changes and checkpoints stay paused.
An empty or stale cache cannot overwrite unknown durable history merely because
a later disk write succeeds. Validated complete fallback checkpoints choose
content and membership by checkpoint time, including imported future-dated
thread metadata; unmarked legacy cache recovery retains its merge behavior.

### Native provider permissions

Codex command/file approvals project only the choices in that request's native
`availableDecisions`. The selected index is revalidated in the main process and
returns the exact advertised native decision: one-time or session acceptance,
persistent command-prefix policy, persistent network allow/deny policy, decline,
or turn cancellation. Unsupported, empty, and malformed lists do not create
fallback grants, and forged or unrelated choice IDs are rejected. Decline and
cancel remain distinct responses; stopping a request does not silently save a
deny rule. The separate permissions request grants only its requested categories
with the provider's turn scope.

Claude retains native tool permission, question, elicitation, and Plan behavior,
including Plan use by Studio and validated legacy callers. Life declares no
`supportedDialogKinds`; undeclared `request_user_dialog` messages stay pending
for their native consumer without a fabricated dismissal. Initialization replay
and provider session-state changes retain their protocol meaning. These paths
continue to use Codex app-server and Claude Code control messages over SSH.

## Verification

Run the native and integration checks with:

```sh
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run test:checkpoints
npm run test:loads
npm run test:performance
npm run format:check
```

The tests exercise real encrypted loopback SSH alongside deterministic provider
stand-ins. They cover Effect interruption, finalizer completion, concurrent
command isolation, suspended Codex deadlines, permission protocols, atomic
history/profile recovery, and bounded HTTP bodies. Browser checks cover exact
transcript output, history anchors, native Find, drafts, queued messages, and
small-window Studio controls. History-load fixtures exercise exact recovery,
fragmented large messages, cancellation, malformed input, StrictMode ownership,
and encoded/object equivalence through the real preload and IPC. Permission
fixtures exercise the exact advertised Codex choices through Electron and real
encrypted loopback SSH with deterministic provider stand-ins.
See [renderer measurements](renderer-performance.md)
for fixture scopes and reproducible comparisons.

Final restoration verification passes 113 unit test files with 2,183 tests;
the allocation refinement also has a 227-test focused history run. Typechecking
and the production build pass. Twelve local App recovery checks and 35 queue
browser checks use production React, mocked bridge/provider boundaries, and
real downloads/IndexedDB. The final Linux packaged desktop run passes 47 workflow
groups through real Electron, SSH/SFTP and deterministic provider stand-ins,
with no renderer errors. Its source, compiled output, helper, and package hashes
match the verified build; the archive stays identical across the run. Reports
are under `output/playwright/history-restoration-optimized-source/`,
`history-restoration-optimized-packaged/`, and
`history-restoration-packaged-desktop/`, with separate browser proofs under
`conversation-recovery/` and `thread-queue/`.

The migration does not establish authenticated upstream inference, native PTY
control-sequence behavior, installation behavior on every OS, or the absence of
all possible performance issues. Initial loading, full-save resyncs, and worker
disk serialization remain workload-dependent costs. Incremental checkpoint
measurements are reported separately from browser caching and rendering. The
remaining extension/updater/source-compiler Promise
boundaries are explicit migration work, not claims of an entirely Effect-only
application.

The source raw-startup fixture changes its first payload from a 45,750,700-byte
full save to a 1,918-byte order-only checkpoint, preserving the original raw
history and the separately normalized display. Observed renderer/main maximum
pauses change from 442.3/246.87 ms to 92.2/19.67 ms. Loading-gate readiness is
669.5 ms before versus 692.4 ms after. Standard encoded-load completion has a
17.9% higher median across three observations, and the 8 MiB-message sample is
3.7% slower overall. These are measured responsiveness and preservation
tradeoffs. Source and packaged measurements retain their separate baselines.
Adaptive Markdown block reuse
improves the repeated-content fixture; its unique-content comparison does not
establish an improvement. Neither result supports a universal zero-cost or
frame-rate claim.

Streaming checkpoint verification adds exact suffix support and opaque-message
baseline admission: 2,275 tests across 116 files, full typecheck/format/build,
and all 47 unchanged-package desktop workflow groups pass. Native source and
ASAR fixtures preserve exact strings, opaque rows, workspace/session identity,
atomic rejection, coalescing and fresh-worker recovery. The matched eight-MiB
response fixture reduces append packets from roughly 8.4 MB to 4,179 bytes and
source main lag from 20.23 to 2.91 ms. Those observations show slower renderer
submission and total acknowledgement. On the historical frozen owned-appends
graph, a subsequent eight-pair native comparison observed submission decrease
from 26.15 to 1.90 ms and renderer timer lag from 23.45 to 1.60 ms; total
acknowledgement remained nearly unchanged. The prior isolated Local integration
preserves exact data and recovery; the current delivery batch has no new paired
timing measurement. Full details and
retained identities are in `docs/renderer-performance.md` and
`output/playwright/streaming-checkpoints-{baseline,candidate,packaged}/`.

## Working on Effect code

Read `node_modules/effect/AGENTS.md` completely before writing Effect code. Use
the installed source and linked guides for this pinned API; v3 examples can use
different names and types. Follow the instructions in the repository's
`AGENTS.md` and `CLAUDE.md`.
Use the [v4 Schema guide](https://effect.website/docs/v4/schema/basic-usage) for
untrusted boundaries and the
[resource management guide](https://effect.website/docs/v4/resource-management/introduction)
for acquisition/release design, checking every API against the installed source.
