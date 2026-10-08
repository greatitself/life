import {
  Server,
  utils,
  type Connection,
  type PseudoTtyInfo,
  type SFTPWrapper,
  type WindowChangeInfo,
} from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createServer,
  connect as connectTCP,
  type Server as TCPServer,
  type Socket,
} from 'node:net'
import type { ConnectInput } from '../../src/shared/types'

type LogEntry = { provider: 'codex' | 'claude'; argv?: string[]; message?: Record<string, any> }
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const status = utils.sftp.STATUS_CODE
type Handle = { file: Buffer; path: string } | { directory: string; done: boolean }

// A real SSH/SFTP connection on loopback. Commands execute fixture programs only.
export class SSHFixture {
  root = ''
  workspace = ''
  port = 0
  initializationDelay = 0
  readonly commands: string[] = []
  readonly ptys: PseudoTtyInfo[] = []
  readonly resizes: WindowChangeInfo[] = []
  readonly allowedForwardPorts = new Set<number>()
  readonly forwardRequests: Array<{ host: string; port: number }> = []
  discoveryPorts?: number[]
  private server?: Server
  private transport?: TCPServer
  private sockets = new Set<Socket>()
  private clients = new Set<Connection>()
  private processes = new Set<ChildProcess>()
  constructor(private providerSource = join(process.cwd(), 'tests/fixtures/fake-provider.cjs')) {}
  async start() {
    this.root = await mkdtemp(join(tmpdir(), 'relay-ssh-test-'))
    this.workspace = join(this.root, "workspace's project")
    const bin = join(this.root, '.local/bin')
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(join(this.workspace, 'src'), { recursive: true }),
      mkdir(join(this.workspace, 'node_modules'), { recursive: true }),
      mkdir(join(this.workspace, '.git'), { recursive: true }),
    ])
    const provider = await readFile(this.providerSource, 'utf8')
    await Promise.all(
      ['codex', 'claude'].map((name) => writeFile(join(bin, name), provider, { mode: 0o755 })),
    )
    const shell = join(bin, 'fixture-shell')
    await writeFile(
      shell,
      '#!/bin/bash\nif [[ "$1" == "-lc" ]]; then\n  task_command="${2//\\$HOME/\\$RELAY_TEST_HOME}"\n  exec /bin/bash --noprofile --norc -c "$task_command"\nfi\nif [[ "$1" == "-s" ]]; then\n  exec /bin/bash --noprofile --norc -s\nfi\nexec /bin/bash --noprofile --norc -i\n',
      { mode: 0o755 },
    )
    await Promise.all([
      writeFile(join(this.workspace, 'README.md'), '# Fixture workspace\n'),
      writeFile(join(this.workspace, 'src/index.ts'), 'export const answer = 42\n'),
      writeFile(join(this.root, 'outside.txt'), 'private outside workspace'),
      writeFile(join(this.workspace, 'binary.dat'), Buffer.from([0, 1, 2])),
      writeFile(join(this.workspace, 'large.txt'), 'x'.repeat(1_000_001)),
      symlink(join(this.root, 'outside.txt'), join(this.workspace, 'escape-link')),
      writeFile(join(this.root, 'provider-messages.jsonl'), ''),
    ])
    this.server = new Server({ hostKeys: [privateKey] }, (client) => {
      this.clients.add(client)
      client.on('error', () => {})
      client.on('close', () => this.clients.delete(client))
      client.on('authentication', (context) => {
        if (
          context.username === 'fixture' &&
          context.method === 'password' &&
          context.password === 'fixture-password'
        )
          context.accept()
        else context.reject()
      })
      client.on('ready', () => {
        client.on('tcpip', (accept, reject, info) => {
          this.forwardRequests.push({ host: info.destIP, port: info.destPort })
          if (
            !['127.0.0.1', '::1'].includes(info.destIP) ||
            !this.allowedForwardPorts.has(info.destPort)
          ) {
            reject()
            return
          }
          let accepted = false
          const socket = connectTCP(info.destPort, info.destIP, () => {
            accepted = true
            const channel = accept()
            socket.pipe(channel).pipe(socket)
            channel.on('error', () => socket.destroy())
            channel.on('close', () => socket.destroy())
          })
          this.sockets.add(socket)
          socket.on('close', () => this.sockets.delete(socket))
          socket.on('error', () => {
            if (!accepted) reject()
          })
        })
      })
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acceptPty, _reject, info) => {
            this.ptys.push(info)
            acceptPty()
          })
          session.on('window-change', (acceptResize, _reject, info) => {
            this.resizes.push(info)
            acceptResize?.()
          })
          session.on('sftp', (acceptSftp) => this.sftp(acceptSftp()))
          session.on('exec', (acceptExec, _reject, info) => {
            this.commands.push(info.command)
            const channel = acceptExec()
            if (this.discoveryPorts && /LIFE_PORTS_(SS|LSOF)/.test(info.command)) {
              channel.write(
                'LIFE_PORTS_SS\n' +
                  this.discoveryPorts
                    .map((port) => `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*\n`)
                    .join(''),
              )
              channel.exit(0)
              channel.end()
              return
            }
            const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', info.command], {
              cwd: this.workspace,
              env: {
                ...process.env,
                RELAY_TEST_HOME: this.root,
                SHELL: shell,
                PATH: `${bin}:${process.env.PATH}`,
                RELAY_TEST_LOG: join(this.root, 'provider-messages.jsonl'),
                RELAY_TEST_INIT_DELAY: String(this.initializationDelay),
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            this.processes.add(child)
            channel.pipe(child.stdin!)
            child.stdout!.pipe(channel, { end: false })
            child.stderr!.pipe(channel.stderr, { end: false })
            child.stdin!.on('error', () => {})
            channel.on('error', () => {})
            channel.on('close', () => {
              child.kill('SIGKILL')
            })
            child.on('close', (code) => {
              this.processes.delete(child)
              if (!channel.destroyed) {
                channel.exit(code ?? 1)
                channel.end()
              }
            })
            child.on('error', (error) => {
              channel.stderr.write(error.message)
              channel.exit(1)
              channel.end()
            })
          })
        }),
      )
    })
    // Own the TCP listener because ssh2.Server is a wrapper whose runtime lacks
    // net.Server's `listening` property and forced socket cleanup methods.
    this.transport = createServer((socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      this.server!.injectSocket(socket)
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.transport!.once('error', reject)
      this.transport!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.transport.address()
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP')
    this.port = address.port
    return this
  }
  input(): ConnectInput {
    return {
      id: 'fixture-machine',
      name: 'Loopback fixture',
      host: '127.0.0.1',
      port: this.port,
      username: 'fixture',
      auth: 'password',
      password: 'fixture-password',
      privateKeyPath: '',
      workspace: this.workspace,
    }
  }
  async log(): Promise<LogEntry[]> {
    const raw = await readFile(join(this.root, 'provider-messages.jsonl'), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry)
  }
  async close() {
    const childrenClosed = [...this.processes].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('close', () => resolve())
          child.kill('SIGKILL')
        }),
    )
    for (const client of this.clients) client.end()
    for (const socket of this.sockets) socket.destroy()
    const serverClosed = this.transport?.listening
      ? new Promise<void>((resolve) => this.transport!.close(() => resolve()))
      : Promise.resolve()
    await Promise.all([...childrenClosed, serverClosed])
    if (this.root) await rm(this.root, { recursive: true, force: true })
  }
  private sftp(sftp: SFTPWrapper) {
    const handles = new Map<string, Handle>()
    let next = 0
    const fail = (id: number, operation: () => void) => {
      try {
        operation()
      } catch {
        sftp.status(id, status.NO_SUCH_FILE)
      }
    }
    const attrs = (path: string) => {
      const value = statSync(path)
      return {
        mode: value.mode,
        uid: value.uid,
        gid: value.gid,
        size: value.size,
        atime: Math.floor(value.atimeMs / 1000),
        mtime: Math.floor(value.mtimeMs / 1000),
      }
    }
    const handle = (id: number, value: Handle) => {
      const key = String(++next)
      handles.set(key, value)
      sftp.handle(id, Buffer.from(key))
    }
    sftp.on('REALPATH', (id, path) =>
      fail(id, () => {
        const canonical = realpathSync(path)
        sftp.name(id, [{ filename: canonical, longname: canonical, attrs: attrs(canonical) }])
      }),
    )
    sftp.on('STAT', (id, path) => fail(id, () => sftp.attrs(id, attrs(path))))
    sftp.on('LSTAT', (id, path) => fail(id, () => sftp.attrs(id, attrs(path))))
    sftp.on('OPENDIR', (id, path) =>
      fail(id, () => {
        if (!statSync(path).isDirectory()) throw new Error('Not a directory')
        handle(id, { directory: path, done: false })
      }),
    )
    sftp.on('READDIR', (id, key) =>
      fail(id, () => {
        const value = handles.get(key.toString())
        if (!value || !('directory' in value)) throw new Error('Bad handle')
        if (value.done) {
          sftp.status(id, status.EOF)
          return
        }
        value.done = true
        sftp.name(
          id,
          readdirSync(value.directory).map((filename) => ({
            filename,
            longname: filename,
            attrs: attrs(join(value.directory, filename)),
          })),
        )
      }),
    )
    sftp.on('OPEN', (id, path) => fail(id, () => handle(id, { file: readFileSync(path), path })))
    sftp.on('FSTAT', (id, key) =>
      fail(id, () => {
        const value = handles.get(key.toString())
        if (!value || !('file' in value)) throw new Error('Bad handle')
        sftp.attrs(id, attrs(value.path))
      }),
    )
    sftp.on('READ', (id, key, offset, length) =>
      fail(id, () => {
        const value = handles.get(key.toString())
        if (!value || !('file' in value)) throw new Error('Bad handle')
        if (offset >= value.file.length) sftp.status(id, status.EOF)
        else sftp.data(id, value.file.subarray(offset, offset + length))
      }),
    )
    sftp.on('CLOSE', (id, key) => {
      handles.delete(key.toString())
      sftp.status(id, status.OK)
    })
  }
}
