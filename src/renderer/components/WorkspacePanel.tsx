import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Code2,
  File,
  FileCode2,
  Folder,
  GitBranch,
  GitCompareArrows,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import type { ConnectionState, FileEntry, GitState } from '../../shared/types'
import { api, errorText } from '../api'
export function WorkspacePanel({
  connection,
  onConnect,
  onClose,
  refreshKey,
  onAttach,
  onTerminal,
}: {
  connection: ConnectionState
  onConnect: () => void
  onClose: () => void
  refreshKey: number
  onAttach: (path: string) => void
  onTerminal: () => void
}) {
  const [tab, setTab] = useState<'files' | 'changes'>('files')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [path, setPath] = useState<string>()
  const [file, setFile] = useState<{ path: string; text: string }>()
  const [git, setGit] = useState<GitState>({ branch: '', diff: '', status: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    setPath(undefined)
    setFile(undefined)
    setFiles([])
    setGit({ branch: '', diff: '', status: '' })
    setError('')
  }, [connection.workspace, connection.status])
  useEffect(() => {
    if (connection.status !== 'connected' || !connection.workspace || !api) return
    let active = true
    setBusy(true)
    setError('')
    void Promise.all([api.files.list(path), api.files.git()])
      .then(([entries, state]) => {
        if (active) {
          setFiles(entries)
          setGit(state)
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e))
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [connection.status, connection.workspace, path, refresh, refreshKey])
  async function openFile(entry: FileEntry) {
    if (entry.directory) {
      setPath(entry.path)
      setFile(undefined)
      return
    }
    setBusy(true)
    setError('')
    try {
      const text = await api!.files.read(entry.path)
      setFile({ path: entry.path, text })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const changes = git.status.split('\n').filter((line) => line.trim())
  return (
    <aside className="workspace-panel" aria-label="Remote workspace">
      <header className="panel-heading">
        <span>Workspace</span>
        <div>
          <button
            className="icon-button"
            aria-label="Refresh remote workspace"
            disabled={connection.status !== 'connected' || !connection.workspace || busy}
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw size={14} className={busy ? 'spinning' : ''} />
          </button>
          <button
            className="icon-button panel-close"
            aria-label="Close workspace panel"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="panel-tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          <Folder size={14} /> Files
        </button>
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
          <GitCompareArrows size={14} /> Changes
          {changes.length ? <span>{changes.length}</span> : null}
        </button>
      </div>
      {connection.status !== 'connected' || !connection.workspace ? (
        <div className="workspace-empty">
          <div className="workspace-illustration">
            <div>
              <Code2 size={20} />
              <span />
              <span />
              <span />
            </div>
            <Server size={23} className="illustration-server" />
          </div>
          <h3>
            {connection.status === 'connected' ? 'Choose your project' : 'A home for your code'}
          </h3>
          <p>
            {connection.status === 'connected'
              ? 'Select a project to browse files'
              : 'Connect a machine to browse files'}
            <br />
            and review what your agents change.
          </p>
          <button className="button secondary" onClick={onConnect}>
            {connection.status === 'connected' ? 'Select project' : 'Connect machine'}{' '}
            <ChevronRight size={14} />
          </button>
          <div className="workspace-checklist">
            <span>
              <HardDrive size={14} />
              Remote project files
            </span>
            <span>
              <GitBranch size={14} />
              Live Git changes
            </span>
            <span>
              <Terminal size={14} />
              Integrated terminal
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="workspace-path">
            <Folder size={13} />
            <span title={path || connection.workspace}>
              {tab === 'files' && file
                ? file.path.split('/').pop()
                : (path || connection.workspace)?.split('/').pop()}
            </span>
            {git.branch && git.branch !== 'No repository' ? (
              <span className="branch">
                <GitBranch size={11} />
                {git.branch}
              </span>
            ) : null}
          </div>
          {error ? (
            <div className="panel-error" role="alert">
              {error}
            </div>
          ) : null}
          {busy && !files.length ? (
            <div className="panel-loading">
              <LoaderCircle size={20} className="spinning" /> Loading workspace…
            </div>
          ) : tab === 'files' ? (
            file ? (
              <div className="file-preview">
                <header>
                  <button className="text-button" onClick={() => setFile(undefined)}>
                    <ArrowLeft size={13} /> Files
                  </button>
                  <button className="text-button" onClick={() => onAttach(file.path)}>
                    Add to prompt
                  </button>
                </header>
                <pre>
                  {file.text.split('\n').map((line, i) => (
                    <div key={i}>
                      <span className="line-number">{i + 1}</span>
                      <code>{line || ' '}</code>
                    </div>
                  ))}
                </pre>
              </div>
            ) : (
              <div className="file-list">
                {path && path !== connection.workspace ? (
                  <button
                    className="file-row"
                    onClick={() =>
                      setPath(path.slice(0, path.lastIndexOf('/')) || connection.workspace)
                    }
                  >
                    <ArrowLeft size={14} />
                    <span>Parent directory</span>
                  </button>
                ) : null}
                {files.map((entry) => (
                  <button
                    className="file-row"
                    key={entry.path}
                    onClick={() => void openFile(entry)}
                  >
                    {entry.directory ? (
                      <Folder size={15} className="folder-icon" />
                    ) : /\.(tsx?|jsx?|json|css|py|go|rs)$/.test(entry.name) ? (
                      <FileCode2 size={15} />
                    ) : (
                      <File size={15} />
                    )}
                    <span>{entry.name}</span>
                    {entry.directory ? <ChevronRight size={12} /> : null}
                  </button>
                ))}
                {!files.length ? <div className="small-empty">This directory is empty.</div> : null}
              </div>
            )
          ) : (
            <div className="changes-view">
              {git.branch === 'No repository' ? (
                <div className="small-empty">This folder is not a Git repository.</div>
              ) : !changes.length ? (
                <div className="small-empty">
                  <GitCompareArrows size={25} />
                  <strong>Working tree is clean</strong>
                  <span>Changes will appear here as your agent works.</span>
                </div>
              ) : (
                <>
                  {changes.map((line, i) => (
                    <div key={i} className="change-row">
                      <span>{line.slice(0, 2).trim() || 'M'}</span>
                      <code>{line.slice(3)}</code>
                    </div>
                  ))}
                  {git.diff ? (
                    <pre className="git-diff">
                      {git.diff.split('\n').map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.startsWith('+')
                              ? 'added'
                              : line.startsWith('-')
                                ? 'removed'
                                : line.startsWith('@@')
                                  ? 'hunk'
                                  : ''
                          }
                        >
                          {line || ' '}
                        </div>
                      ))}
                    </pre>
                  ) : (
                    <p className="panel-note">
                      Untracked files are listed above. Open them in Files to view their contents.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
      <footer className="workspace-footer">
        <span className={`status-dot ${connection.status === 'connected' ? 'online' : ''}`} />
        {connection.status === 'connected' ? connection.profile?.host : 'No machine connected'}
        <button className="icon-button" aria-label="Open remote terminal" onClick={onTerminal}>
          <Terminal size={14} />
        </button>
      </footer>
    </aside>
  )
}
