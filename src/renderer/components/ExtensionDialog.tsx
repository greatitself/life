import { useEffect, useRef, useState } from 'react'
import {
  Braces,
  Check,
  Code2,
  Download,
  FileCode2,
  FolderOpen,
  Globe,
  LoaderCircle,
  PackagePlus,
  Puzzle,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react'
import type { ConnectionState, Provider } from '../../shared/types'
import type { LifeExtensionManifest, LifeExtensionsSnapshot } from '../../shared/extensions'
import { parseExtensionManifest } from '../../shared/extensions'
import type { LifeSourceSnapshot } from '../../shared/source-code'
import { parseSourceExtensionBundle } from '../../shared/source-extensions'
import type { LifePortableExtension } from '../../shared/extension-sharing'
import {
  buildRuntimePortableExtension,
  buildSourcePortableExtension,
  parsePortableExtension,
  PORTABLE_EXTENSION_MAX_BYTES,
  serializePortableExtension,
} from '../../shared/extension-sharing'
import { api, errorText } from '../api'
import { Modal } from './Modal'
import { ExtensionBundlePreview, ShareExtensionDialog } from './ShareExtensionDialog'
import { deleteBuiltinExtension, setBuiltinEnabled, useBuiltinFeature } from '../builtin-extensions'
import { relatedBuiltinExtensions } from '../../shared/builtin-extensions'
import './extensions.css'

const emptySnapshot: LifeExtensionsSnapshot = {
  extensions: [],
  revision: 0,
  path: '',
  errors: {},
  canRollback: [],
  recovered: false,
}
const tabs = ['installed', 'source', 'import'] as const
type Tab = (typeof tabs)[number]

function parseImport(text: string): LifePortableExtension {
  if (new TextEncoder().encode(text).byteLength > PORTABLE_EXTENSION_MAX_BYTES)
    throw new Error('An extension file must be smaller than 8 MB.')
  const value = JSON.parse(text)
  const bundle =
    value?.format === 'life-extension'
      ? parsePortableExtension(value)
      : value?.format === 'life-source-extension'
        ? buildSourcePortableExtension(parseSourceExtensionBundle(value))
        : buildRuntimePortableExtension(parseExtensionManifest(value))
  // Validate the exact portable payload before it reaches a preview or publication.
  serializePortableExtension(bundle)
  return bundle
}

function download(bundle: LifePortableExtension) {
  const url = URL.createObjectURL(
    new Blob([serializePortableExtension(bundle)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${bundle.extension.id}.life-extension.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type ExtensionBackup = {
  format: 'life-extension-backup'
  formatVersion: 1
  exportedAt: string
  runtime: {
    snapshot: LifeExtensionsSnapshot
    extensions: LifePortableExtension[]
  }
  source: {
    snapshot: LifeSourceSnapshot | undefined
    extensions: Array<{
      id: string
      enabled: boolean
      incorporated?: boolean
      error?: string
      bundle: LifePortableExtension
    }>
  }
}

function downloadBackup(backup: ExtensionBackup) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `life-extension-backup-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  const backupEnabled = useBuiltinFeature('extension-backups')
  const [snapshot, setSnapshot] = useState<LifeExtensionsSnapshot>(emptySnapshot)
  const [sourceSnapshot, setSourceSnapshot] = useState<LifeSourceSnapshot | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('installed')
  const [source, setSource] = useState('')
  const [editingSourceId, setEditingSourceId] = useState<string | undefined>(undefined)
  const [importSource, setImportSource] = useState('')
  const [publicLink, setPublicLink] = useState('')
  const [importPreview, setImportPreview] = useState<LifePortableExtension | undefined>(undefined)
  const [sharing, setSharing] = useState<LifePortableExtension | undefined>(undefined)
  const [mutating, setMutating] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const mutation = useRef(false)
  const previewRequest = useRef(0)

  useEffect(() => {
    if (!open || !api) return
    let disposed = false
    void Promise.allSettled([api.extensions.get(), api.sourceCode.get()]).then((results) => {
      if (disposed) return
      const [runtime, source] = results
      if (runtime.status === 'fulfilled') setSnapshot(runtime.value)
      if (source.status === 'fulfilled') setSourceSnapshot(source.value)
      for (const result of results) {
        if (result.status === 'rejected') {
          setFailed(true)
          setFeedback(errorText(result.reason))
        }
      }
    })
    const unsubscribe = api.extensions.onState((state) => {
      if (!disposed) setSnapshot(state)
    })
    const unsubscribeSource = api.sourceCode.onState((state) => {
      if (!disposed) setSourceSnapshot(state)
    })
    return () => {
      disposed = true
      previewRequest.current++
      unsubscribe()
      unsubscribeSource()
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setSharing(undefined)
      setPreviewing(false)
    }
  }, [open])

  function fail(error: unknown) {
    setFeedback(errorText(error))
    setFailed(true)
  }

  async function run(action: () => Promise<void>) {
    if (mutation.current) return
    mutation.current = true
    setMutating(true)
    setFeedback('')
    try {
      await action()
      setFailed(false)
      setDeleting(undefined)
    } catch (error) {
      fail(error)
    } finally {
      mutation.current = false
      setMutating(false)
    }
  }

  async function installRuntime(manifest: LifeExtensionManifest) {
    if (!api) throw new Error('Open Life on your computer to install executable extensions.')
    const state = await api.extensions.apply(manifest)
    setSnapshot(state)
    if (state.errors[manifest.id]) throw new Error(state.errors[manifest.id])
    const installed = state.extensions.find((item) => item.id === manifest.id) || manifest
    onInstalled?.(installed)
    setFeedback(
      `${manifest.name} ${installed.enabled ? 'is live' : 'was saved disabled'}. Its previous version can be restored from Installed.`,
    )
  }

  async function changeSource(action: () => Promise<LifeSourceSnapshot>) {
    if (!api) throw new Error('Open Life on your computer to compile interface extensions.')
    setSourceSnapshot(await action())
    await api.sourceCode.reload()
    onOpenChange(false)
  }

  async function install(bundle: LifePortableExtension) {
    if (bundle.kind === 'runtime') {
      await installRuntime(bundle.extension)
      setImportPreview(undefined)
    } else {
      await changeSource(() => api!.sourceCode.importExtension(bundle.extension))
    }
  }

  async function applyEditor(bundle: LifePortableExtension) {
    if (!editingSourceId) return install(bundle)
    if (bundle.kind !== 'source' || bundle.extension.id !== editingSourceId) {
      throw new Error(
        `This editor is updating ${editingSourceId}. Keep its ID, or cancel editing to install a different extension.`,
      )
    }
    await changeSource(() => api!.sourceCode.updateExtension(bundle.extension))
  }

  async function mutateRuntime(
    action: () => Promise<LifeExtensionsSnapshot>,
    success: string,
    id?: string,
  ) {
    const state = await action()
    setSnapshot(state)
    if (id && state.errors[id]) throw new Error(state.errors[id])
    setFeedback(success)
  }

  function edit(manifest: LifeExtensionManifest) {
    setEditingSourceId(undefined)
    setSource(JSON.stringify(manifest, null, 2))
    setTab('source')
    setFeedback('')
  }

  async function sourceBundle(id: string) {
    if (!api) throw new Error('Open Life on your computer to export interface extensions.')
    const bundle = buildSourcePortableExtension(await api.sourceCode.exportExtension(id))
    serializePortableExtension(bundle)
    return bundle
  }

  function previewText(text: string) {
    previewRequest.current++
    setPreviewing(false)
    try {
      setImportPreview(parseImport(text))
      setFeedback('Review the code below, then install it when you are ready.')
      setFailed(false)
    } catch (error) {
      setImportPreview(undefined)
      fail(error)
    }
  }

  async function previewPublic() {
    if (!api || !publicLink.trim() || previewing) return
    const generation = ++previewRequest.current
    setPreviewing(true)
    setImportPreview(undefined)
    setFeedback('')
    try {
      const result = await api.extensionSharing.inspectPublic(publicLink.trim())
      if (generation !== previewRequest.current) return
      const bundle = parsePortableExtension(result.bundle)
      serializePortableExtension(bundle)
      setImportPreview(bundle)
      setFailed(false)
      setFeedback('Public extension loaded for review. Nothing has been installed.')
    } catch (error) {
      if (generation === previewRequest.current) fail(error)
    } finally {
      if (generation === previewRequest.current) setPreviewing(false)
    }
  }

  async function readImportFile(file: File | undefined) {
    if (!file) return
    const generation = ++previewRequest.current
    setPreviewing(true)
    setImportPreview(undefined)
    try {
      if (file.size > PORTABLE_EXTENSION_MAX_BYTES)
        throw new Error('An extension file must be smaller than 8 MB.')
      const text = await file.text()
      if (generation !== previewRequest.current) return
      setImportSource(text)
      previewText(text)
    } catch (error) {
      if (generation === previewRequest.current) fail(error)
    } finally {
      if (generation === previewRequest.current) setPreviewing(false)
    }
  }

  const allSourceExtensions = sourceSnapshot?.extensions || []
  const sourceExtensions = allSourceExtensions.filter((extension) => !extension.builtIn)
  const builtinExtensions = allSourceExtensions.filter(
    (extension) => extension.builtIn && !extension.deleted,
  )
  const deletedBuiltins = allSourceExtensions.filter(
    (extension) => extension.builtIn && extension.deleted,
  )
  const builtinOriginalIds = new Set(
    allSourceExtensions
      .filter((extension) => extension.builtIn)
      .map((extension) => extension.originalId),
  )
  const visibleSourceExtensions = sourceExtensions.filter(
    (extension) => !extension.incorporated || !builtinOriginalIds.has(extension.id),
  )
  const featureEnabled = (extension: LifeSourceSnapshot['extensions'][number]) => extension.enabled

  async function changeBuiltin(action: () => Promise<LifeSourceSnapshot>) {
    setSourceSnapshot(await action())
    setFeedback(
      'Built-in feature choices are live and saved for the next startup. Conversations and project files are preserved.',
    )
  }

  async function exportAllExtensions() {
    if (!backupEnabled) return
    if (!api) throw new Error('Open Life on your computer to export extensions.')
    const source = await Promise.all(
      sourceExtensions.map(async (extension) => ({
        id: extension.id,
        enabled: extension.enabled,
        ...(extension.incorporated ? { incorporated: true } : {}),
        ...(extension.error ? { error: extension.error } : {}),
        bundle: await sourceBundle(extension.id),
      })),
    )
    const runtime = snapshot.extensions.map(buildRuntimePortableExtension)
    downloadBackup({
      format: 'life-extension-backup',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      runtime: { snapshot, extensions: runtime },
      source: { snapshot: sourceSnapshot, extensions: source },
    })
    setFeedback(
      `Exported ${runtime.length + source.length} extensions with their manifests, source files, dependencies, timestamps, enabled states, and saved snapshot details.`,
    )
  }

  const sourcePaused =
    sourceSnapshot !== undefined &&
    !sourceSnapshot.enabled &&
    sourceExtensions.some((extension) => extension.enabled)
  const count =
    snapshot.extensions.length + visibleSourceExtensions.length + builtinExtensions.length
  const busy = mutating
  const recoveryShortcut = api?.platform === 'darwin' ? '⌘+Shift+L' : 'Ctrl+Shift+L'
  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="Manage extensions"
        description="Enable, disable, delete, export, or share extensions, including features built into Life."
        className="extensions-modal"
      >
        <div className="extension-scope">
          <ShieldAlert size={18} />
          <p>
            Extensions run code with your user permissions. Press {recoveryShortcut} to disable
            extensions and return to Life if a change stops working.
          </p>
        </div>
        <div
          className="extension-tabs"
          role="tablist"
          aria-label="Extensions"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = tabs.indexOf(tab)
            const position =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length
            const next = tabs[position]
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
            <Check size={14} /> Installed <span>{count}</span>
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
          <button
            id="extension-tab-import"
            role="tab"
            aria-controls="extension-panel-import"
            tabIndex={tab === 'import' ? 0 : -1}
            aria-selected={tab === 'import'}
            onClick={() => setTab('import')}
          >
            <Upload size={14} /> Import
          </button>
        </div>
        {tab === 'installed' ? (
          <div
            id="extension-panel-installed"
            aria-labelledby="extension-tab-installed"
            className="extension-tab-content"
            role="tabpanel"
          >
            {snapshot.recovered || sourceSnapshot?.recovered ? (
              <div className="extension-recovery-note">
                Life restored its built-in interface after an interrupted startup. Review the saved
                source changes and enable runtime extensions when you are ready.
              </div>
            ) : null}
            {sourcePaused ? (
              <div className="extension-recovery-note">
                Source changes are paused. Their saved enable choices are shown below; compiling a
                change applies those choices again.
              </div>
            ) : null}
            {sourceSnapshot?.builtInError ? (
              <div className="form-error" role="alert">
                {sourceSnapshot.builtInError}
              </div>
            ) : null}
            {backupEnabled ? (
              <div className="extension-card-actions">
                <button
                  className="button secondary"
                  disabled={busy || !api}
                  onClick={() => void run(exportAllExtensions)}
                  title="Download every installed runtime and source extension, including full source payloads and saved state"
                >
                  <Download size={13} /> Export all extensions
                </button>
              </div>
            ) : null}
            {!count && !deletedBuiltins.length ? (
              <div className="extensions-empty">
                <Puzzle size={24} />
                <strong>A workspace that can grow with you.</strong>
                <p>Open Life Studio to change the application, or import an extension here.</p>
              </div>
            ) : (
              <div className="extension-list">
                {builtinExtensions.map((extension) => {
                  const archive = sourceExtensions.find(
                    (candidate) => candidate.id === extension.originalId && candidate.incorporated,
                  )
                  const related = relatedBuiltinExtensions(extension.id)
                  const disabledRelated = related.filter((candidate) =>
                    allSourceExtensions.some(
                      (state) => state.id === candidate.id && (!state.enabled || state.deleted),
                    ),
                  )
                  return (
                    <article
                      className="extension-card"
                      key={extension.id}
                      data-extension-kind="built-in"
                      data-extension-id={extension.id}
                    >
                      <div className="extension-card-heading">
                        <Puzzle size={18} />
                        <div>
                          <h3>{extension.name}</h3>
                          <span>Built into Life · v{extension.version}</span>
                        </div>
                        <label className="extension-toggle">
                          <input
                            type="checkbox"
                            aria-label={`Enable ${extension.name}`}
                            checked={extension.enabled}
                            disabled={busy || !api}
                            onChange={(event) => {
                              const enabled = event.target.checked
                              void run(() =>
                                changeBuiltin(() =>
                                  setBuiltinEnabled(api!.sourceCode, extension.id, enabled),
                                ),
                              )
                            }}
                          />
                          <span>{extension.enabled ? 'Enabled' : 'Disabled'}</span>
                        </label>
                      </div>
                      <p>{extension.effect}</p>
                      {extension.enabled && disabledRelated.length ? (
                        <p className="extension-recovery-note">
                          Shared features are paused while a related built-in extension is disabled
                          or deleted. Enable its related extensions to restore every shared feature.
                        </p>
                      ) : null}
                      <details className="extension-change-summary">
                        <summary>Features, original identity, and shared dependencies</summary>
                        <p>
                          <code>{extension.originalId}</code>
                        </p>
                        <p>{extension.description}</p>
                        <ul>
                          {extension.features?.map((feature) => (
                            <li key={feature}>{feature}</li>
                          ))}
                        </ul>
                        {related.length ? (
                          <>
                            <p>
                              These original changes overlap. A shared feature runs only when every
                              related extension that owns it is enabled.
                            </p>
                            <ul>
                              {related.map((candidate) => (
                                <li key={candidate.id}>{candidate.name}</li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        <p>
                          Turning a feature off stops its optional behavior. Historical messages,
                          saved attachments, drafts, and research files remain available for
                          recovery. Core provider settings, steering, and thread continuity remain
                          available.
                        </p>
                      </details>
                      <div className="extension-card-actions">
                        {archive ? (
                          <>
                            <button
                              className="icon-button"
                              aria-label={`Export ${extension.name}`}
                              disabled={busy || !api}
                              onClick={() =>
                                void run(async () => download(await sourceBundle(archive.id)))
                              }
                            >
                              <Download size={14} />
                            </button>
                            <button
                              className="button secondary extension-share-action"
                              aria-label={`Share ${extension.name} publicly`}
                              disabled={busy || !api}
                              onClick={() =>
                                void run(async () => setSharing(await sourceBundle(archive.id)))
                              }
                            >
                              <Globe size={12} /> Share original source
                            </button>
                          </>
                        ) : null}
                        <button
                          className="icon-button"
                          aria-label={`Delete ${extension.name}`}
                          disabled={busy || !api}
                          onClick={() =>
                            setDeleting(deleting === extension.id ? undefined : extension.id)
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {deleting === extension.id ? (
                        <div className="extension-delete-confirm">
                          <span>
                            Delete {extension.name}? Its features will remain off after restart and
                            its installed record will be removed. Life saves a private
                            feature-choice recovery copy before deletion. Project files and
                            conversations are preserved.
                          </span>
                          <button
                            className="button secondary"
                            onClick={() => setDeleting(undefined)}
                          >
                            Keep
                          </button>
                          <button
                            className="button primary"
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                changeBuiltin(() =>
                                  deleteBuiltinExtension(api!.sourceCode, extension.id),
                                ),
                              )
                            }
                          >
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </article>
                  )
                })}
                {deletedBuiltins.length ? (
                  <details className="extension-card">
                    <summary>Deleted built-ins · {deletedBuiltins.length}</summary>
                    <p>
                      These features stay disabled after restart. Restore a record and its feature
                      choice without changing any project data.
                    </p>
                    {deletedBuiltins.map((extension) => (
                      <div className="extension-card-actions" key={extension.id}>
                        <span>{extension.name}</span>
                        <button
                          className="button secondary"
                          disabled={busy || !api}
                          onClick={() =>
                            void run(() =>
                              changeBuiltin(() =>
                                setBuiltinEnabled(api!.sourceCode, extension.id, true),
                              ),
                            )
                          }
                        >
                          <RotateCcw size={13} /> Restore
                        </button>
                      </div>
                    ))}
                  </details>
                ) : null}
                {visibleSourceExtensions.map((extension) => (
                  <article
                    className="extension-card"
                    key={`source:${extension.id}`}
                    data-extension-kind="source"
                    data-extension-id={extension.id}
                  >
                    <div className="extension-card-heading">
                      <FileCode2 size={18} />
                      <div>
                        <h3>{extension.name}</h3>
                        <span>
                          Interface source · {extension.files.length}{' '}
                          {extension.files.length === 1 ? 'file' : 'files'} · v{extension.version}
                        </span>
                      </div>
                      <label className="extension-toggle">
                        <input
                          type="checkbox"
                          aria-label={`Enable ${extension.name}`}
                          checked={featureEnabled(extension)}
                          disabled={busy || !api || extension.incorporated}
                          title={
                            extension.incorporated
                              ? 'Enable or disable these built-in changes.'
                              : undefined
                          }
                          onChange={(event) => {
                            const enabled = event.target.checked
                            void run(() =>
                              changeSource(() =>
                                api!.sourceCode.setExtensionEnabled(extension.id, enabled),
                              ),
                            )
                          }}
                        />
                        <span>
                          {extension.incorporated
                            ? featureEnabled(extension)
                              ? 'Enabled · built-in'
                              : sourcePaused
                                ? 'Disable paused'
                                : 'Disabled · built-in'
                            : extension.enabled
                              ? sourcePaused
                                ? 'Paused'
                                : 'Enabled'
                              : 'Disabled'}
                        </span>
                      </label>
                    </div>
                    {extension.description ? <p>{extension.description}</p> : null}
                    {extension.incorporated ? (
                      <p>
                        Original source retained for export and sharing. Manage its feature choices
                        in the built-in card above.
                      </p>
                    ) : null}
                    <details className="extension-change-summary">
                      <summary>Changed files and dependencies</summary>
                      <ul>
                        {extension.files.map((path) => (
                          <li key={path}>
                            <code>{path}</code>
                          </li>
                        ))}
                      </ul>
                      {Object.entries(extension.dependencies).map(([name, version]) => (
                        <code className="extension-dependency" key={name}>
                          {name}@{version}
                        </code>
                      ))}
                    </details>
                    {extension.error ? (
                      <div className="form-error" role="alert">
                        {extension.error}
                      </div>
                    ) : null}
                    <div className="extension-card-actions">
                      <button
                        className="button secondary"
                        disabled={busy || !api || extension.incorporated}
                        onClick={() =>
                          void run(async () => {
                            const bundle = await sourceBundle(extension.id)
                            // A legacy saved source ID can collide with a new native feature.
                            // Edit its safe routing alias; untouched exports retain the original ID.
                            if (
                              extension.originalId &&
                              !extension.incorporated &&
                              bundle.kind === 'source'
                            )
                              bundle.extension.id = extension.id
                            setSource(serializePortableExtension(bundle))
                            setEditingSourceId(extension.id)
                            setImportPreview(undefined)
                            setTab('source')
                          })
                        }
                        title={
                          extension.incorporated
                            ? 'Create a new extension to change the built-in interface.'
                            : undefined
                        }
                      >
                        <Braces size={12} /> Edit code
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Export ${extension.name}`}
                        disabled={busy || !api}
                        onClick={() =>
                          void run(async () => download(await sourceBundle(extension.id)))
                        }
                      >
                        <Download size={14} />
                      </button>
                      <button
                        className="button secondary extension-share-action"
                        aria-label={`Share ${extension.name} publicly`}
                        disabled={busy || !api}
                        onClick={() =>
                          void run(async () => setSharing(await sourceBundle(extension.id)))
                        }
                      >
                        <Globe size={12} /> Share publicly
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete ${extension.name}`}
                        disabled={busy || !api}
                        onClick={() =>
                          setDeleting(
                            deleting === `source:${extension.id}`
                              ? undefined
                              : `source:${extension.id}`,
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {deleting === `source:${extension.id}` ? (
                      <div className="extension-delete-confirm">
                        <span>
                          {extension.incorporated
                            ? `Remove the original ${extension.name} source archive? Its built-in feature choice is managed separately.`
                            : `Remove ${extension.name} and compile the remaining extensions?`}
                        </span>
                        <button className="button secondary" onClick={() => setDeleting(undefined)}>
                          Keep
                        </button>
                        <button
                          className="button primary"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              changeSource(() => api!.sourceCode.removeExtension(extension.id)),
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
                {snapshot.extensions.map((manifest) => (
                  <article
                    className="extension-card"
                    key={`runtime:${manifest.id}`}
                    data-extension-kind="runtime"
                    data-extension-id={manifest.id}
                  >
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
                          onChange={(event) => {
                            const enabled = event.target.checked
                            void run(() =>
                              mutateRuntime(
                                () => api!.extensions.enable(manifest.id, enabled),
                                `${manifest.name} ${enabled ? 'enabled' : 'disabled'}.`,
                                manifest.id,
                              ),
                            )
                          }}
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
                        onClick={() => download(buildRuntimePortableExtension(manifest))}
                      >
                        <Download size={14} />
                      </button>
                      <button
                        className="button secondary extension-share-action"
                        aria-label={`Share ${manifest.name} publicly`}
                        disabled={busy || !api}
                        onClick={() => setSharing(buildRuntimePortableExtension(manifest))}
                      >
                        <Globe size={12} /> Share publicly
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Restore previous ${manifest.name}`}
                        disabled={busy || !api || !snapshot.canRollback.includes(manifest.id)}
                        onClick={() =>
                          void run(() =>
                            mutateRuntime(
                              () => api!.extensions.rollback(manifest.id),
                              `Previous ${manifest.name} restored.`,
                              manifest.id,
                            ),
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
                          setDeleting(
                            deleting === `runtime:${manifest.id}`
                              ? undefined
                              : `runtime:${manifest.id}`,
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {deleting === `runtime:${manifest.id}` ? (
                      <div className="extension-delete-confirm">
                        <span>Remove {manifest.name} and its saved versions?</span>
                        <button className="button secondary" onClick={() => setDeleting(undefined)}>
                          Keep
                        </button>
                        <button
                          className="button primary"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              mutateRuntime(
                                () => api!.extensions.remove(manifest.id),
                                `${manifest.name} removed.`,
                              ),
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
              try {
                const bundle = parseImport(source)
                void run(() => applyEditor(bundle))
              } catch (error) {
                fail(error)
              }
            }}
          >
            {editingSourceId ? (
              <div className="extension-editor-selection">
                <span>
                  Editing{' '}
                  <strong>
                    {sourceExtensions.find((extension) => extension.id === editingSourceId)?.name ||
                      editingSourceId}
                  </strong>
                  . Edit the file content fields; Life recalculates merge patches when compiling and
                  keeps the other installed changes.
                </span>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditingSourceId(undefined)
                    setSource('')
                    setFeedback('')
                  }}
                >
                  Cancel edit
                </button>
              </div>
            ) : null}
            <label htmlFor="life-extension-source">Extension manifest</label>
            <textarea
              id="life-extension-source"
              value={source}
              disabled={busy}
              onChange={(event) => setSource(event.target.value)}
              spellCheck={false}
              rows={14}
              placeholder="Paste a runtime manifest or a portable source extension…"
            />
            <div className="extension-source-footer">
              <span>Interface source compiles locally. Runtime extensions apply immediately.</span>
              <button
                className="button primary"
                type="submit"
                disabled={busy || !source.trim() || !api}
              >
                {busy ? <LoaderCircle size={14} className="spinning" /> : <Check size={14} />}
                Apply source
              </button>
            </div>
          </form>
        ) : null}
        {tab === 'import' ? (
          <div
            className="extension-tab-content extension-import"
            id="extension-panel-import"
            aria-labelledby="extension-tab-import"
            role="tabpanel"
          >
            <div className="extension-import-file">
              <Upload size={18} />
              <div>
                <label htmlFor="life-extension-file">Extension file</label>
                <span>
                  Import a portable Life extension. The code is shown before installation.
                </span>
              </div>
              <input
                id="life-extension-file"
                type="file"
                accept=".json,.life-extension,application/json"
                disabled={busy}
                onChange={(event) => void readImportFile(event.target.files?.[0])}
              />
            </div>
            <form
              className="extension-public-import"
              onSubmit={(event) => {
                event.preventDefault()
                void previewPublic()
              }}
            >
              <label htmlFor="life-extension-public-link">Public extension link</label>
              <div>
                <input
                  id="life-extension-public-link"
                  value={publicLink}
                  onChange={(event) => {
                    previewRequest.current++
                    setPreviewing(false)
                    setPublicLink(event.target.value)
                    setImportPreview(undefined)
                  }}
                  disabled={busy}
                  placeholder="https://gist.github.com/…"
                />
                <button
                  className="button secondary"
                  type="submit"
                  disabled={!api || !publicLink.trim() || previewing || busy}
                >
                  <Globe size={13} /> Preview public extension
                </button>
              </div>
            </form>
            <form
              className="extension-source"
              onSubmit={(event) => {
                event.preventDefault()
                previewText(importSource)
              }}
            >
              <label htmlFor="life-extension-import-json">Extension JSON</label>
              <textarea
                id="life-extension-import-json"
                value={importSource}
                onChange={(event) => {
                  previewRequest.current++
                  setPreviewing(false)
                  setImportSource(event.target.value)
                  setImportPreview(undefined)
                }}
                disabled={busy}
                spellCheck={false}
                rows={5}
                placeholder="Or paste an exported extension here…"
              />
              <div className="extension-source-footer">
                <span>
                  JSON files contain code and dependencies, without your threads or projects.
                </span>
                <button
                  className="button secondary"
                  type="submit"
                  disabled={busy || !importSource.trim()}
                >
                  <Braces size={13} /> Preview extension
                </button>
              </div>
            </form>
            {previewing ? (
              <div className="extension-progress" role="status">
                <LoaderCircle size={14} className="spinning" /> Loading extension for review…
              </div>
            ) : null}
            {importPreview ? (
              <div className="extension-import-preview">
                <ExtensionBundlePreview bundle={importPreview} />
                <div className="extension-source-footer">
                  <span>
                    {importPreview.kind === 'source'
                      ? 'Install dependencies, compile, and reload your interface.'
                      : 'This extension can execute local code when installed.'}
                  </span>
                  <button
                    className="button primary"
                    disabled={busy || !api}
                    onClick={() => void run(() => install(importPreview))}
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="spinning" />
                    ) : (
                      <PackagePlus size={14} />
                    )}
                    Install extension
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {feedback ? (
          <div
            className={failed ? 'form-error' : 'form-success'}
            role={failed ? 'alert' : 'status'}
          >
            {feedback}
          </div>
        ) : null}
        <div className="extension-footer">
          <code>{snapshot.path || 'Extensions are stored in Life’s app data folder'}</code>
          <div className="extension-folder-actions">
            <button
              className="button secondary"
              disabled={!api}
              onClick={() => void api?.sourceCode.openFolder().catch(fail)}
            >
              <FileCode2 size={13} /> Source folder
            </button>
            <button
              className="button secondary"
              disabled={!api}
              onClick={() => void api?.extensions.openFolder().catch(fail)}
            >
              <FolderOpen size={13} /> Open folder
            </button>
          </div>
        </div>
      </Modal>
      <ShareExtensionDialog
        bundle={sharing}
        onOpenChange={(value) => {
          if (!value) setSharing(undefined)
        }}
      />
    </>
  )
}
