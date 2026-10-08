import { useState } from 'react'
import { MessageSquare, Puzzle, RefreshCw, RotateCcw } from 'lucide-react'
import type { LifeConfigPatch, LifeConfigState } from '../../shared/customization'
import { errorText } from '../api'
import { Modal } from './Modal'

export function CustomizationDialog({
  open,
  onOpenChange,
  state,
  onUndo,
  onReset,
  onReload,
  onOpenExtensions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: LifeConfigState
  connected: boolean
  onApply: (patch: LifeConfigPatch) => Promise<void>
  onUndo: () => Promise<void>
  onReset: () => Promise<void>
  onReload: () => Promise<void>
  onOpenExtensions: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)

  async function action(callback: () => Promise<void>, success: string) {
    setBusy(true)
    setFeedback('')
    try {
      await callback()
      setFeedback(success)
      setFailed(false)
    } catch (error) {
      setFeedback(errorText(error))
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description="Review Life’s current settings and manage saved changes."
      className="customization-modal"
    >
      <div className="customization-scope">
        <MessageSquare size={17} />
        <p>
          Change Life from any thread. Start your message with <code>/life</code>, then describe
          what you want—for example, <code>/life add a research counter</code>. Your agent can
          update settings, add features, and change the interface without leaving the conversation.
        </p>
      </div>
      <div className="customization-current" aria-label="Current settings">
        <span>{state.config.theme} theme</span>
        <span>{state.config.density} layout</span>
        <span>{state.config.fontSize}px text</span>
        <span>{state.config.sidebarWidth}px sidebar</span>
        <span>{state.config.defaultProvider === 'codex' ? 'Codex' : 'Claude Code'} by default</span>
        <span>{state.config.commands.length} commands</span>
        <span>{state.config.widgets.length} panels</span>
      </div>
      {state.config.commands.length ? (
        <details className="customization-output">
          <summary>Saved commands</summary>
          <ul>
            {state.config.commands.map((command) => (
              <li key={command.id}>{command.name}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {state.config.widgets.length ? (
        <details className="customization-output">
          <summary>Saved panels</summary>
          <ul>
            {state.config.widgets.map((widget) => (
              <li key={widget.id}>
                {widget.title} · {widget.kind}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <button
        className="button secondary extension-entry-button"
        disabled={busy}
        onClick={onOpenExtensions}
      >
        <Puzzle size={15} /> Manage extensions
      </button>
      <div className="customization-file">
        <span>Live configuration</span>
        <code>{state.path || 'Browser preview storage'}</code>
      </div>
      {feedback ? (
        <div className={failed ? 'form-error' : 'form-success'} role={failed ? 'alert' : 'status'}>
          {feedback}
        </div>
      ) : null}
      {state.error ? (
        <div className="form-error" role="alert">
          {state.error}
        </div>
      ) : null}
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={busy || !state.canUndo}
          onClick={() => void action(onUndo, 'Previous settings restored.')}
        >
          <RotateCcw size={14} /> Undo
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void action(onReload, 'Configuration reloaded.')}
        >
          <RefreshCw size={14} /> Reload
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void action(onReset, 'Life’s default settings restored.')}
        >
          Reset settings
        </button>
      </div>
    </Modal>
  )
}
