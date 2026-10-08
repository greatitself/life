import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  File,
  FileCode2,
  FileDiff,
  Folder,
  GitBranch,
  GitCompareArrows,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Server,
  Terminal,
  WrapText,
  X,
} from 'lucide-react'
import type { ConnectionState, FileEntry, GitState } from '../../shared/types'
import { api, errorText } from '../api'
import { parseGitStatus, parseUnifiedDiff, type DiffFile } from '../unified-diff'
import './workspace-panel.css'

type WorkspaceTab = 'diff' | 'files' | 'git'
const codeTokens =
  /(\/\/.*|\/\*.*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|new|async|await|throw|try|catch|type|interface|extends|implements|public|private|readonly|def|pass|None|True|False|fn|pub|use|struct|impl|match|in|of)\b)|(\b(?:true|false|null|undefined|\d+(?:\.\d+)?)\b)|(\b[A-Z][\w]*\b)/g

const CodeLine = memo(function CodeLine({ text }: { text: string }) {
  if (!text) return <code> </code>
  const fragments = []
  let cursor = 0
  for (const match of text.matchAll(codeTokens)) {
    const index = match.index!
    if (index > cursor) fragments.push(text.slice(cursor, index))
    const kind = match[1]
      ? 'comment'
      : match[2]
        ? 'string'
        : match[3]
          ? 'keyword'
          : match[4]
            ? 'literal'
            : 'type'
    fragments.push(
      <span key={index} className={`code-token-${kind}`}>
        {match[0]}
      </span>,
    )
    cursor = index + match[0].length
  }
  if (cursor < text.length) fragments.push(text.slice(cursor))
  return <code>{fragments}</code>
})

