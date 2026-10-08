import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, connect as connectTCP, type Socket } from 'node:net'
import { get } from 'node:http'
import { join } from 'node:path'
import { Client } from 'ssh2'
import { PassThrough, type Duplex } from 'node:stream'
import { SSHFixture } from './helpers/ssh-fixture'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import {
  PortForwarding,
  parseListeningPorts,
  remotePortDiscoveryCommand,
} from '../src/main/port-forwarding'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function ss(...addresses: string[]) {
  return ['LIFE_PORTS_SS', ...addresses.map((address) => `LISTEN 0 511 ${address} 0.0.0.0:*`)].join(
    '\n',
  )
}

async function listener(onSocket: (socket: Socket) => void) {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onSocket(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { server, port: address.port, sockets }
}

function tcpTransport(exec: (command: string) => Promise<string>) {
  const channels = new Set<Socket>()
  const forwardOut = vi.fn(
    (host: string, port: number, done: (error: Error | undefined, channel?: Duplex) => void) => {
      let accepted = false
      const socket = connectTCP(port, host, () => {
        accepted = true
        done(undefined, socket)
      })
      channels.add(socket)
      socket.on('error', (error) => {
        if (!accepted) done(error)
      })
      socket.on('close', () => channels.delete(socket))
    },
  )
  cleanup.push(() => {
    for (const channel of channels) channel.destroy()
  })
  return { exec, forwardOut, channels }
}

function manager(
  transport: ConstructorParameters<typeof PortForwarding>[0],
  options: { pollInterval?: number; discoveryTimeout?: number; maxPorts?: number } = {},
) {
  const value = new PortForwarding(transport, undefined, {
    pollInterval: 60_000,
    discoveryTimeout: 1000,
    ...options,
  })
  cleanup.push(() => value.stop())
  return value
}

function httpText(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}/`, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (text) => (body += text))
      response.on('end', () => resolve(body))
      response.on('error', reject)
    })
    request.setTimeout(2000, () => request.destroy(new Error('Forwarded HTTP timed out')))
    request.on('error', reject)
  })
}

describe('remote listening port discovery', () => {
  it('parses Linux IPv4, wildcard, IPv6, and duplicate listeners without privileged ports', () => {
    expect(
      parseListeningPorts(
        ss(
          '127.0.0.1:3000',
          '[::1]:3000',
          '0.0.0.0:5173',
          '[::]:8080',
          '*:9000',
          '127.0.0.1:22',
          '127.0.0.1:443',
          '127.0.0.1:0',
          '127.0.0.1:65536',
        ),
      ),
    ).toEqual([
      { remoteHost: '127.0.0.1', remotePort: 3000 },
      { remoteHost: '127.0.0.1', remotePort: 5173 },
      { remoteHost: '::1', remotePort: 8080 },
      { remoteHost: '127.0.0.1', remotePort: 9000 },
    ])
  })

  it('parses macOS lsof machine records and chooses IPv4 when both address families listen', () => {
    expect(
      parseListeningPorts(
        'LIFE_PORTS_LSOF\np123\nf22\nn[::1]:3000\nf23\nn127.0.0.1:3000\np124\nf24\nn*:5173\nn[::]:8000\nn127.0.0.1:80\n',
      ),
    ).toEqual([
      { remoteHost: '127.0.0.1', remotePort: 3000 },
      { remoteHost: '127.0.0.1', remotePort: 5173 },
      { remoteHost: '::1', remotePort: 8000 },
    ])
  })

  it('uses address-family markers to distinguish IPv6-only wildcard listeners', () => {
    expect(
      parseListeningPorts(
        'LIFE_PORTS_SS4\nLISTEN 0 511 *:5173 *:*\nLIFE_PORTS_SS6\nLISTEN 0 511 *:8000 *:*\n',
      ),
    ).toEqual([
      { remoteHost: '127.0.0.1', remotePort: 5173 },
      { remoteHost: '::1', remotePort: 8000 },
    ])
    expect(
      parseListeningPorts(
        'LIFE_PORTS_LSOF\np123\nf22\ntIPv6\nn*:8000\np124\nf23\ntIPv4\nn*:5173\n',
      ),
    ).toEqual([
      { remoteHost: '127.0.0.1', remotePort: 5173 },
      { remoteHost: '::1', remotePort: 8000 },
    ])
  })

  it('ignores malformed and non-listening entries and rejects unmarked command output', () => {
    expect(() => parseListeningPorts('LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*')).toThrow(
      /not recognized/i,
    )
    expect(
      parseListeningPorts(
        'LIFE_PORTS_SS\nESTAB 0 0 127.0.0.1:3000 127.0.0.1:4000\nLISTEN bad\nLISTEN 0 128 host.example:3000 *:*\nLISTEN 0 128 127.0.0.1:nan *:*\n',
      ),
    ).toEqual([])
    expect(
      parseListeningPorts('LIFE_PORTS_LSOF\nn127.0.0.1:99999\nnexample.com:4000\nn\n'),
    ).toEqual([])
  })

  it('uses bounded listening-only discovery with Linux and macOS fallbacks', () => {
    expect(remotePortDiscoveryCommand).toContain('ss')
    expect(remotePortDiscoveryCommand).toContain('lsof')
    expect(remotePortDiscoveryCommand).toContain('LIFE_PORTS_SS')
    expect(remotePortDiscoveryCommand).toContain('LIFE_PORTS_LSOF')
    expect(remotePortDiscoveryCommand).toContain('-ltn')
    expect(remotePortDiscoveryCommand).toContain('-sTCP:LISTEN')
  })
})

describe('automatic loopback port forwarding', () => {
  it('starts by default on a real workspace connection and preserves disabled state across reconnects', async () => {
    const service = await listener((socket) => {
      socket.once('data', () =>
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\npreview'),
      )
    })
    const fixture = await new SSHFixture().start()
    cleanup.push(() => fixture.close())
    fixture.allowedForwardPorts.add(service.port)
    fixture.discoveryPorts = [service.port]
    const store = new Store(join(fixture.root, 'forwarding-settings'))
    await store.init()
    const connection = new SSHConnection(store)
    cleanup.push(() => connection.disconnect())
    connection.on('host-key', (request: { id: string }) => connection.trust(request.id, true))
    const published: Array<{ active: boolean; enabled: boolean }> = []
    connection.on('forwarding-state', (state) => published.push(state))
    await connection.connect(fixture.input())
    await vi.waitFor(() => expect(connection.forwarding.getState().ports).toHaveLength(1))
    expect(connection.forwarding.getState()).toMatchObject({ enabled: true, active: true })
    expect(await httpText(connection.forwarding.getState().ports[0].localPort)).toBe('preview')
    connection.forwarding.setEnabled(false)
    connection.disconnect()
    await connection.connect(fixture.input())
    expect(connection.forwarding.getState()).toMatchObject({
      enabled: false,
      active: false,
      ports: [],
    })
    connection.forwarding.setEnabled(true)
    await vi.waitFor(() => expect(connection.forwarding.getState().ports).toHaveLength(1))
    connection.disconnect()
    expect(connection.forwarding.getState()).toMatchObject({ active: false, ports: [] })
    expect(published).toContainEqual(expect.objectContaining({ active: true, enabled: true }))
    expect(published.at(-1)).toMatchObject({ active: false, enabled: true })
  })

  it('carries HTTP requests through an authenticated real SSH direct-tcpip channel', async () => {
    const service = await listener((socket) => {
      socket.once('data', () =>
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nSSH transport',
        ),
      )
    })
    const fixture = await new SSHFixture().start()
    cleanup.push(() => fixture.close())
    fixture.allowedForwardPorts.add(service.port)
    fixture.discoveryPorts = [service.port]
    const client = new Client()
    cleanup.push(() => {
      client.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', reject)
      client.connect({
        host: '127.0.0.1',
        port: fixture.port,
        username: 'fixture',
        password: 'fixture-password',
        hostVerifier: () => true,
      })
    })
    const forwarding = manager({
      exec: (command) =>
        new Promise<string>((resolve, reject) => {
          client.exec(command, (error, channel) => {
            if (error) {
              reject(error)
              return
            }
            let output = ''
            channel.setEncoding('utf8')
            channel.on('data', (text: string) => (output += text))
            channel.on('error', reject)
            channel.on('close', (code: number | undefined) => {
              if (code && code !== 0) reject(new Error(`Fixture discovery exited ${code}`))
              else resolve(output)
            })
          })
        }),
      forwardOut: (host, port, callback) => client.forwardOut('127.0.0.1', 0, host, port, callback),
    })
    await forwarding.start(fixture.port)
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    expect(await httpText(forwarding.getState().ports[0].localPort)).toBe('SSH transport')
    expect(fixture.forwardRequests).toEqual([{ host: '127.0.0.1', port: service.port }])
    expect(fixture.forwardRequests.some((request) => request.port === fixture.port)).toBe(false)
  })

  it('forwards actual HTTP bytes and uses a different local port if the remote port is occupied locally', async () => {
    const service = await listener((socket) => {
      socket.once('data', () =>
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nresearch preview',
        ),
      )
    })
    const transport = tcpTransport(async () => ss(`127.0.0.1:${service.port}`))
    const forwarding = manager(transport)
    await forwarding.start()
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    const port = forwarding.getState().ports[0]
    expect(port).toMatchObject({
      remoteHost: '127.0.0.1',
      remotePort: service.port,
      localHost: '127.0.0.1',
    })
    expect(port.localPort).not.toBe(service.port)
    expect(port.url).toBe(`http://127.0.0.1:${port.localPort}`)
    expect(await httpText(port.localPort)).toBe('research preview')
    expect(transport.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      service.port,
      expect.any(Function),
    )
  })

  it('closes existing tunnel sockets when a remote listener disappears', async () => {
    const service = await listener((socket) => socket.write('connected'))
    let discovery = ss(`127.0.0.1:${service.port}`)
    const transport = tcpTransport(async () => discovery)
    const forwarding = manager(transport)
    await forwarding.start()
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    const socket = connectTCP(forwarding.getState().ports[0].localPort, '127.0.0.1')
    cleanup.push(() => {
      socket.destroy()
    })
    socket.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      socket.once('data', () => resolve())
      socket.once('error', reject)
    })
    discovery = ss()
    await forwarding.refresh()
    await vi.waitFor(() => {
      expect(forwarding.getState().ports).toEqual([])
      expect(socket.destroyed).toBe(true)
      expect(transport.channels.size).toBe(0)
    })
  })

  it('disabling forwarding closes every listener and does not discover until re-enabled', async () => {
    const service = await listener(() => {})
    const discover = vi.fn(async () => ss(`127.0.0.1:${service.port}`))
    const forwarding = manager(tcpTransport(discover))
    await forwarding.start()
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    const localPort = forwarding.getState().ports[0].localPort
    await forwarding.setEnabled(false)
    const callCount = discover.mock.calls.length
    await forwarding.refresh()
    expect(discover).toHaveBeenCalledTimes(callCount)
    expect(forwarding.getState()).toMatchObject({ enabled: false, ports: [] })
    await expect(httpText(localPort)).rejects.toThrow()
    await forwarding.setEnabled(true)
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    expect(forwarding.getState().enabled).toBe(true)
  })

  it('automatically discovers new listeners and removes them on later polls', async () => {
    const service = await listener(() => {})
    let discovery = ss()
    const forwarding = manager(
      tcpTransport(async () => discovery),
      { pollInterval: 20 },
    )
    forwarding.start()
    await forwarding.refresh()
    expect(forwarding.getState().ports).toEqual([])
    discovery = ss(`127.0.0.1:${service.port}`)
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    discovery = ss()
    await vi.waitFor(() => expect(forwarding.getState().ports).toEqual([]))
  })

  it('keeps a working mapping when a later discovery response is malformed', async () => {
    let discovery = ss('127.0.0.1:3000')
    const forwarding = manager(tcpTransport(async () => discovery))
    forwarding.start()
    await forwarding.refresh()
    const original = forwarding.getState().ports
    expect(original).toHaveLength(1)
    discovery = 'shell banner without a discovery marker'
    await forwarding.refresh()
    expect(forwarding.getState().error).toMatch(/not recognized/i)
    expect(forwarding.getState().ports).toEqual(original)
  })

  it('stopping during discovery prevents a stale result from reopening local listeners', async () => {
    let resolveDiscovery!: (value: string) => void
    const discovery = new Promise<string>((resolve) => (resolveDiscovery = resolve))
    const discover = vi.fn(() => discovery)
    const forwarding = manager(tcpTransport(discover))
    const starting = forwarding.start()
    await vi.waitFor(() => expect(discover).toHaveBeenCalled())
    await forwarding.stop()
    resolveDiscovery(ss('127.0.0.1:3000'))
    await starting
    expect(forwarding.getState()).toMatchObject({ active: false, ports: [] })
  })

  it('destroys a late SSH channel if forwarding was disabled while the channel was opening', async () => {
    let acceptChannel: ((error: Error | undefined, channel?: Duplex) => void) | undefined
    const forwarding = manager({
      exec: async () => ss('127.0.0.1:3000'),
      forwardOut: (_host, _port, callback) => {
        acceptChannel = callback
      },
    })
    await forwarding.start()
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    const socket = connectTCP(forwarding.getState().ports[0].localPort, '127.0.0.1')
    cleanup.push(() => {
      socket.destroy()
    })
    socket.on('error', () => {})
    await vi.waitFor(() => expect(acceptChannel).toBeDefined())
    await forwarding.setEnabled(false)
    const channel = new PassThrough()
    cleanup.push(() => {
      channel.destroy()
    })
    acceptChannel!(undefined, channel)
    await vi.waitFor(() => expect(channel.destroyed).toBe(true))
    expect(forwarding.getState().ports).toEqual([])
  })

  it('aborts stalled discovery within its deadline and publishes a recoverable error', async () => {
    let discoverySignal: AbortSignal | undefined
    const forwarding = manager(
      {
        exec: (_command, signal) => {
          discoverySignal = signal
          return new Promise<string>(() => {})
        },
        forwardOut: () => {},
      },
      { discoveryTimeout: 30 },
    )
    await forwarding.start()
    await forwarding.refresh()
    await vi.waitFor(() => {
      expect(forwarding.getState().error).toMatch(/timed out|timeout/i)
      expect(discoverySignal?.aborted).toBe(true)
    })
    expect(forwarding.getState().ports).toEqual([])
  })

  it('excludes the connected SSH port and bounds discovery to the configured maximum', async () => {
    const forwarding = manager(
      tcpTransport(async () =>
        ss('127.0.0.1:2222', '127.0.0.1:3000', '127.0.0.1:4000', '127.0.0.1:5000'),
      ),
      { maxPorts: 2 },
    )
    await forwarding.start(2222)
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(2))
    expect(forwarding.getState().ports.map((port) => port.remotePort)).toEqual([3000, 4000])
    expect(forwarding.getState().ports.every((port) => port.localHost === '127.0.0.1')).toBe(true)
  })

  it('surfaces discovery failures without blocking the SSH connection and recovers on refresh', async () => {
    let failed = true
    const forwarding = manager(
      tcpTransport(async () => {
        if (failed) throw new Error('Remote discovery unavailable')
        return ss('127.0.0.1:3000')
      }),
    )
    await forwarding.start()
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().error).toMatch(/discovery unavailable/i))
    expect(forwarding.getState()).toMatchObject({ active: true, ports: [] })
    failed = false
    await forwarding.refresh()
    await vi.waitFor(() => expect(forwarding.getState().ports).toHaveLength(1))
    expect(forwarding.getState().error).toBeUndefined()
  })
})
