import { createServer, isIP, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ForwardedPort, PortForwardingState } from '../shared/port-forwarding'

export interface RemotePort {
  remoteHost: string
  remotePort: number
}

export const remotePortDiscoveryCommand =
  "if command -v ss >/dev/null 2>&1; then printf 'LIFE_PORTS_SS4\\n'; ss -ltnH -4 && printf 'LIFE_PORTS_SS6\\n' && ss -ltnH -6; " +
  'elif command -v lsof >/dev/null 2>&1; then printf \'LIFE_PORTS_LSOF\\n\'; lsof -nP -iTCP -sTCP:LISTEN -F tn 2>/dev/null || test "$?" -eq 1; ' +
  "else printf 'Port discovery requires ss (Linux) or lsof (macOS).\\n' >&2; exit 1; fi"

function endpoint(address: string, ipv6 = false): RemotePort | undefined {
  const match = address.match(/^(.*):(\d+)$/)
  if (!match) return
  const remotePort = Number(match[2])
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) return
  let remoteHost = match[1].replace(/^\[|\]$/g, '').replace(/%[^%]*$/, '')
  if (remoteHost === '*') remoteHost = ipv6 ? '::1' : '127.0.0.1'
  else if (remoteHost === '0.0.0.0') remoteHost = '127.0.0.1'
  else if (remoteHost === '::') remoteHost = '::1'
  else if (/^::ffff:127\./i.test(remoteHost)) remoteHost = remoteHost.slice('::ffff:'.length)
  // A service bound only to a public/LAN interface cannot be reached through loopback.
  if (!(isIP(remoteHost) === 4 && /^127\./.test(remoteHost)) && remoteHost !== '::1') return
  return { remoteHost, remotePort }
}

/** Read only numeric TCP listeners; one local mapping per remote port, IPv4 preferred. */
export function parseListeningPorts(output: string): RemotePort[] {
  const lines = output.split(/\r?\n/)
  const header = /^LIFE_PORTS_(SS[46]?|LSOF)$/
  if (!lines.some((line) => header.test(line.trim())))
    throw new Error('The remote port discovery response is not recognized')
  const ports = new Map<number, RemotePort>()
  let format: string | undefined
  let ipv6 = false
  for (const line of lines) {
    if (header.test(line.trim())) {
      format = line.trim()
      ipv6 = format === 'LIFE_PORTS_SS6'
      continue
    }
    let address: string | undefined
    if (format?.startsWith('LIFE_PORTS_SS')) {
      const fields = line.trim().split(/\s+/)
      const state = fields.indexOf('LISTEN')
      if (state >= 0) address = fields[state + 3]
    } else if (format === 'LIFE_PORTS_LSOF') {
      if (line.startsWith('p') || line.startsWith('f')) ipv6 = false
      else if (line.startsWith('t')) ipv6 = line === 'tIPv6'
      else if (line.startsWith('n')) address = line.slice(1).replace(/ \(LISTEN\)$/, '')
    }
    if (!address) continue
    const port = endpoint(address, ipv6)
    if (!port) continue
    const previous = ports.get(port.remotePort)
    if (!previous || (previous.remoteHost === '::1' && port.remoteHost !== '::1'))
      ports.set(port.remotePort, port)
  }
  return [...ports.values()].sort((left, right) => left.remotePort - right.remotePort)
}

interface ForwardingTransport {
  exec(command: string, signal?: AbortSignal): Promise<string>
  forwardOut(
    remoteHost: string,
    remotePort: number,
    callback: (error: Error | null | undefined, channel?: Duplex) => void,
  ): void
}

interface ForwardingOptions {
  pollInterval?: number
  discoveryTimeout?: number
  maxPorts?: number
}

interface Listener {
  port: ForwardedPort
  server: Server
  sockets: Set<Socket>
  channels: Set<Duplex>
  closed: boolean
}

/** Local listeners exist only while this SSH connection and the user's setting are active. */
export class PortForwarding {
  private enabled = true
  private connected = false
  private generation = 0
  private excludedPort = 22
  private listeners = new Map<number, Listener>()
  private timer?: ReturnType<typeof setTimeout>
  private discovery?: AbortController
  private pending?: { generation: number; promise: Promise<void> }
  private error?: string
  private pollInterval: number
  private discoveryTimeout: number
  private maxPorts: number

  constructor(
    private transport: ForwardingTransport,
    private onState: (state: PortForwardingState) => void = () => {},
    options: ForwardingOptions = {},
  ) {
    this.pollInterval = Math.max(10, options.pollInterval ?? 5000)
    this.discoveryTimeout = Math.max(10, options.discoveryTimeout ?? 5000)
    this.maxPorts = Math.min(32, Math.max(1, options.maxPorts ?? 32))
  }

