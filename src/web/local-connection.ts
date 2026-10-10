import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { userInfo } from 'node:os'
import { Duplex, PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type {
  ConnectInput,
  ConnectionProfile,
  FileEntry,
  RemoteDirectoryList,
} from '../shared/types'
import { SSHConnection } from '../main/ssh'
import { Store } from '../main/store'

export const LOCAL_PROFILE_ID = 'life-web-local'

function environment() {
  const env: NodeJS.ProcessEnv = { ...process.env, SHELL: process.env.SHELL || '/bin/bash' }
  // A separately launched conversation is not a nested Claude Code session.
  delete env.CLAUDECODE
  return env
}

/** Adapt a real local process to the channel used by the shared provider runner. */
class LocalChannel extends Duplex {
  readonly stderr = new PassThrough()
  readonly transportState = 'connected'
  private child: ChildProcessWithoutNullStreams
  constructor(command: string, cwd: string) {
    super({ autoDestroy: false })
    this.child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: environment(),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) this.child.stdout.pause()
    })
    this.child.stderr.pipe(this.stderr)
    this.child.stdin.on('error', (error) => {
      if (!this.destroyed) this.destroy(error)
    })
    this.child.on('error', (error) => this.destroy(error))
    this.child.on('close', (code, signal) => {
      this.emit('exit', code, signal)
      this.push(null)
      this.emit('close', code, signal)
    })
  }
  override _read() {
    this.child.stdout.resume()
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.child.stdin.write(chunk, callback)
  }
  override _final(callback: (error?: Error | null) => void) {
    this.child.stdin.end(callback)
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.signal('TERM')
    const timer = setTimeout(() => this.signal('KILL'), 2000)
    timer.unref()
    this.child.once('close', () => clearTimeout(timer))
    callback(error)
  }
  signal(signal: string) {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return
    try {
      process.kill(-this.child.pid, `SIG${signal.replace(/^SIG/, '')}` as NodeJS.Signals)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  close() {
    this.destroy()
  }
}

// Python's standard library provides a real PTY, including interactive sign-in and resizing.
const terminalProgram = String.raw`
import os, sys, json, select, signal, fcntl, termios, struct
pid, fd = os.forkpty()
if pid == 0:
    os.execvpe('/bin/bash', ['/bin/bash', '--noprofile', '--norc', '-i'], os.environ)
def stop(*args):
    try: os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
pending = b''
try:
    while True:
        readable, _, _ = select.select([fd, sys.stdin.buffer], [], [])
        if fd in readable:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.buffer in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data: break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if message['type'] == 'write': os.write(fd, message['data'].encode())
                elif message['type'] == 'resize':
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', message['rows'], message['cols'], 0, 0))
finally:
    stop()
`

/** One host selector supports this machine and the existing SSH transport. */
export class WebConnection extends SSHConnection {
  private processes = new Set<LocalChannel>()
  private localTerminal?: ChildProcessWithoutNullStreams
  private localWorkspace: string
  constructor(
    private readonly webStore: Store,
    readonly localHome: string,
  ) {
    super(webStore)
    this.localWorkspace =
      webStore.list().find((item) => item.id === LOCAL_PROFILE_ID)?.workspace || localHome
  }
  get localProfile(): ConnectionProfile {
    return {
      id: LOCAL_PROFILE_ID,
      name: 'This machine',
      host: 'localhost',
      port: 22,
      username: userInfo().username,
      auth: 'agent',
      privateKeyPath: '',
      workspace: this.localWorkspace,
    }
  }
  private get local() {
    return this.state.profile?.id === LOCAL_PROFILE_ID
  }
  override async connect(input: ConnectInput) {
    if (input.id !== LOCAL_PROFILE_ID) return super.connect(input)
    this.disconnect()
    const workspace = await realpath(input.workspace || this.localWorkspace)
    if (!(await stat(workspace)).isDirectory()) throw new Error('Select a project directory.')
    this.localWorkspace = workspace
    this.state = {
      status: 'connected',
      profile: this.localProfile,
      home: this.localHome,
      workspace,
    }
    const version = async (provider: string) =>
      this.exec(`${provider} --version`, { timeoutMs: 10000 }).then(
        (value) => value.trim(),
        () => 'missing',
      )
    const [codex, claude] = await Promise.all([version('codex'), version('claude')])
    this.state = { ...this.state, codex, claude }
    this.emit('state', this.state)
    return this.state
  }
  override async channel(
    command: string,
    pty?: { cols: number; rows: number },
    signal?: AbortSignal,
  ) {
    if (!this.local) return super.channel(command, pty, signal)
    if (this.state.status !== 'connected') throw new Error('Connect to a machine first.')
    if (signal?.aborted) throw new Error('Command cancelled.')
    const channel = new LocalChannel(command, this.state.workspace || this.localHome)
    this.processes.add(channel)
    const abort = () => channel.close()
    signal?.addEventListener('abort', abort, { once: true })
    channel.once('close', () => {
      this.processes.delete(channel)
      signal?.removeEventListener('abort', abort)
    })
    return channel as unknown as ClientChannel
  }
  override async durableChannel(command: string) {
    return this.local ? this.channel(command) : super.durableChannel(command)
  }
  override async selectWorkspace(path: string) {
    if (!this.local) return super.selectWorkspace(path)
    const workspace = await realpath(this.expand(path))
    if (!(await stat(workspace)).isDirectory()) throw new Error('Select a project directory.')
    this.emit('workspace-changing')
    this.closeTerminal()
    this.localWorkspace = workspace
    await this.webStore.save(this.localProfile)
    this.state = { ...this.state, workspace, profile: this.localProfile }
    this.emit('state', this.state)
    return this.state
  }
  private expand(path: string) {
    return path === '~'
      ? this.localHome
      : path.startsWith('~/')
        ? join(this.localHome, path.slice(2))
        : resolve(this.state.workspace || this.localHome, path)
  }
  override async listDirectories(path?: string): Promise<RemoteDirectoryList> {
    if (!this.local) return super.listDirectories(path)
    const directory = await realpath(this.expand(path || this.localWorkspace))
    const entries = await readdir(directory, { withFileTypes: true })
    return {
      path: directory,
      parent: dirname(directory),
      entries: entries
        .filter((item) => item.isDirectory() && !['.git', 'node_modules'].includes(item.name))
        .map((item) => ({ name: item.name, path: join(directory, item.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  }
  private async filePath(path?: string) {
    const root = await realpath(this.state.workspace || this.localHome)
    const target = await realpath(path ? (isAbsolute(path) ? path : join(root, path)) : root)
    if (target !== root && !target.startsWith(root + sep))
      throw new Error('Select a file inside the current project.')
    return target
  }
  override async list(path?: string): Promise<FileEntry[]> {
    if (!this.local) return super.list(path)
    const directory = await this.filePath(path)
    const entries = await readdir(directory, { withFileTypes: true })
    return Promise.all(
      entries
        .filter((item) => item.name !== '.git')
        .map(async (item) => ({
          name: item.name,
          path: join(directory, item.name),
          directory: item.isDirectory(),
          size: item.isDirectory() ? 0 : (await stat(join(directory, item.name))).size,
        })),
    )
  }
  override async read(path: string) {
    if (!this.local) return super.read(path)
    const file = await this.filePath(path)
    const info = await stat(file)
    if (!info.isFile() || info.size > 4_000_000)
      throw new Error('Select a text file smaller than 4 MB.')
    return readFile(file, 'utf8')
  }
  override async openTerminal() {
    if (!this.local) return super.openTerminal()
    if (this.localTerminal) return
    const child = spawn('python3', ['-u', '-c', terminalProgram], {
      cwd: this.state.workspace,
      env: { ...environment(), TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.localTerminal = child
    child.stdin.on('error', () => {
      if (this.localTerminal === child) this.localTerminal = undefined
    })
    child.stdout.on('data', (data: Buffer) => this.emit('terminal', data.toString()))
    child.stderr.on('data', (data: Buffer) => this.emit('terminal', data.toString()))
    child.on('error', (error) => this.emit('terminal', `\r\n${error.message}\r\n`))
    child.on('close', () => {
      if (this.localTerminal === child) this.localTerminal = undefined
      this.emit('terminal', '\r\n[Terminal closed]\r\n')
    })
  }
  override writeTerminal(data: string) {
    if (!this.local) return super.writeTerminal(data)
    this.localTerminal?.stdin.write(JSON.stringify({ type: 'write', data }) + '\n')
  }
  override resizeTerminal(cols: number, rows: number) {
    if (!this.local) return super.resizeTerminal(cols, rows)
    this.localTerminal?.stdin.write(JSON.stringify({ type: 'resize', cols, rows }) + '\n')
  }
  override closeTerminal() {
    super.closeTerminal()
    this.localTerminal?.kill('SIGTERM')
    this.localTerminal = undefined
  }
  override disconnect() {
    if (!this.local) return super.disconnect()
    this.closeTerminal()
    this.state = { status: 'disconnected' }
    this.emit('disconnected')
    this.emit('state', this.state)
  }
  closeLocalProcesses() {
    this.closeTerminal()
    for (const channel of this.processes) channel.close()
    this.disconnect()
  }
}
