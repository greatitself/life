import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  accessSync,
  closeSync,
  constants,
  readSync,
  statSync,
  writeSync as writeDescriptor,
} from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { dirname, posix, resolve } from 'node:path'
import { Duplex, Readable } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { LocalFiles } from './local-files'

export interface LocalTransportOptions {
  shell?: string
  env?: NodeJS.ProcessEnv
  /** Private integration-test storage; it never changes the user's environment. */
  brokerDirectory?: string
}

type ExecOptions = { pty?: { term?: string; cols: number; rows: number } }
type ExecCallback = (error: Error | null | undefined, channel?: ClientChannel) => void
type FilesCallback = (error: Error | null | undefined, files?: LocalFiles) => void

const BUFFER_BYTES = 64 * 1024
const MAX_STDIN_BYTES = 4_000_000
const TERMINATION_GRACE_MS = 250

// Electron's inspector can leave non-CLOEXEC sockets in its process. Close
// inherited descriptors before the selected shell/provider runs, without
// changing its argv, standard streams, or authentication environment.
const LOCAL_EXEC_TRAMPOLINE = `
set -- "$@" "\${life_local_fd_directory+x}" "\${life_local_fd_directory-}" "\${life_local_fd_path+x}" "\${life_local_fd_path-}" "\${life_local_fd_number+x}" "\${life_local_fd_number-}"
if [ -d /dev/fd ]; then
  life_local_fd_directory=/dev/fd
elif [ -d /proc/self/fd ]; then
  life_local_fd_directory=/proc/self/fd
else
  printf '%s\\n' 'Life cannot enumerate inherited local file descriptors' >&2
  exit 125
fi
for life_local_fd_path in "$life_local_fd_directory"/[0-9]*; do
  life_local_fd_number=\${life_local_fd_path##*/}
  case "$life_local_fd_number" in ''|*[!0-9]*) continue ;; esac
  if [ "$life_local_fd_number" -ge 3 ]; then
    eval "exec $life_local_fd_number>&-" || exit 125
  fi
done
if [ "$4" = x ]; then life_local_fd_directory=$5; else unset life_local_fd_directory; fi
if [ "$6" = x ]; then life_local_fd_path=$7; else unset life_local_fd_path; fi
if [ "$8" = x ]; then life_local_fd_number=$9; else unset life_local_fd_number; fi
exec "$1" "$2" "$3"
`

function localExecArguments(shell: string, command: string) {
  return ['-c', LOCAL_EXEC_TRAMPOLINE, 'life-local', shell, '-c', command]
}

