import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../api'
import { Terminal as TerminalIcon, RotateCw, X } from 'lucide-react'
export function RemoteTerminal({
  onClose,
  connected,
}: {
  onClose: () => void
  connected: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (!container.current || !api || !connected) return
    const bridge = api
    let disposed = false
    let cleanup = () => {}
    setError('')
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(async ([{ Terminal }, { FitAddon }]) => {
        if (disposed || !container.current) return
        const term = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          fontFamily: '"IBM Plex Mono", monospace',
          theme: {
            background: '#17181b',
            foreground: '#c9cbd3',
            cursor: '#c4b5fd',
            selectionBackground: '#413856',
            black: '#1b1c20',
            red: '#ee8b92',
            green: '#94c9aa',
            yellow: '#dfc18c',
            blue: '#9eb6e7',
            magenta: '#c4b5fd',
            cyan: '#92c9d0',
            white: '#e4e5ec',
          },
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(container.current)
        const unsub = bridge.onTerminal((data) => term.write(data))
        const input = term.onData((data) => bridge.terminal.write(data))
        const resize = () => {
          if (!disposed) {
            fit.fit()
            bridge.terminal.resize(term.cols, term.rows)
          }
        }
        const observer = new ResizeObserver(resize)
        observer.observe(container.current)
        cleanup = () => {
          observer.disconnect()
          unsub()
          input.dispose()
          term.dispose()
          void bridge.terminal.close()
        }
        try {
          await bridge.terminal.open()
          if (!disposed) {
            resize()
            term.focus()
          }
        } catch (e) {
          if (!disposed) setError(errorText(e))
        }
      })
      .catch((e) => {
        if (!disposed) setError(errorText(e))
      })
    return () => {
      disposed = true
      cleanup()
    }
  }, [connected, generation])
  return (
    <section className="terminal-panel" aria-label="Remote terminal">
      <header>
        <span>
          <TerminalIcon size={14} /> Terminal <span className="terminal-caption">remote shell</span>
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="Restart terminal"
            onClick={() => setGeneration((g) => g + 1)}
          >
            <RotateCw size={14} />
          </button>
          <button className="icon-button" aria-label="Close terminal" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      {!connected ? (
        <div className="terminal-offline">Connect a machine to open its terminal.</div>
      ) : error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="terminal-container" ref={container} />
    </section>
  )
}
