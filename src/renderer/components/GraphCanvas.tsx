import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Maximize2, Minus, Plus } from 'lucide-react'

export interface CanvasNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  content: ReactNode
}
export interface CanvasEdge {
  from: string
  to: string
  label?: string
  color?: string
  dashed?: boolean
  arrow?: boolean
}
interface Camera {
  x: number
  y: number
  zoom: number
}
const clamp = (value: number) => Math.max(0.25, Math.min(1.75, value))
export function GraphCanvas({
  nodes,
  edges,
  fitKey,
  label,
  children,
}: {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  fitKey: string
  label: string
  children?: ReactNode
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const markerId = 'life-map-arrow-' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const graph = useRef(nodes)
  graph.current = nodes
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const current = useRef(camera)
  current.current = camera
  const drag = useRef<{ id: number; x: number; y: number; camera: Camera } | undefined>(undefined)
  const [panning, setPanning] = useState(false)
  function fit() {
    const el = viewport.current
    const items = graph.current
    if (!el || !items.length || !el.clientWidth || !el.clientHeight) return
    const left = Math.min(...items.map((node) => node.x))
    const right = Math.max(...items.map((node) => node.x + node.width))
    const top = Math.min(...items.map((node) => node.y))
    const bottom = Math.max(...items.map((node) => node.y + node.height))
    const zoom = Math.max(
      0.25,
      Math.min(
        1,
        (el.clientWidth - 100) / (right - left),
        (el.clientHeight - 120) / (bottom - top),
      ),
    )
    setCamera({
      x: el.clientWidth / 2 - ((left + right) / 2) * zoom,
      y: el.clientHeight / 2 - ((top + bottom) / 2) * zoom,
      zoom,
    })
  }
  function zoomAt(factor: number, x?: number, y?: number) {
    const el = viewport.current
    if (!el) return
    const point = { x: x ?? el.clientWidth / 2, y: y ?? el.clientHeight / 2 }
    setCamera((previous) => {
      const zoom = clamp(previous.zoom * factor)
      const ratio = zoom / previous.zoom
      return {
        zoom,
        x: point.x - (point.x - previous.x) * ratio,
        y: point.y - (point.y - previous.y) * ratio,
      }
    })
  }
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    )
    observer.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(fit, [fitKey, size.width, size.height])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.life-canvas-tools, .life-canvas-overlay')) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const bounds = el.getBoundingClientRect()
        zoomAt(
          Math.exp(-event.deltaY * 0.006),
          event.clientX - bounds.left,
          event.clientY - bounds.top,
        )
      } else {
        const multiplier = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? el.clientHeight : 1
        setCamera((previous) => ({
          ...previous,
          x: previous.x - (event.shiftKey ? event.deltaY : event.deltaX) * multiplier,
          y: previous.y - (event.shiftKey ? event.deltaX : event.deltaY) * multiplier,
        }))
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  const lookup = new Map(nodes.map((node) => [node.id, node]))
  const paths = edges.flatMap((edge) => {
    const from = lookup.get(edge.from)
    const to = lookup.get(edge.to)
    if (!from || !to) return []
    const dx = to.x + to.width / 2 - from.x - from.width / 2
    const dy = to.y + to.height / 2 - from.y - from.height / 2
    const horizontal = Math.abs(dx) >= Math.abs(dy)
    const direction = (horizontal ? dx : dy) >= 0 ? 1 : -1
    const x1 = horizontal ? from.x + (direction > 0 ? from.width : 0) : from.x + from.width / 2
    const y1 = horizontal ? from.y + from.height / 2 : from.y + (direction > 0 ? from.height : 0)
    const x2 = horizontal ? to.x + (direction > 0 ? 0 : to.width) : to.x + to.width / 2
    const y2 = horizontal ? to.y + to.height / 2 : to.y + (direction > 0 ? 0 : to.height)
    const bend = Math.max(40, Math.abs(horizontal ? x2 - x1 : y2 - y1) / 2) * direction
    const path = horizontal
      ? 'M ' +
        x1 +
        ' ' +
        y1 +
        ' C ' +
        (x1 + bend) +
        ' ' +
        y1 +
        ', ' +
        (x2 - bend) +
        ' ' +
        y2 +
        ', ' +
        x2 +
        ' ' +
        y2
      : 'M ' +
        x1 +
        ' ' +
        y1 +
        ' C ' +
        x1 +
        ' ' +
        (y1 + bend) +
        ', ' +
        x2 +
        ' ' +
        (y2 - bend) +
        ', ' +
        x2 +
        ' ' +
        y2
    return [{ ...edge, path, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 8 }]
  })
  function endPan(id: number) {
    if (drag.current?.id !== id) return
    drag.current = undefined
    setPanning(false)
  }
  return (
    <div
      ref={viewport}
      className={'life-canvas' + (panning ? ' is-panning' : '')}
      tabIndex={0}
      role="region"
      aria-label={label}
      style={{
        backgroundPosition: camera.x + 'px ' + camera.y + 'px',
        backgroundSize: 22 * camera.zoom + 'px ' + 22 * camera.zoom + 'px',
      }}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          (event.target as HTMLElement).closest(
            'button, input, textarea, select, a, .life-canvas-tools, .life-canvas-overlay',
          )
        )
          return
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          camera: current.current,
        }
        setPanning(true)
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start || start.id !== event.pointerId) return
        setCamera({
          ...start.camera,
          x: start.camera.x + event.clientX - start.x,
          y: start.camera.y + event.clientY - start.y,
        })
      }}
      onPointerUp={(event) => endPan(event.pointerId)}
      onPointerCancel={(event) => endPan(event.pointerId)}
      onLostPointerCapture={(event) => endPan(event.pointerId)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
          return
        const delta = event.shiftKey ? 120 : 40
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault()
          setCamera((previous) => ({
            ...previous,
            x:
              previous.x +
              (event.key === 'ArrowLeft' ? delta : event.key === 'ArrowRight' ? -delta : 0),
            y:
              previous.y +
              (event.key === 'ArrowUp' ? delta : event.key === 'ArrowDown' ? -delta : 0),
          }))
        } else if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          zoomAt(1.2)
        } else if (event.key === '-') {
          event.preventDefault()
          zoomAt(1 / 1.2)
        } else if (event.key === '0') {
          event.preventDefault()
          fit()
        }
      }}
    >
      <div
        className="life-canvas-world"
        style={{
          transform: 'translate(' + camera.x + 'px, ' + camera.y + 'px) scale(' + camera.zoom + ')',
        }}
      >
        <svg className="life-canvas-edges" width="1" height="1" aria-hidden="true">
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: 'context-stroke', stroke: 'none' }} />
            </marker>
          </defs>
          {paths.map((edge, index) => (
            <g key={edge.from + ':' + edge.to + ':' + index}>
              <path
                d={edge.path}
                style={{ stroke: edge.color, strokeDasharray: edge.dashed ? '6 4' : undefined }}
                markerEnd={edge.arrow ? 'url(#' + markerId + ')' : undefined}
              />
              {edge.label ? (
                <text
                  x={edge.labelX}
                  y={edge.labelY}
                  textAnchor="middle"
                  className="research-map-edge-label"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
        {nodes.map((node) => (
          <div
            key={node.id}
            className="life-canvas-node"
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            onFocus={() => {
              const el = viewport.current
              if (!el) return
              const view = current.current
              const left = node.x * view.zoom + view.x
              const top = node.y * view.zoom + view.y
              if (
                left < 16 ||
                top < 16 ||
                left + node.width * view.zoom > el.clientWidth - 16 ||
                top + node.height * view.zoom > el.clientHeight - 16
              ) {
                setCamera({
                  ...view,
                  x: el.clientWidth / 2 - (node.x + node.width / 2) * view.zoom,
                  y: el.clientHeight / 2 - (node.y + node.height / 2) * view.zoom,
                })
              }
            }}
          >
            {node.content}
          </div>
        ))}
      </div>
      <div className="life-canvas-tools" aria-label="Canvas controls">
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => zoomAt(1 / 1.2)}
          disabled={camera.zoom <= 0.25}
        >
          <Minus size={14} />
        </button>
        <span aria-label={'Zoom ' + Math.round(camera.zoom * 100) + ' percent'}>
          {Math.round(camera.zoom * 100)}%
        </span>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => zoomAt(1.2)}
          disabled={camera.zoom >= 1.75}
        >
          <Plus size={14} />
        </button>
        <i />
        <button type="button" title="Fit map (0)" aria-label="Fit map" onClick={fit}>
          <Maximize2 size={14} />
        </button>
      </div>
      {children}
    </div>
  )
}
