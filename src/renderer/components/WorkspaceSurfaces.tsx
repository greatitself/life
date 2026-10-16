import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Link,
  Maximize2,
  Minimize2,
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
import { AgentsPanel } from './AgentsPanel'
import { ResizeHandle, type ResizeProps } from './SidebarResize'
import { useBuiltinFeature } from '../builtin-extensions'
import {
  closeRightPanelSurfaces,
  emptyRightPanel,
  openRightPanelSurface,
  readRightPanelStates,
  setRightPanelState,
  writeRightPanelStates,
  type RightPanelState,
  type WorkspaceSurface as Surface,
} from './right-panel-state'
import './workspace-surfaces.css'

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
const launchers = surfaces.filter((surface) => surface.id !== 'git')
const codeSurface = (surface?: Surface): surface is WorkspaceTab =>
  surface === 'files' || surface === 'diff' || surface === 'git'
const typingTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest('input,textarea,select,[contenteditable="true"],.terminal-panel'))

interface Props {
  connection: ConnectionState
  headerTarget: HTMLElement | null
  theme: 'dark' | 'light'
  open: boolean
  inline?: boolean
  maximized: boolean
  onMaximizedChange: (maximized: boolean) => void
  threadScopeKey: string
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
  const enabled = useBuiltinFeature('workspace-surfaces')
  const {
    connection,
    headerTarget,
    terminalOpen,
    onTerminalChange,
    theme,
    onClose,
    resize,
    open: panelOpen,
    maximized,
    onMaximizedChange,
    threadScopeKey,
  } = props
  const scope = JSON.stringify([connection.profile?.id, connection.workspace, threadScopeKey])
  const workspacePrefix =
    JSON.stringify([connection.profile?.id, connection.workspace]).slice(0, -1) + ','
  const callbacks = useRef({ onClose, onMaximizedChange, onTerminalChange })
  callbacks.current = { onClose, onMaximizedChange, onTerminalChange }
  const [states, setStates] = useState(readRightPanelStates)
  const statesRef = useRef(states)
  statesRef.current = states
  const state = states[scope] || emptyRightPanel
  const { tabs, selected } = state
  // Native resources belong to this workspace mount, independently of the selected thread.
  const [mounted, setMounted] = useState(() => new Set<Surface>(tabs))
  const [viewportSheet, setViewportSheet] = useState(() => window.innerWidth <= 980)
  const sheet = props.inline === undefined ? viewportSheet : !props.inline
  const [addOpen, setAddOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [context, setContext] = useState<{ id: Surface; x: number; y: number }>()
  const [overflow, setOverflow] = useState({ left: false, right: false })
  const host = useRef<HTMLElement>(null)
  const tabList = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  const showPicker = !selected
  const visible = enabled && panelOpen

  const change = useCallback(
    (update: (current: RightPanelState) => RightPanelState) => {
      const next = setRightPanelState(
        statesRef.current,
        scope,
        update(statesRef.current[scope] || emptyRightPanel),
      )
      statesRef.current = next
      setStates(next)
    },
    [scope],
  )
  const open = useCallback(
    (id: Surface) => {
      if (!enabled) return
      setMounted((current) => (current.has(id) ? current : new Set([...current, id])))
      change((current) => openRightPanelSurface(current, id))
      setAddOpen(false)
      if (id === 'terminal') onTerminalChange(true)
    },
    [enabled, change, onTerminalChange],
  )
  const openRef = useRef(open)
  openRef.current = open
  const closePanel = useCallback(() => {
    setAddOpen(false)
    setContext(undefined)
    callbacks.current.onMaximizedChange(false)
    callbacks.current.onClose()
  }, [])
  const close = useCallback(
    (removed: readonly Surface[]) => {
      const current = statesRef.current[scope] || emptyRightPanel
      const next = closeRightPanelSurfaces(current, removed)
      change(() => next)
      setContext(undefined)
      if (removed.includes('terminal')) onTerminalChange(false)
      // Closing a tab may release a pane; hiding the panel or switching threads never does.
      setMounted((currentMounted) => {
        const keep = new Set(currentMounted)
        for (const id of removed) {
          if (
            !Object.entries(statesRef.current).some(
              ([key, entry]) => key.startsWith(workspacePrefix) && entry.tabs.includes(id),
            )
          )
            keep.delete(id)
        }
        return keep
      })
      if (!next.tabs.length) closePanel()
    },
    [scope, workspacePrefix, change, onTerminalChange, closePanel],
  )

  useEffect(() => writeRightPanelStates(states), [states])
  useEffect(() => {
    const update = () => setViewportSheet(window.innerWidth <= 980)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  useEffect(() => {
    setAddOpen(false)
    setContext(undefined)
    setHighlight(-1)
    callbacks.current.onMaximizedChange(false)
  }, [scope])
  useEffect(() => {
    setMounted((current) =>
      tabs.every((id) => current.has(id)) ? current : new Set([...current, ...tabs]),
    )
  }, [tabs])
  const previousTerminalOpen = useRef(false)
  useEffect(() => {
    // Restoring a remembered terminal tab opens the one workspace-owned terminal.
    // A later explicit close is handled below and must not immediately reopen it.
    if (visible && statesRef.current[scope]?.selected === 'terminal')
      callbacks.current.onTerminalChange(true)
  }, [scope, visible])
  useEffect(() => {
    if (!enabled) {
      if (terminalOpen) onTerminalChange(false)
      return
    }
    if (terminalOpen && !previousTerminalOpen.current) openRef.current('terminal')
    if (!terminalOpen && previousTerminalOpen.current) {
      const next = Object.fromEntries(
        Object.entries(statesRef.current).map(([key, entry]) => [
          key,
          key.startsWith(workspacePrefix) ? closeRightPanelSurfaces(entry, ['terminal']) : entry,
        ]),
      )
      statesRef.current = next
      setStates(next)
    }
    previousTerminalOpen.current = terminalOpen
  }, [enabled, terminalOpen, onTerminalChange, workspacePrefix])

  useLayoutEffect(() => {
    const element = tabList.current
    if (!element || !visible) return
    const measure = () => {
      const left = element.scrollLeft > 1
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      setOverflow((previous) =>
        previous.left === left && previous.right === right ? previous : { left, right },
      )
    }
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [visible, headerTarget, sheet, tabs])
  useEffect(() => {
    if (!visible || !selected) return
    tabList.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.closest('.surface-tab')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [visible, selected, scope, sheet])
  useEffect(() => {
    if (visible && showPicker) picker.current?.focus()
  }, [visible, showPicker, scope])
  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'w' &&
        selected &&
        !(event.target instanceof Element && event.target.closest('.terminal-panel'))
      ) {
        if (document.querySelector('.modal-overlay,[role="menu"][data-state="open"]')) return
        event.preventDefault()
        event.stopPropagation()
        close([selected])
        return
      }
      if (
        !showPicker ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        typingTarget(event.target) ||
        document.querySelector('.modal-overlay,[role="menu"][data-state="open"]')
      )
        return
      const item = launchers.find((item) => item.key.toLowerCase() === event.key.toLowerCase())
      if (!item) return
      event.preventDefault()
      event.stopPropagation()
      open(item.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, selected, showPicker, close, open])

  // Keep one resource tree across inline/sheet layouts, while containing keyboard focus in a sheet.
  useEffect(() => {
    if (!visible || !sheet || !host.current) return
    const element = host.current
    const previous = document.activeElement
    const focusables = () =>
      [
        ...element.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]'),
      ].filter(
        (node) =>
          node.tabIndex >= 0 && !node.hasAttribute('disabled') && node.getClientRects().length,
      )
    if (!element.contains(previous)) (picker.current || focusables()[0] || element).focus()
    const onSheetEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        typingTarget(event.target) ||
        document.querySelector('.modal-overlay,[role="menu"][data-state="open"]')
      )
        return
      // A background HoverCard consumes Escape in Radix's document capture phase.
      // This visible sheet owns it first; editable fields and native terminals keep
      // their own key handling before the bubble fallback below.
      event.preventDefault()
      event.stopPropagation()
      closePanel()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('.modal-overlay'))
        return
      if (event.key === 'Escape') {
        if (
          document.querySelector('[role="menu"][data-state="open"]') ||
          (event.target instanceof Element && event.target.closest('.terminal-panel'))
        )
          return
        event.preventDefault()
        closePanel()
      } else if (event.key === 'Tab') {
        const nodes = focusables()
        const first = nodes[0] || element
        const last = nodes.at(-1) || element
        if (
          event.shiftKey &&
          (document.activeElement === first || !element.contains(document.activeElement))
        ) {
          event.preventDefault()
          last.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !element.contains(document.activeElement))
        ) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onSheetEscape, true)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onSheetEscape, true)
      document.removeEventListener('keydown', onKey)
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        element.contains(document.activeElement)
      )
        previous.focus()
    }
  }, [visible, sheet, closePanel])

  function scrollTabs(direction: number) {
    const element = tabList.current
    if (!element) return
    element.scrollBy({
      left: direction * Math.max(120, element.clientWidth * 0.75),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }
  const header = (
    <header className="surface-header" aria-label="Workspace surface controls">
      {overflow.left ? (
        <button
          type="button"
          className="surface-scroll-control"
          aria-label="Scroll surfaces left"
          onClick={() => scrollTabs(-1)}
        >
          <ChevronLeft size={14} />
        </button>
      ) : null}
      <div
        className="surface-tabs"
        ref={tabList}
        role="tablist"
        aria-label="Open workspace surfaces"
        onWheel={(event) => {
          if (!event.deltaY || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth)
            return
          event.currentTarget.scrollLeft += event.deltaY
          event.preventDefault()
        }}
      >
        {tabs.map((id) => {
          const item = surfaces.find((item) => item.id === id)!
          return (
            <div
              className="surface-tab"
              key={id}
              data-selected={selected === id}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  close([id])
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                setContext({ id, x: event.clientX, y: event.clientY })
              }}
            >
              <button
                type="button"
                className="surface-tab-close"
                aria-label={`Close ${item.label}`}
                title={`Close ${item.label}`}
                onClick={() => close([id])}
              >
                <item.icon className="surface-tab-icon" size={16} />
                <X className="surface-tab-close-icon" size={12} />
              </button>
              <button
                type="button"
                role="tab"
                id={`surface-tab-${id}`}
                aria-controls={`surface-panel-${id}`}
                aria-selected={selected === id}
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
                  else if (event.key === 'End') next = tabs.at(-1)
                  else if (event.key === 'Delete') {
                    event.preventDefault()
                    close([id])
                    return
                  } else return
                  event.preventDefault()
                  if (next) {
                    open(next)
                    document.getElementById(`surface-tab-${next}`)?.focus()
                  }
                }}
              >
                <span>{item.label}</span>
              </button>
            </div>
          )
        })}
        {tabs.length ? (
          <DropdownMenu.Root open={addOpen} onOpenChange={setAddOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="surface-add-control"
                aria-label="Add panel surface"
                title="Open a surface"
              >
                <Plus size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="surface-menu"
                sideOffset={6}
                align="start"
                onKeyDown={(event) => {
                  if (event.ctrlKey || event.metaKey || event.altKey) return
                  const item = launchers.find(
                    (item) => item.key.toLowerCase() === event.key.toLowerCase(),
                  )
                  if (item) {
                    event.preventDefault()
                    open(item.id)
                  }
                }}
              >
                {launchers.map((item) => (
                  <DropdownMenu.Item
                    className="surface-menu-item"
                    key={item.id}
                    onSelect={() => open(item.id)}
                  >
                    <item.icon size={14} />
                    <span>{item.label}</span>
                    <kbd>{item.key}</kbd>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
      {overflow.right ? (
        <button
          type="button"
          className="surface-scroll-control"
          aria-label="Scroll surfaces right"
          onClick={() => scrollTabs(1)}
        >
          <ChevronRight size={14} />
        </button>
      ) : null}
      <div className="surface-layout-controls">
        {!sheet ? (
          <button
            type="button"
            className="icon-button"
            aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
            title={maximized ? 'Restore panel size' : 'Maximize panel'}
            onClick={() => onMaximizedChange(!maximized)}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button surface-collapse-control"
          aria-label="Collapse workspace sidebar"
          title="Collapse workspace sidebar"
          aria-expanded={visible}
          aria-controls="life-workspace-surfaces"
          onClick={closePanel}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  )
  const ready = connection.status === 'connected' && Boolean(connection.workspace)
  const agentsActive = visible && selected === 'agents'
  const activeThread =
    agentsActive &&
    props.activeThread?.profileId === connection.profile?.id &&
    props.activeThread?.workspace === connection.workspace
      ? props.activeThread
      : undefined
  if (!enabled) return null
  return (
    <>
      {visible && sheet ? (
        <div className="surface-sheet-backdrop" onPointerDown={closePanel} aria-hidden="true" />
      ) : null}
      <aside
        ref={host}
        className="workspace-surfaces"
        id="life-workspace-surfaces"
        aria-label="Workspace surfaces"
        role={sheet ? 'dialog' : undefined}
        aria-modal={visible && sheet ? true : undefined}
        tabIndex={-1}
        hidden={!visible}
        data-panel-mode={sheet ? 'sheet' : 'inline'}
        data-inline={!sheet}
        data-maximized={maximized && !sheet}
        data-active-surface={selected}
      >
        {!sheet && !maximized ? <ResizeHandle {...resize} /> : null}
        {visible && headerTarget && !sheet ? createPortal(header, headerTarget) : header}
        <div className="surface-body">
          {showPicker ? (
            <div
              className="surface-picker"
              ref={picker}
              tabIndex={0}
              aria-label="Open a surface"
              onKeyDown={(event) => {
                if (event.ctrlKey || event.metaKey || event.altKey) return
                if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
                  event.preventDefault()
                  const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
                  setHighlight(
                    (current) => (current + direction + launchers.length) % launchers.length,
                  )
                } else if (
                  event.key === 'Enter' &&
                  event.target === event.currentTarget &&
                  launchers[highlight]
                ) {
                  event.preventDefault()
                  open(launchers[highlight].id)
                }
              }}
            >
              <div>
                <h2>Open a surface</h2>
                <div className="surface-launcher-actions">
                  {launchers.map((item, index) => (
                    <button
                      type="button"
                      key={item.id}
                      data-highlighted={highlight === index}
                      onMouseEnter={() => setHighlight(index)}
                      onMouseLeave={() => setHighlight(-1)}
                      onClick={() => open(item.id)}
                    >
                      <item.icon size={16} />
                      <span>{item.label}</span>
                      <kbd>{item.key}</kbd>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          {[...mounted].some(codeSurface) ? (
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
                onClose={closePanel}
                refreshKey={props.refreshKey}
                onAttach={props.onAttach}
                onTerminal={props.onTerminal}
                activeTab={codeSurface(selected) ? selected : 'diff'}
                onTabChange={open}
              />
            </div>
          ) : null}
          {mounted.has('terminal') && terminalOpen ? (
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
                onClose={() => close(['terminal'])}
              />
            </div>
          ) : null}
          {(['browser', 'device'] as const).map((id) =>
            mounted.has(id) ? (
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
            mounted.has(id) ? (
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
                  active={visible && selected === id}
                  refreshKey={props.refreshKey}
                />
              </div>
            ) : null,
          )}
          {mounted.has('agents') ? (
            <div
              className="surface-pane surface-agents"
              role="tabpanel"
              id="surface-panel-agents"
              aria-labelledby="surface-tab-agents"
              hidden={showPicker || selected !== 'agents'}
            >
              <AgentsPanel thread={activeThread} active={agentsActive} />
            </div>
          ) : null}
        </div>
      </aside>
      <DropdownMenu.Root
        open={Boolean(context) && visible}
        onOpenChange={(value) => {
          if (!value) setContext(undefined)
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="surface-context-anchor"
            tabIndex={-1}
            aria-hidden="true"
            style={{ left: context?.x, top: context?.y }}
          />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="surface-menu"
            sideOffset={0}
            align="start"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (context) document.getElementById(`surface-tab-${context.id}`)?.focus()
            }}
          >
            <DropdownMenu.Item
              className="surface-menu-item"
              onSelect={() => {
                if (context) close([context.id])
              }}
            >
              Close
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="surface-menu-item"
              disabled={tabs.length <= 1}
              onSelect={() => {
                if (context) close(tabs.filter((id) => id !== context.id))
              }}
            >
              Close others
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="surface-menu-item"
              disabled={!context || tabs.indexOf(context.id) >= tabs.length - 1}
              onSelect={() => {
                if (context) close(tabs.slice(tabs.indexOf(context.id) + 1))
              }}
            >
              Close to the right
            </DropdownMenu.Item>
            <DropdownMenu.Item className="surface-menu-item" onSelect={() => close(tabs)}>
              Close all
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}
