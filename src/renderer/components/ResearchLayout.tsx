import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare } from 'lucide-react'
import type { ResearchWorkbenchState } from '../workbench'
import type { Thread } from '../state'
import { ResearchOverview } from './ResearchWorkbench'
import { ResizeHandle } from './SidebarResize'
import { useBuiltinFeature } from '../builtin-extensions'
import './research-agent-layout.css'

const widthKey = 'life.research.agent-sidebar-width.v1'
const defaultWidth = 440
const minWidth = 320
const maxWidth = 640
const clampWidth = (value: number) => Math.max(minWidth, Math.min(maxWidth, value))
function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(widthKey) || defaultWidth)
    return Number.isFinite(value) ? clampWidth(value) : defaultWidth
  } catch {
    return defaultWidth
  }
}
interface ResearchLayoutProps {
  enabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  headerTarget?: HTMLElement | null
  onSidebarWidthChange?: (width: number) => void
  workbench: ResearchWorkbenchState
  threads: Thread[]
  children: ReactNode
}
export function ResearchLayout({
  enabled,
  open,
  onOpenChange,
  headerTarget,
  onSidebarWidthChange,
  workbench,
  threads,
  children,
}: ResearchLayoutProps) {
  const resizeEnabled = useBuiltinFeature('sidebar-resizing')
  const [width, setWidth] = useState(readWidth)
  const sidebar = useRef<HTMLElement>(null)
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 901px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 901px)')
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useLayoutEffect(() => {
    const pane = sidebar.current
    if (!enabled || !open || !pane || !onSidebarWidthChange) return
    const measure = () => {
      const measured = pane.getBoundingClientRect().width
      if (measured > 0) onSidebarWidthChange(measured)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [enabled, open, width, onSidebarWidthChange])
  const commitWidth = (value: number) => {
    if (!resizeEnabled) return
    const next = clampWidth(value)
    setWidth(next)
    try {
      localStorage.setItem(widthKey, String(next))
    } catch {
      /* Resizing remains usable. */
    }
  }
  if (!enabled) return <>{children}</>
  const resizeTarget = headerTarget?.closest('.app-shell')
  const docked = wide && Boolean(headerTarget && resizeTarget)
  const divider = (
    <div className={'research-agent-resize' + (docked ? ' research-agent-resize-full-height' : '')}>
      <ResizeHandle
        side="right"
        label="Resize research conversation sidebar"
        controls="life-research-agent-sidebar"
        value={width}
        min={minWidth}
        max={maxWidth}
        reset={defaultWidth}
        onChange={(value) => {
          if (resizeEnabled) setWidth(value)
        }}
        onCommit={commitWidth}
      />
    </div>
  )
  return (
    <div
      className="research-split-layout"
      data-agent-open={open}
      style={{ '--research-agent-width': width + 'px' } as CSSProperties}
    >
      <section
        className="research-map-stage"
        aria-label={
          workbench.goal ? 'Research map for ' + workbench.goal.title : 'Research goal map'
        }
      >
        <ResearchOverview workbench={workbench} threads={threads} />
        {!open ? (
          <button
            type="button"
            className="button secondary research-map-chat-action"
            aria-controls="life-research-agent-sidebar"
            aria-expanded={false}
            onClick={() => onOpenChange(true)}
          >
            <MessageSquare size={15} /> Open conversation
          </button>
        ) : null}
      </section>
      <aside
        ref={sidebar}
        id="life-research-agent-sidebar"
        className="research-agent-sidebar"
        aria-label="Research conversation"
        hidden={!open}
      >
        {open && resizeEnabled
          ? docked && resizeTarget
            ? createPortal(divider, resizeTarget)
            : divider
          : null}
        {children}
      </aside>
    </div>
  )
}
