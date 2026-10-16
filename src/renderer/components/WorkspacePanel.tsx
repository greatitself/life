import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Columns2,
  Copy,
  File,
  FileCode2,
  FileDiff,
  Folder,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Rows3,
  Search,
  Server,
  Terminal,
  WrapText,
  X,
} from 'lucide-react'
import type { ConnectionState, FileEntry, GitState } from '../../shared/types'
import { api, errorText } from '../api'
import { parseGitStatus, parseUnifiedDiff, type DiffFile, type DiffLine } from '../unified-diff'
import './workspace-panel.css'

export type WorkspaceTab = 'diff' | 'files' | 'git'
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

function splitDiffLines(lines: readonly DiffLine[]) {
  const rows: { left?: DiffLine; right?: DiffLine; annotation?: string }[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++)
      rows.push({ left: removed[index], right: added[index] })
    removed = []
    added = []
  }
  for (const line of lines) {
    if (line.kind === 'removed') removed.push(line)
    else if (line.kind === 'added') added.push(line)
    else {
      flush()
      if (line.kind === 'annotation') rows.push({ annotation: line.text })
      else rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}

const SplitDiffLines = memo(function SplitDiffLines({ lines }: { lines: readonly DiffLine[] }) {
  const rows = useMemo(() => splitDiffLines(lines), [lines])
  return (
    <div className="workspace-diff-split-hunk">
      {rows.map((row, index) =>
        row.annotation ? (
          <div key={index} className="workspace-diff-split-annotation">
            {row.annotation}
          </div>
        ) : (
          <div key={index} className="workspace-diff-split-row">
            {(['left', 'right'] as const).map((side) => {
              const line = row[side]
              return (
                <div
                  key={side}
                  className={`workspace-diff-line diff-${line?.kind || 'empty'}`}
                  aria-hidden={!line || undefined}
                >
                  <span className="diff-line-number" aria-hidden="true">
                    {side === 'left' ? line?.oldLine : line?.newLine}
                  </span>
                  <span className="diff-line-marker" aria-hidden="true">
                    {line?.kind === 'added' ? '+' : line?.kind === 'removed' ? '−' : ''}
                  </span>
                  <CodeLine text={line?.text || ''} />
                </div>
              )
            })}
          </div>
        ),
      )}
    </div>
  )
})

function changedFileTree(paths: readonly string[]) {
  const rows: { path: string; label: string; depth: number; directory: boolean }[] = []
  const directories = new Set<string>()
  for (const path of [...new Set(paths)].sort((a, b) => a.localeCompare(b))) {
    const segments = path.split('/')
    for (let index = 0; index < segments.length - 1; index++) {
      const directory = segments.slice(0, index + 1).join('/')
      if (directories.has(directory)) continue
      directories.add(directory)
      rows.push({ path: directory, label: segments[index], depth: index, directory: true })
    }
    rows.push({
      path,
      label: segments.at(-1) || path,
      depth: segments.length - 1,
      directory: false,
    })
  }
  return rows
}

export function WorkspacePanel({
  connection,
  onConnect,
  onClose,
  refreshKey,
  onAttach,
  onTerminal,
  activeTab,
  onTabChange,
}: {
  connection: ConnectionState
  onConnect: () => void
  onClose: () => void
  refreshKey: number
  onAttach: (path: string) => void
  onTerminal: () => void
  activeTab?: WorkspaceTab
  onTabChange?: (tab: WorkspaceTab) => void
}) {
  const [localTab, setLocalTab] = useState<WorkspaceTab>('diff')
  const tab = activeTab ?? localTab
  function setTab(next: WorkspaceTab) {
    setLocalTab(next)
    onTabChange?.(next)
  }
  const [files, setFiles] = useState<FileEntry[]>([])
  const [directories, setDirectories] = useState<Map<string, FileEntry[]>>(() => new Map())
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set())
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(() => new Set())
  const [fileSearch, setFileSearch] = useState('')
  const [file, setFile] = useState<{ path: string; text: string }>()
  const [git, setGit] = useState<GitState>(emptyGit)
  const [error, setError] = useState('')
  const [listBusy, setListBusy] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [wrap, setWrap] = useState(true)
  const [diffLayout, setDiffLayout] = useState<'stacked' | 'split'>('stacked')
  const [diffTreeOpen, setDiffTreeOpen] = useState(false)
  const [diffTreeCollapsed, setDiffTreeCollapsed] = useState<Set<string>>(() => new Set())
  const [selectedDiff, setSelectedDiff] = useState<string>()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const fileRequest = useRef(0)
  const workspaceRevision = useRef(0)
  const folderRequests = useRef(new Map<string, number>())
  const folderRequest = useRef(0)
  const expandedFoldersCurrent = useRef(expandedFolders)
  expandedFoldersCurrent.current = expandedFolders
  const workspaceKey = JSON.stringify([
    connection.profile?.id,
    connection.profile?.transport,
    connection.workspace,
    connection.status,
  ])
  const currentWorkspace = useRef(workspaceKey)
  currentWorkspace.current = workspaceKey
  const [dataWorkspace, setDataWorkspace] = useState(workspaceKey)
  const ownsData = dataWorkspace === workspaceKey
  const diffSections = useRef(new Map<string, HTMLElement>())
  const revealFrame = useRef<number | undefined>(undefined)
  const busy = listBusy || fileBusy
  const connected = connection.status === 'connected' && !!connection.workspace
  const changes = useMemo(() => parseGitStatus(ownsData ? git.status : ''), [git.status, ownsData])
  const diffFiles = useMemo(() => parseUnifiedDiff(ownsData ? git.diff : ''), [git.diff, ownsData])
  const diffTree = useMemo(
    () =>
      changedFileTree([
        ...diffFiles.map((changed) => changed.path),
        ...changes.map((changed) => changed.path),
      ]),
    [diffFiles, changes],
  )
  const visibleFiles = useMemo(() => {
    const query = fileSearch.toLocaleLowerCase()
    const rows: { entry: FileEntry; depth: number; key: string }[] = []
    const visit = (entries: readonly FileEntry[], depth: number, ancestors: readonly string[]) => {
      for (const entry of entries) {
        const children = directories.get(entry.path) || []
        const start = rows.length
        const relativePath = entry.path.slice(
          (connection.workspace?.replace(/\/$/, '').length || 0) + 1,
        )
        const matches =
          !query ||
          entry.name.toLocaleLowerCase().includes(query) ||
          relativePath.toLocaleLowerCase().includes(query)
        rows.push({ entry, depth, key: JSON.stringify([...ancestors, entry.path]) })
        if (
          entry.directory &&
          !ancestors.includes(entry.path) &&
          (query || expandedFolders.has(entry.path))
        )
          visit(children, depth + 1, [...ancestors, entry.path])
        if (!matches && rows.length === start + 1) rows.pop()
      }
    }
    visit(files, 0, [])
    return rows
  }, [files, directories, expandedFolders, fileSearch, connection.workspace])
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
    workspaceRevision.current++
    folderRequests.current.clear()
    setDataWorkspace(workspaceKey)
    setDirectories(new Map())
    setExpandedFolders(new Set())
    setLoadingFolders(new Set())
    setFileSearch('')
    setFile(undefined)
    setFiles([])
    setGit(emptyGit)
    setError('')
    setFileBusy(false)
    setCollapsed(new Set())
    setSelectedDiff(undefined)
    setDiffTreeCollapsed(new Set())
  }, [workspaceKey])

  useEffect(
    () => () => {
      fileRequest.current++
      workspaceRevision.current++
      if (revealFrame.current !== undefined) cancelAnimationFrame(revealFrame.current)
    },
    [],
  )

  async function loadFolder(folder: string, force = false) {
    if (!connected || !api || currentWorkspace.current !== workspaceKey) return
    if (folderRequests.current.has(folder) || (!force && directories.has(folder))) return
    const owner = workspaceKey
    const revision = workspaceRevision.current
    const request = ++folderRequest.current
    folderRequests.current.set(folder, request)
    setLoadingFolders((current) => new Set(current).add(folder))
    const current = () =>
      currentWorkspace.current === owner &&
      workspaceRevision.current === revision &&
      folderRequests.current.get(folder) === request
    try {
      const entries = await api.files.list(folder)
      if (current()) setDirectories((previous) => new Map(previous).set(folder, entries))
    } catch (error) {
      if (current()) setError(errorText(error))
    } finally {
      if (current()) {
        folderRequests.current.delete(folder)
        setLoadingFolders((previous) => {
          const next = new Set(previous)
          next.delete(folder)
          return next
        })
      }
    }
  }

  useEffect(() => {
    if (!connected || !api) {
      setListBusy(false)
      return
    }
    let active = true
    const owner = workspaceKey
    const revision = ++workspaceRevision.current
    folderRequests.current.clear()
    setLoadingFolders(new Set())
    setListBusy(true)
    setError('')
    const current = () =>
      active && currentWorkspace.current === owner && workspaceRevision.current === revision
    void Promise.all([api.files.list(), api.files.git()])
      .then(async ([entries, state]) => {
        if (current()) {
          setFiles(entries)
          setGit(state)
          setDirectories(new Map())
          setListBusy(false)
          for (const folder of expandedFoldersCurrent.current) {
            if (!current()) break
            await loadFolder(folder, true)
          }
        }
      })
      .catch((e) => {
        if (current()) setError(errorText(e))
      })
      .finally(() => {
        if (current()) setListBusy(false)
      })
    return () => {
      active = false
    }
  }, [connected, workspaceKey, refresh, refreshKey])

  async function openFile(entry: Pick<FileEntry, 'path' | 'directory'>) {
    if (!connected || !api || !ownsData || currentWorkspace.current !== workspaceKey) return
    const request = ++fileRequest.current
    const owner = workspaceKey
    if (entry.directory) {
      const expanded = expandedFolders.has(entry.path)
      setExpandedFolders((current) => {
        const next = new Set(current)
        if (expanded) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      if (!expanded) void loadFolder(entry.path)
      setFileBusy(false)
      return
    }
    setFileBusy(true)
    setError('')
    setTab('files')
    try {
      const text = await api.files.read(entry.path)
      if (currentWorkspace.current === owner && fileRequest.current === request) {
        setFile({ path: entry.path, text })
      }
    } catch (e) {
      if (currentWorkspace.current === owner && fileRequest.current === request)
        setError(errorText(e))
    } finally {
      if (currentWorkspace.current === owner && fileRequest.current === request) setFileBusy(false)
    }
  }
  function remotePath(relative: string) {
    return `${connection.workspace?.replace(/\/$/, '')}/${relative}`
  }
  async function copy(value: string) {
    const owner = workspaceKey
    try {
      await navigator.clipboard.writeText(value)
    } catch (e) {
      if (currentWorkspace.current === owner) setError(`Could not copy: ${errorText(e)}`)
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
  function revealDiff(path: string) {
    setSelectedDiff(path)
    setCollapsed((current) => {
      const next = new Set(current)
      next.delete(path)
      return next
    })
    if (revealFrame.current !== undefined) cancelAnimationFrame(revealFrame.current)
    const owner = workspaceKey
    revealFrame.current = requestAnimationFrame(() => {
      revealFrame.current = undefined
      if (currentWorkspace.current === owner)
        diffSections.current.get(path)?.scrollIntoView({ block: 'start' })
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
          {tab === 'files' && !file ? (
            <div className="workspace-files-toolbar">
              <button
                className="icon-button"
                aria-label="Refresh workspace files"
                disabled={busy}
                onClick={() => setRefresh((current) => current + 1)}
              >
                <RefreshCw size={14} className={listBusy ? 'spinning' : ''} />
              </button>
              <label className="workspace-files-search">
                <Search size={13} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search project files"
                  placeholder="Search files"
                  spellCheck={false}
                  value={fileSearch}
                  onChange={(event) => setFileSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setFileSearch('')
                      event.currentTarget.blur()
                    }
                  }}
                />
              </label>
              <button
                className="icon-button"
                aria-label="Collapse all folders"
                disabled={!expandedFolders.size}
                onClick={() => setExpandedFolders(new Set())}
              >
                <ChevronsDownUp size={14} />
              </button>
            </div>
          ) : (
            <div className="workspace-review-toolbar">
              <span className="workspace-review-title" title={connection.workspace}>
                {tab === 'diff'
                  ? 'Working tree'
                  : tab === 'git'
                    ? 'Source control'
                    : 'Project files'}
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
                        allCollapsed
                          ? new Set()
                          : new Set(diffFiles.map((changed) => changed.path)),
                      )
                    }
                  >
                    {allCollapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}
                  </button>
                  <div className="workspace-diff-layout" role="group" aria-label="Diff layout">
                    <button
                      className="icon-button"
                      aria-label="Stacked diff view"
                      aria-pressed={diffLayout === 'stacked'}
                      onClick={() => setDiffLayout('stacked')}
                    >
                      <Rows3 size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Split diff view"
                      aria-pressed={diffLayout === 'split'}
                      onClick={() => setDiffLayout('split')}
                    >
                      <Columns2 size={14} />
                    </button>
                  </div>
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
                    aria-label={diffTreeOpen ? 'Hide file tree' : 'Show file tree'}
                    aria-pressed={diffTreeOpen}
                    disabled={!diffTree.length}
                    onClick={() => setDiffTreeOpen((current) => !current)}
                  >
                    <FolderTree size={14} />
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
          )}
          {error ? (
            <div className="panel-error" role="alert">
              {error}
            </div>
          ) : null}
          {!ownsData || (listBusy && !git.branch && !files.length) ? (
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
                  <span title={connection.workspace}>{connection.workspace?.split('/').pop()}</span>
                  <span>{files.length} items</span>
                </div>
                <nav className="file-list workspace-file-tree" aria-label="Project files">
                  {visibleFiles.map(({ entry, depth, key }) => (
                    <button
                      className="file-row"
                      key={key}
                      title={entry.path}
                      style={{ paddingLeft: 5 + depth * 12 }}
                      aria-expanded={
                        entry.directory
                          ? expandedFolders.has(entry.path) || !!fileSearch
                          : undefined
                      }
                      aria-busy={(entry.directory && loadingFolders.has(entry.path)) || undefined}
                      onClick={() => void openFile(entry)}
                    >
                      {entry.directory ? (
                        expandedFolders.has(entry.path) || fileSearch ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )
                      ) : (
                        <span className="file-tree-chevron-space" aria-hidden="true" />
                      )}
                      {entry.directory ? (
                        <Folder size={15} className="folder-icon" />
                      ) : /\.(tsx?|jsx?|json|css|py|go|rs)$/.test(entry.name) ? (
                        <FileCode2 size={15} />
                      ) : (
                        <File size={15} />
                      )}
                      <span>{entry.name}</span>
                      {loadingFolders.has(entry.path) ? (
                        <LoaderCircle size={12} className="spinning" />
                      ) : null}
                    </button>
                  ))}
                  {!visibleFiles.length ? (
                    <div className="small-empty">
                      {fileSearch ? 'No matching loaded files.' : 'This directory is empty.'}
                    </div>
                  ) : null}
                </nav>
                {fileSearch ? (
                  <p className="workspace-file-search-note">
                    Search includes files in folders opened here.
                  </p>
                ) : null}
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
            <div className="workspace-diff-layout-body">
              <div
                className={`workspace-diff-view ${wrap ? 'diff-wrap' : ''} ${diffLayout === 'split' ? 'diff-split' : 'diff-stacked'}`}
                aria-label="Git diff"
              >
                {!changes.length && !diffFiles.length ? (
                  emptyChanges()
                ) : (
                  <>
                    {diffFiles.map((changed) => (
                      <section
                        className="workspace-diff-file"
                        key={changed.path}
                        ref={(element) => {
                          if (element) diffSections.current.set(changed.path, element)
                          else diffSections.current.delete(changed.path)
                        }}
                      >
                        <header
                          className="workspace-diff-file-heading"
                          onClick={(event) => {
                            if (event.target instanceof Element && !event.target.closest('button'))
                              toggleFile(changed)
                          }}
                        >
                          <button
                            className="workspace-diff-file-toggle"
                            aria-expanded={!collapsed.has(changed.path)}
                            aria-label={`${collapsed.has(changed.path) ? 'Expand' : 'Collapse'} ${changed.path}`}
                            onClick={() => toggleFile(changed)}
                          >
                            {collapsed.has(changed.path) ? (
                              <ChevronRight size={14} />
                            ) : (
                              <ChevronDown size={14} />
                            )}
                          </button>
                          <FileCode2 size={14} />
                          <button
                            className="workspace-diff-file-name"
                            title={changed.path}
                            aria-label={`Open file ${changed.path}`}
                            disabled={changed.kind === 'deleted'}
                            onClick={() =>
                              void openFile({ path: remotePath(changed.path), directory: false })
                            }
                          >
                            {changed.path}
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
                                    {diffLayout === 'split' ? (
                                      <SplitDiffLines lines={hunk.lines} />
                                    ) : (
                                      hunk.lines.map((line, lineIndex) => (
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
                                      ))
                                    )}
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
                        <div
                          className="workspace-untracked-file"
                          key={changed.path}
                          ref={(element) => {
                            if (element) diffSections.current.set(changed.path, element)
                            else diffSections.current.delete(changed.path)
                          }}
                        >
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
              {diffTreeOpen && diffTree.length ? (
                <nav className="workspace-diff-tree" aria-label="Changed files">
                  <header>
                    <strong>Files</strong>
                    <span>{diffTree.filter((entry) => !entry.directory).length}</span>
                    <button
                      className="icon-button"
                      aria-label={
                        diffTree
                          .filter((entry) => entry.directory)
                          .every((entry) => diffTreeCollapsed.has(entry.path))
                          ? 'Expand changed folders'
                          : 'Collapse changed folders'
                      }
                      disabled={!diffTree.some((entry) => entry.directory)}
                      onClick={() =>
                        setDiffTreeCollapsed((current) =>
                          diffTree
                            .filter((entry) => entry.directory)
                            .every((entry) => current.has(entry.path))
                            ? new Set()
                            : new Set(
                                diffTree
                                  .filter((entry) => entry.directory)
                                  .map((entry) => entry.path),
                              ),
                        )
                      }
                    >
                      {diffTree
                        .filter((entry) => entry.directory)
                        .every((entry) => diffTreeCollapsed.has(entry.path)) ? (
                        <ChevronsUpDown size={14} />
                      ) : (
                        <ChevronsDownUp size={14} />
                      )}
                    </button>
                  </header>
                  <div className="workspace-diff-tree-rows">
                    {diffTree
                      .filter(
                        (entry) =>
                          !entry.path
                            .split('/')
                            .slice(0, -1)
                            .some((_, index, segments) =>
                              diffTreeCollapsed.has(segments.slice(0, index + 1).join('/')),
                            ),
                      )
                      .map((entry) => (
                        <button
                          key={`${entry.directory ? 'folder' : 'file'}:${entry.path}`}
                          className="file-row"
                          style={{ paddingLeft: 5 + entry.depth * 12 }}
                          aria-label={entry.path}
                          aria-expanded={
                            entry.directory ? !diffTreeCollapsed.has(entry.path) : undefined
                          }
                          aria-current={
                            !entry.directory && selectedDiff === entry.path ? 'true' : undefined
                          }
                          title={entry.path}
                          onClick={() => {
                            if (!entry.directory) {
                              revealDiff(entry.path)
                              return
                            }
                            setDiffTreeCollapsed((current) => {
                              const next = new Set(current)
                              if (next.has(entry.path)) next.delete(entry.path)
                              else next.add(entry.path)
                              return next
                            })
                          }}
                        >
                          {entry.directory ? (
                            diffTreeCollapsed.has(entry.path) ? (
                              <ChevronRight size={12} />
                            ) : (
                              <ChevronDown size={12} />
                            )
                          ) : (
                            <span className="file-tree-chevron-space" aria-hidden="true" />
                          )}
                          {entry.directory ? <Folder size={14} /> : <FileCode2 size={14} />}
                          <span>{entry.label}</span>
                        </button>
                      ))}
                  </div>
                </nav>
              ) : null}
            </div>
          )}
        </>
      )}
      <footer className="workspace-footer">
        <span className={`status-dot ${connection.status === 'connected' ? 'online' : ''}`} />
        <span
          title={
            connection.profile?.transport === 'local'
              ? 'Runs on the computer running Life'
              : connection.profile?.host
          }
        >
          {connection.status === 'connected'
            ? connection.profile?.transport === 'local'
              ? 'Local'
              : connection.profile?.host
            : 'No machine connected'}
        </span>
        {ownsData && tab === 'diff' && git.branch && git.branch !== 'No repository' ? (
          <span className="workspace-footer-branch" title={git.branch}>
            <GitBranch size={11} /> {git.branch}
          </span>
        ) : null}
        <button
          className="icon-button"
          aria-label={
            connection.profile?.transport === 'local'
              ? 'Open local terminal'
              : 'Open remote terminal'
          }
          onClick={onTerminal}
        >
          <Terminal size={14} />
        </button>
      </footer>
    </aside>
  )
}
