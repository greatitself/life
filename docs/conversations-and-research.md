# Conversations, environments, and Research

Agents, Research, and Life Studio have distinct purposes and saved conversations. Agents works in selected coding projects. Research works in machine-level research goals. Life Studio changes the application. An ordinary chat cannot apply Life customization proposals, including when its text contains `/life`.

## Current project and environment

Connect to a machine first, then select an Agents project when you want to work in one. The new-thread page identifies the active project rather than presenting a generic placeholder. **Current Active Environment** in the header provides the selected machine, SSH identity, connection state, project folder, scope, and provider availability. A saved folder is not described as an active project before selection succeeds.

Each Agents thread retains its provider, saved connection, project folder, and remote conversation ID. Selecting a thread restores that context. On the same machine Life can select the folder without reconnecting; saved key, agent, and SSH-config profiles can reconnect when needed. A password or encrypted-key passphrase may require the connection dialog if it is no longer held in memory. Navigation is serialized so a late project selection cannot send a message to the wrong folder.

## Titles and unchanged messages

Life uses Codex or Claude Code's generated titles rather than truncating the first message. Existing provider titles are preferred. When a new thread needs a title, a separate best-effort metadata task uses the same provider and the original first message unchanged. Its title instructions live in a disposable `AGENTS.md`/`CLAUDE.md` workspace, with tools disabled. It cannot add title instructions to the coding conversation. A failed or unavailable title task leaves the conversation usable with its untitled name; it does not fall back to copying the prompt. Manual title editing remains available.

For normal, queued, and steering messages, Life preserves submitted text, including leading and trailing whitespace. Research instructions and Studio source context belong in their own native instruction files. Life does not append a generated research prompt, attachment explanation, or source preamble.

Selected attachments are separate inputs. Codex supports raster images natively; other files use their visible remote paths. Claude supports raster images, PDF documents, and UTF-8 text documents natively; other binaries use their paths. The provider's supported formats and bounded upload/read limits still apply. These inputs represent the files the user selected and do not add explanatory prose to the prompt.

## Read model output and subagent activity

The conversation preserves chronological provider events: responses, provider-emitted reasoning, plans, tools, approvals, errors, and subagent work. Subagents retain their provider identity, name or role, parent relationship, status, tool calls, and emitted text. Their output stays associated with its owning conversation rather than appearing as an unrelated project thread.

Activity rows show useful live output, with raw/code views and copying. Large outputs have bounded previews so a long diff or tool response cannot freeze the interface; the full retained output remains available to copy or download. Provider reasoning can be shown only when the provider emits it. Life cannot expose internal information absent from the stream.

## Queue a follow-up or steer current work

With the message-queue feature enabled, sending while a provider is busy queues a follow-up. The queue runs in order after the current response reaches provider-confirmed completion. A partial result, pending approval, failure, interruption, or lost connection does not start the next queued prompt. Claude's native session-idle event takes precedence over individual result events when that protocol is available.

To influence current work instead, choose **Steer** beside the composer or the steering arrow on a queued message while the thread is busy. Life sends native steering: Codex uses the current turn ID with `turn/steer`; Claude uses its noninterrupting `next` priority. It sends the exact selected message and does not stop the current turn. If the turn changes before steering can be delivered, Life reports that outcome instead of replaying the message into unrelated work.

Queue entries preserve their attachments and can be removed. Restarted queues are paused for review rather than automatically sending old work. A paused or failed queue entry stays recoverable. The queue supports up to 32 messages per thread. If you disable the message-queue built-in, sending while busy uses native steering directly instead of creating a new queue entry; previously saved queue entries remain recoverable.

## Change run settings during a response

Model, reasoning effort, and speed controls remain available while a thread works. Life uses settings controls, without sending an additional chat message or stopping and restarting the response.

- **Codex:** Version 0.162 or later with the live settings API and model-step switching can apply supported model, effort, and speed choices at the next model step. Older providers save the choice for the next turn or request. Changing permission mode during a running turn applies to the next turn; a pending approval keeps its existing policy.
- **Claude Code:** Supported model and effort changes apply at subsequent model requests. Fast/default speed changes are accepted without interruption and take effect on the next turn. They cannot change the speed of inference already underway.

The controls display the actual provider result. Choices follow the provider's advertised model capabilities, CLI version, account, and policy. Unsupported settings are not presented as successfully applied. Life never chooses a paid Fast tier automatically.

## Connection continuity

An unexpected SSH interruption leaves the remote provider running in a detached broker. Life keeps the thread active, retries the same machine, and resumes missing output from its journal after reconnecting. Numbered input acknowledgements prevent a submitted prompt from being launched again. Output replay follows the last received cursor.

