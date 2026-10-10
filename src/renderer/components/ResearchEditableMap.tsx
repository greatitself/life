import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GraphCanvas, type CanvasEdge, type CanvasNode } from './GraphCanvas'
import { queueMermaidRender } from '../mermaid'
import type { ResearchWorkbenchState } from '../workbench'
import type { ResearchMapFile } from '../research-files'
import { api, errorText } from '../api'

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
const color = (value: unknown) =>
  typeof value === 'string' && CSS.supports('color', value) ? value : undefined
function graph(
  source: string,
  workbench: ResearchWorkbenchState,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const value: unknown = JSON.parse(source)
  if (
    !object(value) ||
    !Array.isArray(value.nodes) ||
    (value.edges !== undefined && !Array.isArray(value.edges))
  )
    throw new Error('map.json must contain nodes and an optional edges array.')
  if (value.nodes.length > 1000 || (Array.isArray(value.edges) && value.edges.length > 3000))
    throw new Error('Use map.html for visualizations larger than 1,000 nodes or 3,000 edges.')
  const ids = new Set<string>()
  const nodes: CanvasNode[] = value.nodes.map((item, index) => {
    if (!object(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id))
      throw new Error('Each map node needs a unique id.')
    ids.add(item.id)
    const label = text(item.label, text(item.title, item.id))
    const problemId = text(item.problemId)
    const selectable = Boolean(workbench.goal?.problems.some((problem) => problem.id === problemId))
    const overview = item.action === 'overview'
    const shape = ['pill', 'ellipse', 'diamond', 'note'].includes(text(item.shape))
      ? text(item.shape)
      : 'box'
    const style = {
      '--research-node-color': color(item.color) || 'var(--border-strong)',
    } as CSSProperties
    const contents = (
      <>
        <strong>{label}</strong>
        {item.detail ? <span>{text(item.detail)}</span> : null}
      </>
    )
    return {
      id: item.id,
      x: number(item.x, index * 320, -1_000_000, 1_000_000),
      y: number(item.y, 0, -1_000_000, 1_000_000),
      width: number(item.width, 250, 40, 2000),
      height: number(item.height, item.detail ? 110 : 74, 32, 2000),
      content:
        selectable || overview ? (
          <button
            type="button"
            className="research-custom-node"
            data-shape={shape}
            style={style}
            aria-pressed={selectable ? workbench.problem?.id === problemId : !workbench.problem}
            onClick={() => (selectable ? workbench.selectProblem(problemId) : workbench.overview())}
          >
            {contents}
          </button>
        ) : (
          <div className="research-custom-node" data-shape={shape} style={style}>
            {contents}
          </div>
        ),
    }
  })
  const edges: CanvasEdge[] = (Array.isArray(value.edges) ? value.edges : []).map((item) => {
    if (
      !object(item) ||
      typeof item.from !== 'string' ||
      typeof item.to !== 'string' ||
      !ids.has(item.from) ||
      !ids.has(item.to)
    )
      throw new Error('Map edges must reference existing node IDs.')
    return {
      from: item.from,
      to: item.to,
      label: text(item.label),
      color: color(item.color),
      dashed: item.dashed === true,
      arrow: item.arrow === true,
    }
  })
  return { nodes, edges }
}
function useTheme() {
  const [theme, setTheme] = useState(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  )
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() =>
      setTheme(root.dataset.theme === 'light' ? 'light' : 'dark'),
    )
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
function MermaidMap({ source, revision }: { source: string; revision?: string }) {
  const theme = useTheme()
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const sequence = useRef(0)
  const [rendered, setRendered] = useState<{ svg: string; width: number; height: number }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    setError('')
    void queueMermaidRender(async () => {
      const { default: mermaid } = await import('mermaid')
      if (disposed) return
      const styles = getComputedStyle(document.documentElement)
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'base',
        htmlLabels: false,
        themeVariables: {
          darkMode: theme === 'dark',
          background: styles.getPropertyValue('--bg').trim(),
          primaryColor: styles.getPropertyValue('--surface').trim(),
          primaryTextColor: styles.getPropertyValue('--text').trim(),
          primaryBorderColor: styles.getPropertyValue('--border-strong').trim(),
          lineColor: styles.getPropertyValue('--muted').trim(),
          fontFamily: 'DM Sans Variable, sans-serif',
        },
      })
      const result = await mermaid.render(
        'life-research-custom-' + id + '-' + ++sequence.current,
        source,
      )
      const parsedSvg = new DOMParser().parseFromString(result.svg, 'image/svg+xml')
      const values = (parsedSvg.documentElement.getAttribute('viewBox') || '')
        .split(/\s+/)
        .map(Number)
      if (!disposed)
        setRendered({
          svg: result.svg,
          width: number(values[2], 800, 40, 50000),
          height: number(values[3], 600, 40, 50000),
        })
    }).catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      disposed = true
    }
  }, [source, theme, id])
  return (
    <div className="research-custom-map">
      {rendered ? (
        <GraphCanvas
          nodes={[
            {
              id: 'diagram',
              x: 0,
              y: 0,
              width: rendered.width,
              height: rendered.height,
              content: (
                <div
                  className="research-mermaid-svg"
                  dangerouslySetInnerHTML={{ __html: rendered.svg }}
                />
              ),
            },
          ]}
          edges={[]}
          fitKey={revision || source}
          label="Agent-edited Research diagram"
        />
      ) : (
        <div className="research-map-feedback" role="status">
          {error ? 'The diagram could not render.' : 'Rendering diagram…'}
        </div>
      )}
      {error ? (
        <div className="research-map-file-error" role="alert">
          map.mmd: {error}
        </div>
      ) : null}
    </div>
  )
}
function HtmlMap({ source, workbench }: { source: string; workbench: ResearchWorkbenchState }) {
  const theme = useTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  const current = useRef(workbench)
  const [documentURL, setDocumentURL] = useState<{ html: string; url: string }>()
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  current.current = workbench
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !object(event.data) ||
        event.data.type !== 'life-research-select'
      )
        return
      const target = current.current
      if (event.data.overview === true) target.overview()
      else if (
        typeof event.data.problemId === 'string' &&
        target.goal?.problems.some((problem) => problem.id === event.data.problemId)
      )
        target.selectProblem(event.data.problemId)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  const styles = getComputedStyle(document.documentElement)
  const variables = ['bg', 'surface', 'text', 'muted', 'border']
    .map((name) => '--' + name + ':' + styles.getPropertyValue('--' + name).trim())
    .join(';')
  const htmlDocument =
    '<!doctype html><html data-theme="' +
    theme +
    '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{' +
    variables +
    ';color-scheme:' +
    theme +
    '}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body>' +
    source +
    '</body></html>'
  useEffect(() => {
    let disposed = false
    let registrationId: string | undefined
    const documents = api?.researchDocuments
    setDocumentURL(undefined)
    setLoadError('')
    if (!documents) {
      setLoadError('Interactive HTML maps need the current Life desktop application.')
      return
    }
    void documents
      .register(htmlDocument)
      .then((registration) => {
        registrationId = registration.id
        if (disposed) {
          void documents.revoke(registration.id).catch(() => {})
          return
        }
        setDocumentURL({ html: htmlDocument, url: registration.url })
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(errorText(error))
      })
    return () => {
      disposed = true
      if (registrationId) void documents.revoke(registrationId).catch(() => {})
    }
  }, [htmlDocument, attempt])
  if (loadError)
    return (
      <div className="research-map-file-error" role="alert">
        <span>map.html: {loadError}</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </button>
      </div>
    )
  if (!documentURL || documentURL.html !== htmlDocument)
    return (
      <div className="research-map-feedback" role="status">
        Opening interactive map…
      </div>
    )
  return (
    <iframe
      ref={frame}
      className="research-html-map"
      title={'Custom Research map: ' + (workbench.goal?.title || 'Research')}
      sandbox="allow-scripts"
      src={documentURL.url}
    />
  )
}
export function ResearchEditableMap({
  map,
  workbench,
  fallback,
}: {
  map?: ResearchMapFile
  workbench: ResearchWorkbenchState
  fallback: ReactNode
}) {
  let contents = fallback
  let error = map?.error
  if (map?.format === 'html')
    contents = (
      <HtmlMap
        key={JSON.stringify([workbench.scopeKey, workbench.goal?.id])}
        source={map.source || ''}
        workbench={workbench}
      />
    )
  else if (map?.format === 'mermaid')
    contents = <MermaidMap source={map.source || ''} revision={map.revision} />
  else if (map?.format === 'json') {
    try {
      const parsed = graph(map.source || '', workbench)
      const layout = parsed.nodes
        .map((node) => [node.id, node.x, node.y, node.width, node.height].join(':'))
        .join('|')
      contents = (
        <GraphCanvas
          nodes={parsed.nodes}
          edges={parsed.edges}
          fitKey={(workbench.goal?.id || '') + ':' + layout}
          label="Agent-edited Research map"
        />
      )
    } catch (cause) {
      error = 'map.json: ' + (cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <div className="research-custom-map">
      {contents}
      {error ? (
        <div className="research-map-file-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={workbench.refresh}>
            Retry
          </button>
        </div>
      ) : null}
    </div>
  )
}