  getState(): PortForwardingState {
    return {
      enabled: this.enabled,
      active: this.connected && this.enabled,
      ports: [...this.listeners.values()]
        .map(({ port }) => ({ ...port }))
        .sort((left, right) => left.remotePort - right.remotePort),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  start(excludedSSHPort = 22) {
    this.cancel()
    this.connected = true
    this.excludedPort = excludedSSHPort
    this.error = undefined
    this.emit()
    if (this.enabled) void this.refresh()
  }

  stop() {
    this.connected = false
    this.cancel()
    this.error = undefined
    this.emit()
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.cancel()
    this.error = undefined
    this.emit()
    if (enabled && this.connected) void this.refresh()
  }

  refresh(): Promise<void> {
    if (!this.connected || !this.enabled) return Promise.resolve()
    const generation = this.generation
    if (this.pending?.generation === generation) return this.pending.promise
    clearTimeout(this.timer)
    this.timer = undefined
    const promise = this.discover(generation).finally(() => {
      if (this.pending?.promise === promise) this.pending = undefined
      if (this.current(generation)) {
        this.timer = setTimeout(() => void this.refresh(), this.pollInterval)
        this.timer.unref()
      }
    })
    this.pending = { generation, promise }
    return promise
  }

  private current(generation: number) {
    return this.generation === generation && this.connected && this.enabled
  }

  private cancel() {
    this.generation += 1
    clearTimeout(this.timer)
    this.timer = undefined
    this.discovery?.abort()
    this.discovery = undefined
    for (const listener of this.listeners.values()) this.close(listener)
    this.listeners.clear()
  }

  private async discover(generation: number) {
    const controller = new AbortController()
    this.discovery = controller
    const timeout = setTimeout(() => controller.abort(), this.discoveryTimeout)
    timeout.unref()
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const aborted = () => reject(new Error('Remote port discovery timed out'))
        controller.signal.addEventListener('abort', aborted, { once: true })
        this.transport
          .exec(remotePortDiscoveryCommand, controller.signal)
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', aborted))
      })
      if (!this.current(generation)) return
      if (Buffer.byteLength(output, 'utf8') > 256_000)
        throw new Error('Remote port discovery exceeds 256 KB')
      const ports = parseListeningPorts(output)
        .filter((port) => port.remotePort !== this.excludedPort)
        .slice(0, this.maxPorts)
      const desired = new Map(ports.map((port) => [port.remotePort, port]))
      for (const [remotePort, listener] of this.listeners) {
        if (desired.get(remotePort)?.remoteHost !== listener.port.remoteHost) {
          this.close(listener)
          this.listeners.delete(remotePort)
        }
      }
      const failures: string[] = []
      for (const port of ports) {
        if (!this.current(generation)) return
        if (this.listeners.has(port.remotePort)) continue
        try {
          const listener = await this.listen(port, generation)
          if (!this.current(generation)) {
            this.close(listener)
            return
          }
          this.listeners.set(port.remotePort, listener)
        } catch (error) {
          if (!this.current(generation)) return
          failures.push(
            `Port ${port.remotePort}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      this.error = failures.length ? failures.join('; ') : undefined
      this.emit()
    } catch (error) {
      if (!this.current(generation)) return
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
    } finally {
      clearTimeout(timeout)
      if (this.discovery === controller) this.discovery = undefined
    }
  }

  private async listen(remote: RemotePort, generation: number): Promise<Listener> {
    const listener: Listener = {
      port: { ...remote, localHost: '127.0.0.1', localPort: 0, url: '' },
      server: createServer({ pauseOnConnect: true, allowHalfOpen: true }),
      sockets: new Set(),
      channels: new Set(),
      closed: false,
    }
    listener.server.maxConnections = 32
    listener.server.on('connection', (socket) => this.tunnel(listener, socket, generation))
    listener.server.on('error', (error) => {
      if (!listener.port.localPort || !this.current(generation) || listener.closed) return
      this.close(listener)
      this.listeners.delete(remote.remotePort)
      this.error = `Port ${remote.remotePort}: ${error.message}`
      this.emit()
    })
    const bind = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const error = (failure: Error) => {
          listener.server.removeListener('listening', ready)
          reject(failure)
        }
        const ready = () => {
          listener.server.removeListener('error', error)
          resolve()
        }
        listener.server.once('error', error)
        listener.server.once('listening', ready)
        listener.server.listen({ host: '127.0.0.1', port, exclusive: true })
      })
    try {
      try {
        await bind(remote.remotePort)
      } catch (error) {
        if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error
        await bind(0)
      }
      const address = listener.server.address()
      if (!address || typeof address === 'string') throw new Error('Local port did not open')
      listener.server.unref()
      listener.port.localPort = address.port
      listener.port.url = `http://127.0.0.1:${address.port}`
      return listener
    } catch (error) {
      this.close(listener)
      throw error
    }
  }

  private tunnel(listener: Listener, socket: Socket, generation: number) {
    if (!this.current(generation) || listener.closed) {
      socket.destroy()
      return
    }
    listener.sockets.add(socket)
    let channel: Duplex | undefined
    const cleanup = () => {
      clearTimeout(timeout)
      listener.sockets.delete(socket)
      if (channel) {
        listener.channels.delete(channel)
        channel.destroy()
      }
    }
    const timeout = setTimeout(() => socket.destroy(), 10_000)
    timeout.unref()
    socket.on('error', () => {})
    socket.once('close', cleanup)
    try {
      this.transport.forwardOut(
        listener.port.remoteHost,
        listener.port.remotePort,
        (error, stream) => {
          clearTimeout(timeout)
          if (
            error ||
            !stream ||
            socket.destroyed ||
            listener.closed ||
            !this.current(generation)
          ) {
            stream?.destroy()
            socket.destroy()
            if (error && this.current(generation)) {
              this.error = `Remote port ${listener.port.remotePort}: ${error.message}`
              this.emit()
            }
            return
          }
          channel = stream
          listener.channels.add(stream)
          stream.on('error', () => socket.destroy())
          stream.once('close', () => {
            listener.channels.delete(stream)
            socket.destroy()
          })
          socket.pipe(stream)
          stream.pipe(socket)
        },
      )
    } catch {
      socket.destroy()
    }
  }

  private close(listener: Listener) {
    listener.closed = true
    for (const socket of listener.sockets) socket.destroy()
    for (const channel of listener.channels) channel.destroy()
    listener.sockets.clear()
    listener.channels.clear()
    listener.server.close()
  }

  private emit() {
    this.onState(this.getState())
  }
}
