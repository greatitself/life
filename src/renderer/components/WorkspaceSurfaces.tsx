import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bot,
  FileDiff,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Link,
  PanelRight,
  Plus,
  Smartphone,
  Terminal,
  X,
} from 'lucide-react'
import type { ConnectionState } from '../../shared/types'
import type { Thread } from '../state'
import { WorkspacePanel, type WorkspaceTab } from './WorkspacePanel'
import { RemoteTerminal } from './RemoteTerminal'
import { BrowserSurface } from './BrowserSurface'
import { PullRequestSurface } from './PullRequestSurface'
import { ResizeHandle, type ResizeProps } from './SidebarResize'
import './workspace-surfaces.css'

type Surface =
  | 'browser'
  | 'terminal'
  | 'files'
  | 'diff'
  | 'pull-request'
  | 'linked-pull-requests'
  | 'agents'
  | 'device'
  | 'git'
const surfaces = [
  { id: 'browser', label: 'Browser', icon: Globe, key: 'B' },
  { id: 'terminal', label: 'Terminal', icon: Terminal, key: 'T' },
  { id: 'files', label: 'Files', icon: Folder, key: 'F' },
  { id: 'diff', label: 'Diff', icon: FileDiff, key: 'D' },
  { id: 'pull-request', label: 'Pull request', icon: GitPullRequest, key: 'P' },
  { id: 'linked-pull-requests', label: 'Linked pull requests', icon: Link, key: 'L' },
  { id: 'agents', label: 'Agents', icon: Bot, key: 'A' },
  { id: 'device', label: 'Device', icon: Smartphone, key: 'M' },
  { id: 'git', label: 'Git', icon: GitBranch, key: 'G' },
] as const
const codeSurface = (surface?: Surface): surface is WorkspaceTab =>
  surface === 'files' || surface === 'diff' || surface === 'git'
