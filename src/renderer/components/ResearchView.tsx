import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileCode2,
  FolderGit2,
  GitBranch,
  List,
  LoaderCircle,
  Maximize,
  Network,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import type { ConnectionProfile } from '../../shared/types'
import type { Thread } from '../state'
import {
  buildResearchGraph,
  MAX_PROJECTS,
  createProject,
  deleteProject,
  exportResearchBackup,
  importResearchBackup,
  readProjects,
  reconcileProjects,
  saveProjects,
  updateProject,
  type ResearchProject,
} from '../research'
import { queueMermaidRender } from '../mermaid'
import { Modal } from './Modal'
import './research.css'

const statusLabels = {
  active: 'Active',
  planned: 'Planned',
  paused: 'Paused',
  complete: 'Complete',
} as const
const statuses = Object.keys(statusLabels) as ResearchProject['status'][]
const hiddenWorkspacesKey = 'life.research.hiddenWorkspaces.v1'
const viewSettingsKey = 'life.research.view.v1'

interface ViewSettings {
  view: 'graph' | 'list'
  direction: 'LR' | 'TB'
  groupBy: 'none' | 'status' | 'machine'
}

function readViewSettings(): ViewSettings {
  const fallback: ViewSettings = { view: 'graph', direction: 'LR', groupBy: 'none' }
  try {
    const value = JSON.parse(localStorage.getItem(viewSettingsKey) || '{}')
    return {
      view: value.view === 'list' ? 'list' : 'graph',
      direction: value.direction === 'TB' ? 'TB' : 'LR',
      groupBy: ['status', 'machine'].includes(value.groupBy) ? value.groupBy : 'none',
    }
  } catch {
    return fallback
  }
}

function readHiddenWorkspaces(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(hiddenWorkspacesKey) || '[]')
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string').slice(0, 1000)
      : []
  } catch {
    return []
  }
}

interface ProjectDraft {
  id?: string
  title: string
  summary: string
  notes: string
  status: ResearchProject['status']
  tags: string
  profileId: string
  dependencies: string[]
}

function projectDraft(project?: ResearchProject): ProjectDraft {
  return {
    id: project?.id,
    title: project?.title || '',
    summary: project?.summary || '',
    notes: project?.notes || '',
    status: project?.status || 'planned',
    tags: project?.tags.join(', ') || '',
    profileId: project?.profileId || '',
    dependencies: project?.dependencies || [],
  }
}

