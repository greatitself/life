import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Folder,
  House,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import type { ConnectionState, RemoteDirectoryList } from '../../shared/types'
import { api, errorText } from '../api'
import { Modal } from './Modal'
import './project-dialog.css'

export function ProjectDialog({
  open,
  onOpenChange,
  connection,
  onSelected,
  suggestedPath,
  beforeSelect,
  hasActiveTurns = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection: ConnectionState
  onSelected: (connection: ConnectionState) => void
  suggestedPath?: string
  beforeSelect?: () => Promise<void>
  hasActiveTurns?: boolean
}) {
  const [path, setPath] = useState('')
  const [directories, setDirectories] = useState<RemoteDirectoryList>()
  const [loading, setLoading] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const selectionGeneration = useRef(0)
  const recent = connection.workspace || connection.profile?.workspace

  async function browse(requestedPath?: string, updatePath = true) {
    if (!api) return
    const request = ++generation.current
    setLoading(true)
    setError('')
    try {
      const result = await api.connection.listDirectories(requestedPath)
      if (generation.current !== request) return
      setDirectories(result)
      if (updatePath) setPath(result.path)
    } catch (failure) {
      if (generation.current === request) setError(errorText(failure))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }

  useEffect(() => {
    selectionGeneration.current++
    setSelecting(false)
    setLoading(false)
    if (!open) {
      generation.current++
      return
    }
    setDirectories(undefined)
    setError('')
    setPath(suggestedPath || recent || connection.home || '~')
    // Start browsing at home; an old project path never blocks connecting.
    void browse(undefined, false)
    return () => {
      generation.current++
    }
  }, [open, connection.profile?.id, connection.status, suggestedPath])

  async function selectProject() {
    if (!api || selecting || loading || !path.trim()) return
    const request = ++selectionGeneration.current
    const profileId = connection.profile?.id
    setSelecting(true)
    setError('')
    try {
      await beforeSelect?.()
      if (selectionGeneration.current !== request) return
      const state = await api.connection.selectWorkspace(path.trim())
      if (selectionGeneration.current !== request) return
      if (state.status !== 'connected' || state.profile?.id !== profileId)
        throw new Error('The connected machine changed. Select the project on its current machine.')
      onSelected(state)
      onOpenChange(false)
    } catch (failure) {
      if (selectionGeneration.current === request) setError(errorText(failure))
    } finally {
      if (selectionGeneration.current === request) setSelecting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!selecting) onOpenChange(value)
      }}
      title="Select a project"
      description={`Connected to ${connection.profile?.name || 'your machine'}. Choose the folder your agents will work in.`}
      className="project-modal"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void selectProject()
        }}
      >
        <label className="project-directory-field">
          Project directory
          <div className="input-with-button">
            <input
              aria-label="Project directory"
              placeholder="~/projects/my-app"
              value={path}
              disabled={selecting}
              autoComplete="off"
              onChange={(event) => {
                setPath(event.target.value)
                setError('')
              }}
            />
            <button
              type="button"
              aria-label="Browse project directory"
              disabled={loading || selecting || !path.trim()}
              onClick={() => void browse(path.trim())}
            >
              <ArrowUpRight size={16} />
            </button>
          </div>
        </label>
        {recent && recent !== '~' && recent !== connection.home ? (
          <button
            type="button"
            className="project-recent"
            disabled={selecting || loading}
            onClick={() => {
              setPath(recent)
              void browse(recent)
            }}
          >
            <Folder size={14} />
            <span>
              Last project <strong>{recent}</strong>
            </span>
            <ChevronRight size={14} />
          </button>
        ) : null}
        <section className="remote-directories" aria-label="Remote folders" aria-busy={loading}>
          <header>
            <button
              type="button"
              className="icon-button"
              aria-label="Parent folder"
              disabled={loading || selecting || !directories?.parent}
              onClick={() => void browse(directories?.parent)}
            >
              <ArrowLeft size={15} />
            </button>
            <span title={directories?.path}>
              {directories?.path || connection.home || 'Remote home'}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Remote home folder"
              disabled={loading || selecting}
              onClick={() => void browse()}
            >
              <House size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh remote folders"
              disabled={loading || selecting}
              onClick={() => void browse(directories?.path)}
            >
              <RefreshCw size={14} />
            </button>
          </header>
          {loading ? (
            <div className="project-folders-empty" role="status">
              <LoaderCircle size={18} className="spinning" /> Loading folders…
            </div>
          ) : directories?.entries.length ? (
            <ul>
              {directories.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={selecting}
                    aria-label={`Open folder ${entry.name}`}
                    onClick={() => void browse(entry.path)}
                  >
                    <Folder size={16} /> <span>{entry.name}</span> <ChevronRight size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="project-folders-empty">
              {directories
                ? 'No subfolders here. You can select this folder.'
                : 'Enter a project path, or browse remote folders.'}
            </div>
          )}
        </section>
        {hasActiveTurns ? (
          <p className="form-hint">Switching projects stops running agent turns on this machine.</p>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={selecting}
            onClick={() => onOpenChange(false)}
          >
            {connection.workspace ? 'Cancel' : 'Choose later'}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={selecting || loading || !path.trim()}
            aria-busy={selecting}
          >
            {selecting ? <LoaderCircle size={16} className="spinning" /> : <Folder size={16} />}
            {selecting ? 'Opening project…' : 'Open project'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
