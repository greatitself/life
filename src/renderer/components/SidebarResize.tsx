import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useBuiltinFeature } from '../builtin-extensions'
import './workspace-surfaces.css'

const storageKey = 'life.workspace.sidebar-widths.v1'
type Side = 'left' | 'right'
type Sizes = { left: number; right: number }
export interface ResizeProps {
  label?: string
  controls?: string
  side: Side
  value: number
  min: number
  max: number
  reset: number
  onChange: (value: number) => void
  onCommit: (value: number) => void
}
const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, value)))
function defaults(left: number, right: number): Sizes {
  const w = window.innerWidth
  return {
    left: left === 260 ? (w > 1280 ? 306 : w > 1080 ? 280 : 260) : left,
    right:
      right === 320
        ? w > 1280
          ? Math.min(680, w * 0.375)
          : w > 1080
            ? clamp(w * 0.3, 310, 380)
            : Math.min(520, w - 48)
        : right,
  }
}
function readSizes(fallback: Sizes): Sizes {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
    return {
      left: Number.isFinite(saved?.left) ? clamp(saved.left, 220, 420) : fallback.left,
      right: Number.isFinite(saved?.right) ? clamp(saved.right, 260, 900) : fallback.right,
    }
  } catch {
    return fallback
  }
}
export function usePanelSizes(
  configuredLeft: number,
  configuredRight: number,
  sidebarOpen: boolean,
  collapsedWidth = 100,
) {
  const enabled = useBuiltinFeature('sidebar-resizing')
  const [sizes, setSizes] = useState(() => readSizes(defaults(configuredLeft, configuredRight)))
  const current = useRef(sizes)
  current.current = sizes
  const previousConfig = useRef({ left: configuredLeft, right: configuredRight })
  const [viewport, setViewport] = useState(() => window.innerWidth)
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    const previous = previousConfig.current
    previousConfig.current = { left: configuredLeft, right: configuredRight }
    if (previous.left === configuredLeft && previous.right === configuredRight) return
    const fallback = defaults(configuredLeft, configuredRight)
    const next = {
      left: previous.left === configuredLeft ? current.current.left : fallback.left,
      right: previous.right === configuredRight ? current.current.right : fallback.right,
    }
    current.current = next
    setSizes(next)
    try {
      if (enabled) localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {}
  }, [enabled, configuredLeft, configuredRight])
  function change(side: Side, value: number, persist: boolean) {
    if (!enabled) return
    const next = { ...current.current, [side]: value }
    current.current = next
    setSizes(next)
    if (persist) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {}
    }
  }
  const leftMax = Math.max(220, Math.min(420, viewport - 48))
  const left = Math.min(sizes.left, leftMax)
  const rightMax =
    viewport > 1080
      ? Math.max(260, Math.min(900, viewport - (sidebarOpen ? left : collapsedWidth) - 360))
      : Math.max(260, Math.min(900, viewport - 48))
  const right = Math.min(sizes.right, rightMax)
  const fallback = defaults(configuredLeft, configuredRight)
  const props = (side: Side, value: number, min: number, max: number): ResizeProps => ({
    side,
    value,
    min,
    max,
    reset: clamp(fallback[side], min, max),
    onChange: (value) => change(side, value, false),
    onCommit: (value) => change(side, value, true),
  })
  return {
    style: {
      '--life-navigation-width': `${left}px`,
      '--life-sidebar-width': `${left}px`,
      '--life-panel-width': `${right}px`,
    } as CSSProperties,
    left: props('left', left, 220, leftMax),
    right: props('right', right, 260, rightMax),
  }
}
export function ResizeHandle({
  side,
  value,
  min,
  max,
  reset,
  onChange,
  onCommit,
  label,
  controls,
}: ResizeProps) {
  const enabled = useBuiltinFeature('sidebar-resizing')
  const drag = useRef<{ pointer: number; x: number; start: number; next: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  function finish(cancelled = false) {
    const current = drag.current
    if (!current) return
    drag.current = null
    setDragging(false)
    if (cancelled) onChange(current.start)
    else if (enabled) onCommit(current.next)
  }
  useEffect(() => {
    if (!enabled && drag.current) {
      drag.current = null
      setDragging(false)
    }
  }, [enabled])
  if (!enabled) return null
  return (
    <div
      className="sidebar-resize-handle"
      data-side={side}
      data-dragging={dragging}
      role="separator"
      aria-label={label || `Resize ${side === 'left' ? 'projects sidebar' : 'workspace sidebar'}`}
      aria-orientation="vertical"
      aria-controls={controls || (side === 'left' ? 'life-sidebar' : 'life-workspace-surfaces')}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} pixels`}
      tabIndex={0}
      title="Drag to resize. Arrow keys adjust width. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        drag.current = { pointer: event.pointerId, x: event.clientX, start: value, next: value }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current || current.pointer !== event.pointerId) return
        current.next = clamp(
          current.start + (event.clientX - current.x) * (side === 'left' ? 1 : -1),
          min,
          max,
        )
        onChange(current.next)
      }}
      onPointerUp={() => finish()}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish()}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onCommit(reset)
      }}
      onKeyDown={(event) => {
        let next: number
        if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const direction = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1)
          next = clamp(value + direction * (event.shiftKey ? 40 : 10), min, max)
        } else return
        event.preventDefault()
        event.stopPropagation()
        onCommit(next)
      }}
    />
  )
}