function DiffCounts({ additions, removals }: { additions: number; removals: number }) {
  return (
    <span className="diff-counts" aria-label={`${additions} additions, ${removals} deletions`}>
      <span className="diff-additions">+{additions}</span>
      <span className="diff-removals">−{removals}</span>
    </span>
  )
}
const emptyGit: GitState = { branch: '', diff: '', status: '' }

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
  const [tab, setTab] = useState<WorkspaceTab>('diff')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [path, setPath] = useState<string>()
  const [file, setFile] = useState<{ path: string; text: string }>()
  const [git, setGit] = useState<GitState>(emptyGit)
  const [error, setError] = useState('')
  const [listBusy, setListBusy] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [wrap, setWrap] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const fileRequest = useRef(0)
  const busy = listBusy || fileBusy
  const connected = connection.status === 'connected' && !!connection.workspace
  const changes = useMemo(() => parseGitStatus(git.status), [git.status])
  const diffFiles = useMemo(() => parseUnifiedDiff(git.diff), [git.diff])
  const totals = useMemo(
    () =>
      diffFiles.reduce(
        (total, changed) => ({
          additions: total.additions + changed.additions,
          removals: total.removals + changed.removals,
        }),
        { additions: 0, removals: 0 },
      ),
    [diffFiles],
  )

  useEffect(() => {
    fileRequest.current++
    setPath(undefined)
    setFile(undefined)
    setFiles([])
    setGit(emptyGit)
    setError('')
    setFileBusy(false)
    setCollapsed(new Set())
  }, [connection.workspace, connection.status, connection.profile?.id])

  useEffect(() => {
    if (!connected || !api) {
      setListBusy(false)
      return
    }
    let active = true
    setListBusy(true)
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
        if (active) setListBusy(false)
      })
    return () => {
      active = false
    }
  }, [connected, connection.workspace, connection.profile?.id, path, refresh, refreshKey])

  async function openFile(entry: Pick<FileEntry, 'path' | 'directory'>) {
    const request = ++fileRequest.current
    if (entry.directory) {
      setPath(entry.path)
      setFile(undefined)
      setFileBusy(false)
      return
    }
    setFileBusy(true)
    setError('')
    try {
      const text = await api!.files.read(entry.path)
      if (fileRequest.current === request) {
        setFile({ path: entry.path, text })
        setTab('files')
      }
    } catch (e) {
      if (fileRequest.current === request) setError(errorText(e))
    } finally {
      if (fileRequest.current === request) setFileBusy(false)
    }
  }
  function remotePath(relative: string) {
    return `${connection.workspace?.replace(/\/$/, '')}/${relative}`
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
    } catch (e) {
      setError(`Could not copy: ${errorText(e)}`)
    }
  }
  function toggleFile(changed: DiffFile) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(changed.path)) next.delete(changed.path)
      else next.add(changed.path)
      return next
    })
  }
  const allCollapsed =
    !!diffFiles.length && diffFiles.every((changed) => collapsed.has(changed.path))
  function emptyChanges() {
    return (
      <div className="small-empty diff-empty">
        {git.branch === 'No repository' ? (
          <>
            <GitBranch size={24} />
            <strong>No Git repository</strong>
            <span>Select a Git project to review its changes.</span>
          </>
        ) : (
          <>
            <GitCompareArrows size={24} />
            <strong>Working tree is clean</strong>
            <span>File changes appear here as your agent works.</span>
          </>
        )}
      </div>
    )
  }

  return (
    <aside className="workspace-panel" aria-label="Remote workspace">
      <header className="panel-heading workspace-panel-heading">
        <nav className="workspace-view-tabs" aria-label="Workspace views">
          <button aria-pressed={tab === 'diff'} onClick={() => setTab('diff')}>
            <FileDiff size={14} /> Diff
          </button>
          <button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
            <Folder size={14} /> Files
          </button>
          <button aria-pressed={tab === 'git'} onClick={() => setTab('git')}>
            <GitBranch size={14} /> Git
          </button>
        </nav>
        <div>
          <button
            className="icon-button"
            aria-label="Refresh remote workspace"
            disabled={!connected || busy}
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
      {!connected ? (
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
          <div className="workspace-review-toolbar">
            <span className="workspace-review-title" title={connection.workspace}>
              {tab === 'diff' ? 'Working tree' : tab === 'git' ? 'Source control' : 'Project files'}
            </span>
            {tab === 'diff' ? (
              <>
                <DiffCounts {...totals} />
                <button
                  className="icon-button"
                  aria-label={allCollapsed ? 'Expand all diffs' : 'Collapse all diffs'}
                  disabled={!diffFiles.length}
                  onClick={() =>
                    setCollapsed(
                      allCollapsed ? new Set() : new Set(diffFiles.map((changed) => changed.path)),
                    )
                  }
                >
                  {allCollapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}
                </button>
                <button
                  className="icon-button"
                  aria-label="Wrap diff lines"
                  aria-pressed={wrap}
                  onClick={() => setWrap((current) => !current)}
                >
                  <WrapText size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Copy diff"
                  disabled={!git.diff}
                  onClick={() => void copy(git.diff)}
                >
                  <Copy size={14} />
                </button>
              </>
            ) : (
              <span className="workspace-branch" title={git.branch}>
                <GitBranch size={12} />
                {git.branch || 'Loading…'}
              </span>
            )}
          </div>
          {error ? (
            <div className="panel-error" role="alert">
              {error}
            </div>
          ) : null}
          {listBusy && !git.branch && !files.length ? (
            <div className="panel-loading">
              <LoaderCircle size={20} className="spinning" /> Loading workspace…
            </div>
          ) : tab === 'files' ? (
            file ? (
              <div className="file-preview workspace-file-preview">
                <header>
                  <button className="text-button" onClick={() => setFile(undefined)}>
                    <ArrowLeft size={13} /> Files
                  </button>
                  <span title={file.path}>{file.path.split('/').pop()}</span>
                  <button className="text-button" onClick={() => onAttach(file.path)}>
                    Add to prompt
                  </button>
                </header>
                <pre aria-label={`File contents: ${file.path}`}>
                  {file.text.split('\n').map((line, i) => (
                    <div key={i}>
                      <span className="line-number" aria-hidden="true">
                        {i + 1}
                      </span>
                      <CodeLine text={line} />
                    </div>
                  ))}
                </pre>
              </div>
            ) : (
              <>
                <div className="workspace-path">
                  <Folder size={13} />
                  <span title={path || connection.workspace}>
                    {(path || connection.workspace)?.split('/').pop()}
                  </span>
                  <span>{files.length} items</span>
                </div>
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
                  {!files.length ? (
                    <div className="small-empty">This directory is empty.</div>
                  ) : null}
                </div>
              </>
            )
          ) : tab === 'git' ? (
            <div className="workspace-git-view">
              <div className="workspace-git-summary">
                <span>
                  {changes.length} changed {changes.length === 1 ? 'file' : 'files'}
                </span>
                <DiffCounts {...totals} />
              </div>
              {!changes.length ? (
                emptyChanges()
              ) : (
                <>
                  {changes.map((changed) => (
                    <button
                      key={`${changed.status}:${changed.path}`}
                      className="workspace-change-file"
                      title={
                        changed.previousPath
                          ? `${changed.previousPath} → ${changed.path}`
                          : changed.path
                      }
                      onClick={() =>
                        void openFile({ path: remotePath(changed.path), directory: false })
                      }
                    >
                      <FileCode2 size={15} />
                      <span>{changed.path}</span>
                      <code className={changed.untracked ? 'diff-additions' : ''}>
                        {changed.status.trim()}
                      </code>
                    </button>
                  ))}
                  <p className="panel-note">
                    Open a file to inspect its contents, or switch to Diff to review the changes.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className={`workspace-diff-view ${wrap ? 'diff-wrap' : ''}`} aria-label="Git diff">
              {!changes.length && !diffFiles.length ? (
                emptyChanges()
              ) : (
                <>
                  {diffFiles.map((changed) => (
                    <section className="workspace-diff-file" key={changed.path}>
                      <header className="workspace-diff-file-heading">
                        <button
                          className="workspace-diff-file-toggle"
                          aria-expanded={!collapsed.has(changed.path)}
                          onClick={() => toggleFile(changed)}
                        >
                          {collapsed.has(changed.path) ? (
                            <ChevronRight size={14} />
                          ) : (
                            <ChevronDown size={14} />
                          )}
                          <FileCode2 size={15} />
                          <span title={changed.path}>{changed.path}</span>
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Copy path ${changed.path}`}
                          onClick={() => void copy(changed.path)}
                        >
                          <Copy size={12} />
                        </button>
                        <DiffCounts additions={changed.additions} removals={changed.removals} />
                      </header>
                      {!collapsed.has(changed.path) ? (
                        <>
                          {changed.previousPath ? (
                            <div className="workspace-diff-rename">
                              Renamed from {changed.previousPath}
                            </div>
                          ) : null}
                          {changed.hunks.length ? (
                            <div className="workspace-diff-code">
                              {changed.hunks.map((hunk, hunkIndex) => (
                                <Fragment key={`${hunk.header}:${hunkIndex}`}>
                                  <div className="workspace-diff-hunk" title={hunk.header}>
                                    {hunk.header}
                                  </div>
                                  {hunk.lines.map((line, lineIndex) => (
                                    <div
                                      className={`workspace-diff-line diff-${line.kind}`}
                                      key={lineIndex}
                                    >
                                      <span className="diff-line-number" aria-hidden="true">
                                        {line.oldLine}
                                      </span>
                                      <span className="diff-line-number" aria-hidden="true">
                                        {line.newLine}
                                      </span>
                                      <span className="diff-line-marker" aria-hidden="true">
                                        {line.kind === 'added'
                                          ? '+'
                                          : line.kind === 'removed'
                                            ? '−'
                                            : ''}
                                      </span>
                                      <CodeLine text={line.text} />
                                    </div>
                                  ))}
                                </Fragment>
                              ))}
                            </div>
                          ) : (
                            <div className="workspace-diff-metadata">
                              {changed.metadata.join(' · ') || 'File metadata changed'}
                            </div>
                          )}
                        </>
                      ) : null}
                    </section>
                  ))}
                  {changes
                    .filter((changed) => !diffFiles.some((diff) => diff.path === changed.path))
                    .map((changed) => (
                      <div className="workspace-untracked-file" key={changed.path}>
                        <FileCode2 size={15} />
                        <span title={changed.path}>{changed.path}</span>
                        <code>{changed.status.trim()}</code>
                        <button
                          className="text-button"
                          onClick={() =>
                            void openFile({ path: remotePath(changed.path), directory: false })
                          }
                        >
                          Open file
                        </button>
                      </div>
                    ))}
                </>
              )}
            </div>
          )}
        </>
      )}
      <footer className="workspace-footer">
        <span className={`status-dot ${connection.status === 'connected' ? 'online' : ''}`} />
        <span title={connection.profile?.host}>
          {connection.status === 'connected' ? connection.profile?.host : 'No machine connected'}
        </span>
        {tab === 'diff' && git.branch && git.branch !== 'No repository' ? (
          <span className="workspace-footer-branch" title={git.branch}>
            <GitBranch size={11} /> {git.branch}
          </span>
        ) : null}
        <button className="icon-button" aria-label="Open remote terminal" onClick={onTerminal}>
          <Terminal size={14} />
        </button>
      </footer>
    </aside>
  )
}