function download(content: string, fileName: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ResearchView({
  profiles,
  threads,
  theme,
  onOpenWorkspace,
  onNotify,
}: {
  profiles: ConnectionProfile[]
  threads: Thread[]
  theme: 'dark' | 'light'
  onOpenWorkspace: (profileId?: string, threadId?: string) => void
  onNotify: (message: string) => void
}) {
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState(readHiddenWorkspaces)
  const [projects, setProjects] = useState(() =>
    readProjects(profiles.filter((profile) => !readHiddenWorkspaces().includes(profile.id))),
  )
  const [settings, setSettings] = useState(readViewSettings)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [statusFilter, setStatusFilter] = useState<'all' | ResearchProject['status']>('all')
  const [selectedId, setSelectedId] = useState<string>()
  const [draft, setDraft] = useState<ProjectDraft>()
  const [deleteTarget, setDeleteTarget] = useState<ResearchProject>()
  const [formError, setFormError] = useState('')
  const [storageError, setStorageError] = useState('')
  const [backupError, setBackupError] = useState('')
  const [importingBackup, setImportingBackup] = useState(false)
  const [graph, setGraph] = useState('')
  const [rendering, setRendering] = useState(false)
  const [graphError, setGraphError] = useState('')
  const [renderAttempt, setRenderAttempt] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [sourceOpen, setSourceOpen] = useState(false)
  const graphRef = useRef<HTMLDivElement>(null)
  const renderSequence = useRef(0)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const currentProjects = useRef(projects)
  currentProjects.current = projects
  const diagramId = `life-research-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  useEffect(() => {
    setProjects((current) =>
      reconcileProjects(
        current,
        profiles.filter((profile) => !hiddenWorkspaces.includes(profile.id)),
      ),
    )
  }, [profiles, hiddenWorkspaces])

  useEffect(() => {
    try {
      saveProjects(projects)
      localStorage.setItem(hiddenWorkspacesKey, JSON.stringify(hiddenWorkspaces))
      setStorageError('')
    } catch {
      setStorageError(
        'Life could not save this research map. Choose Backup projects to save your notes and project details before closing.',
      )
    }
  }, [projects, hiddenWorkspaces])

  useEffect(() => {
    try {
      localStorage.setItem(viewSettingsKey, JSON.stringify(settings))
    } catch {
      // Projects are persisted separately; view preferences can remain in memory.
    }
  }, [settings])

  const profilesById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  )
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  )
  const visibleProjects = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase()
    return projects.filter((project) => {
      if (statusFilter !== 'all' && project.status !== statusFilter) return false
      if (!search) return true
      const machine = project.profileId ? profilesById.get(project.profileId) : undefined
      return [project.title, project.summary, project.notes, ...project.tags, machine?.name || '']
        .join(' ')
        .toLowerCase()
        .includes(search)
    })
  }, [projects, deferredQuery, statusFilter, profilesById])
  const researchGraph = useMemo(
    () => buildResearchGraph(visibleProjects, settings, profiles),
    [visibleProjects, settings.direction, settings.groupBy, profiles],
  )
  const selectedProject = projects.find((project) => project.id === selectedId) || projects[0]
  const selectedProfile = selectedProject?.profileId
    ? profilesById.get(selectedProject.profileId)
    : undefined
  const projectThreads = selectedProject?.profileId
    ? threads
        .filter((thread) => thread.profileId === selectedProject.profileId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : []
  const activeCount = projects.filter((project) => project.status === 'active').length
  const dependencyCount = projects.reduce(
    (total, project) => total + project.dependencies.length,
    0,
  )

  useEffect(() => {
    if (settings.view !== 'graph' || visibleProjects.length === 0) return
    let cancelled = false
    setRendering(true)
    setGraphError('')
    const render = async () => {
      const { default: mermaid } = await import('mermaid')
      if (cancelled) return
      const dark = theme === 'dark'
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        look: 'classic',
        htmlLabels: true,
        suppressErrorRendering: true,
        fontFamily: 'DM Sans Variable, sans-serif',
        themeVariables: {
          darkMode: dark,
          background: dark ? '#121212' : '#ffffff',
          primaryColor: dark ? '#1c1c1c' : '#ffffff',
          primaryTextColor: dark ? '#ededed' : '#151515',
          primaryBorderColor: dark ? '#626262' : '#b4b4b4',
          lineColor: dark ? '#808080' : '#777777',
          secondaryColor: dark ? '#242424' : '#f3f3f3',
          tertiaryColor: dark ? '#171717' : '#fafafa',
          clusterBkg: dark ? '#171717' : '#fafafa',
          clusterBorder: dark ? '#363636' : '#dddddd',
          edgeLabelBackground: dark ? '#121212' : '#ffffff',
        },
        flowchart: {
          htmlLabels: true,
          useMaxWidth: false,
          curve: 'basis',
          nodeSpacing: 44,
          rankSpacing: 76,
          padding: 20,
        },
      })
      // Mermaid removes an existing element with its render ID. Each render needs a fresh ID,
      // especially when reopening a cached diagram after switching from the project list.
      const rendered = await mermaid.render(
        `${diagramId}-${++renderSequence.current}`,
        researchGraph.source,
      )
      if (!cancelled) setGraph(rendered.svg)
    }
    // Mermaid has global configuration. Serializing renders prevents a theme change racing an import.
    const task = queueMermaidRender(render)
    void task
      .catch((error: unknown) => {
        if (!cancelled) {
          setGraph('')
          setGraphError(
            error instanceof Error ? error.message : 'The project map could not render.',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setRendering(false)
      })
    return () => {
      cancelled = true
    }
  }, [researchGraph.source, settings.view, theme, diagramId, renderAttempt, visibleProjects.length])

  useEffect(() => {
    const nodes = graphRef.current?.querySelectorAll<SVGGElement>('g.node')
    for (const node of nodes || []) {
      const projectId = resolveNode(node)
      const project = projectId ? projectsById.get(projectId) : undefined
      node.setAttribute('role', 'button')
      node.setAttribute('tabindex', '0')
      node.setAttribute('aria-label', project ? `Select ${project.title}` : 'Select project')
      node.setAttribute('aria-pressed', String(project?.id === selectedProject?.id))
      node.classList.toggle('research-node-selected', project?.id === selectedProject?.id)
    }
  }, [graph, researchGraph.nodeIds, selectedProject?.id, projectsById])

  function resolveNode(node: Element): string | undefined {
    const nodeKey = node.getAttribute('data-id')
    if (nodeKey && researchGraph.nodeIds[nodeKey]) return researchGraph.nodeIds[nodeKey]
    const id = node.getAttribute('id') || ''
    const key = Object.keys(researchGraph.nodeIds).find((candidate) =>
      id.includes(`flowchart-${candidate}-`),
    )
    return key ? researchGraph.nodeIds[key] : undefined
  }

  function selectGraphNode(event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    if (rendering) return
    if ('key' in event && !['Enter', ' '].includes(event.key)) return
    if (!(event.target instanceof Element)) return
    const node = event.target.closest('g.node')
    if (!node) return
    const projectId = resolveNode(node)
    if (projectId) {
      if ('key' in event) event.preventDefault()
      setSelectedId(projectId)
    }
  }

  function edit(project?: ResearchProject) {
    setFormError('')
    setDraft(projectDraft(project))
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    if (!draft.title.trim()) {
      setFormError('Give this project a title.')
      return
    }
    if (!draft.id && projects.length >= MAX_PROJECTS) {
      setFormError(`This map supports ${MAX_PROJECTS} projects. Remove one before adding another.`)
      return
    }
    const patch = {
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      notes: draft.notes,
      status: draft.status,
      tags: draft.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      profileId: draft.profileId || undefined,
      dependencies: draft.dependencies,
    }
    if (draft.id) {
      setProjects((current) => updateProject(current, draft.id!, patch))
      setSelectedId(draft.id)
    } else {
      const project = createProject(patch)
      setProjects((current) => [...current, project])
      setSelectedId(project.id)
    }
    setDraft(undefined)
    onNotify(draft.id ? 'Research project updated.' : 'Research project added.')
  }

  function removeProject() {
    if (!deleteTarget) return
    if (deleteTarget.profileId) {
      setHiddenWorkspaces((current) => [...new Set([...current, deleteTarget.profileId!])])
    }
    setProjects((current) => deleteProject(current, deleteTarget.id))
    setSelectedId(undefined)
    setDeleteTarget(undefined)
    onNotify('Project removed from the research map.')
  }

  function exportSvg() {
    if (!graph) return
    download(graph, 'life-research-map.svg', 'image/svg+xml;charset=utf-8')
    onNotify('Research map exported as SVG.')
  }

  function backupProjects() {
    download(
      exportResearchBackup(projects),
      `life-research-backup-${new Date().toISOString().slice(0, 10)}.json`,
      'application/json;charset=utf-8',
    )
    onNotify('All research projects, notes, and metadata backed up as JSON.')
  }

  async function importProjects(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setBackupError('')
    setImportingBackup(true)
    try {
      if (file.size > 16_000_000)
        throw new Error('Choose a Life research backup smaller than 16 MB.')
      const source = await file.text()
      const result = importResearchBackup(source, currentProjects.current)
      setProjects(result.projects)
      onNotify(
        `Research backup imported: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped. Newer local edits are kept.`,
      )
    } catch (error) {
      setBackupError(
        error instanceof Error ? error.message : 'The research backup could not import.',
      )
    } finally {
      setImportingBackup(false)
    }
  }

  return (
    <section className="research-view" aria-label="Research workspace">
      <header className="research-heading">
        <div>
          <div className="eyebrow">RESEARCH WORKSPACE</div>
          <h1>See the work. Find the next question.</h1>
          <p>Projects, dependencies, and the machines where your research happens.</p>
        </div>
        <button className="button primary" onClick={() => edit()}>
          <Plus size={16} /> New project
        </button>
      </header>

      <div className="research-overview" aria-label="Research map summary">
        <span>
          <strong>{projects.length}</strong> {projects.length === 1 ? 'project' : 'projects'}
        </span>
        <span>
          <span className="research-status-marker active" />
          <strong>{activeCount}</strong> active
        </span>
        <span>
          <GitBranch size={13} />
          <strong>{dependencyCount}</strong> dependencies
        </span>
        <span className="research-overview-tail">Stored on this computer</span>
      </div>

      <div className="research-toolbar">
        <label className="research-search">
          <Search size={15} />
          <input
            aria-label="Search research projects"
            placeholder="Find a project, tag, or machine…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button aria-label="Clear project search" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          ) : null}
        </label>
        <select
          aria-label="Filter project status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
        >
          <option value="all">All statuses</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {statusLabels[status]}
            </option>
          ))}
        </select>
        {settings.view === 'graph' ? (
          <>
            <select
              aria-label="Group projects"
              value={settings.groupBy}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  groupBy: event.target.value as ViewSettings['groupBy'],
                }))
              }
            >
              <option value="none">No grouping</option>
              <option value="status">Group by status</option>
              <option value="machine">Group by machine</option>
            </select>
            <button
              className="research-direction icon-button"
              aria-label={
                settings.direction === 'LR'
                  ? 'Switch to top to bottom graph'
                  : 'Switch to left to right graph'
              }
              title={
                settings.direction === 'LR' ? 'Layout: left to right' : 'Layout: top to bottom'
              }
              onClick={() =>
                setSettings((current) => ({
                  ...current,
                  direction: current.direction === 'LR' ? 'TB' : 'LR',
                }))
              }
            >
              {settings.direction === 'LR' ? <ArrowRight size={16} /> : <ArrowDown size={16} />}
            </button>
          </>
        ) : null}
        <div className="research-view-toggle" role="group" aria-label="Project presentation">
          <button
            aria-label="Show project graph"
            aria-pressed={settings.view === 'graph'}
            onClick={() => setSettings((current) => ({ ...current, view: 'graph' }))}
          >
            <Network size={15} />
            <span>Map</span>
          </button>
          <button
            aria-label="Show project list"
            aria-pressed={settings.view === 'list'}
            onClick={() => setSettings((current) => ({ ...current, view: 'list' }))}
          >
            <List size={15} />
            <span>List</span>
          </button>
        </div>
        <div className="research-backup-actions" role="group" aria-label="Project backups">
          <button
            className="research-backup-button"
            aria-label="Backup projects"
            title="Download all projects, notes, and metadata as a JSON backup"
            onClick={backupProjects}
          >
            <Download size={14} /> <span>Backup projects</span>
          </button>
          <button
            className="icon-button"
            aria-label="Import projects"
            title="Merge a Life research backup; keep the most recently edited projects"
            disabled={importingBackup}
            onClick={() => backupInputRef.current?.click()}
          >
            {importingBackup ? (
              <LoaderCircle size={14} className="spinning" />
            ) : (
              <Upload size={14} />
            )}
          </button>
          <input
            ref={backupInputRef}
            className="research-backup-input"
            type="file"
            accept=".json,application/json"
            aria-label="Import research backup"
            onChange={(event) => void importProjects(event)}
          />
        </div>
      </div>

      {storageError ? (
        <div className="research-storage-error" role="alert">
          {storageError}
        </div>
      ) : null}
      {backupError ? (
        <div className="research-storage-error" role="alert">
          {backupError}
        </div>
      ) : null}

      <div className={`research-content ${projects.length === 0 ? 'research-content-empty' : ''}`}>
        <div className="research-canvas">
          {projects.length === 0 ? (
            <div className="research-empty">
              <div className="research-empty-mark">
                <Network size={32} strokeWidth={1.2} />
              </div>
              <h2>Give your research a map.</h2>
              <p>
                Add your first project, then connect ideas and open the agent workspace when it is
                time to build.
              </p>
              <button className="button primary" onClick={() => edit()}>
                <Plus size={15} /> Add a research project
              </button>
              <button className="text-button" onClick={() => onOpenWorkspace()}>
                Connect a research machine <ArrowUpRight size={13} />
              </button>
            </div>
          ) : visibleProjects.length === 0 ? (
            <div className="research-empty research-filter-empty">
              <Search size={28} strokeWidth={1.3} />
              <h2>No matching projects.</h2>
              <p>Try another search or include all project statuses.</p>
              <button
                className="button secondary"
                onClick={() => {
                  setQuery('')
                  setStatusFilter('all')
                }}
              >
                Clear filters
              </button>
            </div>
          ) : settings.view === 'list' ? (
            <div className="research-project-list" aria-label="Research projects">
              <div className="research-list-heading">
                <span>Project</span>
                <span>Status</span>
                <span>Machine</span>
              </div>
              {visibleProjects.map((project) => {
                const profile = project.profileId ? profilesById.get(project.profileId) : undefined
                return (
                  <button
                    key={project.id}
                    className={`research-project-row ${selectedProject?.id === project.id ? 'selected' : ''}`}
                    aria-pressed={selectedProject?.id === project.id}
                    onClick={() => setSelectedId(project.id)}
                  >
                    <span className="research-list-title">
                      <FolderGit2 size={17} />
                      <span>
                        <strong>{project.title}</strong>
                        <small>{project.summary || 'No research question added yet.'}</small>
                      </span>
                    </span>
                    <span className="research-status">
                      <span className={`research-status-marker ${project.status}`} />
                      {statusLabels[project.status]}
                    </span>
                    <span className="research-list-machine">{profile?.name || 'Unassigned'}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              <div className="research-canvas-caption">
                <span>
                  <Network size={13} /> PROJECT DEPENDENCIES
                </span>
                <span>{visibleProjects.length} visible · arrows point to dependent projects</span>
              </div>
              <div
                className="research-graph-viewport"
                tabIndex={0}
                aria-label="Project graph. Scroll to explore, or select a project for details."
              >
                {graphError ? (
                  <div className="research-empty research-graph-error" role="alert">
                    <h2>The map could not render.</h2>
                    <p>{graphError}</p>
                    <button
                      className="button secondary"
                      onClick={() => setRenderAttempt((current) => current + 1)}
                    >
                      Try again
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setSettings((current) => ({ ...current, view: 'list' }))}
                    >
                      Show project list
                    </button>
                  </div>
                ) : (
                  <div
                    className="research-graph-svg"
                    ref={graphRef}
                    style={{ zoom }}
                    onClick={selectGraphNode}
                    onKeyDown={selectGraphNode}
                    dangerouslySetInnerHTML={{ __html: graph }}
                  />
                )}
                {rendering ? (
                  <div className="research-rendering" role="status">
                    <LoaderCircle size={15} className="spinning" /> Updating map
                  </div>
                ) : null}
              </div>
              <div className="research-canvas-footer">
                <div className="research-zoom-controls" role="group" aria-label="Graph zoom">
                  <button
                    className="icon-button"
                    aria-label="Zoom out"
                    disabled={zoom <= 0.4}
                    onClick={() => setZoom((current) => Math.max(0.4, +(current - 0.2).toFixed(1)))}
                  >
                    <ZoomOut size={15} />
                  </button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <button
                    className="icon-button"
                    aria-label="Zoom in"
                    disabled={zoom >= 2.4}
                    onClick={() => setZoom((current) => Math.min(2.4, +(current + 0.2).toFixed(1)))}
                  >
                    <ZoomIn size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Fit graph to view"
                    onClick={() => {
                      const svg = graphRef.current?.querySelector('svg')
                      const viewport = graphRef.current?.parentElement
                      if (svg && viewport) {
                        const box = svg.viewBox.baseVal
                        const width = box.width || svg.getBoundingClientRect().width / zoom
                        const height = box.height || svg.getBoundingClientRect().height / zoom
                        setZoom(
                          Math.max(
                            0.2,
                            Math.min(
                              1.5,
                              (viewport.clientWidth - 60) / width,
                              (viewport.clientHeight - 60) / height,
                            ),
                          ),
                        )
                        viewport.scrollTo({ top: 0, left: 0 })
                      }
                    }}
                  >
                    <Maximize size={14} />
                  </button>
                </div>
                <div className="research-export-controls">
                  <button className="text-button" onClick={() => setSourceOpen(true)}>
                    <FileCode2 size={14} />
                    <span>Mermaid source</span>
                  </button>
                  <button
                    className="text-button"
                    disabled={!graph || rendering}
                    onClick={exportSvg}
                  >
                    <Download size={14} />
                    <span>Export SVG</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {selectedProject ? (
          <aside className="research-inspector" aria-label="Selected project details">
            <div className="research-inspector-top">
              <span className="eyebrow">PROJECT DETAILS</span>
              <div>
                <button
                  className="icon-button"
                  aria-label="Edit selected project"
                  onClick={() => edit(selectedProject)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Delete selected project"
                  onClick={() => setDeleteTarget(selectedProject)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <span className="research-status">
              <span className={`research-status-marker ${selectedProject.status}`} />
              {statusLabels[selectedProject.status]}
            </span>
            <h2>{selectedProject.title}</h2>
            <p className={`research-project-summary ${selectedProject.summary ? '' : 'muted'}`}>
              {selectedProject.summary ||
                'Add a research question or the outcome you want to reach.'}
            </p>
            {selectedProject.tags.length > 0 ? (
              <div className="research-tags">
                {selectedProject.tags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setQuery(tag)}
                    title={`Find projects tagged ${tag}`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="research-machine-card">
              <span className="eyebrow">WORKSPACE</span>
              {selectedProfile ? (
                <>
                  <strong>{selectedProfile.name}</strong>
                  <code>
                    {selectedProfile.username}@{selectedProfile.host}
                  </code>
                  <code title={selectedProfile.workspace}>{selectedProfile.workspace}</code>
                </>
              ) : (
                <p>
                  {selectedProject.profileId
                    ? 'The linked machine profile was removed.'
                    : 'Link a machine to work on this project with an agent.'}
                </p>
              )}
              <button
                className="button secondary"
                onClick={() =>
                  onOpenWorkspace(
                    selectedProfile?.id,
                    selectedProfile ? projectThreads[0]?.id : undefined,
                  )
                }
              >
                {selectedProfile ? 'Open agent workspace' : 'Choose a machine'}
                <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="research-detail-section">
              <h3>
                Depends on <span>{selectedProject.dependencies.length}</span>
              </h3>
              {selectedProject.dependencies.length ? (
                selectedProject.dependencies.map((id) => {
                  const project = projectsById.get(id)
                  return project ? (
                    <button
                      className="research-dependency-link"
                      key={id}
                      onClick={() => setSelectedId(id)}
                    >
                      <GitBranch size={14} />
                      <span>{project.title}</span>
                      <ArrowUpRight size={12} />
                    </button>
                  ) : null
                })
              ) : (
                <p>No dependencies. Connect a project when this work builds on it.</p>
              )}
              <button className="text-button" onClick={() => edit(selectedProject)}>
                <Plus size={12} /> Edit dependencies
              </button>
            </div>
            <div className="research-detail-section">
              <h3>Research notes</h3>
              <p className={`research-project-notes ${selectedProject.notes ? '' : 'muted'}`}>
                {selectedProject.notes ||
                  'Keep questions, findings, and next steps with this project.'}
              </p>
            </div>
            <div className="research-detail-section research-thread-section">
              <h3>
                Agent threads <span>{projectThreads.length}</span>
              </h3>
              {projectThreads.length ? (
                projectThreads.slice(0, 5).map((thread) => (
                  <button
                    className="research-thread-link"
                    key={thread.id}
                    onClick={() => onOpenWorkspace(thread.profileId, thread.id)}
                  >
                    <span className={`research-thread-dot ${thread.busy ? 'busy' : ''}`} />
                    <span>{thread.title}</span>
                    <ArrowUpRight size={12} />
                  </button>
                ))
              ) : (
                <p>Agent conversations on the linked workspace will appear here.</p>
              )}
            </div>
          </aside>
        ) : null}
      </div>

      <Modal
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) setDraft(undefined)
        }}
        title={draft?.id ? 'Edit research project' : 'New research project'}
        description="Give the work a question, connect its dependencies, and choose where to build."
        className="research-project-modal"
      >
        {draft ? (
          <form onSubmit={save}>
            <div className="research-project-form">
              <label>
                Project title
                <input
                  required
                  maxLength={160}
                  placeholder="What are you researching?"
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <label>
                Research question or goal
                <textarea
                  rows={2}
                  maxLength={2000}
                  placeholder="What do you want to learn or make possible?"
                  value={draft.summary}
                  onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                />
              </label>
              <div className="research-form-pair">
                <label>
                  Status
                  <select
                    value={draft.status}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        status: event.target.value as ResearchProject['status'],
                      })
                    }
                  >
                    {statuses.map((status) => (
                      <option key={status} value={status}>
                        {statusLabels[status]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Machine
                  <select
                    value={draft.profileId}
                    onChange={(event) => setDraft({ ...draft, profileId: event.target.value })}
                  >
                    <option value="">Unassigned</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Tags <span>separate with commas</span>
                <input
                  maxLength={1000}
                  placeholder="agents, evaluation, experiment"
                  value={draft.tags}
                  onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                />
              </label>
              {projects.some((project) => project.id !== draft.id) ? (
                <fieldset className="research-dependency-options">
                  <legend>Depends on</legend>
                  <div>
                    {projects
                      .filter((project) => project.id !== draft.id)
                      .map((project) => (
                        <label key={project.id}>
                          <input
                            type="checkbox"
                            checked={draft.dependencies.includes(project.id)}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                dependencies: event.target.checked
                                  ? [...draft.dependencies, project.id]
                                  : draft.dependencies.filter((id) => id !== project.id),
                              })
                            }
                          />
                          <span>{project.title}</span>
                        </label>
                      ))}
                  </div>
                </fieldset>
              ) : null}
              <label>
                Research notes
                <textarea
                  rows={4}
                  maxLength={8000}
                  placeholder="Questions, observations, next steps…"
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </label>
            </div>
            {formError ? (
              <div className="form-error" role="alert">
                {formError}
              </div>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDraft(undefined)}
              >
                Cancel
              </button>
              <button type="submit" className="button primary">
                <Check size={15} />
                {draft.id ? 'Save project' : 'Add project'}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined)
        }}
        title="Remove this research project?"
        description="Its entry, notes, and dependency links will be removed from this map. Your remote files and agent threads stay available."
      >
        <p className="research-delete-title">{deleteTarget?.title}</p>
        <div className="modal-actions">
          <button className="button secondary" onClick={() => setDeleteTarget(undefined)}>
            Keep project
          </button>
          <button className="button primary" onClick={removeProject}>
            <Trash2 size={15} /> Remove project
          </button>
        </div>
      </Modal>

      <Modal
        open={sourceOpen}
        onOpenChange={setSourceOpen}
        title="Mermaid source"
        description="Use this diagram in your research notes, documentation, or another Mermaid renderer."
        className="research-source-modal"
      >
        <pre className="research-source">
          <code>{researchGraph.source}</code>
        </pre>
        <div className="modal-actions">
          <button
            className="button secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(researchGraph.source)
                onNotify('Mermaid source copied.')
              } catch {
                onNotify('Clipboard is unavailable. Download the source instead.')
              }
            }}
          >
            <Copy size={15} /> Copy source
          </button>
          <button
            className="button primary"
            onClick={() => {
              download(researchGraph.source, 'life-research-map.mmd', 'text/plain;charset=utf-8')
              onNotify('Mermaid source exported.')
            }}
          >
            <Download size={15} /> Download source
          </button>
        </div>
      </Modal>
    </section>
  )
}
