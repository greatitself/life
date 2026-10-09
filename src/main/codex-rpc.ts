import type { ClientChannel } from 'ssh2'
import { JsonLines } from './json-lines'

type Wire = Record<string, unknown>
const object = (value: unknown): Wire => (value && typeof value === 'object' ? (value as Wire) : {})
const string = (value: unknown) => (typeof value === 'string' ? value : '')

export class CodexRequestError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'CodexRequestError'
  }
}

export class CodexRPC {
  private next = 1
  private failure?: Error
  private stderr = ''
  private startupOutput = ''
  private suspended = false
  private pending = new Map<
    number,
    {
      method: string
      resolve: (value: Wire) => void
      reject: (error: Error) => void
      cleanup: () => void
      timer?: NodeJS.Timeout
      remaining: number
      started: number
      expire: () => void
    }
  >()
  constructor(
    readonly channel: ClientChannel,
    receive: (message: Wire) => void,
    private onFailure: (error: Error) => void = () => {},
  ) {
    this.suspended =
      (channel as ClientChannel & { transportState?: string }).transportState === 'suspended'
    channel.on('suspended', () => {
      if (this.suspended) return
      this.suspended = true
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.timer = undefined
        pending.remaining = Math.max(1, pending.remaining - (Date.now() - pending.started))
      }
    })
    channel.on('resumed', () => {
      if (!this.suspended || this.failure) return
      this.suspended = false
      for (const pending of this.pending.values()) {
        pending.started = Date.now()
        pending.timer = setTimeout(pending.expire, pending.remaining)
      }
    })
    const lines = new JsonLines(
      (message) => {
        if (this.failure) return
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id)
          // Responses to cancelled requests are not server notifications.
          if (!pending) return
          this.pending.delete(message.id)
          pending.cleanup()
          if (message.error) {
            const error = object(message.error)
            pending.reject(
              new CodexRequestError(
                pending.method,
                string(error.message) || 'Codex request failed',
                typeof error.code === 'number' ? error.code : undefined,
              ),
            )
          } else pending.resolve(object(message.result))
        } else receive(message)
      },
      (line) => {
        // Login shells can print banners before exec reaches app-server. Keep
        // those separate from JSON framing failures and accept the handshake.
        if (line !== 'Agent output exceeded the message limit' && !/^\s*[\[{]/.test(line)) {
          this.startupOutput = (this.startupOutput + '\n' + line.slice(0, 2048)).slice(-8192)
          return
        }
        this.close(
          new Error(
            line === 'Agent output exceeded the message limit'
              ? 'Codex returned a response larger than the protocol limit. Update the remote Codex installation and retry; your saved conversation is unchanged.'
              : 'Codex returned an invalid protocol message. Retry, or check the remote Codex installation and shell startup output.',
          ),
        )
      },
    )
    channel.on('data', (chunk: Buffer) => lines.push(chunk))
    channel.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8192)
    })
    channel.on('error', (error: Error) => this.close(error))
    channel.on('close', () => {
      this.fail(
        this.failure ||
          new Error(this.stderr || 'Codex disconnected. Retry to reopen your saved conversation.'),
      )
    })
  }
  get closed() {
    return Boolean(this.failure) || this.channel.destroyed
  }
  send(message: Wire) {
    if (this.closed) throw this.failure || new Error('Codex is disconnected')
    this.channel.write(JSON.stringify(message) + '\n')
  }
  request(method: string, params: Wire = {}, timeout = 60000, signal?: AbortSignal): Promise<Wire> {
    if (signal?.aborted) return Promise.reject(new Error('Codex request cancelled'))
    const id = this.next++
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id)
        cleanup()
        reject(new Error('Codex request cancelled'))
      }
      const expire = () => {
        this.pending.delete(id)
        cleanup()
        const error = new CodexRequestError(
          method,
          `${method} did not respond within ${Math.round(timeout / 1000)} seconds. ` +
            (method === 'thread/resume'
              ? 'Your saved conversation is unchanged. Retry to restart Codex; check remote Codex or required MCP server startup if this continues.'
              : method === 'turn/start'
                ? 'The Codex connection was stopped to avoid leaving an untracked turn running. Your saved conversation is unchanged; retry to resume it.'
                : 'Retry, or check the remote Codex installation and server startup.') +
            (this.stderr
              ? `\nRemote diagnostic: ${this.stderr.trim().slice(-2000)}`
              : this.startupOutput
                ? '\nThe remote login shell printed non-protocol output. Check its startup configuration.'
                : ''),
        )
        reject(error)
        // A timed-out mutation may still be running remotely. Do not reuse the
        // stream or replay a user prompt against an uncertain thread state.
        if (['initialize', 'thread/start', 'thread/resume', 'turn/start'].includes(method))
          this.close(error)
      }
      const cleanup = () => {
        clearTimeout(pending.timer)
        signal?.removeEventListener('abort', cancel)
      }
      const pending = {
        method,
        resolve,
        reject,
        cleanup,
        remaining: timeout,
        started: Date.now(),
        expire,
        timer: this.suspended ? undefined : setTimeout(expire, timeout),
      }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        this.send({ id, method, params })
      } catch (error) {
        cleanup()
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  close(error = new Error('Codex connection closed')) {
    if (this.failure) return
    this.fail(error)
    try {
      this.channel.signal('TERM')
    } catch {}
    try {
      this.channel.close()
    } catch {}
  }
  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
    this.onFailure(error)
  }
}
