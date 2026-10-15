# Life 0.13.1

Life 0.13.1 fixes the release-blocking test failures from 0.13.0.

- Retire an idle Local provider opening only after its original broker handshake establishes native input-delivery support. The opening cannot initialize a replacement provider while retirement is pending. Switching environments still requires the original close delivery and actual provider exit; uncertain native input remains protected.
- Observe Studio keyboard-focus restoration after the dialog close event, preserving the assertion that focus returns to its opener at every supported test viewport.

- Keep the history-only Electron fixture disconnected so it cannot discover or start ambient Local provider CLIs while testing exact raw-history checkpoints.
- Observe authoritative provider completion and queued follow-up delivery as separate bounded events; retain exact prompt, native ordering, and once-only delivery checks.

- Resume ordinary Windows documents through a document-owned platform check. A delayed support reply cannot resume a newer renderer, and observing platform support does not enter native replay admission or block a subsequent reload.

- Stop cancels an ordinary turn still waiting for provider-start admission, including a follow-up after an earlier Stop. The new request cannot start later after being reported stopped, and a previous completion cannot acknowledge the new Stop. Renderer preparation is cancelled before a delayed connection reply can dispatch a stopped prompt. Both providers recheck Stop and session ownership after native owner checkpoints, before dispatching a prompt. Concurrent native Stop checks retain their follow-up observation when another check is already running.

- Bind Studio follow-ups to the admitted native generation and advance repair attempts together with their saved intent. Cache preparations identify each exact session row and owner.

- Reuse deeply immutable committed recovery entries across reads while keeping current ownership data and each reader’s ordered history prefix detached. Exact journal chronology, prompts, and recovery evidence remain intact.

- Preserve Claude’s cumulative usage identity when recovering later turns on the same native process, so exact saved usage events replay with their original identity.

The release pipeline requires successful verification of the exact source commit before installer publication. Typecheck, unit/integration tests, the production build, browser/Electron workflows, native fixtures, packaged compatibility, and Windows upgrade results are recorded in GitHub Actions. Fixture checks do not establish authenticated upstream-provider behavior.

The platform and experimental active-session-recovery limits described in 0.13.0 still apply. Windows supports SSH environments; native Local execution and active-session recovery require POSIX facilities. Windows and macOS packages use the existing unsigned policy.

Renderer replacement joins accepted native Stop, startup, permission, and owner-checkpoint work before evaluating the existing ownership gate. A timeout keeps the replacement paused and preserves the original native operation.

A failed provider opening can finish renderer handoff once its exact original native exit is durably confirmed. Missing, unconfirmed, or unrelated-machine exit evidence keeps the original ownership block in place.

Cancelled Claude openings retain retirement ownership until native exit is confirmed. An opening cancelled before owner admission sends neither initialization nor a user prompt. A provider that has already confirmed exit no longer waits for a close receipt when no close envelope was issued.

Studio now reconciles a native source generation’s recorded startup failure and uses its bounded repair flow. Explicit disable, rollback, unverified readiness, and stopped requests do not authorize a new repair.

Cold replay preserves an observed Codex turn completion when a later checkpoint on the shared provider process repeats an older active owner. Completed conversations no longer acquire a false process-exit error after restart; an incomplete turn still reports its native exit.

Renderer handoff closes the old document’s history-write admission after its final flush and before draining accepted writes or revoking recovery tokens. Late unload writes cannot replace a proved history file with an unproved snapshot; a new native document receives fresh write admission.
