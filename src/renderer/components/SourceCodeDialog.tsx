import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Code2,
  FileCode2,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react'
import type { LifeSourceContext, LifeSourcePatch } from '../../shared/source-code'
import { lifeSourcePathSchema } from '../../shared/source-code'
import { api, errorText } from '../api'
import { useSourceCode } from '../useSourceCode'
import { Modal } from './Modal'
import './source-code.css'

const fixedPaths = new Set(['src/renderer/bootstrap.ts', 'src/renderer/index.html'])
const editable = (path: string) =>
  (path.startsWith('src/renderer/') || path.startsWith('src/shared/')) &&
  !fixedPaths.has(path.toLowerCase())
type Draft = { original: string; content: string; created?: boolean }

export function SourceCodeDialog({
  open,
  onOpenChange,
  onNotify,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNotify?: (message: string) => void
}) {
  const snapshot = useSourceCode()
  const [context, setContext] = useState<LifeSourceContext | undefined>(undefined)
  const [selected, setSelected] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [query, setQuery] = useState('')
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [working, setWorking] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const request = useRef(0)
  const readRequest = useRef(0)
  const alive = useRef(true)
  const dirty = Object.entries(drafts).filter(
    ([, draft]) => draft.created || draft.content !== draft.original,
  )
  const stale = context !== undefined && context.revision !== snapshot.revision
  const paths = useMemo(() => {
    const index = new Set([...(context?.paths || []), ...Object.keys(drafts)])
    return [...index].sort().filter((path) => path.toLowerCase().includes(query.toLowerCase()))
  }, [context?.paths, drafts, query])
  const file = drafts[selected]

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      request.current++
      readRequest.current++
    }
  }, [])

  async function loadIndex(clearDrafts = false) {
    if (!api) return
    const generation = ++request.current
    setLoading(true)
    setFeedback('')
    try {
      const next = await api.sourceCode.getContext()
      if (!alive.current || generation !== request.current) return
      setContext(next)
      if (clearDrafts) {
        readRequest.current++
        setDrafts(
          Object.fromEntries(
            next.files.map((file) => [
              file.path,
              { original: file.content, content: file.content },
            ]),
          ),
        )
        setSelected('')
      } else {
        setDrafts((previous) => ({
          ...Object.fromEntries(
            next.files.map((file) => [
              file.path,
              { original: file.content, content: file.content },
            ]),
          ),
          ...previous,
        }))
      }
      setFailed(false)
    } catch (error) {
      if (alive.current && generation === request.current) {
        setFeedback(errorText(error))
        setFailed(true)
      }
    } finally {
      if (alive.current && generation === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (open && !context) void loadIndex()
  }, [open])

  async function selectFile(path: string) {
    if (working || loading) return
    setSelected(path)
    setFeedback('')
    const generation = ++readRequest.current
    if (drafts[path]) {
      setReading(false)
      return
    }
    if (!api || !context) return
    setReading(true)
    try {
      const next = await api.sourceCode.getContext({ paths: [path] })
      if (!alive.current || generation !== readRequest.current) return
      if (next.revision !== context.revision) {
        throw new Error(
          'Life’s source changed while this file was loading. Refresh source before editing.',
        )
      }
      const found = next.files.find((file) => file.path === path)
      if (!found) throw new Error('This file is unavailable in the source workspace.')
      setDrafts((previous) => ({
        ...previous,
        [path]: { original: found.content, content: found.content },
      }))
    } catch (error) {
      if (alive.current && generation === readRequest.current) {
        setFeedback(errorText(error))
        setFailed(true)
      }
    } finally {
      if (alive.current && generation === readRequest.current) setReading(false)
    }
  }

  function addFile() {
    if (!api || !context || working || loading || stale) return
    const path = newPath.trim()
    const valid = lifeSourcePathSchema.safeParse(path)
    if (!valid.success || !editable(path)) {
      setFeedback(
        'Use a new path in src/renderer/ or src/shared/. Life’s bootstrap files are read-only.',
      )
      setFailed(true)
      return
    }
    if (
      [...context.paths, ...Object.keys(drafts)].some(
        (existing) => existing.toLowerCase() === path.toLowerCase(),
      )
    ) {
      setFeedback('This source path already exists. Select it in the file list.')
      setFailed(true)
      return
    }
    readRequest.current++
    setReading(false)
    setDrafts((previous) => ({ ...previous, [path]: { original: '', content: '', created: true } }))
    setSelected(path)
    setQuery('')
    setNewPath('')
    setAdding(false)
    setFeedback('')
  }

  async function apply() {
    if (!api || !context || !dirty.length || stale || working) return
    setWorking(true)
    setFeedback('')
    const patch: LifeSourcePatch = {
      summary: `Manual source edit: ${dirty.map(([path]) => path).join(', ')}`.slice(0, 2000),
      baseRevision: context.revision,
      files: dirty.map(([path, draft]) => ({ path, content: draft.content })),
    }
    try {
      const next = await api.sourceCode.apply(patch)
      if (next.error) throw new Error(next.error)
      onNotify?.(`Compiled Life source revision ${next.revision}.`)
      await api.sourceCode.reload()
    } catch (error) {
      if (alive.current) {
        setFeedback(errorText(error))
        setFailed(true)
      }
    } finally {
      if (alive.current) setWorking(false)
    }
  }

  async function action(kind: 'rollback' | 'disable' | 'reload' | 'folder') {
    if (!api || working) return
    setWorking(true)
    setFeedback('')
    try {
      if (kind === 'folder') await api.sourceCode.openFolder()
      else {
        if (kind === 'rollback') await api.sourceCode.rollback()
        if (kind === 'disable') await api.sourceCode.disable()
        await api.sourceCode.reload()
      }
      setFailed(false)
    } catch (error) {
      if (alive.current) {
        setFeedback(errorText(error))
        setFailed(true)
      }
    } finally {
      if (alive.current) setWorking(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Life source"
      description="Inspect the source behind your interface. Ask for changes in Life Studio at the bottom of the sidebar."
      className="source-code-modal"
    >
      {!api ? (
        <div className="source-desktop-notice">
          Source compilation runs in the Life desktop application.
        </div>
      ) : null}
      <div className="source-state-row">
        <div className="source-state-icon">
          <Code2 size={19} />
        </div>
        <div>
          <strong>
            {snapshot.enabled && snapshot.active
              ? 'Custom source is active'
              : 'Built-in interface is active'}
          </strong>
          <span>
            Revision {snapshot.revision}
            {snapshot.active ? ` · compiled revision ${snapshot.active.revision}` : ''}
          </span>
        </div>
        {snapshot.recovered ? <span className="source-recovered">Recovered</span> : null}
      </div>
      {snapshot.summary ? <p className="source-last-change">{snapshot.summary}</p> : null}
      {snapshot.error ? (
        <div className="form-error" role="alert">
          {snapshot.error}
        </div>
      ) : null}
      {snapshot.recovered ? (
        <p className="source-recovery-copy">
          Life restored its built-in interface after the previous custom source failed to start.
        </p>
      ) : null}
      <div className="source-management-actions">
        <button
          className="button secondary"
          disabled={!api || working || !snapshot.canRollback}
          onClick={() => void action('rollback')}
        >
          <RotateCcw size={13} /> Restore previous
        </button>
        <button
          className="button secondary"
          disabled={!api || working || !snapshot.enabled}
          onClick={() => void action('disable')}
        >
          Use built-in interface
        </button>
        <button
          className="icon-button"
          aria-label="Reload Life interface"
          disabled={!api || working}
          onClick={() => void action('reload')}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="source-browser-heading">
        <strong>Source files</strong>
        <span>
          Renderer and shared files are editable. Native host and startup files are read-only.
        </span>
        <button
          className="icon-button"
          aria-label={
            dirty.length ? 'Discard edits and refresh source files' : 'Refresh source files'
          }
          disabled={!api || working || loading}
          onClick={() => void loadIndex(true)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="Add source file"
          disabled={!api || !context || working || loading || stale}
          onClick={() => setAdding(!adding)}
        >
          <Plus size={15} />
        </button>
      </div>
      {adding ? (
        <form
          className="source-new-file"
          onSubmit={(event) => {
            event.preventDefault()
            addFile()
          }}
        >
          <input
            aria-label="New Life source file path"
            placeholder="src/renderer/components/MyPanel.tsx"
            value={newPath}
            disabled={!api || !context || working || loading || stale}
            onChange={(event) => setNewPath(event.target.value)}
          />
          <button
            className="button secondary"
            disabled={!newPath.trim() || !api || !context || working || loading || stale}
          >
            Create file
          </button>
        </form>
      ) : null}
      {stale ? (
        <div className="source-stale" role="status">
          <span>Source changed in another thread. Refresh before applying your edits.</span>
          <button
            className="button secondary"
            disabled={working || loading}
            onClick={() => void loadIndex(true)}
          >
            {dirty.length ? 'Discard edits & refresh' : 'Refresh source'}
          </button>
        </div>
      ) : null}
      <div className="source-browser">
        <aside className="source-file-list" aria-label="Life source files">
          <label className="source-file-filter">
            <Search size={13} />
            <input
              aria-label="Filter Life source files"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a source file…"
            />
          </label>
          {loading ? (
            <div className="source-loading">
              <LoaderCircle size={14} className="spinning" /> Loading source…
            </div>
          ) : paths.length ? (
            <div className="source-file-entries">
              {paths.map((path) => (
                <button
                  key={path}
                  aria-pressed={selected === path}
                  disabled={working || loading}
                  title={path}
                  onClick={() => void selectFile(path)}
                >
                  {editable(path) ? <FileCode2 size={12} /> : <LockKeyhole size={11} />}
                  <span>{path.replace(/^src\//, '')}</span>
                  {drafts[path] &&
                  (drafts[path].created || drafts[path].content !== drafts[path].original) ? (
                    <i aria-label="Unsaved changes" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="source-file-empty">
              {query ? 'No matching source files.' : 'No source index available.'}
            </div>
          )}
        </aside>
        <div className="source-editor">
          {selected ? (
            <>
              <div className="source-editor-label">
                <code>{selected}</code>
                {editable(selected) ? (
                  <span>Editable</span>
                ) : (
                  <span>
                    <LockKeyhole size={10} /> Read-only
                  </span>
                )}
              </div>
              {reading ? (
                <div className="source-editor-empty">
                  <LoaderCircle size={16} className="spinning" /> Reading file…
                </div>
              ) : file ? (
                <textarea
                  aria-label={`Source of ${selected}`}
                  value={file.content}
                  readOnly={!editable(selected)}
                  disabled={working || loading}
                  spellCheck={false}
                  onChange={(event) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [selected]: { ...previous[selected], content: event.target.value },
                    }))
                  }
                />
              ) : (
                <div className="source-editor-empty">Refresh or select another source file.</div>
              )}
            </>
          ) : (
            <div className="source-editor-empty">
              <Code2 size={24} />
              <strong>View the code that makes Life yours.</strong>
              <span>Select a file to inspect or edit it.</span>
            </div>
          )}
        </div>
      </div>
      {dirty.length ? (
        <div className="source-change-audit">
          <strong>
            {dirty.length} pending {dirty.length === 1 ? 'file change' : 'file changes'}
          </strong>
          {dirty.map(([path, draft]) => (
            <div key={path}>
              <span>{draft.created ? 'New' : 'Edited'}</span>
              <code>{path}</code>
              <button
                className="icon-button"
                aria-label={`Discard changes in ${path}`}
                disabled={working || loading}
                onClick={() => {
                  if (draft.created) {
                    setDrafts((previous) => {
                      const next = { ...previous }
                      delete next[path]
                      return next
                    })
                    if (selected === path) setSelected('')
                  } else
                    setDrafts((previous) => ({
                      ...previous,
                      [path]: { ...draft, content: draft.original },
                    }))
                }}
              >
                <RotateCcw size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {context ? (
        <details className="source-dependencies">
          <summary>
            <ChevronDown size={12} /> Dependencies{' '}
            <span>{Object.keys(context.dependencies).length}</span>
          </summary>
          <div>
            {Object.entries(context.dependencies)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, version]) => (
                <p key={name}>
                  <code>{name}</code>
                  <span>{version}</span>
                </p>
              ))}
          </div>
        </details>
      ) : null}
      {feedback ? (
        <div className={failed ? 'form-error' : 'form-success'} role={failed ? 'alert' : 'status'}>
          {feedback}
        </div>
      ) : null}
      <div className="source-footer">
        <code>{snapshot.path || 'Source workspace in Life’s app data folder'}</code>
        <button
          className="button secondary"
          disabled={!api || working}
          onClick={() => void action('folder')}
        >
          <FolderOpen size={13} /> Open folder
        </button>
        <button
          className="button primary"
          disabled={!api || !dirty.length || stale || working || loading}
          onClick={() => void apply()}
        >
          {working ? <LoaderCircle size={14} className="spinning" /> : <Check size={14} />} Compile
          & reload
        </button>
      </div>
    </Modal>
  )
}
