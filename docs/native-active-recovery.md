# Native active-session recovery

Life keeps the providers' native protocols. Codex runs its stdio app server; Claude Code runs its bidirectional stream-json interface. Recovery reconnects to the original broker and process. It preserves the submitted bytes, provider thread/session/turn IDs, root and child ownership, workspace, and native permission IDs.

Recovery is currently admitted for the recorded Codex `0.162.1` and Claude Code `2.1.278` contracts. The original version matters: changing the installed executable does not change an already running process. Unknown protocol labels, versions, corrupt journals, foreign profiles, missing brokers, and uncertain ownership remain preserved and cannot authorize a replacement launch or permission response. This version gate must expand only with native contract evidence and verification.

## Ownership and persistence

`NativeRecoveryStore` owns the protected local registry and append journals through a scoped Effect service. Transport metadata identifies the stable connection profile and transport, original broker root/UUID and launch command, parser contract, initialization, and root/child owners. Local identity uses the persisted Local profile ID; SSH identity retains host, port, and username plus exact profile ownership.

An input receives its sequence and exact wire bytes in a synced write-ahead record before transmission. Reattachment reconciles the broker's contiguous acceptance high-water mark. An outstanding retry retains the same sequence and bytes. Acceptance acknowledges the immutable numbered command and prevents a duplicate execution; it does not prove that queued stdin bytes reached the provider.

Receipt-capable brokers advertise `inputReceipts: 1` themselves. Life commits that capability before replaying receipt records. Each accepted sequence has one immutable final receipt: `written`, `cancelled`, or `uncertain`. A complete Node write callback or complete Python OS write establishes pipe delivery. Cancellation covers only work that never started; partial or unconfirmed writes remain uncertain. A later sequence cannot establish an earlier sequence's delivery. Native replies separately establish protocol processing, and a written receipt alone cannot establish that the provider parsed or applied a command. Tracked older brokers without this capability remain read-only rather than replaying unverified inputs.

A writer lease fences every broker mutation; an observer can replay output but cannot write, signal, end stdin, or close the provider. Stop and close retain their exact write-ahead commands. Close requires both its written receipt and observed provider exit before it can release native ownership. A terminal close covering cancelled inputs does not prove that those inputs reached the provider. Permission answers retain their original request occurrence and ownership while their receipt is pending; uncertainty cannot authorize another answer.

Raw stdout/stderr and native events commit in bounded batches before renderer publication. Recovery folds the recorded chronology, including owner changes, inputs, replies, and split UTF-8/JSON tails. Incoming broker output remains held until this reconstruction finishes. Native event IDs, original timestamps, approval bindings, and request-ID allocation are retained. Replay does not initialize a second connection or generate new titles or permission answers.

Renderer replacement suspends delivery while native ownership continues. Shutdown settles accepted work, releases only verified idle providers, detaches active attachments, and then releases the service leases. A closing provider cannot grant a replacement writer before its native terminal receipt.

History lifecycle barriers wait for actual worker acknowledgments within a bounded grace period. If the worker remains silent, Life terminates its owned worker and reports `shutdown-uncertain`; it does not acknowledge the unanswered write or claim that the file was rolled back. The same store stays retired, and replacement documents remain suspended until a fresh application reconciles the actual protected history. Ordinary caller cancellation still leaves accepted healthy writes owned by the store.

Forced broker cleanup carries `nativeExitConfirmed: false` when it has not observed provider death. That notice remains in the journal, keeps native ownership unknown, and cannot resolve permissions, children, or Stop. Legacy markerless records retain compatibility semantics; marker omission is not retrospective evidence that an older timeout observed native exit.

## History and Studio

Saved JSON cursor fields are archival data. Private projection capabilities accompany current, actually applied renderer projections in checkpoint headers; they are excluded from exported history, native event journals, and sidecars. Imported JSON cannot create those capabilities.

The history worker hashes the exact serialized file, obtains native admission, stages a private receipt, and then atomically commits the file. Native receipt acknowledgment follows file and directory sync. A cold read accepts the receipt only if the actual bytes match its hash and the native journal contains the corresponding preparation. This covers a process crash after the file commit and before acknowledgment without replaying an already saved append. Ambiguous rename/sync failures retain proof and replay data while refusing a false durable acknowledgment. Ordinary unowned archive saves retain their prior behavior.

Studio captures its exact planner state and source-read/action intents before continuing work. A preparation owner exists before the first source read and never launches a broker. The first real provider owner links that reservation. Cache persistence prepares exact owned rows and checkpoints their hash and planner progress before writing them; only a successful matching write can acknowledge them.

The main fallback cache binds its exact bytes and original save clock before writing. A cold read verifies the actual stored hash, including a crash between the payload and timestamp-marker writes. Explicit deletion can carry a private membership proof even when no owned row remains. That absence proof never authorizes a native history acknowledgment or an approval, and imports cannot create it. Studio recovery binds the thread to its actual recorded staging workspace.

Source/settings/extension/reload actions use separate native receipts. Duplicate action IDs cannot execute a different intent. A started action is observed and reconciled, never blindly executed again. Source receipts retain checksum-bound historical snapshots in the committed revision and compact ownership markers in mutable state. A completed source action stays completed if later history bookkeeping fails. Reload success requires a fresh native document reporting the exact applied source revision; merely scheduling a reload is insufficient. Stopped or discarded planners can observe existing receipts without admitting another action.

## Verification

Run `npm run typecheck`, the relevant Vitest suites, and `npm run build`. `npm run test:active-recovery` exercises real Electron and SSH/SFTP with deterministic native provider stand-ins and private profiles. `npm run test:active-reload` checks actual renderer reload and delayed native exit. The fixture records original IDs, exact prompt/input bytes, provider PIDs, partial output before final completion, permission ownership, source receipts, and opaque archive hashes.

These fixtures do not authenticate or request upstream inference. Authenticated Claude verification remains outside this change. Linux worker durability is verified; Windows directory durability and native recovery require a supported implementation before they can be claimed. Retained journals are not pruned initially. Performance comparisons must use the same fixture and an exclusive quiet measurement slot; functional test durations are not performance evidence.
