import { randomUUID } from 'node:crypto'
import { Duplex, PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { posix } from 'node:path'
import type { ClientChannel } from 'ssh2'
import type { ConnectionProfile, ConnectionState } from '../shared/types'
import { buildRemoteAgentBrokerCommand } from './remote-agent-broker'

type Frame = Record<string, unknown>
type InputFrame = { type: string; sequence: number; data?: string; signal?: string }

export interface DurableChannelHost {
  state: ConnectionState
  channel(
    command: string,
    pty?: { cols: number; rows: number },
    signal?: AbortSignal,
    timeoutMs?: number,
    rendererOwned?: boolean,
  ): Promise<ClientChannel>
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

const sameMachine = (a: ConnectionProfile, b?: ConnectionProfile) =>
  a.host === b?.host && a.port === b.port && a.username === b.username

/**
 * A provider's lifetime belongs to its detached remote broker. SSH transports
 * only carry the broker protocol and can disappear without closing this stream.
 * Numbered inputs are acknowledged by the broker; reattachment retries an
 * unacknowledged delivery with the same number, never as a second prompt.
 */
export class DurableRemoteChannel extends Duplex {
  readonly sessionId = randomUUID()
  readonly machineIdentity: string
  readonly stderr = new PassThrough()
  readonly stdin = this
  readonly stdout = this
  readonly server = false
  readonly type = 'session' as const
  readonly subtype = 'exec' as const
  readonly incoming = undefined
  readonly outgoing = undefined
  transportState: 'connected' | 'suspended' | 'closed' = 'suspended'
  private transport?: ClientChannel
  private attachment = 0
  private attaching?: Promise<void>
  private reattachTimer?: NodeJS.Timeout
  private handshakeTimer?: NodeJS.Timeout
  private reattachAttempts = 0
  private cursor = 0
  private nextInput = 0
  private pending = new Map<number, InputFrame>()
  private started = false
  private closing = false
  private retired = false
  private exitReceived = false
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private readonly machine: ConnectionProfile
  private readonly onState = (state: ConnectionState) => {
    if (state.status === 'connected' && sameMachine(this.machine, state.profile)) {
      if (this.reattachTimer) clearTimeout(this.reattachTimer)
      this.reattachTimer = undefined
      void this.attach().catch((error) => this.transportFailure(error))
    } else if (state.status !== 'connected' || !sameMachine(this.machine, state.profile))
      this.suspend(new Error('SSH connection is unavailable. The remote agent is still running.'))
  }
  private readonly onDisconnected = () =>
    this.suspend(new Error('SSH connection closed. The remote agent is still running.'))

  private constructor(
    private host: DurableChannelHost,
    private command: string,
  ) {
    super({ autoDestroy: false })
    if (!host.state.profile) throw new Error('Connect to a machine first')
    this.machine = { ...host.state.profile }
    this.machineIdentity = JSON.stringify([
      this.machine.host,
      this.machine.port,
      this.machine.username,
    ])
    host.on('state', this.onState)
    host.on('disconnected', this.onDisconnected)
  }

  get isCurrentMachine() {
    return sameMachine(this.machine, this.host.state.profile)
  }

  matchesMachine(profile?: ConnectionProfile) {
    return sameMachine(this.machine, profile)
  }

  static async open(host: DurableChannelHost, command: string): Promise<DurableRemoteChannel> {
    if (host.state.status !== 'connected') throw new Error('Connect to a machine first')
    const channel = new DurableRemoteChannel(host, command)
    // Errors before open() resolves belong to the opening caller. Afterwards,
    // provider consumers install their own stream error listeners.
    const initialError = () => {}
    channel.on('error', initialError)
    try {
      await channel.attach()
      await channel.ready
      return channel
    } catch (error) {
      channel.retire()
      channel.destroy()
      throw error
    } finally {
      channel.off('error', initialError)
    }
  }

  override _read() {}

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ) {
    if (this.closing || this.retired) {
      callback(new Error('The remote agent session is closed'))
      return
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    this.queue({ type: 'write', data: bytes.toString('base64') })
    callback()
  }

  override _final(callback: (error?: Error) => void) {
    if (!this.closing && !this.retired) this.queue({ type: 'end' })
    callback()
  }

  private queue(frame: Omit<InputFrame, 'sequence'>) {
    const value = { ...frame, sequence: ++this.nextInput } as InputFrame
    this.pending.set(value.sequence, value)
    if (this.transportState === 'connected') this.send(value)
  }

  private send(frame: InputFrame) {
    const transport = this.transport
    if (!transport || transport.destroyed || this.transportState !== 'connected') return
    try {
      transport.write(JSON.stringify(frame) + '\n')
    } catch (error) {
      this.suspend(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async attach(): Promise<void> {
    if (this.retired || this.transport) return
    if (this.attaching) {
      // The owning attach invocation classifies its result against its own
      // generation. A concurrent state notification must not turn a rejected
      // acknowledgement from an obsolete connection into a new-session error.
      await this.attaching.catch(() => {})
      return
    }
    if (
      this.host.state.status !== 'connected' ||
      !sameMachine(this.machine, this.host.state.profile)
    )
      return
    const generation = ++this.attachment
    const starting = (async () => {
      const launch = !this.started
      // The server may execute the bootstrap before acknowledging the SSH exec
      // request. Once sent, its outcome is uncertain after a network cut, so a
      // reattachment must locate that session rather than launch a replacement.
      this.started = true
      const transport = await this.host.channel(
        buildRemoteAgentBrokerCommand({
          id: this.sessionId,
          command: this.command,
          root: this.host.state.home
            ? posix.join(this.host.state.home, '.life', 'agent-sessions', this.sessionId)
            : undefined,
          cursor: this.cursor,
          launch,
        }),
        undefined,
        undefined,
        30000,
        false,
      )
      if (this.retired || generation !== this.attachment) {
        transport.close()
        return
      }
      this.transport = transport
      this.handshakeTimer = setTimeout(() => {
        if (generation !== this.attachment || this.transport !== transport || this.retired) return
        this.transportFailure(
          new Error(
            'The remote agent broker did not become ready within 20 seconds. No prompt was replayed.',
          ),
        )
      }, 20000)
      this.handshakeTimer.unref()
      let buffer = ''
      let diagnostic = ''
      const decoder = new StringDecoder('utf8')
      const consume = (chunk: Buffer) => {
        buffer += decoder.write(chunk)
        // Broker frames contain at most one bounded provider-output chunk.
        // Reject malformed transport rather than dropping provider output.
        if (buffer.length > 2_000_000) {
          this.transportFailure(new Error('The remote agent broker returned an oversized frame'))
          return
        }
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue
          let frame: Frame
          try {
            frame = JSON.parse(line) as Frame
          } catch {
            diagnostic = (diagnostic + '\n' + line).slice(-8192)
            continue
          }
          if (generation === this.attachment && this.transport === transport) this.receive(frame)
        }
      }
      transport.on('data', consume)
      transport.stderr.on('data', (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-8192)
      })
      const lost = (error?: Error) => {
        if (this.transport !== transport || generation !== this.attachment || this.retired) return
        this.transport = undefined
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = undefined
        if (this.exitReceived) return
        // ssh2 can close child exec channels just before the parent connection
        // reports its network failure. Give that state event a turn to arrive
        // before treating a missing initial handshake as a broker failure.
        setImmediate(() => {
          if (generation !== this.attachment || this.retired || this.exitReceived) return
          if (this.host.state.status !== 'connected') this.suspend(error)
          else if (this.transportState !== 'connected')
            this.transportFailure(
              error || new Error(diagnostic.trim() || 'The remote agent broker could not start'),
            )
          else this.suspend(error)
        })
      }
      transport.on('error', lost)
      transport.on('close', () => lost())
    })()
    this.attaching = starting
    try {
      await starting
    } catch (error) {
      if (generation !== this.attachment || this.host.state.status !== 'connected') return
      throw error
    } finally {
      if (this.attaching === starting) this.attaching = undefined
      if (
        generation !== this.attachment &&
        !this.retired &&
        !this.transport &&
        this.host.state.status === 'connected' &&
        sameMachine(this.machine, this.host.state.profile)
      )
        void this.attach().catch((error) => this.transportFailure(error))
    }
  }

  private receive(frame: Frame) {
    if (frame.type === 'ready') {
      const wasSuspended = this.transportState === 'suspended'
      this.transportState = 'connected'
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
      this.reattachAttempts = 0
      if (this.reattachTimer) clearTimeout(this.reattachTimer)
      this.reattachTimer = undefined
      this.readyResolve()
      // Keep the consumer's acknowledged output cursor. ready.cursor describes
      // remote high-water and must never skip output produced while offline.
      for (const pending of this.pending.values()) this.send(pending)
      if (wasSuspended) this.emit('resumed')
      return
    }
    if (frame.type === 'ack' && typeof frame.sequence === 'number') {
      this.pending.delete(frame.sequence)
      if (this.closing && this.pending.size === 0) this.finish()
      return
    }
    if (frame.type === 'error') {
      this.transportFailure(new Error(String(frame.message || 'The remote agent session failed')))
      return
    }
    if (typeof frame.cursor !== 'number' || frame.cursor <= this.cursor) return
    if (frame.cursor !== this.cursor + 1) {
      this.transportFailure(new Error('The remote agent output journal has a missing frame'))
      return
    }
    if (frame.type === 'stdout' || frame.type === 'stderr') {
      if (typeof frame.data !== 'string') {
        this.transportFailure(new Error('The remote agent broker returned invalid output'))
        return
      }
      const bytes = Buffer.from(frame.data, 'base64')
      this.cursor = frame.cursor
      if (!this.closing) {
        if (frame.type === 'stdout') this.push(bytes)
        else this.stderr.write(bytes)
      }
    } else if (frame.type === 'exit') {
      this.exitReceived = true
      this.cursor = frame.cursor
      const code = typeof frame.code === 'number' ? frame.code : undefined
      this.emit('exit', code, frame.signal)
      // Let open() and provider constructors attach listeners after an immediate
      // provider exit, just as a real ssh2 exec channel does.
      setImmediate(() => this.finish())
    }
  }

  private suspend(error?: Error) {
    if (this.retired || this.transportState === 'closed') return
    const transport = this.transport
    this.transport = undefined
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    this.attachment++
    transport?.close()
    if (this.transportState !== 'suspended') {
      this.transportState = 'suspended'
      this.emit('suspended', error || new Error('SSH connection closed'))
    }
    this.scheduleReattach()
  }

  private scheduleReattach() {
    if (
      this.retired ||
      this.reattachTimer ||
      this.host.state.status !== 'connected' ||
      !sameMachine(this.machine, this.host.state.profile)
    )
      return
    const delay = Math.min(3000, 100 * 2 ** Math.min(this.reattachAttempts++, 5))
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = undefined
      void this.attach().catch((error) => this.transportFailure(error))
    }, delay)
    this.reattachTimer.unref()
  }

  private transportFailure(error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (this.host.state.status !== 'connected') {
      this.suspend(failure)
      return
    }
    this.readyReject(failure)
    if (!this.closing) this.emit('error', failure)
    this.finish()
  }

  signal(signalName: string) {
    if (this.closing || this.retired) return
    this.queue({
      type: 'signal',
      signal: signalName.startsWith('SIG') ? signalName : 'SIG' + signalName,
    })
  }

  eof() {
    this.end()
  }

  close() {
    if (this.closing || this.retired) return
    this.closing = true
    // Closing is an out-of-band terminal instruction. Discard deliveries that
    // might not have reached the remote process instead of sending a queued
    // user prompt solely to satisfy a sequence gap before termination.
    this.pending.clear()
    if (this.reattachTimer) clearTimeout(this.reattachTimer)
    this.reattachTimer = undefined
    this.queue({ type: 'close' })
    this.push(null)
    this.stderr.end()
    this.emit('close')
    this.scheduleReattach()
  }

  private finish() {
    if (this.retired) return
    const alreadyClosed = this.closing
    this.retire()
    this.push(null)
    this.stderr.end()
    if (!alreadyClosed) this.emit('close')
  }

  private retire() {
    this.retired = true
    this.transportState = 'closed'
    this.pending.clear()
    if (this.reattachTimer) clearTimeout(this.reattachTimer)
    this.reattachTimer = undefined
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    this.host.off('state', this.onState)
    this.host.off('disconnected', this.onDisconnected)
    const transport = this.transport
    this.transport = undefined
    this.attachment++
    transport?.close()
  }
}
