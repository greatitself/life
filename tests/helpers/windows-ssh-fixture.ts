import { Server, utils, type Connection, type ServerChannel, type SFTPWrapper } from 'ssh2'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { createServer, type Server as TCPServer, type Socket } from 'node:net'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ConnectInput } from '../../src/shared/types'

type Wire = Record<string, any>
type Handle = { path: string; bytes: Buffer } | { path: string; directory: true; done: boolean }

/**
 * A real loopback SSH/SFTP server with synthetic POSIX paths and native protocol
 * peers. It runs on Windows without a shell, installed provider CLI or credentials.
 * Unknown shell commands fail; detached brokers never have an implementation.
 */
export class WindowsSSHFixture {
  readonly home = '/home/life-windows-fixture'
  readonly workspace = `${this.home}/workspace`
  readonly commands: string[] = []
  readonly rejectedCommands: string[] = []
  readonly messages: Array<{
    provider: 'codex' | 'claude'
    channelId: string
    direction: 'in' | 'out'
    message: Wire
  }> = []
  readonly protocolErrors: string[] = []
  readonly studioContexts: Array<{ workspace: string; session: string; context: Wire }> = []
  readonly studioPrompts: Array<{
    prompt: string
    phase: string
    threadId: string
    proposal: string
  }> = []
  readonly nativeChannels = { codex: 0, claude: 0 }
  readonly connections = new Set<Connection>()
  readonly sockets = new Set<Socket>()
  readonly channels = new Set<ServerChannel>()
  port = 0
  private transport?: TCPServer
  private server?: Server
  private nextThread = 0
  private nextTurn = 0

  constructor(
    readonly root: string,
    readonly studioProgramHash: string,
  ) {}

