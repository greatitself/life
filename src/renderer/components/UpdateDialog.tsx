import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowUpRight, Check, LoaderCircle, RefreshCw } from 'lucide-react'
import { LIFE_RELEASES_URL, type UpdateState } from '../../shared/updates'
import { errorText } from '../api'
import { Modal } from './Modal'
import './updates.css'

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function downloadTime(seconds: number): string {
  return seconds < 60
    ? `${Math.max(1, Math.ceil(seconds))}s remaining`
    : `${Math.ceil(seconds / 60)} min remaining`
}

const headings: Record<UpdateState['status'], string> = {
  idle: 'Keep Life up to date',
  checking: 'Checking for updates',
  available: 'A new version of Life is ready',
  'not-available': 'You’re up to date',
  downloading: 'Downloading your update',
  downloaded: 'Ready to restart',
  error: 'The update could not finish',
  unsupported: 'Download the latest version',
}

export function UpdateDialog({
  open,
  onOpenChange,
  state,
  onCheck,
  onDownload,
  onInstall,
  onAutoDownload,
  busy = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: UpdateState
  onCheck: () => Promise<unknown>
  onDownload: () => Promise<unknown>
  onInstall: () => Promise<unknown>
  onAutoDownload?: (enabled: boolean) => Promise<unknown>
  busy?: boolean
}) {
  const [pending, setPending] = useState(false)
  const [preferencePending, setPreferencePending] = useState(false)
  const [actionError, setActionError] = useState('')
  useEffect(() => setActionError(''), [state.status])
  async function run(action: () => Promise<unknown>) {
    setPending(true)
    setActionError('')
    try {
      await action()
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setPending(false)
    }
  }
  async function changeAutoDownload(enabled: boolean) {
    if (!onAutoDownload) return
    setPreferencePending(true)
    setActionError('')
    try {
      await onAutoDownload(enabled)
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setPreferencePending(false)
    }
  }
  const working = pending || state.status === 'checking' || state.status === 'downloading'
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Life updates"
      description="Updates replace your existing Life installation and keep your saved workspace."
      className="updates-modal"
    >
      <div className="updates-card" aria-live="polite">
        <div className="updates-symbol">
          {state.status === 'not-available' ? (
            <Check size={25} />
          ) : state.status === 'checking' || state.status === 'downloading' ? (
            <LoaderCircle size={25} className="spinning" />
          ) : (
            <ArrowDownToLine size={25} />
          )}
        </div>
        <h3>{headings[state.status]}</h3>
        <p>
          Installed version <strong>{state.currentVersion}</strong>
          {state.version ? (
            <>
              {' · '}New version <strong>{state.version}</strong>
            </>
          ) : null}
        </p>
        {state.status === 'available' ? (
          <p>Download now, then restart Life whenever you’re ready.</p>
        ) : null}
        {state.status === 'downloaded' ? (
          <p>The update is verified and ready. Restart Life whenever you’re ready.</p>
        ) : state.status === 'downloading' ? (
          <p>You can keep working while Life prepares the update.</p>
        ) : null}
        {state.message ? <p>{state.message}</p> : null}
        {state.status === 'downloading' ? (
          <div className="updates-progress">
            <progress
              max={100}
              value={state.progress?.percent}
              aria-label="Update download progress"
            />
            <div>
              <span>
                {state.progress && state.progress.percent >= 100
                  ? 'Verifying update…'
                  : state.progress
                    ? `${Math.round(state.progress.percent)}%`
                    : 'Preparing download…'}
              </span>
              {state.progress ? (
                <span>
                  {bytes(state.progress.transferred)} / {bytes(state.progress.total)}
                </span>
              ) : null}
            </div>
            {state.progress && state.progress.percent < 100 && state.progress.bytesPerSecond > 0 ? (
              <div>
                <span>{bytes(state.progress.bytesPerSecond)}/s</span>
                <span>
                  {downloadTime(
                    Math.max(0, state.progress.total - state.progress.transferred) /
                      state.progress.bytesPerSecond,
                  )}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
        {state.error || actionError ? (
          <div className="form-error updates-error" role="alert">
            {actionError || state.error}
          </div>
        ) : null}
      </div>
      {onAutoDownload && state.status !== 'unsupported' ? (
        <label className="updates-preference">
          <input
            type="checkbox"
            checked={state.autoDownload !== false}
            onChange={(event) => {
              const enabled = event.currentTarget.checked
              void changeAutoDownload(enabled)
            }}
            disabled={preferencePending}
          />
          <span>
            <strong>Download updates automatically</strong>
            <span>
              {state.autoDownload === false
                ? 'You choose when to download and restart.'
                : 'Updates prepare in the background. You choose when to restart.'}
              {state.status === 'downloading' && state.autoDownload === false
                ? ' The current download will finish.'
                : ''}
            </span>
          </span>
        </label>
      ) : null}
      {state.status === 'downloaded' && busy ? (
        <div className="updates-running" role="status">
          An agent turn is running. Finish or stop it before restarting Life.
        </div>
      ) : null}
      <div className="modal-actions updates-actions">
        <a className="button secondary" href={LIFE_RELEASES_URL} target="_blank" rel="noreferrer">
          View releases <ArrowUpRight size={14} />
        </a>
        {state.status === 'available' || (state.status === 'error' && state.version) ? (
          <button
            className="button primary"
            disabled={working}
            onClick={() => void run(onDownload)}
          >
            <ArrowDownToLine size={15} />
            {state.status === 'error' ? 'Retry download' : 'Download update'}
          </button>
        ) : state.status === 'downloaded' ? (
          <button
            className="button primary"
            disabled={pending || busy}
            onClick={() => void run(onInstall)}
          >
            <RefreshCw size={15} /> Restart and install
          </button>
        ) : state.status !== 'unsupported' ? (
          <button className="button primary" disabled={working} onClick={() => void run(onCheck)}>
            {working ? <LoaderCircle size={15} className="spinning" /> : <RefreshCw size={15} />}
            {state.status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        ) : null}
      </div>
      <p className="updates-source">Official releases from greatitself/life on GitHub.</p>
    </Modal>
  )
}
