import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  CheckCheck,
  Code2,
  Download,
  FileCode2,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Puzzle,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react'
import type { LifeSourcePatch } from '../../shared/source-code'
import { api, errorText } from '../api'
import { useCustomizationStudio, type StudioOptions } from '../useCustomizationStudio'
import type { StudioProposal, StudioStage } from '../studio-history'
import { ApprovalCard } from './MessageView'
import { ProviderIcon } from './Icons'
import { ReferenceComposerControls } from './ReferenceComposer'
import { ThreadTimeline } from './ThreadTimeline'
import { Modal } from './Modal'
import './customization-studio.css'

const stageNames: Record<StudioStage, string> = {
  draft: 'Ready',
  planning: 'Creating a change',
  review: 'Ready to review',
  applying: 'Applying change',
  complete: 'Completed',
  interrupted: 'Paused',
  failed: 'Needs attention',
}
type InspectorTab = 'overview' | 'changes' | 'build' | 'recovery'
const draftKey = 'life.studio.drafts.v1'

function readDrafts(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(draftKey) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        ([id, draft]) =>
          /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(id) &&
          typeof draft === 'string' &&
          draft.length <= 1_000_000,
      ),
    )
  } catch {
    return {}
  }
}

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

function SourceChanges({ patch }: { patch: LifeSourcePatch }) {
  return (
    <div className="studio-source-changes">
      <p>{patch.summary}</p>
      {patch.files.map((file) => (
        <details key={file.path} className="studio-file-change" open>
          <summary>
            <FileCode2 size={13} />
            <code>{file.path}</code>
            <span>{file.content === null ? 'Delete' : file.edits ? 'Edit' : 'Replace'}</span>
          </summary>
          <pre>
            {file.content === null
              ? 'This source file will be removed.'
              : file.content !== undefined
                ? file.content
                : file.edits
                    ?.map((edit) => `Find:\n${edit.find}\n\nReplace with:\n${edit.replace}`)
                    .join('\n\n')}
          </pre>
        </details>
      ))}
      {Object.keys(patch.dependencies || {}).length ? (
        <div className="studio-dependencies">
          <strong>Dependencies</strong>
          {Object.entries(patch.dependencies || {}).map(([name, version]) => (
            <p key={name}>
              <code>{name}</code>
              <span>{version}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ProposalDetails({ proposal }: { proposal: StudioProposal }) {
  if (proposal.kind === 'source') return <SourceChanges patch={proposal.patch} />
  if (proposal.kind === 'settings')
    return (
      <div className="studio-settings-changes">
        {Object.entries(proposal.patch).map(([name, value]) => (
          <div key={name}>
            <strong>{name}</strong>
            <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
          </div>
        ))}
      </div>
    )
  return (
    <div className="studio-runtime-details">
      <h3>{proposal.manifest.name}</h3>
      <p>{proposal.manifest.description}</p>
      <p>
        <code>{proposal.manifest.id}</code> · {proposal.manifest.version}
      </p>
      <details open>
        <summary>Complete runtime extension</summary>
        <pre>{JSON.stringify(proposal.manifest, null, 2)}</pre>
      </details>
    </div>
  )
}

export function CustomizationStudio({
  visible = true,
  dialog = false,
  onOpenChange,
  connection,
  config,
  extensions,
  source,
  applySettings,
  onNotify,
  onConnect,
  onOpenExtensions,
  onOpenSource,
  onOpenSettings,
}: StudioOptions & {
  visible?: boolean
  dialog?: boolean
  onOpenChange?: (open: boolean) => void
  onConnect: () => void
  onOpenExtensions: () => void
  onOpenSource: () => void
  onOpenSettings: () => void
}) {
  const studio = useCustomizationStudio({
    connection,
    config,
    extensions,
    source,
    applySettings,
    onNotify,
  })
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts)
  const draftsCurrent = useRef(drafts)
  draftsCurrent.current = drafts
  const [tab, setTab] = useState<InspectorTab>('overview')
  const [action, setAction] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [search, setSearch] = useState('')
  const viewport = useRef<HTMLDivElement>(null)
  const active = studio.active
  const draft = active ? drafts[active.id] || '' : ''
  const connected = connection.status === 'connected'
  const runtimeCount = extensions.extensions.filter((extension) => extension.enabled).length
  const sourceCount = source.extensions.filter(
    (extension) => extension.enabled && !extension.incorporated,
  ).length
  const status = active ? stageNames[active.stage] : 'Ready'
  const applying = active?.stage === 'applying'
  const review = active?.stage === 'review' && Boolean(active.proposal)
  const history = active?.thread.messages.filter((message) => message.role === 'tool') || []
  const filtered = studio.sessions.filter((session) =>
    `${session.thread.title}\n${session.request || ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )

  useEffect(() => {
    if (!visible || !viewport.current) return
    viewport.current.scrollTop = viewport.current.scrollHeight
  }, [visible, active?.id, active?.thread.messages.length, active?.thread.busy])

  function updateDraft(id: string, text: string) {
    const next = { ...draftsCurrent.current, [id]: text }
    draftsCurrent.current = next
    setDrafts(next)
    try {
      localStorage.setItem(draftKey, JSON.stringify(next))
    } catch {
      /* The draft stays available in the current interface. */
    }
  }

  async function submit() {
    if (!active) return
    const id = active.id
    const request = draft
    if (await studio.submit(request)) updateDraft(id, '')
  }

  async function sourceAction(kind: 'rollback' | 'disable') {
    if (!api || action) return
    setAction(true)
    setFeedback('')
    try {
      if (kind === 'rollback') await api.sourceCode.rollback()
      else await api.sourceCode.disable()
      onNotify?.(kind === 'rollback' ? 'Previous source restored.' : 'Custom source disabled.')
      await api.sourceCode.reload()
    } catch (error) {
      setFeedback(errorText(error))
    } finally {
      setAction(false)
    }
  }

  const content = (
    <section
      className="customization-studio"
      hidden={!visible}
      aria-label="Life Customization Studio"
    >
      <aside className="studio-history" aria-label="Customization conversations">
        <div className="studio-history-heading">
          <Sparkles size={15} />
          <strong>{dialog ? 'Customizations' : 'Life Studio'}</strong>
        </div>
        <button className="button secondary studio-new" onClick={() => studio.newSession()}>
          <MessageSquarePlus size={14} /> New customization
        </button>
        <input
          className="studio-search"
          aria-label="Search customization conversations"
          placeholder="Search customizations…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="studio-session-list">
          {filtered.map((session) => (
            <button
              key={session.id}
              className={`studio-session${active?.id === session.id ? ' selected' : ''}`}
              aria-pressed={active?.id === session.id}
              onClick={() => studio.setActiveId(session.id)}
            >
              <ProviderIcon provider={session.thread.provider} size={14} brand />
              <span>
                <strong>{session.thread.title}</strong>
                <small>{stageNames[session.stage]}</small>
              </span>
              {session.thread.busy ? <LoaderCircle size={12} className="spinning" /> : null}
            </button>
          ))}
          {!filtered.length ? (
            <p className="studio-empty-search">No matching customizations.</p>
          ) : null}
        </div>
        <div className="studio-history-footer">
          <ShieldCheck size={13} />
          <span>Separate from project chats and Research.</span>
        </div>
      </aside>

      <div className="studio-conversation">
        <header className="studio-header">
          <div>
            <span className="studio-eyebrow">Customize your workspace</span>
            <h1>Make Life yours</h1>
          </div>
          <span className={`studio-status ${active?.stage || ''}`} role="status">
            {active?.thread.busy ? (
              <LoaderCircle size={12} className="spinning" />
            ) : (
              <Sparkles size={12} />
            )}
            {status}
          </span>
        </header>
        <div className="studio-conversation-scroll" ref={viewport}>
          {!active?.thread.messages.length ? (
            <div className="studio-welcome">
              <div className="studio-welcome-icon">
                <Wrench size={24} />
              </div>
              <h2>Describe a change to Life.</h2>
              <p>
                Change the interface, add a workflow, create a panel, or build a feature. Your
                customization has its own conversation, source changes, build results, and recovery
                history.
              </p>
              <div className="studio-workflow">
                <span>
                  <MessageSquarePlus size={14} /> Request
                </span>
                <span>
                  <Code2 size={14} /> Changes
                </span>
                <span>
                  <CheckCheck size={14} /> Build
                </span>
                <span>
                  <Puzzle size={14} /> Live extension
                </span>
              </div>
              <div className="studio-examples">
                {[
                  'Add a keyboard shortcut to switch projects',
                  'Make the workspace composer more compact',
                  'Add a panel showing my research milestones',
                ].map((example) => (
                  <button key={example} onClick={() => active && updateDraft(active.id, example)}>
                    {example}
                    <ArrowUp size={12} />
                  </button>
                ))}
              </div>
              <p className="studio-exact-message">
                Your message reaches the agent exactly as written. Life’s instructions and source
                context are provided through its dedicated instruction files.
              </p>
            </div>
          ) : active ? (
            <ThreadTimeline thread={active.thread} />
          ) : null}
          {active?.thread.pending.map((event) => (
            <ApprovalCard
              key={event.requestId}
              event={event}
              onRespond={(accepted, answers) => studio.respond(event, accepted, answers)}
            />
          ))}
          {review && active?.proposal ? (
            <section className="studio-review-card" aria-label="Customization proposal">
              <div>
                <Code2 size={16} />
                <strong>Ready to apply</strong>
                <span>
                  {active.proposal.kind === 'source'
                    ? 'Source extension'
                    : active.proposal.kind === 'settings'
                      ? 'Settings'
                      : 'Runtime extension'}
                </span>
              </div>
              <p>
                {active.proposal.message || 'Review the proposed changes in the Changes panel.'}
              </p>
              <div className="studio-review-actions">
                <button className="button secondary" onClick={() => setTab('changes')}>
                  Inspect changes
                </button>
                <button className="button secondary" onClick={studio.discardProposal}>
                  Discard proposal
                </button>
                <button className="button primary" onClick={() => void studio.applyProposal()}>
                  <Check size={13} /> Apply changes
                </button>
              </div>
            </section>
          ) : null}
        </div>
        <div className="studio-composer-area">
          {studio.notice ? (
            <p className="studio-notice" role="status">
              {studio.notice}
            </p>
          ) : null}
          {studio.feedback || feedback ? (
            <p className="form-error" role="alert">
              {studio.feedback || feedback}
            </p>
          ) : null}
          {!connected ? (
            <div className="studio-connection-notice">
              <span>
                Connect a machine for Codex or Claude Code. No project selection is needed.
              </span>
              <button className="button secondary" onClick={onConnect}>
                Connect
              </button>
            </div>
          ) : null}
          <form
            className="studio-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label className="sr-only" htmlFor="studio-request">
              Describe a Life customization
            </label>
            <textarea
              id="studio-request"
              value={draft}
              disabled={!active || applying}
              rows={3}
              placeholder="What would you like to change in Life?"
              onChange={(event) => active && updateDraft(active.id, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (!active?.thread.busy) void submit()
                }
              }}
            />
            <div className="studio-composer-bottom">
              {active ? (
                <ReferenceComposerControls
                  models={studio.models}
                  provider={active.thread.provider}
                  model={active.thread.model}
                  reasoningEffort={active.thread.reasoningEffort || ''}
                  serviceTier={active.thread.serviceTier || ''}
                  mode="plan"
                  modeDisabled
                  providerDisabled={Boolean(active.thread.busy || active.thread.remoteId)}
                  onChange={(patch) => studio.updateThread(patch)}
                  onProviderChange={(provider, model) =>
                    studio.updateThread({ provider, model, reasoningEffort: '', serviceTier: '' })
                  }
                />
              ) : null}
              {active?.thread.busy ? (
                <button
                  type="button"
                  className="studio-submit"
                  disabled={applying}
                  aria-label={applying ? 'Applying customization' : 'Stop customization'}
                  onClick={() => void studio.stop()}
                >
                  {applying ? (
                    <LoaderCircle size={16} className="spinning" />
                  ) : (
                    <Square size={14} />
                  )}
                </button>
              ) : (
                <button
                  className="studio-submit"
                  aria-label="Send customization request"
                  disabled={!draft.trim() || !active}
                >
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </form>
          <label className="studio-auto-apply">
            <input
              type="checkbox"
              checked={studio.autoApply}
              onChange={(event) => studio.setAutoApply(event.target.checked)}
            />
            <span>Apply valid changes automatically</span>
            <small>Turn off to review before applying.</small>
          </label>
        </div>
      </div>

      <aside className="studio-inspector" aria-label="Customization details">
        <nav className="studio-inspector-tabs" aria-label="Customization details views">
          {(['overview', 'changes', 'build', 'recovery'] as InspectorTab[]).map((item) => (
            <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>
              {item === 'overview'
                ? 'Details'
                : item === 'changes'
                  ? 'Changes'
                  : item === 'build'
                    ? 'Build'
                    : 'Recovery'}
            </button>
          ))}
        </nav>
        <div className="studio-inspector-scroll">
          {tab === 'overview' ? (
            <>
              <section className="studio-inspector-section">
                <h2>Conversation</h2>
                {active ? (
                  <>
                    <label>
                      Title
                      <input
                        aria-label="Customization title"
                        value={active.thread.title}
                        onChange={(event) => studio.rename(active.id, event.target.value)}
                      />
                    </label>
                    <dl>
                      <div>
                        <dt>Agent</dt>
                        <dd>{active.thread.provider === 'codex' ? 'Codex' : 'Claude Code'}</dd>
                      </div>
                      <div>
                        <dt>Environment</dt>
                        <dd>{connection.profile?.name || 'Not connected'}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{status}</dd>
                      </div>
                    </dl>
                    <button
                      className="button secondary"
                      onClick={() => download(`life-studio-${active.id}.json`, active)}
                    >
                      <Download size={13} /> Export conversation
                    </button>
                    <button
                      className="button secondary studio-remove-session"
                      disabled={active.thread.busy}
                      onClick={() => studio.remove(active.id)}
                    >
                      <Trash2 size={13} /> Remove conversation
                    </button>
                  </>
                ) : null}
              </section>
              <section className="studio-inspector-section">
                <h2>Life workspace</h2>
                <dl>
                  <div>
                    <dt>Source revision</dt>
                    <dd>{source.revision}</dd>
                  </div>
                  <div>
                    <dt>Runtime extensions</dt>
                    <dd>{runtimeCount} enabled</dd>
                  </div>
                  <div>
                    <dt>Source extensions</dt>
                    <dd>{sourceCount} enabled</dd>
                  </div>
                  <div>
                    <dt>Theme</dt>
                    <dd>{config.theme}</dd>
                  </div>
                </dl>
                <button className="button secondary" onClick={onOpenExtensions}>
                  <Puzzle size={13} /> Manage and share extensions
                </button>
                <button className="button secondary" onClick={onOpenSource}>
                  <Code2 size={13} /> Inspect Life source
                </button>
                <button className="button secondary" onClick={onOpenSettings}>
                  <Settings2 size={13} /> Settings
                </button>
              </section>
              <section className="studio-inspector-section studio-instruction-info">
                <h2>How requests run</h2>
                <p>
                  Project chats never customize Life. Studio uses an isolated environment with{' '}
                  <code>AGENTS.md</code> and structured source, settings, and capability files.
                </p>
                <p>
                  Source is compiled locally. Failed builds preserve the last working interface. The
                  agent can read additional source and repair actual build diagnostics.
                </p>
                <p>Public sharing is an explicit action in Manage extensions.</p>
              </section>
            </>
          ) : null}
          {tab === 'changes' ? (
            <section className="studio-inspector-section">
              <h2>Proposed changes</h2>
              {active?.proposal ? (
                <ProposalDetails proposal={active.proposal} />
              ) : (
                <p>
                  The agent’s settings, source files, dependencies, and extension code appear here
                  when it proposes a change.
                </p>
              )}
              {active?.changes?.length ? (
                <>
                  <h3>Changed files</h3>
                  {active.changes.map((path) => (
                    <p className="studio-changed-path" key={path}>
                      <FileCode2 size={12} />
                      <code>{path}</code>
                    </p>
                  ))}
                </>
              ) : null}
            </section>
          ) : null}
          {tab === 'build' ? (
            <section className="studio-inspector-section">
              <h2>Build and execution</h2>
              {history.length ? (
                history.map((message) => (
                  <div className="studio-build-entry" key={message.id}>
                    <strong>
                      {message.status === 'running' ? (
                        <LoaderCircle size={12} className="spinning" />
                      ) : message.status === 'failed' ? (
                        <Square size={12} />
                      ) : (
                        <Check size={12} />
                      )}
                      {message.title || 'Agent activity'}
                    </strong>
                    <pre>{message.text || 'No additional output.'}</pre>
                  </div>
                ))
              ) : (
                <p>
                  Source reads, compiler output, repairs, and completed changes will appear here.
                  Your complete conversation remains alongside this panel.
                </p>
              )}
              {source.error ? (
                <p className="form-error" role="alert">
                  {source.error}
                </p>
              ) : null}
            </section>
          ) : null}
          {tab === 'recovery' ? (
            <section className="studio-inspector-section">
              <h2>
                <History size={14} /> Recovery
              </h2>
              <p>
                Return to a working version whenever a customization causes a problem. Saved
                conversations and project histories stay available.
              </p>
              {source.recovered ? (
                <p className="studio-recovery-note">
                  Life recovered the built-in interface after a custom source failed during startup.
                </p>
              ) : null}
              <button
                className="button secondary"
                disabled={!api || action || !source.canRollback}
                onClick={() => void sourceAction('rollback')}
              >
                <RotateCcw size={13} /> Restore previous source
              </button>
              <button
                className="button secondary"
                disabled={!api || action || !source.enabled}
                onClick={() => void sourceAction('disable')}
              >
                Use built-in interface
              </button>
              <button className="button secondary" onClick={onOpenExtensions}>
                <Puzzle size={13} /> Disable or remove an extension
              </button>
              <p className="studio-rescue-shortcut">
                Emergency recovery: <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>L</kbd> (⌘ on macOS).
              </p>
            </section>
          ) : null}
        </div>
      </aside>
    </section>
  )
  return dialog ? (
    <Modal
      open={visible}
      onOpenChange={(open) => onOpenChange?.(open)}
      title="Customize Life"
      description="Describe a change, review the result, and customize your workspace."
      className="life-studio-dialog"
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (
          !document.querySelector('[role="dialog"][data-state="open"]:not(.life-studio-dialog)')
        ) {
          document.querySelector<HTMLButtonElement>('.titlebar-studio-toggle')?.focus()
        }
      }}
    >
      {content}
    </Modal>
  ) : (
    content
  )
}
