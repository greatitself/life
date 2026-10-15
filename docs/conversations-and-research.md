# Conversations, environments, and Research

Agents, Research, and Life Studio have distinct purposes and saved conversations. Agents works in selected coding projects. Research works in machine-level research goals. Life Studio changes the application. An ordinary chat cannot apply Life customization proposals, including when its text contains `/life`.

## Current project and environment

Connect to a machine first, then select an Agents project when you want to work in one. The new-thread page asks what you want to do in the active project. Its dashed-underlined project name opens the project selector. **Current Active Environment** in the header provides the selected machine, SSH identity, connection state, project folder, scope, and provider availability. A saved folder is not described as an active project before selection succeeds.

Each Agents thread retains its provider, saved connection, project folder, and remote conversation ID. Selecting a thread restores that context. On the same machine Life can select the folder without reconnecting; saved key, agent, and SSH-config profiles can reconnect when needed. A password or encrypted-key passphrase may require the connection dialog if it is no longer held in memory. Navigation is serialized so a late project selection cannot send a message to the wrong folder.

## Organize threads

**Thread actions** is available from each sidebar row and the conversation header. Pin important threads and use **Move up** or **Move down** to arrange pinned and active threads. **Arranged** sorting shows that saved manual order, which stays stable while provider output, titles, and Git observations update. Search, filters, automatic sorting, and project grouping remain available; existing custom sidebar preferences are preserved.

**Settle thread** parks work without stopping its provider. **Snooze thread** moves it to the compact Snoozed section until the chosen time, unless a new request, completion, or failure needs your attention sooner. Settled, snoozed, and archived conversations remain in expandable sections, with the selected conversation still shown as a compact row. A pending approval or question prevents settling or snoozing. **Archive thread** retains the conversation in Archived, where **Restore from archive** returns it to the active list. Running parent work, a live child agent, a pending request, or an unpaused queue prevents archiving and deletion.

Completion indicators distinguish unread finished work from waiting requests and failures. Opening a conversation marks it read; **Mark unread** and **Mark read** provide explicit control. Ordinary streaming, title changes, Git refreshes, and imported historical messages do not manufacture unread completions. Arrangement actions show **Undo**, which restores their organization fields without discarding newer messages or provider updates. Deletion remains a separate confirmation.

With a sidebar thread row focused, use **Up/Down** to move focus, **Home/End** for the first or last visible row, and **Enter** to open it. **Shift + F10** or right-click opens its actions; **Escape** closes the menu and restores focus.

## Drafts and new conversations

Draft text and attachment metadata are saved in Life's local composer storage, with attachment bytes in its local attachment database. Switching conversations restores each draft. Restarting restores files that remain available; a missing or unreadable attachment stays visible with instructions to reattach or remove it before sending. Restored attachments pass through the current connection's upload checks rather than reusing an old uploaded path. Storage failures report that the draft or files are still held in the current window.

Choosing **New thread** preserves an existing unsent new-thread draft as a **Draft thread**, then opens a fresh composer. The new composer inherits the selected thread's provider, model, effort, speed, and permission choices. Creating or sending a thread preserves the draft's identity while connection restoration or uploads run. Only submitted text and files are consumed; newer edits stay in the composer, and a failed send restores the original input alongside newly typed content.

## Titles and unchanged messages

Life uses Codex or Claude Code's generated titles rather than truncating the first message. Existing provider titles are preferred. When a new thread needs a title, a separate best-effort metadata task uses the same provider and the original first message unchanged. Its title instructions live in a disposable `AGENTS.md`/`CLAUDE.md` workspace, with tools disabled. It cannot add title instructions to the coding conversation. A failed or unavailable title task leaves the conversation usable with its untitled name; it does not fall back to copying the prompt. **Rename thread** sets a manual title that a later automatic title result cannot overwrite.

For normal, queued, and steering messages, Life preserves submitted text, including leading and trailing whitespace. Research instructions and Studio source context belong in their own native instruction files. Life does not append a generated research prompt, attachment explanation, or source preamble.