The broker requires Node.js, `nodejs`, or Python 3 on the remote Linux or macOS host. It uses standard runtime libraries, without npm or pip dependencies. Session state and full output journals are private files under `~/.life/agent-sessions/<session-id>`: directories use mode `0700`, and files and the local socket use `0600`. Journals remain on the host until removed; provider completion ends the active broker. Research synchronization requires Node.js even when the broker uses Python; Claude selected-file reads support Node.js or Python 3.

Automatic reconnect uses connection credentials held only in RAM, with retries increasing from one to fifteen seconds. Passwords, passphrases, and key contents are not saved. Explicit disconnect cancels automatic retries; reconnecting manually to the same machine can reattach its still-running sessions.

This continuity covers loss of the SSH transport while Life is running. A remote reboot, killed provider, or full Life process restart is a different event. Life does not silently recreate an unavailable broker or replay the original prompt. Provider-session history remains available for a later explicit continuation when the CLI supports it. Explicit stop and conversation closure still stop their work.

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

The root also contains `.life-method.md` and `.life-method-schema.json`. They define the research operators and the versioned `goal.json` method records. Each submitted operation is recorded separately in `.life-invocations/<invocation-id>.json` inside its conversation directory. These snapshots are immutable; the operation selected for later work does not replace the saved identity of a running or queued invocation. Research context is file metadata, and the submitted user message remains unchanged. See [research methods](research-method.md) for the 12 approaches and evidence traceability.

Research's root instruction files and README document stable goal/problem IDs, conversation links, atomic metadata updates, and map formats. User messages remain unchanged. Map priority is `map.html`, `map.mmd`, `map.json`, then the automatic goal/problem map. HTML maps run in an isolated frame; Mermaid and JSON maps can also select linked problems. Life refreshes Research files while the view is visible and after completed turns. Local drafts and pending edits remain cached while disconnected.

Life copies recognized goals, maps, metadata, and artifacts from known legacy `.research` locations. Initialization can incorporate newly discovered legacy project locations even after the new root exists, without recopying an already migrated source or replacing current maps. Original directories and browser caches remain intact. Conflicting names or goal IDs are preserved under `.legacy-conflicts` with a migration manifest; symlink artifacts are skipped. Existing linked conversations retain their provider IDs while their Research working directories move to the canonical goal or problem location. Divergent cached edits remain recoverable instead of silently overwriting another version.

## Host chat history

Open **Host chat history** after connecting to browse conversations already saved by Codex or Claude Code on that machine, including conversations created in another client or terminal. Browsing does not require selecting an Agents project.

1. Select All, Codex, or Claude Code. Search saved chat titles and refresh when sessions have changed. Claude's search also matches saved project folders.
2. Select a session to preview its messages, tools, reasoning, and saved subagents.
3. Use **Load more sessions** or **Load more of this conversation** for older records.
4. Choose **Resume in Life** to import display history with the existing provider session ID, or **Open in Life** for a previously imported session.

Reading and importing do not start a coding turn or rewrite original provider files. Resuming work later uses the original session ID and folder. If a folder is unavailable, Life asks for the missing context instead of assuming the current project. Imported paginated history retains its continuation so remaining messages can still be loaded.

Codex history uses its read-only app-server history APIs, including saved metadata, archived sessions, and paginated items. Claude history reads its existing JSONL sessions under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`. Provider titles, working directories, timestamps, tool results, reasoning, and subagent relationships are retained where present. Missing metadata uses an untitled label rather than a prompt excerpt. Individual subagent sessions stay associated with their parent rather than cluttering the main session list; selecting a subagent preview continues its owning parent conversation.

Large or malformed histories produce explicit warnings or limits instead of changing the original records. Pagination bounds individual reads; the session file scan is capped at 10,000 files. History browsing for another physical machine requires connecting to that machine's SSH account: Life reads that account's provider history, not an unrelated computer's files.

Internal Studio workspaces and disposable title tasks are excluded from the provider session list. Machine-level Life Research sessions remain identifiable as Research and use **Open in Research** rather than becoming Agents projects. An existing linked Research chat opens its goal/problem context; an unlinked Research session is not silently imported into Agents.

## Public browser preview

The [Life browser preview](https://greatitself.github.io/life/) uses the shared interface with editable example Research and settings stored in the current browser. You can explore the workbench, maps, themes, and built-in feature controls, then use **Export Research** to save its browser-local records. The preview banner identifies this environment and links to desktop downloads and feedback.

The sample environment does not open SSH connections or execute Codex, Claude Code, extension backends, or source builds. Those features use the desktop host. Refreshing the site loads the latest published preview while retaining its locally stored edits; browser storage can be cleared by the user or browser.
