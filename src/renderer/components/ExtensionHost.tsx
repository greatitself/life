import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import type { LifeExtensionManifest } from '../../shared/extensions'
import { parseExtensionPayload } from '../../shared/extensions'
import { api, errorText } from '../api'
import './extensions.css'

interface ExtensionHostProps {
  extension: LifeExtensionManifest
  theme: 'dark' | 'light'
  onError?: (error: string) => void
  onReady?: () => void
  onInvoke?: (method: string, args: unknown) => Promise<unknown>
}

type BridgeRequest = {
  kind: 'call' | 'invoke'
  id: number
  method: string
  args?: unknown
}

/** All executable UI lives in a unique-origin iframe; the parent exposes only explicit calls. */
export function ExtensionHost({
  extension,
  theme,
  onError,
  onReady,
  onInvoke,
}: ExtensionHostProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const port = useRef<MessagePort | undefined>(undefined)
  const subscriptions = useRef<Array<() => void>>([])
  const current = useRef({ extension, theme, onError, onReady, onInvoke })
  current.current = { extension, theme, onError, onReady, onInvoke }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const source = JSON.stringify(extension)
  const token = useMemo(() => crypto.randomUUID(), [source])
  const url = `life-extension://runtime/view/${encodeURIComponent(extension.id)}?theme=${theme}&token=${token}`
  // Theme changes update the running frame instead of throwing away its UI state.
  const stableURL = useMemo(() => url, [token])

  useEffect(() => {
    if (!api) {
      setLoading(false)
      return
    }
    let disposed = false
    let connected = false
    let ready = false
    let inFlight = 0
    setLoading(true)
    setError('')
    const timeout = setTimeout(() => {
      if (!disposed && !ready) {
        setLoading(false)
        setError('The extension did not start. Disable it or restore the previous version.')
      }
    }, 15000)

    function emit(event: string, data: unknown) {
      if (!disposed) port.current?.postMessage({ kind: 'event', event, data })
    }
    function connect(event: MessageEvent) {
      if (
        disposed ||
        connected ||
        event.source !== frame.current?.contentWindow ||
        event.data?.kind !== 'life:hello' ||
        event.data.token !== token
      )
        return
      connected = true
      const channel = new MessageChannel()
      port.current = channel.port1
      channel.port1.onmessage = async (
        event: MessageEvent<BridgeRequest | { kind: string; text?: string }>,
      ) => {
        const message = event.data
        if (disposed || !message || typeof message !== 'object') return
        if (message.kind === 'ready') {
          ready = true
          clearTimeout(timeout)
          setLoading(false)
          current.current.onReady?.()
          return
        }
        if (message.kind === 'error') {
          const text = errorText(
            ('text' in message && message.text) || 'The extension encountered an error.',
          )
          setError(text)
          current.current.onError?.(`${current.current.extension.name}: ${text}`)
          return
        }
        if (message.kind !== 'call' && message.kind !== 'invoke') return
        const request = message as BridgeRequest
        if (!Number.isSafeInteger(request.id) || typeof request.method !== 'string') return
        const reply = (value?: unknown, failure?: string) => {
          if (!disposed)
            channel.port1.postMessage({ kind: 'result', id: request.id, value, error: failure })
        }
        if (inFlight >= 64) {
          reply(undefined, 'Too many concurrent extension requests.')
          return
        }
        inFlight++
        try {
          const payload = parseExtensionPayload(request.args === undefined ? null : request.args)
          let value: unknown
          if (request.kind === 'call') {
            value = await api!.extensions.call(
              current.current.extension.id,
              request.method,
              payload,
            )
          } else if (request.method.startsWith('ui.')) {
            if (!current.current.onInvoke) throw new Error('This UI method is unavailable.')
            value = await current.current.onInvoke(request.method, payload)
          } else {
            value = await api!.extensions.invoke(request.method, payload)
          }
          reply(value)
        } catch (failure) {
          reply(undefined, errorText(failure))
        } finally {
          inFlight--
        }
      }
      channel.port1.start()
      subscriptions.current = [
        api!.onConnection((state) => emit('connection', state)),
        api!.onAgent((event) => emit('agent', event)),
        api!.onTerminal((data) => emit('terminal', data)),
        api!.customization.onChange((state) => emit('settings', state)),
        api!.extensions.onEvent((event) => {
          if (event.id !== current.current.extension.id) return
          emit('extension', event)
          if (event.type === 'event' && event.event) emit(event.event, event.data)
          if (event.type === 'error') emit('runtime-error', event.error)
        }),
      ]
      frame.current?.contentWindow?.postMessage(
        {
          kind: 'life:connect',
          token,
          context: {
            id: current.current.extension.id,
            theme: current.current.theme,
            manifest: current.current.extension,
            capabilities: api!.extensions.capabilities,
          },
        },
        '*',
        [channel.port2],
      )
    }
    window.addEventListener('message', connect)
    return () => {
      disposed = true
      clearTimeout(timeout)
      window.removeEventListener('message', connect)
      subscriptions.current.forEach((unsubscribe) => unsubscribe())
      subscriptions.current = []
      port.current?.close()
      port.current = undefined
    }
  }, [token])

  useEffect(() => {
    port.current?.postMessage({ kind: 'event', event: 'theme', data: theme })
  }, [theme])

  if (!api)
    return (
      <div className="extension-placeholder">
        <AlertCircle size={18} />
        <p>Open Life on your computer to run this extension.</p>
      </div>
    )
  return (
    <div className="extension-host" data-placement={extension.renderer.placement}>
      {loading ? (
        <div className="extension-loading" role="status">
          <LoaderCircle size={16} className="spinning" /> Starting {extension.name}…
        </div>
      ) : null}
      {error ? (
        <div className="extension-runtime-error" role="alert">
          <AlertCircle size={14} /> <span>{error}</span>
        </div>
      ) : null}
      <iframe
        ref={frame}
        src={stableURL}
        title={extension.name}
        sandbox="allow-scripts allow-downloads"
      />
    </div>
  )
}
