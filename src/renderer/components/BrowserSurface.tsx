import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Globe, RefreshCw, RotateCw } from 'lucide-react'
import type { ConnectionState } from '../../shared/types'
import type { ForwardedPort, PortForwardingState } from '../../shared/port-forwarding'
import { api, errorText } from '../api'

export function BrowserSurface({
  connection,
  device,
}: {
  connection: ConnectionState
  device: boolean
}) {
  const [ports, setPorts] = useState<ForwardedPort[]>([])
  const [address, setAddress] = useState('')
  const [url, setUrl] = useState('')
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState('')
  const [preset, setPreset] = useState('phone')
  const [rotated, setRotated] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState({ width: 400, height: 700 })
  useEffect(() => {
    if (!api) return
    let valid = true
    let observed = false
    const apply = (state: PortForwardingState) => {
      if (valid) setPorts(state.active && state.enabled ? state.ports : [])
    }
    const off = api.forwarding.onState((state) => {
      observed = true
      apply(state)
    })
    void api.forwarding
      .get()
      .then((state) => {
        if (!observed) apply(state)
      })
      .catch((error) => {
        if (valid) setError(errorText(error))
      })
    return () => {
      valid = false
      off()
    }
  }, [connection.status, connection.profile?.id])
  useEffect(() => {
    if (!device || !stage.current) return
    const element = stage.current
    const measure = () => setSpace({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [device, url])
  function navigate(value: string) {
    try {
      const trimmed = value.trim()
      if (!trimmed) return
      const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error('Enter an HTTP or HTTPS address.')
      setUrl(parsed.href)
      setAddress(parsed.href)
      setError('')
    } catch (error) {
      setError(errorText(error))
    }
  }
  const raw = preset === 'tablet' ? [768, 1024] : preset === 'desktop' ? [1280, 800] : [390, 844]
  const [width, height] = rotated ? [raw[1], raw[0]] : raw
  const scale = Math.max(0.1, Math.min(1, (space.width - 32) / width, (space.height - 32) / height))
  const frame = url ? (
    <iframe
      key={`${url}:${generation}`}
      src={url}
      title={device ? 'Device viewport preview' : 'Workspace browser preview'}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      referrerPolicy="no-referrer"
    />
  ) : null
  return (
    <div className="surface-browser">
      <form
        className="surface-browser-address"
        onSubmit={(event) => {
          event.preventDefault()
          navigate(address)
        }}
      >
        <Globe size={14} />
        <input
          aria-label="Preview URL"
          placeholder="http://localhost:3000"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Reload preview"
          disabled={!url}
          onClick={() => setGeneration((current) => current + 1)}
        >
          <RefreshCw size={14} />
        </button>
        <button type="submit" className="text-button">
          Go
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Open preview in external browser"
          disabled={!url || !api}
          onClick={() =>
            void api?.extensions
              .invoke('app.openExternal', url)
              .catch((error) => setError(errorText(error)))
          }
        >
          <ArrowUpRight size={15} />
        </button>
      </form>
      <div className="surface-browser-controls">
        <select
          aria-label="Open forwarded service"
          value=""
          onChange={(event) => navigate(event.target.value)}
        >
          <option value="">
            {ports.length ? 'Open a forwarded service…' : 'No forwarded services'}
          </option>
          {ports.map((port) => (
            <option key={`${port.remoteHost}:${port.remotePort}`} value={port.url}>
              Port {port.remotePort} → {port.localPort}
            </option>
          ))}
        </select>
        {device ? (
          <>
            <select
              aria-label="Device viewport"
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
            >
              <option value="phone">Phone</option>
              <option value="tablet">Tablet</option>
              <option value="desktop">Desktop</option>
            </select>
            <button
              className="icon-button"
              aria-label="Rotate device viewport"
              onClick={() => setRotated((current) => !current)}
            >
              <RotateCw size={15} />
            </button>
          </>
        ) : null}
      </div>
      {error ? (
        <div className="panel-error" role="alert">
          {error}
        </div>
      ) : null}
      {!url ? (
        <div className="surface-browser-empty">
          <Globe size={26} />
          <strong>
            {device ? 'Preview a device viewport' : 'Open your project in the browser'}
          </strong>
          <p>Choose a forwarded service or enter a web address.</p>
        </div>
      ) : device ? (
        <div className="surface-device-stage" ref={stage}>
          <div
            className="surface-device-size"
            style={{ width: width * scale, height: height * scale }}
          >
            <div
              className="surface-device-frame"
              style={{ width, height, transform: `scale(${scale})` }}
            >
              {frame}
            </div>
          </div>
        </div>
      ) : (
        frame
      )}
      {url ? (
        <div className="surface-browser-caption">
          {device ? `${width} × ${height} viewport · ` : ''}Open externally if the site blocks
          embedded previews.
        </div>
      ) : null}
    </div>
  )
}
