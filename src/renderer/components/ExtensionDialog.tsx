import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Braces,
  Check,
  Code2,
  Download,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Puzzle,
  RotateCcw,
  ShieldAlert,
  Square,
  Trash2,
} from 'lucide-react'
import type { AgentEvent, ConnectionState, Provider } from '../../shared/types'
import type { LifeExtensionManifest, LifeExtensionsSnapshot } from '../../shared/extensions'
import { buildExtensionPrompt, extractExtensionManifest } from '../extension-prompts'
import { api, errorText } from '../api'
import { ApprovalCard } from './MessageView'
import { Modal } from './Modal'
import { ProviderIcon } from './Icons'
import './extensions.css'

const emptySnapshot: LifeExtensionsSnapshot = {
  extensions: [],
  revision: 0,
  path: '',
  errors: {},
  canRollback: [],
  recovered: false,
}
const examples = [
  'Replace the workspace with an interactive experiment dashboard',
  'Add a literature tracker that saves papers to a local JSON file',
  'Add a panel with a button to run a local command and show its output',
]

export function ExtensionDialog({
  open,
  onOpenChange,
  connection,
  defaultProvider = 'codex',
  onInstalled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection: ConnectionState
  defaultProvider?: Provider
  onInstalled?: (manifest: LifeExtensionManifest) => void
}) {
  const [snapshot, setSnapshot] = useState<LifeExtensionsSnapshot>(emptySnapshot)
  const [tab, setTab] = useState<'prompt' | 'installed' | 'source'>('prompt')
  const [provider, setProvider] = useState<Provider>(defaultProvider)
  const [prompt, setPrompt] = useState('')
  const [source, setSource] = useState('')
  const [running, setRunning] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [output, setOutput] = useState('')
  const [pending, setPending] = useState<AgentEvent[]>([])
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const session = useRef<string | undefined>(undefined)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  const cancelRequest = useRef<(() => void) | undefined>(undefined)
  const generation = useRef(0)

  useEffect(() => {
    if (!open || !api) return
    let disposed = false
    api.extensions.get().then(
      (state) => {
        if (!disposed) setSnapshot(state)
      },
      (error) => {
        if (!disposed) {
          setFailed(true)
          setFeedback(errorText(error))
        }
      },
    )
    const unsubscribe = api.extensions.onState((state) => {
      if (!disposed) setSnapshot(state)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [open])

  useEffect(() => {
    if (open) return
    cancelRequest.current?.()
    if (session.current) void api?.agent.stop(session.current).catch(() => {})
  }, [open])

  useEffect(
    () => () => {
      generation.current++
      cleanup.current?.()
      cancelRequest.current?.()
      if (session.current) void api?.agent.dispose(session.current).catch(() => {})
    },
    [],
  )

  async function install(manifest: LifeExtensionManifest) {
    if (!api) throw new Error('Open Life on your computer to install executable extensions.')
    const state = await api.extensions.apply(manifest)
    setSnapshot(state)
    if (state.errors[manifest.id]) throw new Error(state.errors[manifest.id])
    const installed = state.extensions.find((item) => item.id === manifest.id) || manifest
    onInstalled?.(installed)
    setFeedback(
      `${manifest.name} ${installed.enabled ? 'is live' : 'was saved disabled'}. Its previous version can be restored from Installed.`,
    )
    setFailed(false)
  }

  async function create() {
    if (!prompt.trim() || running || mutating) return
    if (!api || connection.status !== 'connected') {
      setFailed(true)
      setFeedback(
        'Connect a machine with Codex or Claude Code to build an extension from your prompt.',
      )
      return
    }
    if (!(provider === 'codex' ? connection.codex : connection.claude)) {
      setFailed(true)
      setFeedback(
        `${provider === 'codex' ? 'Codex' : 'Claude Code'} is unavailable on the connected machine.`,
      )
      return
    }
    const run = ++generation.current
    const id = crypto.randomUUID()
    session.current = id
    setRunning(true)
    setFailed(false)
    setFeedback('')
    setOutput('')
    setPending([])
    const parts = new Map<string, string>()
    const response = new Promise<string>((resolve, reject) => {
      cancelRequest.current = () => reject(new Error('Extension generation stopped.'))
      cleanup.current = api!.onAgent((event) => {
        if (event.sessionId !== id || generation.current !== run) return
        if (event.type === 'text') {
          const key = event.itemId || 'response'
          parts.set(
            key,
            event.status === 'replace'
              ? event.text || ''
              : (parts.get(key) || '') + (event.text || ''),
          )
          const text = [...parts.values()].join('\n')
          if (text.length > 2_000_000) {
            reject(new Error('The extension response is too large. Ask for a smaller extension.'))
            void api!.agent.stop(id).catch(() => {})
            return
          }
          setOutput(text.length > 50000 ? `…${text.slice(-50000)}` : text)
        }
        if (event.type === 'approval' || event.type === 'question')
          setPending((items) => [
            ...items.filter((item) => item.requestId !== event.requestId),
            event,
          ])
        if (event.type === 'error')
          reject(new Error(event.text || 'The agent could not build this extension.'))
        if (event.type === 'complete') {
          if (event.status === 'interrupted') reject(new Error('Extension generation stopped.'))
          else resolve([...parts.values()].join('\n'))
        }
      })
    })
    // A provider can fail during startup before the event promise is awaited.
    void response.catch(() => {})
    try {
      await Promise.race([
        api.agent.start({
          sessionId: id,
          provider,
          mode: 'plan',
          prompt: buildExtensionPrompt(
            prompt.trim(),
            snapshot.extensions,
            api.extensions.capabilities,
          ),
        }),
        response.then(() => undefined),
      ])
      const text = await response
      if (generation.current !== run) return
      const proposal = extractExtensionManifest(text)
      if (!proposal.manifest) throw new Error(proposal.error || 'The agent returned no extension.')
      await install(proposal.manifest)
      setPrompt('')
    } catch (error) {
      if (generation.current === run) {
        setFailed(true)
        setFeedback(errorText(error))
      }
    } finally {
      cleanup.current?.()
      cleanup.current = undefined
      cancelRequest.current = undefined
      session.current = undefined
      void api.agent.dispose(id).catch(() => {})
      if (generation.current === run) {
        setRunning(false)
        setPending([])
      }
    }
  }

  async function mutate(action: () => Promise<LifeExtensionsSnapshot>, success: string) {
    if (!api || running || mutating) return
    setMutating(true)
    try {
      setSnapshot(await action())
      setFeedback(success)
      setFailed(false)
      setDeleting(undefined)
    } catch (error) {
      setFeedback(errorText(error))
      setFailed(true)
    } finally {
      setMutating(false)
    }
  }

  function edit(manifest: LifeExtensionManifest) {
    setSource(JSON.stringify(manifest, null, 2))
    setTab('source')
    setFeedback('')
  }

  function download(manifest: LifeExtensionManifest) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${manifest.id}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const busy = running || mutating
  const recoveryShortcut = api?.platform === 'darwin' ? '⌘+Shift+L' : 'Ctrl+Shift+L'
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Build Life by prompting"
      description="Change the interface, add capabilities, or replace the entire workspace with live code."
      className="extensions-modal"
    >
      <div className="extension-scope">
        <ShieldAlert size={18} />
        <p>
          Extensions can run local code with your user permissions. Describe changes you want Life
          to make; valid extensions install and reload immediately.
        </p>
      </div>
      <div
        className="extension-tabs"
        role="tablist"
        aria-label="Extensions"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const tabs = ['prompt', 'installed', 'source'] as const
          const index = tabs.indexOf(tab)
          const next =
            tabs[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? 2
                  : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3
            ]
          setTab(next)
          document.getElementById(`extension-tab-${next}`)?.focus()
        }}
      >
        <button
          id="extension-tab-prompt"
          role="tab"
          aria-controls="extension-panel-prompt"
          tabIndex={tab === 'prompt' ? 0 : -1}
          aria-selected={tab === 'prompt'}
          onClick={() => setTab('prompt')}
        >
          <Puzzle size={14} /> Prompt
        </button>
        <button
          id="extension-tab-installed"
          role="tab"
          aria-controls="extension-panel-installed"
          tabIndex={tab === 'installed' ? 0 : -1}
          aria-selected={tab === 'installed'}
          onClick={() => setTab('installed')}
        >
          <Check size={14} /> Installed <span>{snapshot.extensions.length}</span>
        </button>
        <button
          id="extension-tab-source"
          role="tab"
          aria-controls="extension-panel-source"
          tabIndex={tab === 'source' ? 0 : -1}
          aria-selected={tab === 'source'}
          onClick={() => setTab('source')}
        >
          <Braces size={14} /> Source
        </button>
      </div>
      {tab === 'prompt' ? (
        <div
          id="extension-panel-prompt"
          aria-labelledby="extension-tab-prompt"
          className="extension-tab-content"
          role="tabpanel"
        >
          <div className="extension-examples">
            {examples.map((example) => (
              <button key={example} disabled={busy} onClick={() => setPrompt(example)}>
                {example}
              </button>
            ))}
          </div>
          <form
            className="extension-builder"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <textarea
              aria-label="Describe a Life extension"
              placeholder="Make Life do anything you need…"
              value={prompt}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
            />
            <div className="extension-builder-toolbar">
              <label>
                <ProviderIcon provider={provider} size={16} />
                <select
                  aria-label="Extension coding agent"
                  value={provider}
                  disabled={busy}
                  onChange={(event) => setProvider(event.target.value as Provider)}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude Code</option>
                </select>
              </label>
              <span>
                {connection.status === 'connected'
                  ? 'Generates code through your connected agent'
                  : 'Connect a machine to build from a prompt'}
              </span>
              {running ? (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    cancelRequest.current?.()
                    if (session.current) void api?.agent.stop(session.current).catch(() => {})
                  }}
                >
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button type="submit" className="button primary" disabled={busy || !prompt.trim()}>
                  <ArrowUp size={15} /> Build & apply
                </button>
              )}
            </div>
          </form>
          <p className="extension-caption">
            Panels extend your workspace. Views add a new destination. Replacements take over the
            interface, with a recovery button and {recoveryShortcut} to return to Life.
          </p>
        </div>
      ) : null}
      {tab === 'installed' ? (
        <div
          id="extension-panel-installed"
          aria-labelledby="extension-tab-installed"
          className="extension-tab-content"
          role="tabpanel"
        >
          {snapshot.recovered ? (
            <div className="extension-recovery-note">
              Life disabled extensions after an interrupted startup. Enable them individually when
              you are ready.
            </div>
          ) : null}
          {!snapshot.extensions.length ? (
            <div className="extensions-empty">
              <Puzzle size={24} />
              <strong>A workspace that can grow with you.</strong>
              <p>Build your first extension from a prompt, or import its source.</p>
            </div>
          ) : (
            <div className="extension-list">
              {snapshot.extensions.map((manifest) => (
                <article className="extension-card" key={manifest.id}>
                  <div className="extension-card-heading">
                    <Code2 size={18} />
                    <div>
                      <h3>{manifest.name}</h3>
                      <span>
                        {manifest.renderer.placement} · v{manifest.version}
                        {manifest.main ? ' · local code' : ''}
                      </span>
                    </div>
                    <label className="extension-toggle">
                      <input
                        type="checkbox"
                        aria-label={`Enable ${manifest.name}`}
                        checked={manifest.enabled}
                        disabled={busy || !api}
                        onChange={(event) =>
                          void mutate(
                            () => api!.extensions.enable(manifest.id, event.target.checked),
                            `${manifest.name} ${event.target.checked ? 'enabled' : 'disabled'}.`,
                          )
                        }
                      />
                      <span>{manifest.enabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                  </div>
                  {manifest.description ? <p>{manifest.description}</p> : null}
                  {snapshot.errors[manifest.id] ? (
                    <div className="form-error" role="alert">
                      {snapshot.errors[manifest.id]}
                    </div>
                  ) : null}
                  <div className="extension-card-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        setPrompt(`Update the existing extension "${manifest.id}": `)
                        setTab('prompt')
                      }}
                    >
                      <Pencil size={12} /> Modify by prompt
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => edit(manifest)}
                    >
                      <Braces size={12} /> Edit code
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Export ${manifest.name}`}
                      onClick={() => download(manifest)}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Restore previous ${manifest.name}`}
                      disabled={busy || !api || !snapshot.canRollback.includes(manifest.id)}
                      onClick={() =>
                        void mutate(
                          () => api!.extensions.rollback(manifest.id),
                          `Previous ${manifest.name} restored.`,
                        )
                      }
                    >
                      <RotateCcw size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${manifest.name}`}
                      disabled={busy || !api}
                      onClick={() =>
                        setDeleting(deleting === manifest.id ? undefined : manifest.id)
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {deleting === manifest.id ? (
                    <div className="extension-delete-confirm">
                      <span>Remove {manifest.name} and its saved versions?</span>
                      <button className="button secondary" onClick={() => setDeleting(undefined)}>
                        Keep
                      </button>
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () => api!.extensions.remove(manifest.id),
                            `${manifest.name} removed.`,
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {tab === 'source' ? (
        <form
          className="extension-tab-content extension-source"
          id="extension-panel-source"
          aria-labelledby="extension-tab-source"
          role="tabpanel"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy) return
            const result = extractExtensionManifest(`<life-extension>${source}</life-extension>`)
            if (!result.manifest) {
              setFailed(true)
              setFeedback(result.error || 'Enter a valid extension manifest.')
              return
            }
            setMutating(true)
            void install(result.manifest)
              .catch((error) => {
                setFailed(true)
                setFeedback(errorText(error))
              })
              .finally(() => setMutating(false))
          }}
        >
          <label htmlFor="life-extension-source">Extension manifest</label>
          <textarea
            id="life-extension-source"
            value={source}
            disabled={busy}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
            rows={14}
            placeholder={
              '{"id":"my-extension","name":"My extension","description":"…","version":"1.0.0","enabled":true,"renderer":{"placement":"view","html":"…","css":"…","js":"…"},"main":"…"}'
            }
          />
          <div className="extension-source-footer">
            <span>HTML, CSS, JavaScript, and optional Node.js runtime code.</span>
            <button
              className="button primary"
              type="submit"
              disabled={busy || !source.trim() || !api}
            >
              <Check size={14} /> Apply source
            </button>
          </div>
        </form>
      ) : null}
      {running ? (
        <div className="extension-progress" role="status">
          <LoaderCircle size={15} className="spinning" /> Your agent is building the extension…
        </div>
      ) : null}
      {pending.map((event) => (
        <ApprovalCard
          key={event.requestId}
          event={event}
          onRespond={async (accepted, answers) => {
            if (session.current && api) {
              await api.agent.respond(session.current, event.requestId!, accepted, answers)
              setPending((items) => items.filter((item) => item.requestId !== event.requestId))
            }
          }}
        />
      ))}
      {feedback ? (
        <div className={failed ? 'form-error' : 'form-success'} role={failed ? 'alert' : 'status'}>
          {feedback}
        </div>
      ) : null}
      {output ? (
        <details className="extension-output">
          <summary>Generated code</summary>
          <pre>{output}</pre>
        </details>
      ) : null}
      <div className="extension-footer">
        <code>{snapshot.path || 'Extensions are stored in Life’s app data folder'}</code>
        <button
          className="button secondary"
          disabled={!api}
          onClick={() => {
            void api?.extensions.openFolder().catch((error) => {
              setFailed(true)
              setFeedback(errorText(error))
            })
          }}
        >
          <FolderOpen size={13} /> Open folder
        </button>
      </div>
    </Modal>
  )
}
