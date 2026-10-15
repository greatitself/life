This is a prepared private benchmark. It has not been executed. Only its JavaScript syntax has been checked.

After native functional verification and an explicit parent GO plus Root quiet lease, run:

```bash
node output/native-registry-performance/run-paired.cjs \
  --candidate /absolute/immutable/ssh-candidate-path \
  --lease /absolute/parent-issued-quiet-lease.json
```

The lease fields and exact sequence are documented in `plan.json`. The preparer does not create a lease. Each attempt gets a fresh output directory, private Xvfb, disposable SSH server/home/workspace, disposable Electron profile, and sixteen fresh app runs in repeated ABBA order. Eight adjacent baseline/candidate pairs are followed by one candidate-only durability probe whose timings are excluded from the comparison.

The real App submits one exact prompt to the fixture's pinned Codex native protocol. Eight1Mi deltas build an8Mi response without crossing Life's8,000,000-character native JSON-line limit. The next measured phase appends an exact2Ki tail to the same native thread/turn/item. The observer calls the App's existing `__lifeFlushConversationHistory` synchronously as the last expected delta arrives, preventing an automatic save from making the measured flush a no-op. The prompt, workspace, machine, native identity, item text and completion are verified after timing. No owned JSON, cursors, native tokens or private projection admissions are injected. The provider stores its final archive and writes deferred output hashes once after timing; it does not repeatedly rewrite its cumulative transcript while streaming.

Paired measurements use small timer and actual history-IPC boundary observations. The separate durability probe transparently observes native journal writes and successful syncs, returns original inputs and Promises unchanged, and binds exact protected history preparation/ACK records to successful sync evidence. It also validates the protected sidecar against the final history bytes. A visible journal ACK or resolved renderer flush alone is not presented as proof of native ACK fsync.

The output interval runs from arming the renderer observer to its last expected native delta. It includes command delivery, up to10ms provider release-file polling, native protocol JSON encoding/emission, a small release log, and the same existing SSH harness broker-frame observer. It excludes the subsequent explicit flush submission. Optional output hashes, snapshot/proof encoding and correctness/file inspections occur after timing.

The immutable baseline's actual source and compiled worker perform file write/sync/close/rename before their API ACK. They do not sync the history directory and have no native registry/protected-history API. Thus the common comparison is API ACK latency, renderer responsiveness and complete native output delivery. Candidate raw WAL and protected durability are additional capability evidence; there is no fabricated old-WAL ratio.

The runner freezes current installed dependency and executable bytes across the new baseline and candidate runs. It does not claim those bytes match the historical baseline publication. It records all private ports/profile/display/process identities and verifies exact private PID disappearance before deleting owned profiles. This remains a deterministic native-provider fixture, separate from the unchanged39-case recovery matrix and from authenticated upstream provider use.
