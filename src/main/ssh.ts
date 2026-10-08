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
  RemoteDirectoryList,
  SSHConfigHost,
} from '../shared/types'
import { shellQuote, profileSchema, remoteDirectorySchema } from '../shared/validation'
import { Store } from './store'
import { openProxyJump, resolveSSHConfig, sshConfigTransportOptions } from './ssh-config'
import { PortForwarding } from './port-forwarding'

export function remoteCommand(command: string) {
  return `exec "$SHELL" -lc ${shellQuote('export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:$PATH"; ' + command)}`
}
export function remotePath(path: string) {
  if (path === '~') return '"$HOME"'
  return path.startsWith('~/') ? '"$HOME"/' + shellQuote(path.slice(2)) : shellQuote(path)
}
export class SSHConnection extends EventEmitter {
  state: ConnectionState = { status: 'disconnected' }
  readonly forwarding: PortForwarding
  private client?: Client
  private jump?: ReturnType<typeof openProxyJump>
  private sftp?: SFTPWrapper
  private pendingTrust = new Map<string, (accepted: boolean) => void>()
  private terminal?: ClientChannel
  private terminalStarting?: Promise<void>
  private terminalGeneration = 0
  private workspaceGeneration = 0
  private workspaceSelection?: symbol
  constructor(private store: Store) {
    super()
    this.forwarding = new PortForwarding(
      {
        exec: (command, signal) => this.exec(command, { signal, maxOutputBytes: 256_000 }),
        forwardOut: (remoteHost, remotePort, callback) => {
          const client = this.client
          if (!client || this.state.status !== 'connected') {
            callback(new Error('Connect to a machine first'))
            return
          }
          client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, channel) => {
            if (this.client !== client) {
              channel?.destroy()
              callback(new Error('SSH connection cancelled'))
              return
            }
            callback(error, channel)
          })
        },
      },
      (state) => this.emit('forwarding-state', state),
    )
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
            this.forwarding.stop()
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
      // Machine access is independent of any saved project. A moved or deleted
      // last-used folder must not prevent connecting and choosing another one.
      const home = (await this.exec('cd "$HOME" && pwd -P')).trim()
      if (this.client !== client) throw new Error('SSH connection cancelled')
      if (!home.startsWith('/'))
        throw new Error('The remote home must resolve to an absolute POSIX path')
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
      let lastWorkspace: string | undefined
      // Legacy threads were associated with the profile's last folder. Resolve
      // that reference for the renderer, but never open it or make it required
      // for machine access. A deleted folder remains an unresolved reference.
      let previousLookupTimedOut = false
      let previousLookupTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const previous =
          profile.workspace === '~'
            ? home
            : profile.workspace.startsWith('~/')
              ? posix.join(home, profile.workspace.slice(2))
              : posix.isAbsolute(profile.workspace)
                ? profile.workspace
                : posix.join(home, profile.workspace)
        const lookup = async () => {
          const canonical = await new Promise<string>((resolve, reject) =>
            sftp.realpath(previous, (error, resolved) =>
              error ? reject(error) : resolve(resolved),
            ),
          )
          if (previousLookupTimedOut) return undefined
          if (this.client !== client) throw new Error('SSH connection cancelled')
          const stat = await new Promise<import('ssh2').Stats>((resolve, reject) =>
            sftp.stat(canonical, (error, value) => (error ? reject(error) : resolve(value))),
          )
          return posix.isAbsolute(canonical) && stat.isDirectory() ? canonical : undefined
        }
        lastWorkspace = await Promise.race([
          lookup(),
          new Promise<undefined>((resolve) => {
            previousLookupTimer = setTimeout(() => {
              previousLookupTimedOut = true
              resolve(undefined)
            }, 1000)
          }),
        ])
      } catch {
        // The stored project is optional. The picker can choose any other folder.
      } finally {
        clearTimeout(previousLookupTimer)
      }
      if (this.client !== client) throw new Error('SSH connection cancelled')
      this.update({
        status: 'connected',
        profile,
        home,
        lastWorkspace,
        codex: version('CODEX'),
        claude: version('CLAUDE'),
      })
      this.forwarding.start(profile.port)
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
    this.forwarding.stop()
    this.workspaceGeneration++
    this.workspaceSelection = undefined
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
  private async remoteDirectory(path?: string) {
    const sftp = this.sftp
    const client = this.client
    const home = this.state.home
    if (this.state.status !== 'connected' || !sftp || !client || !home)
      throw new Error('Connect to a machine first')
    const input = path === undefined ? '~' : remoteDirectorySchema.parse(path)
    const requested =
      input === '~'
        ? home
        : input.startsWith('~/')
          ? posix.join(home, input.slice(2))
          : posix.isAbsolute(input)
            ? input
            : posix.join(home, input)
    const current = () => {
      if (this.client !== client || this.sftp !== sftp || this.state.status !== 'connected')
        throw new Error('SSH connection cancelled')
    }
    const canonical = await new Promise<string>((resolve, reject) =>
      sftp.realpath(requested, (error, resolved) => (error ? reject(error) : resolve(resolved))),
    )
    current()
    if (!posix.isAbsolute(canonical))
      throw new Error('The remote directory must resolve to an absolute POSIX path')
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) =>
      sftp.stat(canonical, (error, value) => (error ? reject(error) : resolve(value))),
    )
    current()
    if (!stat.isDirectory()) throw new Error('Choose an existing remote directory')
    return { canonical, sftp, current }
  }
  async listDirectories(path?: string): Promise<RemoteDirectoryList> {
    const { canonical, sftp, current } = await this.remoteDirectory(path)
    const files = await new Promise<import('ssh2').FileEntryWithStats[]>((resolve, reject) =>
      sftp.readdir(canonical, (error, entries) => (error ? reject(error) : resolve(entries))),
    )
    current()
    return {
      path: canonical,
      ...(canonical === '/' ? {} : { parent: posix.dirname(canonical) }),
      entries: files
        .filter((file) => !['.', '..'].includes(file.filename) && file.attrs.isDirectory())
        .map((file) => ({ name: file.filename, path: posix.join(canonical, file.filename) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  }
  async selectWorkspace(path: string): Promise<ConnectionState> {
    if (this.workspaceSelection) throw new Error('A project selection is already in progress')
    const selection = Symbol('workspace selection')
    this.workspaceSelection = selection
    try {
      const { canonical, sftp, current } = await this.remoteDirectory(path)
      // Ensure the folder can actually be browsed before replacing the current
      // project. Invalid selections leave its terminal and agent sessions intact.
      await new Promise<void>((resolve, reject) =>
        sftp.readdir(canonical, (error) => (error ? reject(error) : resolve())),
      )
      current()
      if (this.state.workspace === canonical) return this.state
      const profile = { ...this.state.profile!, workspace: canonical }
      await this.store.save(profile)
      current()
      this.workspaceGeneration++
      this.closeTerminal()
      this.emit('workspace-changing')
      this.update({ ...this.state, profile, workspace: canonical })
      return this.state
    } finally {
      if (this.workspaceSelection === selection) this.workspaceSelection = undefined
    }
  }
  channel(
    command: string,
    pty?: { cols: number; rows: number },
    signal?: AbortSignal,
  ): Promise<ClientChannel> {
    const client = this.client
    if (!client) return Promise.reject(new Error('Connect to a machine first'))
    if (signal?.aborted) return Promise.reject(new Error('Remote command cancelled'))
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new Error('Remote command cancelled'))
      signal?.addEventListener('abort', aborted, { once: true })
      client.exec(
        remoteCommand(command),
        pty ? { pty: { term: 'xterm-256color', ...pty } } : {},
        (error, channel) => {
          signal?.removeEventListener('abort', aborted)
          if (error) {
            reject(error)
            return
          }
          if (this.client !== client || signal?.aborted) {
            channel.close()
            reject(new Error('SSH connection cancelled'))
            return
          }
          resolve(channel)
        },
      )
    })
  }
  async exec(
    command: string,
    options: { signal?: AbortSignal; maxOutputBytes?: number } = {},
  ): Promise<string> {
    const channel = await this.channel(command, undefined, options.signal)
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
        options.signal?.removeEventListener('abort', aborted)
        reject(error)
      }
      const aborted = () => {
        fail(new Error('Remote command cancelled'))
        channel.close()
      }
      const timer = setTimeout(() => {
        fail(new Error('Remote command timed out after 30 seconds'))
        channel.close()
      }, 30000)
      options.signal?.addEventListener('abort', aborted, { once: true })
      if (options.signal?.aborted) aborted()
      channel.on('data', (chunk: Buffer) => {
        if (settled) return
        outputBytes += chunk.length
        output += decoder.write(chunk)
        if (outputBytes > (options.maxOutputBytes ?? 4_000_000)) {
          fail(
            new Error(
              options.maxOutputBytes
                ? 'Remote output exceeds the command output limit'
                : 'Remote output exceeds 4 MB',
            ),
          )
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
      channel.on('close', (code?: number | null) => {
        if (settled) return
        // ssh2 may parse a fast command's exit packet before the channel()
        // promise resumes. Its close event repeats the protocol's exit status.
        if (exitCode === undefined && typeof code === 'number') exitCode = code
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
        options.signal?.removeEventListener('abort', aborted)
        resolve(output + decoder.end())
      })
    })
  }
  private async safePath(path?: string) {
    const root = this.state.workspace
    const sftp = this.sftp
    const generation = this.workspaceGeneration
    if (!root || !sftp) throw new Error('Connect to a workspace first')
    const requested = path ? (posix.isAbsolute(path) ? path : posix.join(root, path)) : root
    if (requested.includes('\0')) throw new Error('Invalid path')
    const canonical = await new Promise<string>((resolve, reject) =>
      sftp.realpath(requested, (e, p) => (e ? reject(e) : resolve(p))),
    )
    const current = () => {
      if (this.sftp !== sftp) throw new Error('SSH connection cancelled')
      if (this.workspaceGeneration !== generation) throw new Error('The selected project changed')
    }
    current()
    const relative = posix.relative(root, canonical)
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))
      throw new Error('This file is outside the workspace')
    return { canonical, sftp, current }
  }
  async list(path?: string): Promise<FileEntry[]> {
    const { canonical, sftp, current } = await this.safePath(path)
    const entries = await new Promise<import('ssh2').FileEntryWithStats[]>((resolve, reject) =>
      sftp.readdir(canonical, (e, files) => (e ? reject(e) : resolve(files))),
    )
    current()
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
    const { canonical, sftp, current } = await this.safePath(path)
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) =>
      sftp.stat(canonical, (e, s) => (e ? reject(e) : resolve(s))),
    )
    current()
    if (stat.size > 1_000_000) throw new Error('File preview supports files up to 1 MB')
    const buffer = await new Promise<Buffer>((resolve, reject) =>
      sftp.readFile(canonical, (e, data) => (e ? reject(e) : resolve(data))),
    )
    current()
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
    if (this.state.status !== 'connected' || !this.state.workspace)
      throw new Error('Select a project first')
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
