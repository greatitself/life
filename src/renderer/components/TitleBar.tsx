import type { ReactNode, Ref } from 'react'
import { createPortal } from 'react-dom'
import { FlaskConical, MessageSquare, Moon, Network, Paintbrush, Sun } from 'lucide-react'
import { api } from '../api'
import { RelayMark } from './Icons'
import { ActiveEnvironment, type ActiveEnvironmentProps } from './ActiveEnvironment'
import './sidebar-navigation.css'
import './header-view-switch.css'

type TitleBarProps = {
  theme: 'dark' | 'light'
  platform: NodeJS.Platform | string
  maximized: boolean
  onThemeToggle: () => void
  version?: string
  researchTitle?: string
  workspaceTitle?: string
  sidebarOpen?: boolean
  onSidebarToggle?: () => void
  view?: 'research' | 'workspace' | 'investigation' | 'extension' | 'customization'
  onViewChange?: (view: 'research' | 'workspace' | 'investigation') => void
  contentRef?: Ref<HTMLDivElement>
  surfaceContentRef?: Ref<HTMLDivElement>
  leadingActionsRef?: Ref<HTMLDivElement>
  environment?: ActiveEnvironmentProps
  studioOpen?: boolean
  onStudioToggle?: () => void
  utilityActions?: ReactNode
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

export function LifeBrand({ className = '' }: { className?: string }) {
  return (
    <span className={`titlebar-brand ${className}`} aria-label="Life">
      <RelayMark size={16} />{' '}
      <strong>
        life
        <span className="life-brand-dot" aria-hidden="true">
          .
        </span>
      </strong>
    </span>
  )
}

export function TitleBarContent({
  target,
  children,
}: {
  target: HTMLElement | null
  children: ReactNode
}) {
  return target ? createPortal(children, target) : null
}

export function TitleBar({
  theme,
  platform,
  maximized,
  onThemeToggle,
  version,
  sidebarOpen = true,
  onSidebarToggle,
  view,
  onViewChange,
  contentRef,
  surfaceContentRef,
  leadingActionsRef,
  environment,
  studioOpen = false,
  onStudioToggle,
  utilityActions,
  researchTitle = 'Map',
  workspaceTitle = 'Agents',
}: TitleBarProps) {
  const isMac = platform === 'darwin'
  return (
    <div
      className={`titlebar life-titlebar life-unified-titlebar ${isMac ? 'titlebar-mac' : 'titlebar-windows'}`}
      onDoubleClick={(event) => {
        // Dialog content is portaled out of the chrome but still bubbles through React.
        if (!event.currentTarget.contains(event.target as Node)) return
        if (!isMac && !(event.target as HTMLElement).closest('button, input, select, textarea, a'))
          api?.window.maximize()
      }}
    >
      <div className="titlebar-sidebar">
        <div className="titlebar-sidebar-row">
          {isMac ? <span className="native-traffic-light-space" aria-hidden="true" /> : null}
          {sidebarOpen || !onSidebarToggle ? <LifeBrand /> : null}
          {onViewChange ? (
            <nav
              className="titlebar-view-switch life-header-view-switch"
              aria-label="Workspace views"
            >
              <button
                type="button"
                className="icon-button"
                aria-label={researchTitle}
                title={researchTitle}
                aria-pressed={view === 'research'}
                onClick={() => onViewChange('research')}
              >
                <Network size={16} />
                <span className="life-header-view-label" aria-hidden="true">
                  {researchTitle}
                </span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={workspaceTitle}
                title={workspaceTitle}
                aria-pressed={view === 'workspace'}
                onClick={() => onViewChange('workspace')}
              >
                <MessageSquare size={16} />
                <span className="life-header-view-label" aria-hidden="true">
                  {workspaceTitle}
                </span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Research"
                title="Research"
                aria-pressed={view === 'investigation'}
                onClick={() => onViewChange('investigation')}
              >
                <FlaskConical size={16} />
                <span className="life-header-view-label" aria-hidden="true">
                  Research
                </span>
              </button>
            </nav>
          ) : null}
        </div>
      </div>
      <div className="titlebar-content" ref={contentRef} />
      <ActiveEnvironment {...(environment || { connection: { status: 'disconnected' } })} />
      <div className="titlebar-right">
        <div className="titlebar-surface-content" ref={surfaceContentRef} />
        <div className="titlebar-tools">
          {version ? <span className="version">v{version.replace(/^v/, '')}</span> : null}
          <div className="titlebar-action-slot titlebar-leading-actions" ref={leadingActionsRef} />
          {utilityActions}
          {onStudioToggle ? (
            <button
              type="button"
              className="icon-button titlebar-studio-toggle"
              aria-label="Customize"
              aria-haspopup="dialog"
              aria-expanded={studioOpen}
              title="Customize"
              onClick={onStudioToggle}
            >
              <Paintbrush size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button titlebar-theme"
            onClick={onThemeToggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        {!isMac ? (
          <div className="native-window-controls" role="group" aria-label="Window controls">
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
      </div>
    </div>
  )
}
