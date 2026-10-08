import {
  Client,
  type AnyAuthMethod,
  type ClientChannel,
  type SFTPWrapper,
  type VerifyCallback,
} from 'ssh2'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { posix, join } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type {
  ConnectInput,
  ConnectionState,
  FileEntry,
  HostKeyRequest,
  SSHConfigHost,
} from '../shared/types'
import { shellQuote, profileSchema } from '../shared/validation'
import { Store } from './store'
import { openProxyJump, resolveSSHConfig, sshConfigTransportOptions } from './ssh-config'

export function remoteCommand(command: string) {
  return `exec "$SHELL" -lc ${shellQuote('export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:$PATH"; ' + command)}`
}
export function remotePath(path: string) {
  if (path === '~') return '"$HOME"'
  return path.startsWith('~/') ? '"$HOME"/' + shellQuote(path.slice(2)) : shellQuote(path)
}
export class SSHConnection extends EventEmitter {
  state: ConnectionState = { status: 'disconnected' }
  private client?: Client
  private jump?: ReturnType<typeof openProxyJump>
  private sftp?: SFTPWrapper
  private pendingTrust = new Map<string, (accepted: boolean) => void>()
  private terminal?: ClientChannel
  private terminalStarting?: Promise<void>
  private terminalGeneration = 0
  constructor(private store: Store) {
    super()
  }
  private update(state: ConnectionState) {
    this.state = state
    this.emit('state', state)
  }
  async connect(input: ConnectInput): Promise<ConnectionState> {
    if (this.state.status === 'connecting') throw new Error('A connection is already in progress')
    this.disconnect()
    let profile = profileSchema.parse(input)
    this.update({ status: 'connecting', profile })
    const client = new Client()
    this.client = client
    let jump: ReturnType<typeof openProxyJump> | undefined
    try {
      let config: SSHConfigHost | undefined
      if (profile.sshConfig) {
        config = await resolveSSHConfig(profile.sshConfig.alias, profile.sshConfig.path)
        if (this.client !== client) throw new Error('SSH connection cancelled')
        if (config.unsupportedOptions.length)
          throw new Error(
            `This SSH config uses options Life cannot apply: ${config.unsupportedOptions.join(', ')}. Use another alias or switch this profile to manual settings.`,
          )
        profile = profileSchema.parse({
          ...profile,
          host: config.host,
          port: config.port,
          username: config.username,
        })
        input = { ...input, ...profile }
        this.update({ status: 'connecting', profile })
        if (input.auth !== 'password' && config.options.pubkeyauthentication?.[0] === 'no')
          throw new Error(
            'Public-key authentication is disabled by this SSH config. Choose password authentication.',
          )
        if (input.auth === 'password' && config.options.passwordauthentication?.[0] === 'no')
          throw new Error(
            'Password authentication is disabled by this SSH config. Choose a private key or agent.',
          )
        if (input.auth === 'agent' && config.identitiesOnly)
          throw new Error(
            'IdentitiesOnly is enabled. Choose SSH private key authentication to use the IdentityFile entries, or switch to manual settings.',
          )
      }
      const privateKeyPaths =
        input.auth === 'key'
          ? config
            ? config.availableIdentityFiles
            : [
                input.privateKeyPath.startsWith('~/')
                  ? join(homedir(), input.privateKeyPath.slice(2))
                  : input.privateKeyPath,
              ]
          : []
      if (input.auth === 'key' && !privateKeyPaths.length)
        throw new Error(
          'No configured SSH private key exists on this computer. Choose agent/password authentication or switch to manual settings.',
        )
      const privateKeys = await Promise.all(privateKeyPaths.map((path) => readFile(path)))
      const privateKey = privateKeys[0]
      if (this.client !== client) throw new Error('SSH connection cancelled')
      const configuredAgent = config?.options.identityagent?.[0]
      const defaultAgent =
        process.env.SSH_AUTH_SOCK ||
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
      const forwardAgent = config?.options.forwardagent?.[0] === 'yes'
      const agent =
        input.auth === 'agent' ||
        (config && input.auth === 'key' && !config.identitiesOnly) ||
        forwardAgent
          ? configuredAgent === 'none'
            ? undefined
            : (config?.identityAgent ?? defaultAgent)
          : undefined
      if (input.auth === 'agent' && !agent)
        throw new Error('No SSH agent found. Choose a private key or password instead.')
      if (forwardAgent && !agent)
        throw new Error(
          'ForwardAgent is enabled in SSH config, but no local SSH agent is available. Start the configured agent or disable ForwardAgent.',
        )
      const authHandler: AnyAuthMethod[] | undefined =
        config && input.auth === 'key'
          ? [
              { type: 'none', username: input.username },
              ...privateKeys.map((key): AnyAuthMethod => ({
                type: 'publickey',
                username: input.username,
                key,
                passphrase: input.passphrase,
              })),
              ...(agent && !config.identitiesOnly
                ? [{ type: 'agent' as const, username: input.username, agent }]
                : []),
            ]
          : undefined
      if (config?.proxyJump) {
        jump = this.jump = openProxyJump(profile.sshConfig!.path, config)
        // A failed spawn can report asynchronously before client.connect has attached listeners.
        this.jump.stream.on('error', (error) => this.emit('diagnostic', error.message))
      }
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve)
        client.on('error', reject)
        client.once('close', () => {
          reject(new Error('SSH connection closed'))
          if (this.client === client) {
            this.jump?.stream.destroy()
            this.jump = undefined
            this.client = undefined
            this.sftp = undefined
            this.terminal = undefined
            this.update({
              status: 'disconnected',
              profile: this.state.profile,
              error:
                this.state.status === 'connected'
                  ? 'The SSH connection closed. Reconnect to continue.'
                  : this.state.error,
            })
            this.emit('disconnected')
          }
        })
        client.connect({
          host: input.host,
          port: input.port,
          username: input.username,
          privateKey,
          passphrase: input.passphrase,
          password: input.auth === 'password' ? input.password : undefined,
          agent,
          authHandler,
          readyTimeout: 90000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          ...(config ? sshConfigTransportOptions(config) : {}),
          ...(this.jump ? { sock: this.jump.stream } : {}),
          agentForward: forwardAgent,
          hostVerifier: (key: Buffer, callback: VerifyCallback) => {
            if (this.client !== client) {
              callback(false)
              return
            }
            const fingerprint =
              'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
            const host = `${config?.options.hostkeyalias?.[0] || input.host}:${input.port}`
            const known = this.store.hostKey(host)
            if (known) {
              if (known !== fingerprint) {
                this.update({
                  status: 'connecting',
                  profile,
                  error:
                    'SSH host key changed. Verify the machine identity before removing its saved fingerprint from connections.json.',
                })
              }
              callback(known === fingerprint)
              return
            }
            const id = randomUUID()
            const timer = setTimeout(() => {
              this.pendingTrust.delete(id)
              callback(false)
            }, 60000)
            this.pendingTrust.set(id, (accepted) => {
              clearTimeout(timer)
              this.pendingTrust.delete(id)
              if (!accepted) {
                callback(false)
                return
              }
              void this.store.trust(host, fingerprint).then(
                () => callback(this.client === client),
                () => callback(false),
              )
            })
            this.emit('host-key', { id, host, fingerprint } satisfies HostKeyRequest)
          },
        })
      })
      if (this.client !== client) throw new Error('SSH connection cancelled')
      client.on('error', (error) => this.emit('diagnostic', error.message))
      const workspace = (await this.exec(`cd ${remotePath(input.workspace)} && pwd -P`)).trim()
      if (this.client !== client) throw new Error('SSH connection cancelled')
      if (!workspace.startsWith('/'))
        throw new Error('The remote workspace must resolve to an absolute POSIX path')
      const versions = await this.exec(
        'printf "CODEX="; if command -v codex >/dev/null 2>&1; then codex --version; else printf "missing\\n"; fi; printf "CLAUDE="; if command -v claude >/dev/null 2>&1; then claude --version; else printf "missing\\n"; fi',
      )
      if (this.client !== client) throw new Error('SSH connection cancelled')
      const version = (name: string) =>
        versions.match(new RegExp('^' + name + '=(.*)$', 'm'))?.[1]?.trim()
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
        client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))),
      )
      if (this.client !== client) {
        sftp.end()
        throw new Error('SSH connection cancelled')
      }
      this.sftp = sftp
      this.update({
        status: 'connected',
        profile,
        workspace,
        codex: version('CODEX'),
        claude: version('CLAUDE'),
      })
      return this.state
    } catch (error) {
      const proxyDiagnostic = jump?.diagnostic()
      const failureMessage = proxyDiagnostic
        ? `OpenSSH ProxyJump failed: ${proxyDiagnostic}. Jump hosts need key/agent authentication and must already be trusted in OpenSSH known_hosts.`
        : (error as Error).message || 'SSH connection cancelled'
      if (this.client !== client) throw new Error(failureMessage)
      const message = this.state.error || failureMessage
      this.disconnect()
      this.update({ status: 'disconnected', profile, error: message })
      throw new Error(message)
    }
  }
  trust(id: string, accepted: boolean) {
    const reply = this.pendingTrust.get(id)
    if (!reply) throw new Error('This host key request expired')
    reply(accepted)
  }
  disconnect() {
    for (const reply of this.pendingTrust.values()) reply(false)
    this.pendingTrust.clear()
    this.closeTerminal()
    this.sftp = undefined
    const client = this.client
    this.client = undefined
    this.update({ status: 'disconnected' })
    this.emit('disconnected')
    client?.end()
    this.jump?.stream.destroy()
    this.jump = undefined
  }
  channel(command: string, pty?: { cols: number; rows: number }): Promise<ClientChannel> {
    const client = this.client
    if (!client) return Promise.reject(new Error('Connect to a machine first'))
    return new Promise((resolve, reject) =>
      client.exec(
        remoteCommand(command),
        pty ? { pty: { term: 'xterm-256color', ...pty } } : {},
        (error, channel) => {
          if (error) {
            reject(error)
            return
          }
          if (this.client !== client) {
            channel.close()
            reject(new Error('SSH connection cancelled'))
            return
          }
          resolve(channel)
        },
      ),
    )
  }
  async exec(command: string): Promise<string> {
    const channel = await this.channel(command)
    return new Promise((resolve, reject) => {
      let output = ''
      let stderr = ''
      let settled = false
      let exitCode: number | undefined
      let outputBytes = 0
      const decoder = new StringDecoder('utf8')
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => {
        fail(new Error('Remote command timed out after 30 seconds'))
        channel.close()
      }, 30000)
      channel.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        output += decoder.write(chunk)
        if (outputBytes > 4_000_000) {
          fail(new Error('Remote output exceeds 4 MB'))
          channel.close()
        }
      })
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192)
      })
      channel.on('error', (error: Error) => fail(error))
      channel.on('exit', (code: number) => {
        exitCode = code
      })
      channel.on('close', () => {
        if (settled) return
        if (exitCode !== 0) {
          fail(
            new Error(
              stderr.trim() ||
                (exitCode == null
                  ? 'Remote command closed without an exit status'
                  : `Remote command exited with code ${exitCode}`),
            ),
          )
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(output + decoder.end())
      })
    })
  }
  private async safePath(path?: string) {
    const root = this.state.workspace
    const sftp = this.sftp
    if (!root || !sftp) throw new Error('Connect to a workspace first')
    const requested = path ? (posix.isAbsolute(path) ? path : posix.join(root, path)) : root
    if (requested.includes('\0')) throw new Error('Invalid path')
    const canonical = await new Promise<string>((resolve, reject) =>
      sftp.realpath(requested, (e, p) => (e ? reject(e) : resolve(p))),
    )
    if (this.sftp !== sftp) throw new Error('SSH connection cancelled')
    const relative = posix.relative(root, canonical)
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))
      throw new Error('This file is outside the workspace')
    return { canonical, sftp }
  }
  async list(path?: string): Promise<FileEntry[]> {
    const { canonical, sftp } = await this.safePath(path)
    const entries = await new Promise<import('ssh2').FileEntryWithStats[]>((resolve, reject) =>
      sftp.readdir(canonical, (e, files) => (e ? reject(e) : resolve(files))),
    )
    return entries
      .filter((f) => !['.', '..', '.git', 'node_modules'].includes(f.filename))
      .map((f) => ({
        name: f.filename,
        path: posix.join(canonical, f.filename),
        directory: f.attrs.isDirectory(),
        size: f.attrs.size,
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  }
  async read(path: string): Promise<string> {
    const { canonical, sftp } = await this.safePath(path)
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) =>
      sftp.stat(canonical, (e, s) => (e ? reject(e) : resolve(s))),
    )
    if (stat.size > 1_000_000) throw new Error('File preview supports files up to 1 MB')
    const buffer = await new Promise<Buffer>((resolve, reject) =>
      sftp.readFile(canonical, (e, data) => (e ? reject(e) : resolve(data))),
    )
    if (buffer.length > 1_000_000) throw new Error('File preview supports files up to 1 MB')
    if (buffer.includes(0)) throw new Error('Binary files cannot be previewed')
    return buffer.toString('utf8')
  }
  async git() {
    if (this.state.status !== 'connected' || !this.state.workspace)
      throw new Error('Connect to a workspace first')
    const prefix = `cd ${shellQuote(this.state.workspace || '')} && `
    try {
      const [branch, diff, status] = await Promise.all([
        this.exec(prefix + 'git symbolic-ref --short -q HEAD || git rev-parse --short HEAD'),
        this.exec(
          prefix +
            'git -c core.quotePath=false diff --no-ext-diff --no-color HEAD -- || git -c core.quotePath=false diff --no-ext-diff --no-color --',
        ),
        this.exec(prefix + 'git -c core.quotePath=false status --short'),
      ])
      return { branch: branch.trim(), diff, status }
    } catch (error) {
      if (/not a git repository/.test((error as Error).message))
        return { branch: 'No repository', diff: '', status: '' }
      throw error
    }
  }
  async openTerminal() {
    if (this.terminal) return
    if (this.terminalStarting) return this.terminalStarting
    if (this.state.status !== 'connected') throw new Error('Connect to a workspace first')
    const generation = this.terminalGeneration
    const starting = this.createTerminal(generation)
    this.terminalStarting = starting
    try {
      await starting
    } finally {
      if (this.terminalStarting === starting) this.terminalStarting = undefined
    }
  }
  private async createTerminal(generation: number) {
    const channel = await this.channel(
      `cd ${shellQuote(this.state.workspace || '')} && exec "$SHELL" -l`,
      { cols: 100, rows: 18 },
    )
    if (this.terminalGeneration !== generation) {
      channel.close()
      return
    }
    this.terminal = channel
    channel.on('data', (data: Buffer) => this.emit('terminal', data.toString()))
    channel.stderr.on('data', (data: Buffer) => this.emit('terminal', data.toString()))
    channel.on('error', (error: Error) => {
      if (this.terminal === channel) this.emit('terminal', `\r\n[${error.message}]\r\n`)
    })
    channel.on('close', () => {
      if (this.terminal === channel) {
        this.terminal = undefined
        this.emit('terminal', '\r\n[Terminal closed]\r\n')
      }
    })
  }
  writeTerminal(data: string) {
    this.terminal?.write(data)
  }
  resizeTerminal(cols: number, rows: number) {
    this.terminal?.setWindow(rows, cols, 0, 0)
  }
  closeTerminal() {
    this.terminalGeneration++
    this.terminalStarting = undefined
    const terminal = this.terminal
    this.terminal = undefined
    terminal?.close()
    if (terminal) this.emit('terminal', '\r\n[Terminal closed]\r\n')
  }
}
