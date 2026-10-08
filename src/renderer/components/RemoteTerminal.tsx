import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../api'
import { Terminal as TerminalIcon, RotateCw, X } from 'lucide-react'
import type { Terminal, ITheme } from '@xterm/xterm'

const terminalTheme = (theme: 'dark' | 'light'): ITheme =>
  theme === 'light'
    ? {
        background: '#ffffff',
        foreground: '#242424',
        cursor: '#111111',
        cursorAccent: '#ffffff',
        selectionBackground: '#00000020',
        black: '#111111',
        red: '#424242',
        green: '#363636',
        yellow: '#4c4c4c',
        blue: '#303030',
        magenta: '#4a4a4a',
        cyan: '#3d3d3d',
        white: '#777777',
        brightBlack: '#666666',
        brightRed: '#292929',
        brightGreen: '#242424',
        brightYellow: '#303030',
        brightBlue: '#202020',
        brightMagenta: '#2d2d2d',
        brightCyan: '#262626',
        brightWhite: '#000000',
      }
    : {
        background: '#111111',
        foreground: '#dedede',
        cursor: '#fafafa',
        cursorAccent: '#111111',
        selectionBackground: '#ffffff26',
        black: '#222222',
        red: '#cccccc',
        green: '#d8d8d8',
        yellow: '#c4c4c4',
        blue: '#dedede',
        magenta: '#c7c7c7',
        cyan: '#d3d3d3',
        white: '#e5e5e5',
        brightBlack: '#888888',
        brightRed: '#eeeeee',
        brightGreen: '#f1f1f1',
        brightYellow: '#e8e8e8',
        brightBlue: '#f5f5f5',
        brightMagenta: '#ededed',
        brightCyan: '#f0f0f0',
        brightWhite: '#ffffff',
      }

export function RemoteTerminal({
  onClose,
  connected,
  theme = 'dark',
}: {
  onClose: () => void
  connected: boolean
  theme?: 'dark' | 'light'
}) {
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<Terminal | null>(null)
  const currentTheme = useRef(theme)
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    currentTheme.current = theme
    if (instance.current) instance.current.options.theme = terminalTheme(theme)
  }, [theme])
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
          theme: terminalTheme(currentTheme.current),
        })
        instance.current = term
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
          instance.current = null
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