interface Props {
  connection: ConnectionState
  headerTarget: HTMLElement | null
  theme: 'dark' | 'light'
  terminalOpen: boolean
  onTerminalChange: (open: boolean) => void
  threads: Thread[]
  activeThread?: Thread
  onSelectThread: (thread: Thread) => void
  resize: ResizeProps
  onConnect: () => void
  onClose: () => void
  refreshKey: number
  onAttach: (path: string) => void
  onTerminal: () => void
}
export function WorkspaceSurfaces(props: Props) {
  const { connection, headerTarget, terminalOpen, onTerminalChange, theme, onClose, resize } = props
  const [tabs, setTabs] = useState<Surface[]>([])
  const [selected, setSelected] = useState<Surface>()
  const [picker, setPicker] = useState(true)
  const open = useCallback(
    (id: Surface) => {
      setTabs((current) => (current.includes(id) ? current : [...current, id]))
      setSelected(id)
      setPicker(false)
      if (id === 'terminal') onTerminalChange(true)
    },
    [onTerminalChange],
  )
  useEffect(() => {
    if (terminalOpen) open('terminal')
    else {
      setTabs((current) => current.filter((id) => id !== 'terminal'))
      setSelected((current) => (current === 'terminal' ? undefined : current))
    }
  }, [terminalOpen, open])
  function close(id: Surface) {
    const remaining = tabs.filter((tab) => tab !== id)
    setTabs(remaining)
    if (selected === id) setSelected(remaining[remaining.length - 1])
    if (!remaining.length) setPicker(true)
    if (id === 'terminal') onTerminalChange(false)
  }
  const controls = (
    <div className="surface-controls" aria-label="Workspace surface controls">
      <div className="surface-tabs" role="tablist" aria-label="Open workspace surfaces">
        {tabs.map((id) => {
          const item = surfaces.find((item) => item.id === id)!
          return (
            <div className="surface-tab" key={id} data-selected={selected === id && !picker}>
              <button
                type="button"
                role="tab"
                id={`surface-tab-${id}`}
                aria-controls={`surface-panel-${id}`}
                aria-selected={selected === id && !picker}
                tabIndex={selected === id ? 0 : -1}
                title={item.label}
                onClick={() => open(id)}
                onKeyDown={(event) => {
                  const index = tabs.indexOf(id)
                  let next: Surface | undefined
                  if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length]
                  else if (event.key === 'ArrowLeft')
                    next = tabs[(index + tabs.length - 1) % tabs.length]
                  else if (event.key === 'Home') next = tabs[0]
                  else if (event.key === 'End') next = tabs[tabs.length - 1]
                  else if (event.key === 'Delete') {
                    event.preventDefault()
                    close(id)
                    return
                  } else return
                  event.preventDefault()
                  open(next!)
                  document.getElementById(`surface-tab-${next}`)?.focus()
                }}
              >
                <item.icon size={14} />
                <span>{item.label}</span>
              </button>
              <button
                type="button"
                className="surface-tab-close"
                aria-label={`Close ${item.label}`}
                title={`Close ${item.label}`}
                onClick={() => close(id)}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label="Open a surface"
        title="Open a surface"
        aria-expanded={picker}
        onClick={() => setPicker((current) => !current)}
      >
        <Plus size={16} />
      </button>
    </div>
  )
  const collapse = (
    <div className="surface-collapse-row">
      <button
        type="button"
        className="icon-button surface-collapse-control"
        aria-label="Collapse workspace sidebar"
        title="Collapse workspace sidebar"
        aria-expanded={true}
        aria-controls="life-workspace-surfaces"
        onClick={onClose}
      >
        <PanelRight size={16} />
      </button>
    </div>
  )
  const ready = connection.status === 'connected' && Boolean(connection.workspace)
  const showPicker = picker || !selected
  const projectThreads = props.threads.filter(
    (thread) =>
      thread.profileId === connection.profile?.id && thread.workspace === connection.workspace,
  )
  const selectedThread = projectThreads.find((thread) => thread.id === props.activeThread?.id)
  const calls =
    selectedThread?.messages.filter(
      (message) =>
        message.role === 'tool' &&
        /spawn|collab.*agent|(?:^|[\s_])(?:agent|task)(?:$|[\s_])/i.test(message.title || ''),
    ) || []
  return (
    <aside
      className="workspace-surfaces"
      id="life-workspace-surfaces"
      aria-label="Workspace surfaces"
    >
      <ResizeHandle {...resize} />
      {headerTarget ? createPortal(collapse, headerTarget) : collapse}
      <div className="surface-body">
        {showPicker ? (
          <div
            className="surface-picker"
            tabIndex={0}
            onKeyDown={(event) => {
              if (
                event.target !== event.currentTarget ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey
              )
                return
              if (event.key === 'Escape' && selected) {
                event.preventDefault()
                setPicker(false)
                return
              }
              const item = surfaces.find(
                (item) => item.key.toLowerCase() === event.key.toLowerCase(),
              )
              if (item) {
                event.preventDefault()
                open(item.id)
              }
            }}
          >
            <h2>Open a surface</h2>
            <div>
              {surfaces.map((item) => (
                <button type="button" key={item.id} onClick={() => open(item.id)}>
                  <item.icon size={17} />
                  <span>{item.label}</span>
                  <kbd>{item.key}</kbd>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {tabs.some(codeSurface) ? (
          <div
            className="surface-pane surface-code"
            role="tabpanel"
            id={`surface-panel-${codeSurface(selected) ? selected : 'diff'}`}
            aria-labelledby={`surface-tab-${codeSurface(selected) ? selected : 'diff'}`}
            hidden={showPicker || !codeSurface(selected)}
          >
            <WorkspacePanel
              connection={connection}
              onConnect={props.onConnect}
              onClose={onClose}
              refreshKey={props.refreshKey}
              onAttach={props.onAttach}
              onTerminal={props.onTerminal}
              activeTab={codeSurface(selected) ? selected : 'diff'}
              onTabChange={open}
            />
          </div>
        ) : null}
        {tabs.includes('terminal') && terminalOpen ? (
          <div
            className="surface-pane"
            role="tabpanel"
            id="surface-panel-terminal"
            aria-labelledby="surface-tab-terminal"
            hidden={showPicker || selected !== 'terminal'}
          >
            <RemoteTerminal
              key={JSON.stringify([connection.profile?.id, connection.workspace])}
              theme={theme}
              connected={ready}
              onClose={() => close('terminal')}
            />
          </div>
        ) : null}
        {(['browser', 'device'] as const).map((id) =>
          tabs.includes(id) ? (
            <div
              className="surface-pane"
              key={id}
              role="tabpanel"
              id={`surface-panel-${id}`}
              aria-labelledby={`surface-tab-${id}`}
              hidden={showPicker || selected !== id}
            >
              <BrowserSurface connection={connection} device={id === 'device'} />
            </div>
          ) : null,
        )}
        {(['pull-request', 'linked-pull-requests'] as const).map((id) =>
          tabs.includes(id) ? (
            <div
              className="surface-pane"
              key={id}
              role="tabpanel"
              id={`surface-panel-${id}`}
              aria-labelledby={`surface-tab-${id}`}
              hidden={showPicker || selected !== id}
            >
              <PullRequestSurface
                connection={connection}
                thread={props.activeThread}
                linked={id === 'linked-pull-requests'}
                active={!showPicker && selected === id}
                refreshKey={props.refreshKey}
              />
            </div>
          ) : null,
        )}
        {tabs.includes('agents') ? (
          <div
            className="surface-pane surface-agents"
            role="tabpanel"
            id="surface-panel-agents"
            aria-labelledby="surface-tab-agents"
            hidden={showPicker || selected !== 'agents'}
          >
            <div className="surface-section-heading">
              <Bot size={16} />
              <strong>Agents</strong>
              <span>{projectThreads.filter((thread) => thread.busy).length} running</span>
            </div>
            {!projectThreads.length ? (
              <div className="surface-empty">
                Agent threads for the selected project will appear here.
              </div>
            ) : (
              projectThreads.map((thread) => (
                <button
                  className="surface-agent-row"
                  key={thread.id}
                  onClick={() => props.onSelectThread(thread)}
                  aria-current={thread.id === props.activeThread?.id ? 'true' : undefined}
                >
                  <Bot size={17} />
                  <span>
                    <strong>{thread.title}</strong>
                    <small>
                      {thread.provider === 'codex' ? 'Codex' : 'Claude Code'} ·{' '}
                      {thread.model || 'Agent default'}
                    </small>
                  </span>
                  <span className="surface-status">
                    {thread.pending.length ? 'Waiting for you' : thread.busy ? 'Running' : 'Idle'}
                  </span>
                </button>
              ))
            )}
            <div className="surface-section-heading">
              <strong>Reported agent calls</strong>
              <span>{calls.length}</span>
            </div>
            {calls.length ? (
              calls.map((call) => (
                <details className="surface-agent-call" key={call.id}>
                  <summary>
                    {call.title} <span>{call.status || 'Reported'}</span>
                  </summary>
                  <pre>{call.text || 'No additional output reported.'}</pre>
                </details>
              ))
            ) : (
              <div className="surface-empty">
                Agent calls reported in the selected thread will appear here.
              </div>
            )}
          </div>
        ) : null}
      </div>
      {tabs.length ? controls : null}
    </aside>
  )
}
