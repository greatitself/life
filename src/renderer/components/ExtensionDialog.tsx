import { useEffect, useState } from 'react'
import {
  Braces,
  Check,
  Code2,
  Download,
  FolderOpen,
  Puzzle,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import type { ConnectionState, Provider } from '../../shared/types'
import type { LifeExtensionManifest, LifeExtensionsSnapshot } from '../../shared/extensions'
import { extractExtensionManifest } from '../extension-prompts'
import { api, errorText } from '../api'
import { Modal } from './Modal'
import './extensions.css'

const emptySnapshot: LifeExtensionsSnapshot = {
  extensions: [],
  revision: 0,
  path: '',
  errors: {},
  canRollback: [],
  recovered: false,
}
export function ExtensionDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection: ConnectionState
  defaultProvider?: Provider
  onInstalled?: (manifest: LifeExtensionManifest) => void
}) {
  const [snapshot, setSnapshot] = useState<LifeExtensionsSnapshot>(emptySnapshot)
  const [tab, setTab] = useState<'installed' | 'source'>('installed')
  const [source, setSource] = useState('')
  const [mutating, setMutating] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)

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

  async function mutate(action: () => Promise<LifeExtensionsSnapshot>, success: string) {
    if (!api || mutating) return
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

  const busy = mutating
  const recoveryShortcut = api?.platform === 'darwin' ? '⌘+Shift+L' : 'Ctrl+Shift+L'
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Manage extensions"
      description="Use /life in any thread to change Life. Review, edit, or restore installed extensions here."
      className="extensions-modal"
    >
      <div className="extension-scope">
        <ShieldAlert size={18} />
        <p>
          Extensions can run local code with your user permissions. Press {recoveryShortcut} to
          disable extensions and return to Life if a change stops working.
        </p>
      </div>
      <div
        className="extension-tabs"
        role="tablist"
        aria-label="Extensions"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const tabs = ['installed', 'source'] as const
          const index = tabs.indexOf(tab)
          const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (index + 1) % 2]
          setTab(next)
          document.getElementById(`extension-tab-${next}`)?.focus()
        }}
      >
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
              <p>Ask Life to change itself in any thread, or import an extension’s source here.</p>
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
      {feedback ? (
        <div className={failed ? 'form-error' : 'form-success'} role={failed ? 'alert' : 'status'}>
          {feedback}
        </div>
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
