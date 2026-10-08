import { Moon, Sun } from 'lucide-react'
import { api } from '../api'
import { RelayMark } from './Icons'

type TitleBarProps = {
  theme: 'dark' | 'light'
  platform: NodeJS.Platform | string
  maximized: boolean
  onThemeToggle: () => void
  version?: string
}

function WindowGlyph({ action }: { action: 'minimize' | 'maximize' | 'restore' | 'close' }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
      {action === 'minimize' ? <path d="M1 6.5h10" stroke="currentColor" /> : null}
      {action === 'maximize' ? (
        <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" />
      ) : null}
      {action === 'restore' ? (
        <>
          <path d="M3.5 1.5h7v7" stroke="currentColor" />
          <rect x="1.5" y="3.5" width="7" height="7" stroke="currentColor" />
        </>
      ) : null}
      {action === 'close' ? <path d="m1.5 1.5 9 9m0-9-9 9" stroke="currentColor" /> : null}
    </svg>
  )
}

export function TitleBar({ theme, platform, maximized, onThemeToggle, version }: TitleBarProps) {
  const isMac = platform === 'darwin'
  return (
    <header
      className={`titlebar life-titlebar ${isMac ? 'titlebar-mac' : 'titlebar-windows'}`}
      onDoubleClick={(event) => {
        if (!isMac && !(event.target as HTMLElement).closest('button')) api?.window.maximize()
      }}
    >
      {isMac ? <span className="native-traffic-light-space" aria-hidden="true" /> : null}
      <span className="titlebar-brand">
        <RelayMark size={16} /> <span>Life</span>
      </span>
      <span className="titlebar-center">Research workspace</span>
      <div className="titlebar-tools">
        {version ? <span className="version">v{version.replace(/^v/, '')}</span> : null}
        <button
          className="icon-button titlebar-theme"
          onClick={onThemeToggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
      {!isMac ? (
        <div className="native-window-controls" aria-label="Window controls">
          <button
            className="native-window-button"
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => api?.window.minimize()}
            disabled={!api}
          >
            <WindowGlyph action="minimize" />
          </button>
          <button
            className="native-window-button"
            aria-label={maximized ? 'Restore window' : 'Maximize window'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => api?.window.maximize()}
            disabled={!api}
          >
            <WindowGlyph action={maximized ? 'restore' : 'maximize'} />
          </button>
          <button
            className="native-window-button native-window-close"
            aria-label="Close window"
            title="Close"
            onClick={() => api?.window.close()}
            disabled={!api}
          >
            <WindowGlyph action="close" />
          </button>
        </div>
      ) : null}
    </header>
  )
}
