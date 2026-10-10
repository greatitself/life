import { useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, ArrowUpRight, Check, LoaderCircle, RefreshCw } from 'lucide-react'
import {
  PROVIDER_UPDATES,
  providerUpdateCount,
  type ProviderUpdateInfo,
  type ProviderUpdatesState,
} from '../../shared/provider-updates'
import { errorText } from '../api'
import { ProviderIcon } from './Icons'
import { Modal } from './Modal'
import './provider-updates.css'

const statusText: Record<ProviderUpdateInfo['status'], string> = {
  disconnected: 'Connect a machine to check',
  'not-installed': 'Not installed on this machine',
  unknown: 'Version not verified',
  current: 'Latest release installed',
  'update-available': 'Newer release published',
  ahead: 'Newer build installed',
  unavailable: 'Release check unavailable',
}

export function ProviderUpdatesButton({
  state,
  onClick,
  className = 'icon-button',
}: {
  state: ProviderUpdatesState
  onClick: () => void
  className?: string
}) {
  const count = providerUpdateCount(state)
  return (
    <button
      type="button"
      className={`${className} provider-updates-button${count ? ' has-updates' : ''}`}
      onClick={onClick}
      aria-label={
        count ? `Provider updates: ${count} newer releases available` : 'Provider updates'
      }
      title={
        count ? `${count} newer provider releases available` : 'Codex and Claude Code versions'
      }
    >
      <ArrowUpCircle size={17} />
      {count ? (
        <span className="provider-updates-count" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </button>
  )
}

export function ProviderUpdatesDialog({
  open,
  onOpenChange,
  state,
  onCheck,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: ProviderUpdatesState
  onCheck: () => Promise<unknown>
}) {
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState('')
  const request = useRef(0)
  useEffect(() => {
    request.current++
    setActionError('')
    setPending(false)
  }, [open, state.machineId])
  const checking = pending || state.checking
  async function check() {
    const id = ++request.current
    setPending(true)
    setActionError('')
    try {
      await onCheck()
    } catch (error) {
      if (request.current === id) setActionError(errorText(error))
    } finally {
      if (request.current === id) setPending(false)
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Provider updates"
      description="Keep the Codex and Claude Code installations on your connected machine current."
      className="provider-updates-modal"
    >
      <p className="provider-updates-machine">
        {state.connected ? state.machineLabel || 'Connected machine' : 'No machine connected'}
      </p>
      <div className="provider-updates-list" aria-live="polite" aria-busy={checking}>
        {state.providers.map((provider) => {
          const available = provider.status === 'update-available'
          const config = PROVIDER_UPDATES[provider.provider]
          return (
            <article className="provider-update-card" key={provider.provider}>
              <div className="provider-update-heading">
                <ProviderIcon provider={provider.provider} size={22} />
                <h3>{config.name}</h3>
                <span className={`provider-update-status${available ? ' available' : ''}`}>
                  {provider.status === 'current' ? <Check size={12} /> : null}
                  {provider.status === 'current' && provider.stale
                    ? 'Matches last verified release'
                    : statusText[provider.status]}
                </span>
              </div>
              <dl className="provider-update-versions">
                <div>
                  <dt>Installed on this machine</dt>
                  <dd>
                    {state.connected
                      ? provider.installedVersion ||
                        (provider.status === 'not-installed' ? 'Missing' : 'Unknown')
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Latest published release</dt>
                  <dd>{provider.latestVersion || (checking ? 'Checking…' : 'Not checked')}</dd>
                </div>
              </dl>
              {provider.error ? (
                <p className="provider-update-warning">
                  {provider.stale ? 'Showing the last verified release. ' : ''}
                  {provider.error}
                </p>
              ) : provider.stale ? (
                <p className="provider-update-warning">
                  Saved release information; check again to refresh.
                </p>
              ) : null}
              <div className="provider-update-footer">
                <span>
                  {provider.checkedAt
                    ? `Verified ${new Date(provider.checkedAt).toLocaleString()}`
                    : 'Release metadata from npm'}
                </span>
                <a href={config.instructionsUrl} target="_blank" rel="noreferrer">
                  {provider.status === 'not-installed'
                    ? 'Install instructions'
                    : 'Update instructions'}
                  <ArrowUpRight size={13} />
                </a>
              </div>
            </article>
          )
        })}
      </div>
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <p className="provider-updates-help">
        Use the updater for your installation and release channel on this machine. Claude’s stable
        channel and package managers may offer a different version from the latest release shown
        here. Finish active agent turns before updating, then check again to verify the installed
        version.
      </p>
      <div className="modal-actions">
        <button
          className="button primary"
          type="button"
          disabled={checking || !state.connected}
          onClick={() => void check()}
        >
          {checking ? <LoaderCircle size={15} className="spinning" /> : <RefreshCw size={15} />}
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </Modal>
  )
}