  async start(): Promise<this> {
    if (process.platform !== 'win32')
      throw new Error('This fixture requires an actual Windows host')
    await mkdir(this.hostPath(this.workspace), { recursive: true })
    await writeFile(
      join(this.hostPath(this.workspace), 'README.md'),
      'Private Windows SSH fixture\n',
      {
        flag: 'wx',
      },
    )
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    this.server = new Server({ hostKeys: [privateKey] }, (client) => {
      this.connections.add(client)
      client.on('error', () => {})
      client.on('close', () => this.connections.delete(client))
      client.on('authentication', (request) => {
        if (
          request.method === 'password' &&
          request.username === 'fixture' &&
          request.password === 'fixture-password'
        )
          request.accept()
        else request.reject(['password'])
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          let channel: ServerChannel | undefined
          session.on('sftp', (open) => this.sftp(open()))
          session.on('env', (allow) => allow?.())
          session.on('signal', (allow) => {
            allow?.()
            if (channel && !channel.destroyed) {
              channel.exit(0)
              channel.end()
            }
          })
          session.on('exec', (open, _reject, info) => {
            channel = open()
            this.channels.add(channel)
            channel.on('error', () => {})
            channel.on('close', () => this.channels.delete(channel!))
            this.execute(channel, info.command)
          })
        })
      })
    })
    this.transport = createServer((socket) => {
      this.sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => this.sockets.delete(socket))
      this.server!.injectSocket(socket)
    })
    await new Promise<void>((done, fail) => {
      this.transport!.once('error', fail)
      this.server!.once('error', fail)
      this.transport!.listen(0, '127.0.0.1', done)
    })
    const address = this.transport.address()
    if (!address || typeof address === 'string') throw new Error('Loopback fixture failed to bind')
    this.port = address.port
    return this
  }

  input(): ConnectInput {
    return {
      id: 'windows-fixture-machine',
      name: 'Windows loopback fixture',
      transport: 'ssh',
      host: '127.0.0.1',
      port: this.port,
      username: 'fixture',
      auth: 'password',
      password: 'fixture-password',
      privateKeyPath: '',
      workspace: this.workspace,
    }
  }

  async close(): Promise<void> {
    for (const channel of this.channels) channel.destroy()
    for (const connection of this.connections) connection.end()
    for (const socket of this.sockets) socket.destroy()
    if (this.transport?.listening)
      await new Promise<void>((done) => this.transport!.close(() => done()))
  }

  private hostPath(remote: string): string {
    const canonical = posix.normalize(remote)
    if (canonical !== this.home && !canonical.startsWith(`${this.home}/`))
      throw new Error('The fixture refuses paths outside its logical remote HOME')
    const candidate = resolve(this.root, canonical.slice(this.home.length).replace(/^\//, ''))
    const difference = relative(resolve(this.root), candidate)
    if (difference === '..' || difference.startsWith(`..${sep}`))
      throw new Error('Path escaped fixture')
    return candidate
  }

  private execute(channel: ServerChannel, command: string): void {
    this.commands.push(command)
    const finish = (stdout: string, code = 0) => {
      channel.write(stdout)
      channel.exit(code)
      channel.end()
    }
    if (
      command.includes('Life Studio requires Node.js or Python 3 on the connected environment.') &&
      command.includes('inflateSync') &&
      command.includes('command -v node') &&
      [...command.matchAll(/[A-Za-z0-9+/]{200,}={0,2}/g)].some(([encoded]) => {
        try {
          return (
            createHash('sha256')
              .update(inflateSync(Buffer.from(encoded, 'base64')))
              .digest('hex') === this.studioProgramHash
          )
        } catch {
          return false
        }
      })
    )
      this.stageStudio(channel)
    else if (
      /agent-sessions|native-recovery|nohup|setsid|python3|broker\.py|broker\.cjs/.test(command)
    ) {
      this.rejectedCommands.push(command)
      channel.stderr.write(
        'Detached broker commands are forbidden in the Windows compatibility gate',
      )
      finish('', 125)
    } else if (command.includes('CODEX=') && command.includes('CLAUDE=')) {
      finish('CODEX=codex-cli 0.127.0\nCLAUDE=2.1.120 (Claude Code)\n')
    } else if (command.includes('pwd -P') && command.includes('$HOME')) {
      finish(`${this.home}\n`)
    } else if (/codex.*app-server/.test(command)) {
      this.nativeChannels.codex++
      this.protocol(channel, 'codex')
    } else if (/claude/.test(command) && command.includes('stream-json')) {
      this.nativeChannels.claude++
      this.protocol(channel, 'claude')
    } else if (/LIFE_PORTS_(SS|LSOF)/.test(command)) {
      finish('LIFE_PORTS_SS4\nLIFE_PORTS_SS6\n')
    } else if (/git .*rev-parse/.test(command)) {
      finish('windows-fixture\n')
    } else if (/git .*(?:status|diff)/.test(command)) {
      finish('')
    } else {
      this.rejectedCommands.push(command)
      channel.stderr.write(`Unsupported fixture command: ${command}`)
      finish('', 127)
    }
  }

  private stageStudio(channel: ServerChannel): void {
    const chunks: Buffer[] = []
    let size = 0
    channel.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 20_000_000) {
        this.protocolErrors.push('Fixture Studio input exceeds its bound')
        channel.destroy()
        return
      }
      chunks.push(chunk)
    })
    channel.on('end', () => {
      void (async () => {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (
          input.home !== this.home ||
          !/^[a-f0-9]{64}$/.test(input.session) ||
          !['request', 'source-read', 'repair'].includes(input.context?.phase) ||
          !Array.isArray(input.context.files)
        )
          throw new Error('Invalid fixture Studio context')
        const workspace = posix.join(this.home, '.life', 'customization', input.session)
        const root = this.hostPath(workspace)
        await mkdir(join(root, '.life'), { recursive: true })
        const prior = this.studioContexts.findLast((entry) => entry.workspace === workspace)
        const nextPaths = new Set(input.context.files.map((file: Wire) => file.path))
        for (const file of prior?.context.files || [])
          if (!nextPaths.has(file.path)) await rm(join(root, file.path), { force: true })
        for (const file of input.context.files) {
          if (
            !/^\.life\/[a-z][a-z0-9-]*\.json$/.test(file.path) ||
            typeof file.content !== 'string'
          )
            throw new Error('Invalid fixture Studio file')
          await writeFile(join(root, file.path), file.content)
        }
        for (const name of ['AGENTS.md', 'CLAUDE.md'])
          await writeFile(join(root, name), input.context.instructions)
        await writeFile(
          join(root, '.studio-context.json'),
          JSON.stringify({
            session: input.session,
            revision: input.context.revision,
            phase: input.context.phase,
            files: [...nextPaths],
          }),
        )
        this.studioContexts.push({ workspace, session: input.session, context: input.context })
        channel.write(JSON.stringify({ workspace }))
        channel.exit(0)
        channel.end()
      })().catch((error) => {
        this.protocolErrors.push(String(error))
        channel.stderr.write(String(error))
        channel.exit(126)
        channel.end()
      })
    })
  }

  private protocol(channel: ServerChannel, provider: 'codex' | 'claude'): void {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let threadId = ''
    let turnId = ''
    const threads = new Map<string, string>()
    const channelId = `${provider}:${this.nativeChannels[provider]}`
    let sawInitialize = false
    let initialized = false
    const sessionId = `windows-claude-native-${this.nativeChannels.claude}`
    let approvalId = provider === 'codex' ? '' : 'windows-permission-1'
    let awaitingPermission = false
    const send = (message: Wire) => {
      this.messages.push({ provider, channelId, direction: 'out', message })
      channel.write(`${JSON.stringify(message)}\n`)
    }
    const complete = (text = 'Windows native fixture completed.') => {
      awaitingPermission = false
      if (provider === 'codex') {
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            turnId,
            itemId: `${turnId}-answer`,
            delta: text,
          },
        })
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: {
              id: `${turnId}-answer`,
              type: 'agentMessage',
              phase: 'final_answer',
              text,
            },
          },
        })
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        })
      } else {
        send({
          type: 'assistant',
          session_id: sessionId,
          message: {
            id: 'windows-answer',
            role: 'assistant',
            content: [{ type: 'text', text: 'Windows native fixture completed.' }],
          },
        })
        send({
          type: 'result',
          subtype: 'success',
          session_id: sessionId,
          is_error: false,
          result: 'Windows native fixture completed.',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
        send({
          type: 'system',
          subtype: 'session_state_changed',
          session_id: sessionId,
          state: 'idle',
        })
      }
    }
    const receive = (message: Wire) => {
      this.messages.push({ provider, channelId, direction: 'in', message })
      if (provider === 'codex') {
        const reply = (result: Wire) => send({ id: message.id, result })
        if (message.method !== 'initialize' && message.method !== 'initialized' && !initialized)
          throw new Error('Codex sent native work before initialize/initialized')
        if (awaitingPermission && message.id === approvalId && !message.method) return complete()
        switch (message.method) {
          case 'initialize':
            sawInitialize = true
            return reply({ userAgent: 'windows-native-protocol-fixture' })
          case 'initialized':
            if (!sawInitialize) throw new Error('Codex initialized without an initialize request')
            initialized = true
            return
          case 'config/read':
            return reply({
              config: { model: 'fixture-model', model_reasoning_effort: 'low', service_tier: null },
              origins: {},
              layers: null,
            })
          case 'model/list':
            return reply({
              data: [
                {
                  id: 'fixture-model',
                  model: 'fixture-model',
                  displayName: 'Windows fixture model',
                  isDefault: true,
                  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fixture' }],
                  defaultReasoningEffort: 'low',
                },
              ],
            })
          case 'account/rateLimits/read':
            return reply({ rateLimits: null })
          case 'thread/start':
            threadId = `windows-codex-native-${++this.nextThread}`
            threads.set(threadId, message.params.cwd)
            return reply({ thread: { id: threadId, name: 'Windows fixture thread' } })
          case 'thread/read':
            if (!threads.has(message.params?.threadId))
              throw new Error('Codex read used an unissued native thread identity')
            return reply({
              thread: { id: message.params.threadId, name: 'Windows fixture thread', turns: [] },
            })
          case 'turn/start':
            if (!threads.has(message.params?.threadId))
              throw new Error('Codex prompt used an unissued native thread identity')
            threadId = message.params.threadId
            turnId = `windows-codex-turn-${++this.nextTurn}`
            approvalId = `windows-approval-${this.nextTurn}`
            reply({ turn: { id: turnId, status: 'inProgress' } })
            send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
            const studio = this.studioContexts.findLast(
              (entry) => entry.workspace === threads.get(threadId),
            )
            if (studio) {
              const prompt = message.params.input[0]?.text
              if (typeof prompt !== 'string')
                throw new Error('Studio omitted its exact user prompt')
              let proposal =
                '<life-source-read>{"paths":["src/renderer/main.tsx"]}</life-source-read>'
              if (studio.context.phase === 'source-read') {
                const contextFile = studio.context.files.find(
                  (file: Wire) => file.path === '.life/source-context.json',
                )
                const source = JSON.parse(contextFile.content)
                const main = source.files.find(
                  (file: Wire) => file.path === 'src/renderer/main.tsx',
                )
                if (!main || main.content.split('<App />').length !== 2)
                  throw new Error('Studio continuation omitted requested source')
                proposal = `<life-source>${JSON.stringify({ summary: 'Windows Studio source proof', baseRevision: source.revision, files: [{ path: main.path, edits: [{ find: '<App />', replace: '<App />\n    <section data-windows-studio-proof="applied">Windows Studio ordinary source proof</section>' }] }] })}</life-source>`
              }
              this.studioPrompts.push({ prompt, phase: studio.context.phase, threadId, proposal })
              return complete(proposal)
            }
            awaitingPermission = true
            send({
              id: approvalId,
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId,
                turnId,
                itemId: 'windows-fixture-command',
                command: 'fixture-only-command',
                cwd: this.workspace,
                reason: 'Exercise native permission response without executing a command',
                availableDecisions: ['accept', 'decline'],
                opaqueFixtureMetadata: { preserved: true },
              },
            })
            return
          case 'turn/interrupt':
            reply({})
            return send({
              method: 'turn/completed',
              params: { threadId, turn: { id: turnId, status: 'interrupted' } },
            })
          case 'thread/name/set':
            return reply({})
          case 'thread/settings/update':
            return reply({ status: 'applied' })
          default:
            if (message.id !== undefined)
              send({
                id: message.id,
                error: { code: -32601, message: `Unsupported fixture method ${message.method}` },
              })
        }
      } else if (message.type === 'control_request') {
        const subtype = message.request?.subtype
        if (subtype !== 'initialize' && !initialized)
          throw new Error('Claude control preceded initialization')
        const response: Wire =
          subtype === 'initialize'
            ? {
                models: [
                  { value: 'sonnet', displayName: 'Windows fixture Sonnet', supportsEffort: false },
                ],
                supported_models: [{ value: 'sonnet', displayName: 'Windows fixture Sonnet' }],
                session_state: 'idle',
                claude_code_version: '2.1.120',
                fast_mode_state: 'off',
              }
            : subtype === 'get_usage'
              ? { total_cost_usd: 0, rate_limits: null }
              : {}
        if (subtype === 'initialize') {
          send({ type: 'system', subtype: 'init', session_id: sessionId })
          send({
            type: 'system',
            subtype: 'ai_title',
            session_id: sessionId,
            title: 'Windows fixture thread',
          })
        }
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response },
        })
        if (subtype === 'initialize') initialized = true
        if (subtype === 'interrupt')
          send({
            type: 'system',
            subtype: 'session_state_changed',
            session_id: sessionId,
            state: 'idle',
          })
      } else if (message.type === 'user') {
        if (!initialized) throw new Error('Claude user prompt preceded native initialization')
        if (message.session_id !== sessionId)
          throw new Error('Claude prompt changed the initialized native session identity')
        awaitingPermission = true
        send({
          type: 'system',
          subtype: 'session_state_changed',
          session_id: sessionId,
          state: 'running',
        })
        send({
          type: 'control_request',
          request_id: approvalId,
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'fixture-only-command', opaqueFixtureMetadata: { preserved: true } },
          },
        })
      } else if (
        message.type === 'control_response' &&
        message.response?.request_id === approvalId &&
        awaitingPermission
      )
        complete()
    }
    channel.on('data', (chunk: Buffer) => {
      pending += decoder.write(chunk)
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line.trim()) continue
        try {
          receive(JSON.parse(line))
        } catch (error) {
          this.protocolErrors.push(String(error))
          channel.stderr.write(String(error))
          channel.exit(126)
          channel.end()
        }
      }
    })
    // Native completion leaves the attached provider stream alive until its owner closes it.
    channel.on('end', () => {
      if (!channel.destroyed) {
        channel.exit(0)
        channel.end()
      }
    })
  }

  private sftp(sftp: SFTPWrapper): void {
    const status = utils.sftp.STATUS_CODE
    const handles = new Map<string, Handle>()
    let sequence = 0
    const attempt = (id: number, operation: () => void) => {
      try {
        operation()
      } catch {
        sftp.status(id, status.NO_SUCH_FILE)
      }
    }
    const attrs = (path: string) => {
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error('The SSH fixture refuses host links')
      return {
        mode: info.mode,
        uid: 0,
        gid: 0,
        size: info.size,
        atime: Math.floor(info.atimeMs / 1000),
        mtime: Math.floor(info.mtimeMs / 1000),
      }
    }
    const open = (id: number, handle: Handle) => {
      const key = String(++sequence)
      handles.set(key, handle)
      sftp.handle(id, Buffer.from(key))
    }
    sftp.on('REALPATH', (id, remote) =>
      attempt(id, () => {
        const canonical = posix.normalize(remote === '.' ? this.home : remote)
        const path = this.hostPath(canonical)
        sftp.name(id, [{ filename: canonical, longname: canonical, attrs: attrs(path) }])
      }),
    )
    sftp.on('STAT', (id, remote) => attempt(id, () => sftp.attrs(id, attrs(this.hostPath(remote)))))
    sftp.on('LSTAT', (id, remote) =>
      attempt(id, () => sftp.attrs(id, attrs(this.hostPath(remote)))),
    )
    sftp.on('OPENDIR', (id, remote) =>
      attempt(id, () => {
        const path = this.hostPath(remote)
        if (!lstatSync(path).isDirectory()) throw new Error('Not a fixture directory')
        open(id, { path, directory: true, done: false })
      }),
    )
    sftp.on('READDIR', (id, key) =>
      attempt(id, () => {
        const handle = handles.get(key.toString())
        if (!handle || !('directory' in handle)) throw new Error('Bad fixture directory handle')
        if (handle.done) return sftp.status(id, status.EOF)
        handle.done = true
        sftp.name(
          id,
          readdirSync(handle.path).map((filename) => ({
            filename,
            longname: filename,
            attrs: attrs(join(handle.path, filename)),
          })),
        )
      }),
    )
    sftp.on('OPEN', (id, remote, flags) =>
      attempt(id, () => {
        // These workflows read files only. A write is an unexpected remote mutation.
        if (flags !== utils.sftp.OPEN_MODE.READ) throw new Error('Remote writes are forbidden')
        const path = this.hostPath(remote)
        attrs(path)
        open(id, { path, bytes: readFileSync(path) })
      }),
    )
    sftp.on('FSTAT', (id, key) =>
      attempt(id, () => {
        const handle = handles.get(key.toString())
        if (!handle) throw new Error('Bad fixture handle')
        sftp.attrs(id, attrs(handle.path))
      }),
    )
    sftp.on('READ', (id, key, offset, length) =>
      attempt(id, () => {
        const handle = handles.get(key.toString())
        if (!handle || !('bytes' in handle)) throw new Error('Bad fixture file handle')
        if (offset >= handle.bytes.length) sftp.status(id, status.EOF)
        else sftp.data(id, handle.bytes.subarray(offset, offset + length))
      }),
    )
    sftp.on('CLOSE', (id, key) => {
      handles.delete(key.toString())
      sftp.status(id, status.OK)
    })
  }
}
