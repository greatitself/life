import { useState, type ReactNode } from 'react'
import { ArrowUpRight, FolderOpen, MessageSquare, Monitor, Plug, Server } from 'lucide-react'
import type { ConnectionProfile, ConnectionState } from '../../shared/types'
import { describeEnvironment, type EnvironmentScope } from '../environment'
import './active-environment.css'
import './prompt-font-preview.css'

const promptFonts = [
  { name: 'DM Sans', family: "'DM Sans Variable', 'DM Sans', sans-serif" },
  { name: 'Manrope', family: "'Life Prompt Manrope', sans-serif" },
  { name: 'Geist', family: "'Life Prompt Geist', sans-serif" },
  { name: 'Plus Jakarta Sans', family: "'Life Prompt Plus Jakarta Sans', sans-serif" },
  { name: 'Instrument Sans', family: "'Life Prompt Instrument Sans', sans-serif" },
  { name: 'Outfit', family: "'Life Prompt Outfit', sans-serif" },
  { name: 'Onest', family: "'Life Prompt Onest', sans-serif" },
  { name: 'Urbanist', family: "'Life Prompt Urbanist', sans-serif" },
  { name: 'Inter', family: "'Life Prompt Inter', sans-serif" },
  { name: 'IBM Plex Sans', family: "'Life Prompt IBM Plex Sans', sans-serif" },
] as const

export interface ActiveProjectProps {
  connection: ConnectionState
  savedProfile?: ConnectionProfile
  workspace?: string
  scope?: EnvironmentScope
  onChooseProject?: () => void
  onConnect?: () => void
  children?: ReactNode
}

/** The empty conversation describes its real destination before the first message. */
export function ActiveProject({
  connection,
  savedProfile,
  workspace,
  scope = 'agents',
  onChooseProject,
  onConnect,
  children,
}: ActiveProjectProps) {
  const [promptFont, setPromptFont] = useState(0)
  const environment = describeEnvironment(connection, savedProfile, workspace, scope)
  const connected = connection.status === 'connected'
  const connecting = connection.status === 'connecting'
  const hasProject = Boolean(environment.workspace)
  const projectLabel = scope === 'research' ? 'Research directory' : 'Active project'

  if (scope === 'agents' && connected && hasProject) {
    return (
      <section className="active-project-start active-project-prompt" aria-label="New thread">
        <h1 style={{ fontFamily: promptFonts[promptFont].family }}>
          What do you want to do in{' '}
          <button
            type="button"
            className="active-project-selector"
            onClick={onChooseProject}
            disabled={!connected || !onChooseProject}
            aria-haspopup="dialog"
            title={hasProject ? 'Change project' : 'Choose project'}
          >
            {environment.projectName || 'your project'}
          </button>
          ?
        </h1>
        <fieldset className="prompt-font-preview">
          <legend>Choose a font to preview</legend>
          <div className="prompt-font-options">
            {promptFonts.map((font, index) => (
              <button
                key={font.name}
                type="button"
                className="prompt-font-option"
                aria-label={`${index + 1}. ${font.name}`}
                aria-pressed={promptFont === index}
                onClick={() => setPromptFont(index)}
              >
                <span className="prompt-font-option-label">
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <span>{font.name}</span>
                </span>
                <span className="prompt-font-sample" style={{ fontFamily: font.family }}>
                  What would you like to do?
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      </section>
    )
  }

  return (
    <section className="active-project-start" aria-label="New thread">
      <div className="active-project-eyebrow">
        <MessageSquare size={15} aria-hidden="true" />
        New thread
      </div>
      <div className="active-project-heading">
        <span className="active-project-icon">
          <FolderOpen size={27} aria-hidden="true" />
        </span>
        <div>
          <span className="active-project-label">
            {hasProject ? projectLabel : 'Your workspace'}
          </span>
          <h1>
            {environment.projectName ||
              (connected ? 'Choose a project' : 'Connect your environment')}
          </h1>
        </div>
      </div>
      <div className="active-project-location">
        {hasProject ? (
          <div className="active-project-path">
            <FolderOpen size={14} aria-hidden="true" />
            <code>{environment.workspace}</code>
          </div>
        ) : null}
        <div className="active-project-machine">
          {environment.profile?.transport === 'local' ? (
            <Monitor size={14} aria-hidden="true" />
          ) : (
            <Server size={14} aria-hidden="true" />
          )}
          <span>{environment.authority || environment.machineName}</span>
          <span className="environment-status-label" data-status={environment.status}>
            <span
              className="environment-status-dot"
              data-status={environment.status}
              aria-hidden="true"
            />
            {environment.statusLabel}
          </span>
        </div>
      </div>
      <p className="active-project-guidance">
        {connecting
          ? 'Connecting to your machine. Your project will be available when the connection is ready.'
          : connected
            ? hasProject
              ? 'Start a conversation in this project. Your agent runs in the directory shown above.'
              : 'Choose a directory on this machine to start your next conversation.'
            : hasProject
              ? 'Reconnect to this machine to continue in the project shown above.'
              : 'Connect a machine, then choose the project you want to work on.'}
      </p>
      <div className="active-project-actions">
        {connected && onChooseProject && scope === 'agents' ? (
          <button type="button" className="button secondary" onClick={onChooseProject}>
            <FolderOpen size={14} />
            {hasProject ? 'Change project' : 'Choose project'}
            <ArrowUpRight size={13} />
          </button>
        ) : null}
        {!connected && onConnect ? (
          <button
            type="button"
            className="button secondary"
            disabled={connecting}
            onClick={onConnect}
          >
            <Plug size={14} />
            {connecting ? 'Connecting…' : 'Connect environment'}
            <ArrowUpRight size={13} />
          </button>
        ) : null}
      </div>
      {children ? <div className="active-project-provider-choices">{children}</div> : null}
    </section>
  )
}
