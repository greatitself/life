import { useEffect, useState } from 'react'
import { ArrowUpRight, Copy, Network } from 'lucide-react'
import type { PortForwardingState } from '../../shared/port-forwarding'
import { api, errorText } from '../api'
import { Modal } from './Modal'
import './port-forwarding.css'

export function PortForwardDialog({
  open,
  onOpenChange,
  enabled,
  onEnabledChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  enabled: boolean
  onEnabledChange: (enabled: boolean) => Promise<unknown>
}) {
  const [state, setState] = useState<PortForwardingState>({
    enabled,
    active: false,
    ports: [],
  })
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!api) return
    let valid = true
    let observed = false
    const off = api.forwarding.onState((next) => {
      observed = true
      if (valid) setState(next)
    })
    void api.forwarding
      .get()
      .then((next) => {
        if (valid && !observed) setState(next)
      })
      .catch((error) => {
        if (valid) {
          setFeedback(errorText(error))
          setFailed(true)
        }
      })
    return () => {
      valid = false
      off()
    }
  }, [])

  async function toggle(next: boolean) {
    setPending(true)
    setFeedback('')
    setFailed(false)
    try {
      await onEnabledChange(next)
    } catch (error) {
      setFeedback(errorText(error))
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  async function copy(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setFeedback(`Copied ${address}`)
      setFailed(false)
    } catch (error) {
      setFeedback(errorText(error))
      setFailed(true)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Port forwarding"
      description="Use services running on your SSH machine from this computer."
      className="port-forward-modal"
    >
      <label className="port-forward-toggle">
        <span>
          <strong>Automatic port forwarding</strong>
          <span>Enabled by default. Turn it off to close all automatic tunnels.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Automatic port forwarding"
          checked={enabled}
          disabled={pending}
          onChange={(event) => void toggle(event.target.checked)}
        />
      </label>
      <p className="port-forward-description">
        Life discovers listening TCP ports 1024 and above while connected. Forwarded services listen
        on 127.0.0.1 on this computer. If the matching local port is occupied, Life chooses an
        available port.
      </p>
      {!enabled ? (
        <div className="port-forward-empty">Automatic forwarding is off.</div>
      ) : !state.active ? (
        <div className="port-forward-empty">Connect a machine to discover its ports.</div>
      ) : state.ports.length === 0 ? (
        <div className="port-forward-empty">
          <Network size={22} />
          <p>No listening development ports found yet.</p>
          <span>Start a server on your SSH machine. Life checks for new ports automatically.</span>
        </div>
      ) : (
        <ul className="port-forward-list" aria-label="Forwarded ports">
          {state.ports.map((port) => {
            const local = `${port.localHost}:${port.localPort}`
            const remote = `${port.remoteHost.includes(':') ? `[${port.remoteHost}]` : port.remoteHost}:${port.remotePort}`
            return (
              <li key={`${port.remoteHost}:${port.remotePort}`}>
                <div>
                  <strong>{local}</strong>
                  <span>Remote {remote}</span>
                </div>
                <button
                  className="icon-button"
                  aria-label={`Copy local address for remote port ${port.remotePort}`}
                  onClick={() => void copy(local)}
                >
                  <Copy size={16} />
                </button>
                <a
                  className="icon-button"
                  href={port.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open remote port ${port.remotePort} in browser`}
                >
                  <ArrowUpRight size={17} />
                </a>
              </li>
            )
          })}
        </ul>
      )}
      {enabled && state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {feedback ? (
        <p className={failed ? 'form-error' : 'form-success'} role={failed ? 'alert' : 'status'}>
          {feedback}
        </p>
      ) : null}
    </Modal>
  )
}