Selected attachments are separate inputs. Codex supports raster images natively; other files use their visible remote paths. Claude supports raster images, PDF documents, and UTF-8 text documents natively; other binaries use their paths. The provider's supported formats and bounded upload/read limits still apply. These inputs represent the files the user selected and do not add explanatory prose to the prompt.

## Read model output and subagent activity

The conversation preserves chronological provider events: responses, provider-emitted reasoning, plans, tools, approvals, errors, and subagent work. Subagents retain their provider identity, name or role, parent relationship, status, tool calls, and emitted text. Their output stays associated with its owning conversation rather than appearing as an unrelated project thread.

While work runs, progress updates stay expanded between collapsed action rows. Reasoning uses the reported action text without a separate reasoning-summary label. Expanded tool rows retain their code views and copying. Successfully completed turns keep the final parent response visible and fold completed activity under **Worked for …** or **More activity**; expand those disclosures to inspect the original chronological events. Pending requests and live child agents keep their activity visible. Failed, interrupted, and unknown work retains its status and output rather than presenting a successful completion.

The changed-file summary shows successful reported edits, with file paths, line counts, and diff previews when available. Failed or still-running tool calls do not count as successful changes. A path-only report remains path-only; shortened or omitted previews identify their limit and retain the complete tool output in Activity. Submitted prompts and the complete stored transcript remain preserved. Large outputs have bounded previews so a long diff or tool response cannot freeze the interface; the full retained output remains available to copy or download. Provider reasoning can be shown only when the provider emits it. Life cannot expose internal information absent from the stream.

## Saved conversations and recovery

Agents and Research transcripts are saved to `conversations.json` in Life's Electron user-data directory. Each checkpoint flushes a private temporary file before atomically replacing the committed history. Saving waits for a 600 ms quiet period, with checkpoints scheduled every two seconds during continuous output. Native close, quit, and interface reload also request a final checkpoint before replacing the document.

Existing browser history migrates when the native store is first created. Life loads the disk history before enabling conversation edits, then retains newer local fallback messages or a matching newer cache checkpoint. Stale cached threads do not restore conversations already deleted from a newer checkpoint. Browser-cache quota errors cannot prevent a native save; disk errors leave the last committed file intact and report that the newer conversation remains in the cache when available. Unreadable originals are preserved instead of replaced automatically.

Restored unfinished work remains unconfirmed until native ownership is reconciled, and queued messages remain paused for review. The active-recovery candidate records the original broker, process/session identity, workspace, input delivery, output progress, and native permission ownership needed to reattach surviving work. Unsupported contracts, corrupt journals, foreign ownership, missing brokers, and uncertain delivery remain preserved without authorizing replacement work or another permission answer. Broker acceptance and pipe-delivery receipts do not establish that the provider processed or applied a command; native replies provide separate evidence. Restarting Life does not automatically replay prompts or approvals. Life Studio retains its separate customization history and source/action receipts; started actions are reconciled rather than blindly repeated. These local checkpoints do not change Codex or Claude Code's original provider records on the connected host.

## Queue a follow-up or steer current work

With the message-queue feature enabled, pressing Tab in a nonempty composer while a provider is busy queues a follow-up. Empty Tab and modified Tab retain normal keyboard navigation. The queue runs in order after the current response reaches provider-confirmed completion. A partial result, pending approval, failure, interruption, or lost connection does not start the next queued prompt. Claude's native session-idle event takes precedence over individual result events when that protocol is available.

While a thread is busy, the Send button turns yellow. Click it or press Enter to steer the current response. The steering arrow on a queued message can also steer current work. Life sends native steering: Codex uses the current turn ID with `turn/steer`; Claude uses its noninterrupting `next` priority. It sends the exact selected message and does not stop the current turn. If the turn changes before steering can be delivered, Life reports that outcome instead of replaying the message into unrelated work.

