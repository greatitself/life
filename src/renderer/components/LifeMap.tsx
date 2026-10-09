import { useState, type CSSProperties } from 'react'
import { Check, Folder, Network, Plus, Search, X } from 'lucide-react'
import type { ConnectionProfile, ConnectionState } from '../../shared/types'
import type { Thread } from '../state'
import type { WorkspaceProject } from '../workbench'
import { GraphCanvas, type CanvasEdge, type CanvasNode } from './GraphCanvas'
import { Modal } from './Modal'
import { ProviderIcon } from './Icons'
import { useProjectKeyColor } from './ProjectColors'

type MapState = {
  projects: WorkspaceProject[]
  connect: (project: WorkspaceProject) => boolean
  detach: (key: string) => boolean
}
function ProjectNode({
  project,
  working,
  onOpen,
  onDetach,
}: {
  project: WorkspaceProject
  working: number
  onOpen: () => void
  onDetach: () => void
}) {
  const color = useProjectKeyColor(project.key)
  const initials = project.title
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <div className="life-project-node" style={{ '--project-color': color } as CSSProperties}>
      <button className="life-node-main" onClick={onOpen} title={project.workspace}>
        <span className="life-node-project-badge">{initials || 'P'}</span>
        <span className="life-node-title">
          <strong>{project.title}</strong>
          <small>{project.host || project.workspace}</small>
        </span>
        {working ? (
          <span className="life-node-count" aria-label={working + ' working threads'}>
            {working}
          </span>
        ) : null}
      </button>
      <button
        className="life-node-remove"
        aria-label={'Disconnect ' + project.title + ' from map'}
        title="Disconnect from map"
        onClick={onDetach}
      >
        <X size={12} />
      </button>
    </div>
  )
}
export function LifeMap({
  map,
  catalog,
  threads,
  onOpenProject,
  onChooseWorkspace,
  onOpenWorkspace,
}: {
  map: MapState
  catalog: WorkspaceProject[]
  threads: Thread[]
  profiles: ConnectionProfile[]
  connection: ConnectionState
  theme: 'dark' | 'light'
  onNotify: (text: string) => void
  onOpenProject: (project: WorkspaceProject) => void
  onChooseWorkspace: () => void
  onOpenWorkspace: (profileId?: string, threadId?: string) => void
}) {
  const [picker, setPicker] = useState(false)
  const [query, setQuery] = useState('')
  const projects = map.projects.map(
    (project) => catalog.find((item) => item.key === project.key) || project,
  )
  const groups = projects.map((project) => ({
    project,
    working: threads.filter(
      (thread) =>
        thread.profileId === project.profileId &&
        thread.workspace === project.workspace &&
        (thread.busy || thread.pending.length > 0),
    ),
  }))
  const heights = groups.map((group) => Math.max(130, group.working.length * 66 + 24))
  const total = heights.reduce((sum, height) => sum + height, 0)
  const nodes: CanvasNode[] = [
    {
      id: 'life',
      x: 0,
      y: -34,
      width: 172,
      height: 68,
      content: (
        <div className="life-root-node">
          <Network size={20} />
          <strong>
            Life<span className="life-map-dot">.</span>
          </strong>
          <button
            aria-label="Connect a project"
            title="Connect a project"
            onClick={() => setPicker(true)}
          >
            <Plus size={16} />
          </button>
        </div>
      ),
    },
  ]
  const edges: CanvasEdge[] = []
  let cursor = -total / 2
  groups.forEach(({ project, working }, index) => {
    const center = cursor + heights[index]! / 2
    const projectId = 'project:' + project.key
    nodes.push({
      id: projectId,
      x: 325,
      y: center - 37,
      width: 226,
      height: 74,
      content: (
        <ProjectNode
          project={project}
          working={working.length}
          onOpen={() => onOpenProject(project)}
          onDetach={() => map.detach(project.key)}
        />
      ),
    })
    edges.push({ from: 'life', to: projectId })
    working.forEach((thread, position) => {
      const threadId = 'thread:' + thread.id
      const waiting = thread.pending.length > 0
      nodes.push({
        id: threadId,
        x: 686,
        y: center - (working.length * 66) / 2 + position * 66 + 6,
        width: 240,
        height: 54,
        content: (
          <button
            className="life-map-thread-node"
            onClick={() => onOpenWorkspace(thread.profileId, thread.id)}
            title={thread.title}
          >
            <span
              className={'thread-run-ring' + (waiting ? ' is-waiting' : '')}
              aria-hidden="true"
            />
            <span>
              <strong>{thread.title}</strong>
              <small>{waiting ? 'Needs input' : 'Working'}</small>
            </span>
            <ProviderIcon provider={thread.provider} size={15} />
          </button>
        ),
      })
      edges.push({ from: projectId, to: threadId })
    })
    cursor += heights[index]!
  })
  const search = query.trim().toLocaleLowerCase()
  const results = catalog.filter((project) =>
    [project.title, project.workspace, project.host].join(' ').toLocaleLowerCase().includes(search),
  )
  return (
    <div className="life-map">
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        fitKey={groups
          .map(
            (group) => group.project.key + ':' + group.working.map((thread) => thread.id).join(','),
          )
          .join('|')}
        label="Life project map"
      >
        <div className="life-canvas-overlay">
          <button
            className="life-canvas-add"
            onClick={() => {
              setQuery('')
              setPicker(true)
            }}
          >
            <Plus size={15} /> Connect project
          </button>
        </div>
      </GraphCanvas>
      {picker ? (
        <Modal
          title="Connect project"
          description="Choose a project for your map."
          open={picker}
          onOpenChange={setPicker}
        >
          <div className="life-map-picker">
            <label className="life-workbench-search">
              <Search size={15} />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
              />
            </label>
            <div className="life-map-project-options">
              {results.map((project) => {
                const connected = map.projects.some((item) => item.key === project.key)
                return (
                  <button
                    key={project.key}
                    disabled={connected}
                    onClick={() => {
                      if (map.connect(project)) setPicker(false)
                    }}
                  >
                    <Folder size={17} />
                    <span>
                      <strong>{project.title}</strong>
                      <small>
                        {project.host ? project.host + ' · ' : ''}
                        {project.workspace}
                      </small>
                    </span>
                    {connected ? <Check size={15} /> : <Plus size={15} />}
                  </button>
                )
              })}
              {!results.length && search ? <p>No matching projects.</p> : null}
            </div>
            <button
              className="life-map-choose-workspace"
              onClick={() => {
                setPicker(false)
                onChooseWorkspace()
              }}
            >
              <Plus size={15} /> Choose another workspace
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
