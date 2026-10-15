# Codex session ownership on shutdown

Life previously disconnected SSH on normal quit while leaving its idle, detached
Codex app-server alive. That server retained the native conversation writer, so
a new Life process could fail to resume the saved conversation with an active
writer error. Model discovery could leave an idle server behind too.

Normal window close and application quit now suspend renderer admission, flush
conversation history, and release idle Codex transports before disconnecting
SSH. The release service protects an entire shared transport when it owns a
running root or child, startup, stopping operation, live settings change, or
pending native permission. Catalog-only transports are registered before their
broker handshake, so a shutdown during model discovery cannot miss them.

The Effect-owned terminal wait distinguishes the broker's command acknowledgement
from the provider's actual exit. It keeps consuming terminal frames behind paused
output, discards uncertain queued prompt deliveries when closing, and waits at
most eight seconds. Retirement settles a cancelled opening even when its SSH
acknowledgement arrives late. Concurrent close and quit operations join the same
release. Unavailable SSH or an expired wait remains an unconfirmed release;
finishing local shutdown does not prove that a remote process exited.

Unexpected and explicit SSH disconnects retain their existing durable transport
behavior. Active provider work is preserved on quit.

## Verification

The results below retain the scope of the earlier idle-ownership graphs; they
do not certify the final merged active-recovery release. On those graphs,
typecheck and build pass. The focused lifecycle, RPC, durable transport, Claude
usage, socket-cut recovery, and idle ownership suites pass 184 tests.

The native ownership smoke fixture runs actual Electron and SSH/SFTP with a
provider stand-in that holds an exclusive writer until a deliberately delayed
200 ms TERM exit. The identical baseline and candidate fixture proves both quit
paths, models-only cleanup, exact cold-resume identity and prompt/reply retention,
and preservation of an active hanging turn. It observes provider exit before the
actual SSH disconnect and before fixture teardown. Clean idle quit observations
are 56–89 ms for the baseline, which leaves the writer alive, and 283–346 ms for
the candidate, which waits for the provider. These timings measure the expected
cost of waiting for provider exit.

A controlled concurrent regression also starts normal window close, observes
real TERM, then invokes application quit 39 ms later while provider exit remains
pending. The shared service wait keeps SSH connected until provider exit, and
the cold UI follow-up preserves both exact prompts and replies on the same native
session, workspace, and profile. No additional Electron memo layer is needed.

A separate authenticated Codex check resumes and reads the already-created real
session without starting any turn. The baseline reproduces the active writer
error after graceful quit. The candidate exits its actual provider, records a
terminal broker journal entry, and successfully resumes and reads the same exact
session, workspace, completed prompt, and answer before any fixture cleanup.
This check requests zero additional inference and uses an artifact-only reference
to the actual native Agents instance; it does not substitute a service. The
complete 236-source-file and 101-build-file graph matches before and after.

Evidence:

- `output/playwright/codex-restart-ownership-baseline/frozen-build.json`
- `output/playwright/codex-restart-ownership-candidate/comparison-and-cleanup.json`
- `output/playwright/codex-restart-ownership-concurrent/sequence-and-cleanup.json`
- `output/playwright/codex-idle-quit-real/proof.json`

## Active restart recovery candidate

The candidate records a native ownership manifest, exact numbered input journal,
and committed output/parser progress so a new Life process can reconcile an
original surviving broker. The native conversation ID remains distinct from the
broker UUID. Reattachment uses `launch:false`, restores initialization and native
request ownership, reconstructs recorded output before publishing it, and acquires
an exclusive writer lease before admitting outbound work. Observers can replay
output but cannot write, signal, end stdin, or close the provider.

Version gates recognize the recorded Codex `0.162.1` and Claude Code `2.1.278`
contracts; that recognition does not certify both providers' final native matrix.
Unknown versions, corrupt journals, foreign profiles, missing brokers, and
uncertain ownership remain preserved and cannot authorize a replacement launch
or permission response. Restored queues remain paused. Restart does not
automatically replay a prompt or approval, initialize another provider, or
generate replacement titles.

A broker acceptance number records an accepted immutable command. A `written`
receipt establishes complete pipe delivery, while `cancelled` covers only work
that never started and partial or unconfirmed writes remain `uncertain`. Neither
acceptance nor a written receipt proves that the provider parsed or applied the
command; its native response supplies separate evidence. Pending permission
answers retain their original request occurrence and ownership. A later sequence
cannot establish an earlier delivery, and uncertainty cannot authorize a second
answer. Older brokers without receipt support remain read-only.

Stop and close retain exact write-ahead commands. Releasing native ownership
after close requires both its written receipt and observed provider exit.
Forced cleanup without observed death records `nativeExitConfirmed: false` and
cannot resolve permissions, child work, or Stop. Studio source/settings/reload
actions use separate receipts; a started action is reconciled rather than
executed again, and a completed source action stays completed if later history
bookkeeping fails. See [native active-session recovery](native-active-recovery.md).

The current isolated Linux Electron/SSH Codex streaming-restart case passed.
Claude approval recovery remains unresolved (`PENDING_CLAUDE_APPROVAL_RECOVERY`).
Final merged native counts (`PENDING_FINAL_MERGED_NATIVE_COUNTS`), matched
performance (`PENDING_MATCHED_PERFORMANCE`), and Windows directory-durability/native-recovery
compatibility (`PENDING_WINDOWS_NATIVE_RECOVERY_COMPATIBILITY`) remain pending.
These active fixtures use deterministic provider stand-ins and do not authenticate
or request upstream inference. Earlier idle-ownership timings and the separately
scoped authenticated session read above retain their original meaning; they do
not establish complete active recovery or performance on the final merged graph.
