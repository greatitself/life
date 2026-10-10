import { Component, createRef, type ErrorInfo, type ReactNode } from 'react'
import type { RelayAPI } from '../../shared/types'
import './renderer-recovery.css'

type RecoveryAPI = Pick<RelayAPI, 'platform'> & {
  extensions: Pick<RelayAPI['extensions'], 'recover'>
  window?: Pick<RelayAPI['window'], 'minimize' | 'maximize' | 'close' | 'restart'>
}

type Props = {
  children: ReactNode
  recoveryApi?: RecoveryAPI
}

type State = {
  error?: string
  recovering?: 'retry' | 'restore'
  recoveryError?: string
}

/** Keeps a later React render failure from replacing the entire workspace with a blank window. */
export class RendererErrorBoundary extends Component<Props, State> {
  state: State = {}
  private readonly panel = createRef<HTMLElement>()
  private mounted = false
  private recoveryRequested = false

  static getDerivedStateFromError(error: unknown): State {
    return {
      error:
        (error instanceof Error ? error.message : String(error)).slice(0, 2000) ||
        'An unknown render error occurred.',
      recovering: undefined,
    }
  }

  componentDidMount() {
    this.mounted = true
  }

  componentWillUnmount() {
    this.mounted = false
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Life could not render its workspace:', error, info.componentStack)
    this.panel.current?.focus()
    // The immutable bootstrap can recover customized source even though React
    // handles this error and no longer emits a global browser error event.
    window.dispatchEvent(new CustomEvent('life:renderer-error', { detail: this.state.error }))
  }

  private retry = async () => {
    if (this.recoveryRequested) return
    const api = this.props.recoveryApi
    if (!api) {
      // No native sessions exist when the desktop bridge is unavailable.
      this.setState({ error: undefined, recoveryError: undefined, recovering: undefined })
      return
    }
    this.recoveryRequested = true
    this.setState({ recovering: 'retry', recoveryError: undefined })
    try {
      if (!api.window?.restart) throw new Error('Close and reopen Life to retry this workspace.')
      // The native host stops renderer-owned agents and requests before opening
      // the replacement window, retaining SSH, the project and enabled extensions.
      await api.window.restart()
    } catch (error) {
      this.recoveryFailed(error)
    }
  }

  private recoveryFailed = (error: unknown) => {
    this.recoveryRequested = false
    if (this.mounted) {
      this.setState({
        recovering: undefined,
        recoveryError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      })
    }
  }

  private recover = async () => {
    const api = this.props.recoveryApi
    if (!api || this.recoveryRequested) return
    this.recoveryRequested = true
    this.setState({ recovering: 'restore', recoveryError: undefined })
    try {
      // The native host replaces this window, even if the renderer is otherwise broken.
      await api.extensions.recover()
    } catch (error) {
      this.recoveryFailed(error)
    }
  }

  render() {
    if (this.state.error === undefined) return this.props.children
    const { recoveryApi } = this.props
    const shortcut = recoveryApi?.platform === 'darwin' ? '⌘+Shift+L' : 'Ctrl+Shift+L'
    return (
      <div className="renderer-recovery" data-life-renderer-error={this.state.error}>
        <div
          className={`renderer-recovery-titlebar ${recoveryApi?.platform === 'darwin' ? 'renderer-recovery-titlebar-mac' : ''}`}
          aria-label="Life window"
        >
          <span>Life</span>
          {recoveryApi?.window && recoveryApi.platform !== 'darwin' ? (
            <div
              className="renderer-recovery-window-controls"
              role="group"
              aria-label="Window controls"
            >
              <button
                type="button"
                aria-label="Minimize window"
                onClick={() => recoveryApi.window!.minimize()}
              >
                −
              </button>
              <button
                type="button"
                aria-label="Maximize window"
                onClick={() => recoveryApi.window!.maximize()}
              >
                □
              </button>
              <button
                type="button"
                aria-label="Close window"
                onClick={() => recoveryApi.window!.close()}
              >
                ×
              </button>
            </div>
          ) : null}
        </div>
        <main
          className="renderer-recovery-panel"
          ref={this.panel}
          tabIndex={-1}
          role="alert"
          aria-labelledby="renderer-recovery-title"
        >
          <span className="renderer-recovery-brand">life.</span>
          <h1 id="renderer-recovery-title">The workspace could not be displayed</h1>
          <p>
            Your saved projects and threads are still available. Retry the workspace to continue.
          </p>
          {recoveryApi ? (
            <p>
              Retry restarts the interface and stops active turns while keeping your machine
              connection, selected project and extensions.
            </p>
          ) : null}
          {recoveryApi ? (
            <p>
              If the error returns, restore the built-in UI. This disables custom source and runtime
              extensions and disconnects SSH. Your saved conversations and extension files are kept.
            </p>
          ) : null}
          <div className="renderer-recovery-actions">
            <button type="button" onClick={this.retry} disabled={Boolean(this.state.recovering)}>
              {this.state.recovering === 'retry' ? 'Restarting workspace…' : 'Retry workspace'}
            </button>
            {recoveryApi ? (
              <button
                type="button"
                onClick={this.recover}
                disabled={Boolean(this.state.recovering)}
              >
                {this.state.recovering === 'restore'
                  ? 'Restoring built-in UI…'
                  : 'Restore built-in UI'}
              </button>
            ) : null}
          </div>
          {recoveryApi ? (
            <p className="renderer-recovery-shortcut">
              Native recovery is also available with {shortcut}.
            </p>
          ) : null}
          {this.state.recoveryError ? (
            <p className="renderer-recovery-failure">Recovery failed: {this.state.recoveryError}</p>
          ) : null}
          <details>
            <summary>Error details</summary>
            <pre>{this.state.error}</pre>
          </details>
        </main>
      </div>
    )
  }
}