Queue entries preserve their attachments and can be removed. Restarted queues are paused for review rather than automatically sending old work. A paused or failed queue entry stays recoverable. The queue supports up to 32 messages per thread. If you disable the message-queue built-in, Send and Enter still steer current work; Tab reports that queueing is disabled and retains the draft. Previously saved queue entries remain recoverable.

## Change run settings during a response

Model, reasoning effort, and speed controls remain available while a thread works. Life uses settings controls, without sending an additional chat message or stopping and restarting the response.

- **Codex:** Version 0.162 or later with the live settings API and model-step switching can apply supported model, effort, speed, and reviewer choices at the next model step. Older providers save the choice for the next turn or request. Sandbox and approval-policy changes apply to the next turn; a pending approval keeps its existing policy.
- **Claude Code:** Supported model and effort changes apply at subsequent model requests. Fast/default speed changes are accepted without interruption and take effect on the next turn. They cannot change the speed of inference already underway.

The controls display the actual provider result. Choices follow the provider's advertised model capabilities, CLI version, account, and policy. Unsupported settings are not presented as successfully applied. Life never chooses a paid Fast tier automatically.

## Connection continuity

An unexpected SSH interruption leaves the remote provider running in a detached broker. Life keeps the thread active, retries the same machine, and resumes missing output from its journal after reconnecting. Numbered input acknowledgements prevent a submitted prompt from being launched again. Output replay follows the last received cursor.

The broker requires Node.js, `nodejs`, or Python 3 on the remote Linux or macOS host. It uses standard runtime libraries, without npm or pip dependencies. Session state and full output journals are private files under `~/.life/agent-sessions/<session-id>`: directories use mode `0700`, and files and the local socket use `0600`. Journals remain on the host until removed; provider completion ends the active broker. Research synchronization requires Node.js even when the broker uses Python; Claude selected-file reads support Node.js or Python 3.

Automatic reconnect uses connection credentials held only in RAM, with retries increasing from one to fifteen seconds. Passwords, passphrases, and key contents are not saved. Explicit disconnect cancels automatic retries; reconnecting manually to the same machine can reattach its still-running sessions.

Socket continuity covers loss of the SSH transport while Life is running. The active-recovery candidate additionally records the ownership and committed chronology needed to reconcile an original surviving process after a Life restart or renderer reload. Its version gates recognize recorded Codex `0.162.1` and Claude Code `2.1.278` contracts; complete final provider coverage remains pending. A remote reboot, killed provider, missing broker, or unsupported or foreign ownership cannot silently recreate work or authorize a replayed prompt or approval. Provider-session history remains available for a later explicit continuation when the CLI supports it. Stop and close preserve their exact commands; native completion and observed provider exit remain distinct from broker acceptance or pipe delivery. See [native active-session recovery](native-active-recovery.md).

The current isolated Linux Codex streaming-restart case passed. Claude approval recovery (`PENDING_CLAUDE_APPROVAL_RECOVERY`), final merged native counts (`PENDING_FINAL_MERGED_NATIVE_COUNTS`), matched performance (`PENDING_MATCHED_PERFORMANCE`), and Windows directory-durability/native-recovery compatibility (`PENDING_WINDOWS_NATIVE_RECOVERY_COMPATIBILITY`) remain pending. Fixture results do not establish authenticated upstream behavior, and historical performance evidence remains tied to its original frozen graph.

## Research storage and isolation

Research is scoped to the connected machine's home directory. Its root is `<machine-home>/.life/research`, independent of the currently selected Agents project. For a user with home `/root`, this is `/root/.life/research`. Research synchronization can run immediately after connecting, without selecting a project.

Each goal occupies a directory with `goal.json`, its problems and notes, and related artifacts. An overview conversation works in that goal's directory. An individual problem has its own stable subdirectory under `problems/`, so its conversation can retain the exact problem context independently of an overview or neighboring problem:

```text
~/.life/research/<goal-folder>/
  goal.json
  .life-context.json
  AGENTS.md
  CLAUDE.md
  problems/<stable-problem-folder>/
    .life-context.json
    AGENTS.md
    CLAUDE.md
```

Each `.life-context.json` identifies the conversation as a goal overview or problem, records the stable goal and problem IDs, and points to the shared goal metadata, README, map files, and update lock. The provider reads that context and the latest `goal.json` through `AGENTS.md` or `CLAUDE.md`; Life does not add a generated summary or instructions to the submitted user message. Existing user instruction files are preserved. Research conversations retain their purpose and goal/problem association, stay out of Agents grouping, and do not create a synthetic `research` coding project. Selecting another Agents project does not change Research's storage.

The root also contains `.life-method.md` and `.life-method-schema.json`, which describe versioned `goal.json` method records. Each submitted request's goal/problem context is recorded in `.life-invocations/<invocation-id>.json` inside its conversation directory. These snapshots are immutable. In Life, the user's prompt determines the research approach; new contexts and queued messages have no selected operation. Older operation selections and snapshots remain readable. Research context is file metadata, and the submitted user message remains unchanged. See [research methods](research-method.md) for record formats and evidence traceability.

Research's root instruction files and README document stable goal/problem IDs, conversation links, atomic metadata updates, and map formats. User messages remain unchanged. Map priority is `map.html`, `map.mmd`, `map.json`, then the automatic goal/problem map. HTML maps run in an isolated frame; Mermaid and JSON maps can also select linked problems. Life refreshes Research files while the view is visible and after completed turns. Local drafts and pending edits remain cached while disconnected.

Life copies recognized goals, maps, metadata, and artifacts from known legacy `.research` locations. Initialization can incorporate newly discovered legacy project locations even after the new root exists, without recopying an already migrated source or replacing current maps. Original directories and browser caches remain intact. Conflicting names or goal IDs are preserved under `.legacy-conflicts` with a migration manifest; symlink artifacts are skipped. Existing linked conversations retain their provider IDs while their Research working directories move to the canonical goal or problem location. Divergent cached edits remain recoverable instead of silently overwriting another version.

## Host chat history

Open **Host chat history** after connecting to browse conversations already saved by Codex or Claude Code on that machine, including conversations created in another client or terminal. Browsing does not require selecting an Agents project.

1. Select All, Codex, or Claude Code. Search saved chat titles and refresh when sessions have changed. Claude's search also matches saved project folders.
2. Select a session to preview its messages, tools, reasoning, and saved subagents.
3. Use **Load more sessions** or **Load more of this conversation** for older records.
4. Choose **Bring to Life** to import display history with the existing provider session ID, or **Open in Life** for a previously imported session.

Reading and importing do not start a coding turn or rewrite original provider files. Resuming work later uses the original session ID and folder. If a folder is unavailable, Life asks for the missing context instead of assuming the current project. Imported paginated history retains its continuation so remaining messages can still be loaded.

Codex history uses its read-only app-server history APIs, including saved metadata, archived sessions, and paginated items. Claude history reads its existing JSONL sessions under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`. Provider titles, working directories, timestamps, tool results, reasoning, and subagent relationships are retained where present. Missing metadata uses an untitled label rather than a prompt excerpt. Individual subagent sessions stay associated with their parent rather than cluttering the main session list; selecting a subagent preview continues its owning parent conversation.

Large or malformed histories produce explicit warnings or limits instead of changing the original records. Pagination bounds individual reads; the session file scan is capped at 10,000 files. History browsing for another physical machine requires connecting to that machine's SSH account: Life reads that account's provider history, not an unrelated computer's files.

Internal Studio workspaces and disposable title tasks are excluded from the provider session list. Machine-level Life Research sessions remain identifiable as Research and use **Open in Research** rather than becoming Agents projects. An existing linked Research chat opens its goal/problem context; an unlinked Research session is not silently imported into Agents.
