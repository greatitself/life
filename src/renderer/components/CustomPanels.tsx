import { useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { LifeConfig } from '../../shared/customization'
import { queueMermaidRender } from '../mermaid'

function MermaidPanel({ content, theme }: { content: string; theme: LifeConfig['theme'] }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    setError('')
    void queueMermaidRender(async () => {
      const { default: mermaid } = await import('mermaid')
      if (disposed) return
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'base',
        themeVariables: {
          background: theme === 'dark' ? '#161616' : '#ffffff',
          primaryColor: theme === 'dark' ? '#282828' : '#f5f5f5',
          primaryTextColor: theme === 'dark' ? '#eeeeee' : '#171717',
          primaryBorderColor: theme === 'dark' ? '#686868' : '#969696',
          lineColor: theme === 'dark' ? '#b5b5b5' : '#555555',
          secondaryColor: theme === 'dark' ? '#222222' : '#eeeeee',
          tertiaryColor: theme === 'dark' ? '#191919' : '#fafafa',
        },
      })
      const result = await mermaid.render(`lifeWidget${id}${Date.now()}`, content)
      if (!disposed && host.current) host.current.innerHTML = result.svg
    }).catch((reason) => {
      if (!disposed) {
        if (host.current) host.current.innerHTML = ''
        setError(reason instanceof Error ? reason.message : 'Could not render this diagram.')
      }
    })
    return () => {
      disposed = true
    }
  }, [content, theme, id])
  return (
    <>
      <div ref={host} className="custom-panel-diagram" />
      {error ? <pre className="form-error">{error}</pre> : null}
    </>
  )
}
export function CustomPanels({
  config,
  view,
}: {
  config: LifeConfig
  view: 'research' | 'workspace'
}) {
  const widgets = config.widgets.filter(
    (widget) => widget.placement === view || widget.placement === 'both',
  )
  if (!widgets.length) return null
  return (
    <section className="custom-panels" aria-label="Custom research panels">
      {widgets.map((widget) => (
        <article className="custom-panel" key={widget.id}>
          <h3>{widget.title}</h3>
          {widget.kind === 'mermaid' ? (
            <MermaidPanel content={widget.content} theme={config.theme} />
          ) : (
            <div className="markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {widget.content}
              </ReactMarkdown>
            </div>
          )}
        </article>
      ))}
    </section>
  )
}
