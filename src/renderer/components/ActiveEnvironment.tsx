import { useRef, useState } from 'react'
import {
  ArrowRightLeft,
  ChevronDown,
  FolderOpen,
  Plug,
  Server,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import type { ConnectionProfile, ConnectionState } from '../../shared/types'
import { describeEnvironment, type EnvironmentScope } from '../environment'
import { ProviderIcon } from './Icons'
import { Modal } from './Modal'
import './active-environment.css'

export interface ActiveEnvironmentProps {
  connection: ConnectionState
  savedProfile?: ConnectionProfile
  /** Research and customization can show their own directory without changing Agents. */
  workspace?: string
  scope?: EnvironmentScope
  onConnect?: () => void
  onChooseProject?: () => void
  onManageConnections?: () => void
}

export function ActiveEnvironment({
  connection,
  savedProfile,
  workspace,
  scope = 'agents',
  onConnect,
  onChooseProject,
  onManageConnections,
}: ActiveEnvironmentProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const actionRequested = useRef(false)
  const environment = describeEnvironment(connection, savedProfile, workspace, scope)
  const connected = environment.status === 'connected'
  const connecting = environment.status === 'connecting'

  function perform(action: (() => void) | undefined) {
    actionRequested.current = true
    setOpen(false)
    action?.()
  }

  return (
    <>
      <div className="titlebar-environment">
        <button
          type="button"
          ref={trigger}
          className="active-environment-trigger"
          aria-label="Current Active Environment"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`Current Active Environment · ${environment.machineName} · ${environment.statusLabel}`}
          onClick={() => {
            actionRequested.current = false
            setOpen(true)
          }}
        >
          <span
            className="environment-status-dot"
            data-status={environment.status}
            aria-hidden="true"
          />
          <Server size={14} aria-hidden="true" />
          <span className="environment-trigger-label">Current Active Environment</span>
          <span className="environment-trigger-machine">{environment.machineName}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </div>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Current Active Environment"
        description="Your current machine, workspace and available coding agents."
        className="active-environment-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // A switch action opens another dialog, which owns focus next.
          if (!actionRequested.current) trigger.current?.focus()
          actionRequested.current = false
        }}
      >
        <section className="environment-machine-card" aria-label="Machine connection">
          <span className="environment-machine-icon">
            <Server size={21} aria-hidden="true" />
          </span>
          <div className="environment-machine-description">
            <strong>{environment.machineName}</strong>
            <span>{environment.authority || 'Connect a machine to begin'}</span>
          </div>
          <span className="environment-status-label" data-status={environment.status}>
            <span
              className="environment-status-dot"
              data-status={environment.status}
              aria-hidden="true"
            />
            {environment.statusLabel}
          </span>
        </section>

        <dl className="environment-details">
          <div>
            <dt>Area</dt>
            <dd>{environment.scopeLabel}</dd>
          </div>
          <div>
            <dt>{scope === 'research' ? 'Research directory' : 'Workspace'}</dt>
            <dd className="environment-detail-path">
              {environment.workspace ||
                (connected ? 'No project selected' : 'No workspace selected')}
            </dd>
          </div>
          {environment.sshAlias ? (
            <div>
              <dt>SSH config alias</dt>
              <dd>{environment.sshAlias}</dd>
            </div>
          ) : null}
          {environment.sshConfigPath ? (
            <div>
              <dt>SSH config file</dt>
              <dd className="environment-detail-path">{environment.sshConfigPath}</dd>
            </div>
          ) : null}
          {environment.profile ? (
            <div>
              <dt>Authentication</dt>
              <dd>
                <ShieldCheck size={13} aria-hidden="true" />
                {environment.profile.auth === 'agent'
                  ? 'SSH agent'
                  : environment.profile.auth === 'key'
                    ? 'Private key'
                    : 'Password'}
              </dd>
            </div>
          ) : null}
        </dl>

        <section
          className="environment-provider-section"
          aria-labelledby="environment-provider-heading"
        >
          <h3 id="environment-provider-heading">Coding agents</h3>
          <div className="environment-providers">
            {environment.providerStatuses.map((provider) => (
              <div
                className="environment-provider"
                key={provider.provider}
                data-availability={provider.availability}
              >
                <ProviderIcon provider={provider.provider} size={21} />
                <div>
                  <strong>{provider.label}</strong>
                  <span>{provider.detail}</span>
                </div>
                <span className="environment-provider-availability">
                  {provider.availability === 'available'
                    ? 'Available'
                    : provider.availability === 'missing'
                      ? 'Not installed'
                      : 'Not checked'}
                </span>
              </div>
            ))}
          </div>
        </section>

        {connection.error ? (
          <p className="environment-connection-error" role="status">
            {connection.error}
          </p>
        ) : null}
        <div className="environment-actions">
          {onChooseProject && connected && scope === 'agents' ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => perform(onChooseProject)}
            >
              <FolderOpen size={15} />
              {environment.workspace ? 'Change project' : 'Choose project'}
            </button>
          ) : null}
          {onConnect ? (
            <button
              type="button"
              className={`button ${!connected ? 'primary' : 'secondary'}`}
              disabled={connecting}
              onClick={() => perform(onConnect)}
            >
              {connected ? <ArrowRightLeft size={15} /> : <Plug size={15} />}
              {connecting
                ? 'Connecting…'
                : connected
                  ? 'Switch environment'
                  : 'Connect environment'}
            </button>
          ) : null}
          {onManageConnections ? (
            <button
              type="button"
              className="button secondary environment-manage"
              onClick={() => perform(onManageConnections)}
            >
              <Settings2 size={15} />
              Manage connections
            </button>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
