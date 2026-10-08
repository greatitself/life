import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, RotateCcw, Sparkles, Square } from 'lucide-react'
import type { AgentEvent, Provider } from '../../shared/types'
import type { LifeConfigPatch, LifeConfigState } from '../../shared/customization'
import {
  buildCustomizationPrompt,
  extractCustomizationProposal,
  planLocalCustomization,
} from '../customization'
import { api, errorText } from '../api'
import { Modal } from './Modal'
import { ApprovalCard } from './MessageView'
import { ProviderIcon } from './Icons'

export function CustomizationDialog({
  open,
  onOpenChange,
  state,
  connected,
  onApply,
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
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState<Provider>(state.config.defaultProvider)
  const [running, setRunning] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [output, setOutput] = useState('')
  const [pending, setPending] = useState<AgentEvent[]>([])
  const session = useRef<string | undefined>(undefined)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  const cancelRequest = useRef<(() => void) | undefined>(undefined)
  useEffect(
    () => () => {
      cleanup.current?.()
      cancelRequest.current?.()
      if (session.current) void api?.agent.dispose(session.current).catch(() => {})
    },
    [],
  )

  async function customize() {
    if (!prompt.trim() || running) return
    setFeedback('')
    setFailed(false)
    setOutput('')
    setRunning(true)
    try {
      const local = planLocalCustomization(prompt, state.config)
      if (local) {
        await onApply(local)
        setFeedback('Applied. Life has updated immediately. You can undo this change below.')
        setPrompt('')
        return
      }
      if (!connected || !api)
        throw new Error(
          'Connect a machine with Codex or Claude Code for this request. Theme, text size, and layout prompts also work offline.',
        )
      const id = crypto.randomUUID()
      session.current = id
      const response = new Promise<string>((resolve, reject) => {
        const parts = new Map<string, string>()
        cancelRequest.current = () => reject(new Error('Customization stopped.'))
        cleanup.current = api!.onAgent((event) => {
          if (event.sessionId !== id) return
          if (event.type === 'text') {
            const key = event.itemId || 'response'
            parts.set(
              key,
              event.status === 'replace'
                ? event.text || ''
                : (parts.get(key) || '') + (event.text || ''),
            )
            setOutput([...parts.values()].join('\n'))
          }
          if (event.type === 'approval' || event.type === 'question')
            setPending((previous) => [
              ...previous.filter((item) => item.requestId !== event.requestId),
              event,
            ])
          if (event.type === 'error')
            reject(new Error(event.text || 'The agent could not create this customization.'))
          if (event.type === 'complete') {
            if (event.status === 'interrupted') reject(new Error('Customization stopped.'))
            else resolve([...parts.values()].join('\n'))
          }
        })
      })
      // Attach a rejection handler before starting: provider startup can fail first.
      void response.catch(() => {})
      try {
        await Promise.race([
          api.agent.start({
            sessionId: id,
            provider,
            mode: 'plan',
            prompt: buildCustomizationPrompt(prompt, state.config),
          }),
          response.then(() => undefined),
        ])
        const text = await response
        await onApply(extractCustomizationProposal(text))
        setFeedback('Applied the agent’s customization. Your new settings and panels are live.')
        setPrompt('')
      } finally {
        cleanup.current?.()
        void api.agent.dispose(id).catch(() => {})
        cleanup.current = undefined
        cancelRequest.current = undefined
        session.current = undefined
        setPending([])
      }
    } catch (error) {
      setFeedback(errorText(error))
      setFailed(true)
    } finally {
      setRunning(false)
    }
  }
  async function action(callback: () => Promise<void>, success: string) {
    try {
      await callback()
      setFeedback(success)
      setFailed(false)
    } catch (error) {
      setFeedback(errorText(error))
      setFailed(true)
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && running) {
          cancelRequest.current?.()
          if (session.current) void api?.agent.stop(session.current)
        }
        onOpenChange(next)
      }}
      title="Make Life yours"
      description="Describe a change. Life updates its settings, commands, and research panels live."
      className="customization-modal"
    >
      <div className="customization-scope">
        <Sparkles size={17} />
        <p>
          Change the theme, layout, text size, defaults, welcome copy, reusable prompts, or add
          Markdown and Mermaid panels. Use live extensions below to add executable features and
          replace views.
        </p>
      </div>
      <button
        className="button secondary extension-entry-button"
        disabled={running}
        onClick={onOpenExtensions}
      >
        <Sparkles size={15} /> Change anything with live extensions
      </button>
      <div className="customization-examples">
        {[
          'Switch to light theme',
          'Use a compact layout',
          'Set font size to 16',
          'Add a research panel with a Mermaid flowchart of my experiment workflow',
        ].map((example) => (
          <button key={example} disabled={running} onClick={() => setPrompt(example)}>
            {example}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void customize()
        }}
        className="customization-prompt"
      >
        <textarea
          aria-label="Describe how to customize Life"
          placeholder="Make Life work the way you think…"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={running}
          rows={4}
        />
        <div className="customization-toolbar">
          <label>
            <ProviderIcon provider={provider} size={17} />
            <select
              aria-label="Customization agent"
              value={provider}
              disabled={running}
              onChange={(event) => setProvider(event.target.value as Provider)}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <span>{connected ? 'Connected agent available' : 'Local settings work offline'}</span>
          {running ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                cancelRequest.current?.()
                if (session.current) void api?.agent.stop(session.current)
              }}
            >
              <Square size={13} /> Stop
            </button>
          ) : (
            <button type="submit" className="button primary" disabled={!prompt.trim()}>
              <ArrowUp size={15} /> Apply prompt
            </button>
          )}
        </div>
      </form>
      {running ? (
        <div className="customization-progress" role="status">
          <LoaderCircle size={15} className="spinning" /> Preparing your customization…
        </div>
      ) : null}
      {pending.map((event) => (
        <ApprovalCard
          key={event.requestId}
          event={event}
          onRespond={async (accepted, answers) => {
            if (session.current && api) {
              await api.agent.respond(session.current, event.requestId!, accepted, answers)
              setPending((items) => items.filter((item) => item.requestId !== event.requestId))
            }
          }}
        />
      ))}
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
      {output ? (
        <details className="customization-output">
          <summary>Agent output</summary>
          <pre>{output}</pre>
        </details>
      ) : null}
      <div className="customization-current">
        <span>{state.config.theme} theme</span>
        <span>{state.config.density}</span>
        <span>{state.config.fontSize}px</span>
        <span>{state.config.commands.length} commands</span>
        <span>{state.config.widgets.length} panels</span>
      </div>
      <div className="customization-file">
        <span>Live configuration</span>
        <code>{state.path || 'Browser preview storage'}</code>
      </div>
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={running || !state.canUndo}
          onClick={() => void action(onUndo, 'Previous customization restored.')}
        >
          <RotateCcw size={14} /> Undo
        </button>
        <button
          className="button secondary"
          disabled={running}
          onClick={() => void action(onReload, 'Configuration reloaded.')}
        >
          Reload
        </button>
        <button
          className="button secondary"
          disabled={running}
          onClick={() => void action(onReset, 'Life’s default settings restored.')}
        >
          Reset settings
        </button>
      </div>
    </Modal>
  )
}