function executableShell(value: string | undefined): value is string {
  if (!value || !posix.isAbsolute(value)) return false
  try {
    if (!statSync(value).isFile()) return false
    accessSync(value, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function localShell(options: LocalTransportOptions = {}): string {
  if (options.shell !== undefined) {
    if (!executableShell(options.shell))
      throw new Error('The local shell must be an absolute path to an executable file')
    return options.shell
  }
  const inherited = (options.env ?? process.env).SHELL
  return executableShell(inherited) ? inherited : '/bin/sh'
}

function signalName(value: string): NodeJS.Signals {
  const name = value.startsWith('SIG') ? value : `SIG${value}`
  if (!Object.hasOwn(osConstants.signals, name)) throw new Error(`Unknown process signal: ${value}`)
  return name as NodeJS.Signals
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    // A PTY implementation may report a process before its group becomes ready.
    try {
      process.kill(pid, signal)
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code !== 'ESRCH') throw fallback
    }
  }
}

class OutputLane extends Readable {
  sourceEnded = false
  private readonly data: (chunk: Buffer) => void
  private readonly ended: () => void
  private readonly failed: (error: Error) => void

  constructor(
    private readonly source: Readable,
    fail: (error: Error) => void,
  ) {
    super({ highWaterMark: BUFFER_BYTES, autoDestroy: false })
    this.data = (chunk) => {
      if (!this.push(chunk)) source.pause()
    }
    this.ended = () => {
      this.sourceEnded = true
      this.push(null)
      // An empty lane must acknowledge EOF even when no consumer needs stderr.
      if (this.readableLength === 0) this.read(0)
    }
    this.failed = fail
    source.on('data', this.data)
    source.once('end', this.ended)
    source.on('error', this.failed)
    this.on('error', () => {})
  }

  override _read() {
    this.source.resume()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.source.off('data', this.data)
    this.source.off('end', this.ended)
    // The producer may still acknowledge its teardown after the channel is gone.
    this.source.off('error', this.failed)
    this.source.on('error', () => {})
    this.source.destroy()
    callback(error)
  }
}

/** Own the nonblocking master without a libuv TTY stream's queued EOF reads. */
class PtyReader extends Readable {
  descriptorClosed = false
  private polling = false
  private immediate?: NodeJS.Immediate
  private timer?: NodeJS.Timeout
  private idleDelay = 2
  private buffer?: Buffer

  constructor(private readonly descriptor: number) {
    super({ highWaterMark: BUFFER_BYTES, autoDestroy: false })
  }

  override _read() {
    if (this.polling || this.descriptorClosed) return
    this.polling = true
    this.immediate = setImmediate(() => this.poll())
  }

  private poll() {
    this.immediate = undefined
    this.timer = undefined
    if (this.descriptorClosed || this.destroyed) return
    const buffer = this.buffer ?? Buffer.allocUnsafe(BUFFER_BYTES)
    this.buffer = buffer
    try {
      const bytes = readSync(this.descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) {
        this.eof()
        return
      }
      this.buffer = undefined
      this.idleDelay = 2
      this.polling = false
      // A fresh _read schedules another turn; a paused consumer can retain at
      // most the high-water buffer plus one bounded native read.
      this.push(buffer.subarray(0, bytes))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EAGAIN') {
        this.timer = setTimeout(() => this.poll(), this.idleDelay)
        this.idleDelay = Math.min(16, this.idleDelay * 2)
      } else if (code === 'EIO') this.eof()
      else this.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private closeDescriptor(): Error | undefined {
    if (this.descriptorClosed) return
    this.descriptorClosed = true
    this.polling = false
    clearImmediate(this.immediate)
    clearTimeout(this.timer)
    this.immediate = undefined
    this.timer = undefined
    this.buffer = undefined
    try {
      closeSync(this.descriptor)
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  private eof() {
    const error = this.closeDescriptor()
    if (error) this.destroy(error)
    else this.push(null)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    const closeError = this.closeDescriptor()
    callback(error ?? closeError)
  }
}

/** A stream boundary with ssh2's channel shape; domain ownership remains in SSHConnection. */
abstract class LocalChannel extends Duplex {
  readonly stdin = this
  readonly stdout = this
  readonly server = false
  readonly type = 'session'
  readonly subtype = 'exec'
  readonly incoming = undefined
  readonly outgoing = undefined
  abstract readonly stderr: Readable
  protected processClosed = false
  protected exitCode: number | null = null
  protected exitSignal: string | undefined
  protected forced = false
  protected terminating = false
  protected readonly maxInputBytes: number = Infinity
  protected outputEnded = false
  private channelClosed = false
  private destroyDone?: (error?: Error | null) => void
  private destroyError: Error | null = null

  constructor() {
    super({
      highWaterMark: BUFFER_BYTES,
      autoDestroy: false,
      emitClose: false,
      allowHalfOpen: true,
    })
    // Opening and finalization can fail before/after the adopter installs listeners.
    this.on('error', () => {})
    this.on('end', () => this.finish())
  }

  protected watchStderr() {
    this.stderr.on('end', () => this.finish())
  }

  protected exited(code: number | null, signal?: string) {
    this.exitCode = code
    this.exitSignal = signal?.replace(/^SIG/, '')
    if (signal) this.emit('exit', null, this.exitSignal, '', '')
    else this.emit('exit', code)
  }

  protected completed() {
    this.processClosed = true
    this.finish()
  }

  protected finish() {
    if (
      this.channelClosed ||
      !this.processClosed ||
      this.terminating ||
      (!this.forced && (!this.outputEnded || !this.readableEnded || !this.stderr.readableEnded))
    )
      return
    this.channelClosed = true
    if (this.destroyDone) {
      this.destroyDone(this.destroyError)
      this.destroyDone = undefined
    }
    // Repeat the actual exit status, as ssh2 does, for very fast exec acknowledgements.
    queueMicrotask(() => this.emit('close', this.exitCode, this.exitSignal))
  }

  protected fail(error: Error) {
    this.destroy(error)
  }

  close() {
    if (!this.channelClosed) this.destroy()
  }

  eof() {
    this.end()
  }

  override write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const bytes =
      typeof chunk === 'string'
        ? Buffer.byteLength(
            chunk,
            typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined,
          )
        : chunk.byteLength
    if (bytes + this.writableLength > this.maxInputBytes) {
      const error = new Error('Local terminal input exceeds 4 MB; close and reopen the terminal')
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      queueMicrotask(() => done?.(error))
      this.destroy(error)
      return false
    }
    return typeof encodingOrCallback === 'string'
      ? super.write(chunk, encodingOrCallback, callback)
      : super.write(chunk, encodingOrCallback ?? callback)
  }

  override end(callback?: () => void): this
  override end(chunk: unknown, callback?: () => void): this
  override end(chunk: unknown, encoding: BufferEncoding, callback?: () => void): this
  override end(
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    const bytes =
      typeof chunk === 'string'
        ? Buffer.byteLength(
            chunk,
            typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined,
          )
        : chunk instanceof Uint8Array
          ? chunk.byteLength
          : 0
    if (bytes + this.writableLength > this.maxInputBytes) {
      const error = new Error('Local terminal input exceeds 4 MB; close and reopen the terminal')
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      if (done) this.once('close', done)
      this.destroy(error)
      return this
    }
    return typeof encodingOrCallback === 'string'
      ? super.end(chunk, encodingOrCallback, callback)
      : super.end(chunk, encodingOrCallback ?? callback)
  }

  abstract setWindow(rows: number, cols: number, height?: number, width?: number): void
  abstract signal(name: string): void
  protected abstract release(): void

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.forced = true
    this.destroyError = error
    this.destroyDone = callback
    this.release()
    this.stderr.destroy()
    this.push(null)
    this.finish()
  }

  protected terminate(pid: number | undefined, groups = [pid], released?: () => void) {
    if (pid === undefined) {
      released?.()
      return
    }
    this.terminating = true
    for (const group of groups) {
      try {
        signalProcessGroup(group, 'SIGTERM')
      } catch (error) {
        this.emit('error', error)
      }
    }
    released?.()
    // The leader can exit while one of its children ignores TERM. Keep the
    // escalation even after that exit; explicit teardown owns the whole group.
    setTimeout(() => {
      for (const group of groups) {
        try {
          signalProcessGroup(group, 'SIGKILL')
        } catch (error) {
          this.emit('error', error)
        }
      }
      this.terminating = false
      this.finish()
    }, TERMINATION_GRACE_MS)
  }
}

class PipeChannel extends LocalChannel {
  readonly stderr: Readable
  private readonly data: (chunk: Buffer) => void

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    super()
    this.stderr = new OutputLane(process.stderr, (error) => this.fail(error))
    this.watchStderr()
    this.data = (chunk) => {
      if (!this.push(chunk)) process.stdout.pause()
    }
    process.stdout.on('data', this.data)
    process.stdout.once('end', () => {
      this.outputEnded = true
      this.push(null)
      if (this.readableLength === 0) this.read(0)
    })
    process.stdout.on('error', (error) => this.fail(error))
    process.stdin.on('error', (error) => this.fail(error))
    process.on('error', (error) => this.fail(error))
    process.once('exit', (code, signal) => this.exited(code, signal ?? undefined))
    process.once('close', () => this.completed())
  }

  override _read() {
    this.process.stdout.resume()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.process.stdin.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void) {
    if (this.process.stdin.destroyed || this.process.stdin.writableEnded) callback()
    else this.process.stdin.end(callback)
  }

  setWindow() {}

  signal(name: string) {
    signalProcessGroup(this.process.pid, signalName(name))
  }

  protected release() {
    if (!this.processClosed) this.terminate(this.process.pid)
    this.process.stdout.off('data', this.data)
    this.process.stdout.destroy()
    this.process.stdin.destroy()
  }
}

interface NativePty {
  fork(
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helper: string,
    exited: (code: number, signal: number) => void,
  ): { fd: number; pid: number; pty: string }
  resize(fd: number, cols: number, rows: number): void
}

function nativePty(): { binding: NativePty; helper: string } {
  // The public node-pty wrapper drops unread output 200ms after process exit
  // and acknowledges writes before its unbounded private queue drains. Use
  // the pinned 1.1.0 native boundary and own the descriptor/exit separately.
  // Load only on terminal opening so a missing binary cannot disable SSH or
  // ordinary local commands. Resolve the macOS helper exactly as node-pty does.
  try {
    const load = createRequire(__filename)
    const utilities = load('node-pty/lib/utils') as {
      loadNativeModule(name: string): { module: NativePty; dir: string }
    }
    const native = utilities.loadNativeModule('pty')
    if (typeof native.module.fork !== 'function' || typeof native.module.resize !== 'function')
      throw new Error('Incompatible native PTY interface')
    const helper = resolve(dirname(load.resolve('node-pty/lib/utils')), native.dir, 'spawn-helper')
      .replace('app.asar', 'app.asar.unpacked')
      .replace('node_modules.asar', 'node_modules.asar.unpacked')
    if (process.platform === 'darwin') accessSync(helper, constants.X_OK)
    return { binding: native.module, helper }
  } catch (cause) {
    throw new Error(
      'The local terminal could not load its native PTY. Reinstall Life for this platform.',
      {
        cause,
      },
    )
  }
}

function terminalGroups(terminal: string, leader: number, callback: (groups: number[]) => void) {
  execFile(
    '/bin/ps',
    ['-t', terminal.replace(/^\/dev\//, ''), '-o', 'pid=,pgid='],
    { timeout: 500, maxBuffer: 1_000_000 },
    (error, output) => {
      const groups = new Set([leader])
      if (!error) {
        for (const line of output.split('\n')) {
          const [pid, group] = line.trim().split(/\s+/).map(Number)
          if (Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(group) && group > 1)
            groups.add(group)
        }
      }
      callback([...groups])
    },
  )
}

class PtyChannel extends LocalChannel {
  protected override readonly maxInputBytes = MAX_STDIN_BYTES
  readonly stderr = new Readable({ read() {}, autoDestroy: false })
  private readonly source: PtyReader
  private readonly binding: NativePty
  private readonly pid: number
  private readonly fd: number
  private readonly terminal: string
  private readonly data: (chunk: Buffer) => void
  private pendingWrite?: {
    callback: (error?: Error | null) => void
    timer?: NodeJS.Timeout
  }

  constructor(
    shell: string,
    command: string,
    env: NodeJS.ProcessEnv,
    options: NonNullable<ExecOptions['pty']>,
  ) {
    super()
    const { binding, helper } = nativePty()
    this.binding = binding
    const environment = Object.entries({
      ...env,
      TERM: options.term ?? 'xterm-256color',
      PWD: process.cwd(),
    })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${name}=${value}`)
    const terminalProcess = binding.fork(
      '/bin/sh',
      localExecArguments(shell, command),
      environment,
      process.cwd(),
      options.cols,
      options.rows,
      -1,
      -1,
      true,
      helper,
      (code, number) => {
        const signal = number
          ? Object.entries(osConstants.signals).find((entry) => entry[1] === number)?.[0]
          : undefined
        this.exited(number ? null : code, signal)
        this.completed()
      },
    )
    this.fd = terminalProcess.fd
    this.pid = terminalProcess.pid
    this.terminal = terminalProcess.pty
    try {
      this.source = new PtyReader(this.fd)
    } catch (error) {
      signalProcessGroup(this.pid, 'SIGKILL')
      throw error
    }
    this.watchStderr()
    this.stderr.push(null)
    this.stderr.read(0)
    this.data = (bytes) => {
      if (!this.push(bytes)) this.source.pause()
    }
    this.source.on('data', this.data)
    this.source.on('error', (error: Error) => {
      if (!this.forced) this.fail(error)
    })
    this.source.once('end', () => this.outputFinished())
    this.source.once('close', () => this.outputFinished())
  }

  private outputFinished() {
    if (this.outputEnded) return
    this.outputEnded = true
    this.push(null)
    if (this.readableLength === 0) this.read(0)
    this.finish()
  }

  override _read() {
    this.source.resume()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    if (chunk.length > MAX_STDIN_BYTES) {
      callback(new Error('Local terminal input exceeds 4 MB; close and reopen the terminal'))
      return
    }
    const pending = {
      callback,
      timer: undefined as NodeJS.Timeout | undefined,
    }
    this.pendingWrite = pending
    let offset = 0
    const write = () => {
      if (this.pendingWrite !== pending || this.destroyed) return
      // native.fork sets O_NONBLOCK on the master. One bounded syscall per
      // yield accepts only kernel-backed bytes; it never queues a filesystem
      // write that could run after this descriptor has been reused elsewhere.
      if (this.source.descriptorClosed) {
        this.pendingWrite = undefined
        callback(new Error('The local terminal is closed'))
        return
      }
      try {
        const bytes = writeDescriptor(
          this.fd,
          chunk,
          offset,
          Math.min(BUFFER_BYTES, chunk.length - offset),
        )
        offset += bytes
        if (offset === chunk.length) {
          this.pendingWrite = undefined
          callback()
        } else pending.timer = setTimeout(write, bytes ? 0 : 2)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') pending.timer = setTimeout(write, 2)
        else {
          this.pendingWrite = undefined
          callback(error instanceof Error ? error : new Error(String(error)))
        }
      }
    }
    if (chunk.length === 0) {
      this.pendingWrite = undefined
      callback()
    } else write()
  }

  override _final(callback: (error?: Error | null) => void) {
    if (this.processClosed) callback()
    else this._write(Buffer.from('\u0004'), 'utf8', callback)
  }

  setWindow(rows: number, cols: number) {
    if (!Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(cols) || cols < 1)
      throw new Error('Terminal dimensions must be positive integers')
    if (!this.processClosed && !this.destroyed && !this.source.descriptorClosed)
      this.binding.resize(this.fd, cols, rows)
  }

  signal(name: string) {
    signalProcessGroup(this.pid, signalName(name))
  }

  protected release() {
    this.source.off('data', this.data)
    const released = () => {
      const pending = this.pendingWrite
      this.pendingWrite = undefined
      if (pending) clearTimeout(pending.timer)
      this.source.off('data', this.data)
      this.source.destroy()
      pending?.callback(new Error('The local terminal is closed'))
      this.finish()
    }
    if (this.source.descriptorClosed) {
      // EOF already released this terminal's descriptor. Its tty pathname can
      // now be assigned to another terminal; never rediscover jobs through it.
      // A process can close every terminal descriptor while continuing to
      // run. Its live leader/group remain owned independently of the tty path.
      if (!this.processClosed) this.terminate(this.pid, [this.pid], released)
      else released()
      return
    }
    this.terminating = true
    // Job control gives foreground/background jobs their own groups. Capture
    // every group still owning this dedicated terminal before closing its
    // master descriptor sends HUP and reparents those jobs.
    terminalGroups(this.terminal, this.pid, (groups) => {
      // EOF can win while ps is in flight. Its result then describes a tty
      // pathname we no longer own, so retain only our still-live leader.
      if (this.source.descriptorClosed) {
        this.terminating = false
        if (!this.processClosed) this.terminate(this.pid, [this.pid], released)
        else released()
      } else this.terminate(this.pid, groups, released)
    })
  }
}

function closedError() {
  return new Error('The local environment is disconnected')
}

/** Native local equivalent of the exec/SFTP portion of an ssh2 Client. */
export class LocalClient extends EventEmitter {
  private readonly shell: string
  private readonly env: NodeJS.ProcessEnv
  private readonly channels = new Set<LocalChannel>()
  private readonly files = new Set<LocalFiles>()
  private ended = false
  private closed = false

  constructor(options: LocalTransportOptions = {}) {
    super()
    if (process.platform === 'win32')
      throw new Error('Local execution currently requires macOS or Linux')
    this.shell = localShell(options)
    this.env = { ...(options.env ?? process.env), SHELL: this.shell }
  }

  exec(command: string, options: ExecOptions, callback: ExecCallback): this {
    if (this.ended) {
      queueMicrotask(() => callback(closedError()))
      return this
    }
    let channel: LocalChannel
    try {
      if (options.pty) {
        const { cols, rows, term } = options.pty
        if (!Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(cols) || cols < 1)
          throw new Error('Terminal dimensions must be positive integers')
        channel = new PtyChannel(this.shell, command, this.env, {
          cols,
          rows,
          term,
        })
        this.own(channel)
        queueMicrotask(() => this.adopt(channel, callback))
      } else {
        const child = spawn('/bin/sh', localExecArguments(this.shell, command), {
          env: this.env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        channel = new PipeChannel(child)
        this.own(channel)
        let acknowledged = false
        child.once('spawn', () => {
          acknowledged = true
          this.adopt(channel, callback)
        })
        child.once('error', (error) => {
          if (!acknowledged) {
            acknowledged = true
            callback(error)
          }
        })
      }
    } catch (error) {
      queueMicrotask(() => callback(error instanceof Error ? error : new Error(String(error))))
    }
    return this
  }

  private adopt(channel: LocalChannel, callback: ExecCallback) {
    if (this.ended) {
      channel.close()
      callback(closedError())
    } else callback(null, channel as unknown as ClientChannel)
  }

  private own(channel: LocalChannel) {
    this.channels.add(channel)
    channel.once('close', () => {
      this.channels.delete(channel)
      this.finish()
    })
  }

  sftp(callback: FilesCallback): this {
    if (this.ended) {
      queueMicrotask(() => callback(closedError()))
      return this
    }
    const files = new LocalFiles()
    this.files.add(files)
    queueMicrotask(() => {
      if (this.ended) {
        files.end()
        callback(closedError())
      } else callback(undefined, files)
    })
    return this
  }

  end(): this {
    if (this.ended) return this
    this.ended = true
    for (const channel of this.channels) channel.close()
    for (const files of this.files) files.end()
    this.files.clear()
    this.finish()
    return this
  }

  private finish() {
    if (!this.ended || this.closed || this.channels.size !== 0) return
    this.closed = true
    queueMicrotask(() => {
      this.emit('end')
      this.emit('close')
    })
  }
}
