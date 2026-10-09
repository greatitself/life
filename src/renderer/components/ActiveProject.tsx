import type { ReactNode } from 'react'
import { ArrowUpRight, FolderOpen, MessageSquare, Plug, Server } from 'lucide-react'
import type { ConnectionProfile, ConnectionState } from '../../shared/types'
import { describeEnvironment, type EnvironmentScope } from '../environment'
import './active-environment.css'

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
  const environment = describeEnvironment(connection, savedProfile, workspace, scope)
  const connected = connection.status === 'connected'
  const connecting = connection.status === 'connecting'
  const hasProject = Boolean(environment.workspace)
  const projectLabel = scope === 'research' ? 'Research directory' : 'Active project'

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
          <Server size={14} aria-hidden="true" />
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
