import {
  Client,
  type AnyAuthMethod,
  type ClientChannel,
  type SFTPWrapper,
  type VerifyCallback,
} from 'ssh2'
import { readFile } from 'node:fs/promises'
import { realpath as localRealpath } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { posix, join } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import { Clock, Deferred, Effect, Schema } from 'effect'
import type {
  ConnectInput,
  ConnectionProfile,
  ConnectionState,
  FileEntry,
  HostKeyRequest,
  RemoteDirectoryList,
  Provider,
  SSHConfigHost,
} from '../shared/types'
import { shellQuote, profileSchema, remoteDirectorySchema } from '../shared/validation'
import { Store } from './store'
import { openProxyJump, resolveSSHConfig, sshConfigTransportOptions } from './ssh-config'
import { PortForwarding } from './port-forwarding'
import { DurableRemoteChannel, type DurableChannelHost } from './durable-remote-channel'
import { runEffect } from './effect-runtime'
import { LocalClient, localShell, type LocalTransportOptions } from './local-transport'
import type { LocalFiles } from './local-files'
import { buildRemoteAgentBrokerCommand, type RemoteAgentBrokerConfig } from './remote-agent-broker'
import { connectionMachineIdentity } from '../shared/connection-identity'
import type { NativeRecoveryStoreHandle } from './native-recovery-store'
import { NativeRecoveryError, type NativeRecoverySnapshot } from './native-recovery-types'
import {
  validateNativeRecoveryPlatformPolicyEffect,
  type NativeRecoveryPlatformPolicy,
} from './native-recovery-platform'

export interface SSHExecOptions {
  signal?: AbortSignal
  maxOutputBytes?: number
  timeoutMs?: number
  input?: string
  rendererOwned?: boolean
}

export class SSHCommandError extends Schema.TaggedError<SSHCommandError>()('SSHCommandError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class SSHRequestError extends Schema.TaggedError<SSHRequestError>()('SSHRequestError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export function remoteCommand(command: string) {
  return `exec "$SHELL" -lc ${shellQuote('export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:$PATH"; ' + command)}`
}
export function remotePath(path: string) {
  if (path === '~') return '"$HOME"'
  return path.startsWith('~/') ? '"$HOME"/' + shellQuote(path.slice(2)) : shellQuote(path)
}
const PROVIDER_VERSION_COMMAND =
  'if command -v codex >/dev/null 2>&1; then if life_codex_version=$(codex --version 2>/dev/null); then printf "CODEX=%s\\n" "$life_codex_version"; else printf "CODEX=unknown\\n"; fi; else printf "CODEX=missing\\n"; fi; if command -v claude >/dev/null 2>&1; then if life_claude_version=$(claude --version 2>/dev/null); then printf "CLAUDE=%s\\n" "$life_claude_version"; else printf "CLAUDE=unknown\\n"; fi; else printf "CLAUDE=missing\\n"; fi'

function providerVersions(output: string): Pick<ConnectionState, 'codex' | 'claude'> {
  const version = (name: string) =>
    output.match(new RegExp('^' + name + '=(.*)$', 'm'))?.[1]?.trim()
  return { codex: version('CODEX'), claude: version('CLAUDE') }
}

function localExecutionOptions(options: LocalTransportOptions = {}): LocalTransportOptions {
  const shell = localShell(options)
  return { ...options, shell, env: { ...(options.env ?? process.env), SHELL: shell } }
}

/** Own original Local execution separately from the environment selected in SSHConnection. */
class LocalDurableHost extends EventEmitter implements DurableChannelHost {
  readonly client: LocalClient
  readonly closed: Promise<void>
  state: ConnectionState
  private closing = false
  private readonly runtime: { executable: string; inheritedRunAsNode?: string }

  constructor(
    state: ConnectionState,
    private readonly options: LocalTransportOptions,
  ) {
    super()
    this.state = { ...state, profile: { ...state.profile! } }
    this.runtime = {
      executable: process.execPath,
      inheritedRunAsNode: options.env?.ELECTRON_RUN_AS_NODE,
    }
    this.client = new LocalClient(options)
    this.closed = new Promise((resolve) => {
      this.client.once('close', () => {
        this.state = { ...this.state, status: 'disconnected' }
        this.emit('state', this.state)
        this.emit('disconnected')
        resolve()
      })
    })
  }

  channel(
    command: string,
    pty?: { cols: number; rows: number },
    signal?: AbortSignal,
    timeoutMs = 30000,
  ): Promise<ClientChannel> {
    return runEffect(
      Effect.callback<ClientChannel, SSHRequestError>((resume) => {
        let settled = false
        const cleanup = () => signal?.removeEventListener('abort', aborted)
        const fail = (cause: Error) => {
          if (settled) return
          settled = true
          cleanup()
          resume(
            Effect.fail(
              new SSHRequestError({
                operation: 'Opening the original Local agent attachment',
                message: cause.message,
                cause,
              }),
            ),
          )
        }
        const aborted = () => fail(new Error('The original Local attachment was cancelled'))
        signal?.addEventListener('abort', aborted, { once: true })
        if (this.closing || signal?.aborted) aborted()
        else
          this.client.exec(
            remoteCommand(command),
            pty ? { pty: { term: 'xterm-256color', ...pty } } : {},
            (error, channel) => {
              if (settled || this.closing || error || !channel) {
                channel?.close()
                fail(error ?? new Error('The original Local environment is unavailable'))
                return
              }
              settled = true
              cleanup()
              resume(Effect.succeed(channel))
            },
          )
        return Effect.sync(() => {
          settled = true
          cleanup()
        })
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new SSHRequestError({
                operation: 'Opening the original Local agent attachment',
                message: 'The original Local agent attachment timed out',
                cause: undefined,
              }),
            ),
        }),
      ),
    )
  }

  agentBrokerRoot(id: string): string | undefined {
    return this.options.brokerDirectory ? posix.join(this.options.brokerDirectory, id) : undefined
  }

  agentBrokerCommand(config: RemoteAgentBrokerConfig): string {
    return buildRemoteAgentBrokerCommand(config, this.runtime)
  }

  end(): Promise<void> {
    if (!this.closing) {
      this.closing = true
      this.client.end()
    }
    return this.closed
  }
}

export class SSHConnection extends EventEmitter {
  state: ConnectionState = { status: 'disconnected' }
  readonly forwarding: PortForwarding
  private client?: Client | LocalClient
  private localStarting?: {
    client: LocalClient
    profileId: string
    promise: Promise<ConnectionState>
  }
  private readonly localClientsClosing = new Map<LocalClient, Promise<void>>()
  private readonly localClientOptions = new WeakMap<LocalClient, LocalTransportOptions>()
  private readonly nativeChannelExit = new WeakMap<
    ClientChannel,
    { exit: Deferred.Deferred<boolean>; release?: Deferred.Deferred<boolean> }
  >()
  private readonly localDurableHosts = new Map<
    LocalClient,
    { host: LocalDurableHost; references: number }
  >()
  private jump?: ReturnType<typeof openProxyJump>
  private sftp?: SFTPWrapper | LocalFiles
  private pendingTrust = new Map<string, (accepted: boolean) => void>()
  private terminal?: ClientChannel
  private terminalStarting?: Promise<void>
  private terminalGeneration = 0
  private workspaceGeneration = 0
  private workspaceSelection?: AbortController
  private rendererGeneration = 0
  private connectionGeneration = 0
  private providerVersionGeneration = 0
  private providerVersionsStarting?: {
    client: Client | LocalClient
    promise: Promise<ConnectionState>
  }
  private reconnect?: {
    input: ConnectInput
    workspace?: string
    attempts: number
    timer?: NodeJS.Timeout
  }
  private pendingRemoteRequests = new Map<
    (error: Error) => void,
    { project: boolean; renderer: boolean }
  >()
  constructor(
    private store: Store,
    private options: { local?: LocalTransportOptions } = {},
    readonly nativeRecovery?: NativeRecoveryStoreHandle,
    private readonly nativeRecoveryPolicy?: NativeRecoveryPlatformPolicy,
  ) {
    super()
    this.forwarding = new PortForwarding(
      {
        exec: (command, signal) =>
          this.exec(command, { signal, maxOutputBytes: 256_000, rendererOwned: false }),
        forwardOut: (remoteHost, remotePort, callback) => {
          const client = this.client
          if (!client || this.state.status !== 'connected') {
            callback(new Error('Connect to a machine first'))
            return
          }
          if (client instanceof LocalClient) {
            callback(new Error('Local services are already available on this computer'))
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
  private remoteRequest<T>(
    operation: string,
    start: (done: (error: Error | null | undefined, value?: T) => void) => void,
    options: {
      timeoutMs?: number
      signal?: AbortSignal
      project?: boolean
      rendererOwned?: boolean
      discard?: (value: T) => void
      cancel?: () => void
    } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 30000
    return runEffect(
      Effect.callback<T, SSHRequestError>((resume) => {
        let settled = false
        const cleanup = () => {
          options.signal?.removeEventListener('abort', aborted)
          this.pendingRemoteRequests.delete(cancel)
        }
        const release = () => {
          if (settled) return
          settled = true
          cleanup()
          try {
            options.cancel?.()
          } catch {
            // Resource cleanup cannot prevent cancellation from settling.
          }
        }
        const cancel = (error: Error) => {
          if (settled) return
          release()
          resume(
            Effect.fail(new SSHRequestError({ operation, message: error.message, cause: error })),
          )
        }
        const aborted = () => cancel(new Error('Remote command cancelled'))
        this.pendingRemoteRequests.set(cancel, {
          project: options.project === true,
          renderer: options.rendererOwned === true || options.project === true,
        })
        options.signal?.addEventListener('abort', aborted, { once: true })
        if (options.signal?.aborted) {
          aborted()
          return Effect.sync(release)
        }
        try {
          start((error, value) => {
            // A server may answer after timeout, disconnect, or cancellation. Close
            // newly acquired resources rather than adopting them into a later session.
            if (settled || error) {
              if (value !== undefined) {
                try {
                  options.discard?.(value)
                } catch {
                  // A late resource may already have been closed by SSH teardown.
                }
              }
              if (error) cancel(error)
              return
            }
            settled = true
            cleanup()
            resume(Effect.succeed(value as T))
          })
        } catch (error) {
          cancel(error instanceof Error ? error : new Error(String(error)))
        }
        return Effect.sync(release)
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new SSHRequestError({
                operation,
                message: `${operation} timed out after ${timeoutMs / 1000} seconds`,
                cause: undefined,
              }),
            ),
        }),
      ),
    )
  }
  private cancelRemoteRequests(error: Error, scope?: 'project' | 'renderer') {
    for (const [cancel, owner] of this.pendingRemoteRequests)
      if (!scope || owner[scope]) cancel(error)
  }
  async cancelRendererRequests(): Promise<void> {
    this.rendererGeneration++
    this.cancelRemoteRequests(
      new Error('The Life interface changed. Retry this operation.'),
      'renderer',
    )
    this.workspaceSelection?.abort()
    this.workspaceSelection = undefined
    this.closeTerminal()
    await this.store.settled()
  }
  validateConnectInput(input: ConnectInput): ConnectionProfile {
    let profile = profileSchema.parse(input)
    if (profile.id === this.store.localProfile().id && profile.transport !== 'local')
      throw new Error('The built-in Local environment cannot use SSH transport')
    if (profile.transport === 'local') {
      const canonical = this.store.localProfile()
      for (const field of [
        'id',
        'name',
        'host',
        'port',
        'username',
        'auth',
        'privateKeyPath',
        'transport',
      ] as const) {
        if (profile[field] !== canonical[field])
          throw new Error('Use the built-in Local environment from this Life installation')
      }
      if (profile.sshConfig) throw new Error('The Local environment does not use SSH configuration')
      profile = canonical
    }
    return profile
  }
  /** Version discovery and workspace updates cannot transfer a connection's ownership. */
  captureEnvironmentOwnership(): () => boolean {
    const client = this.client
    const connectionGeneration = this.connectionGeneration
    const rendererGeneration = this.rendererGeneration
    const status = this.state.status
    const machine = this.state.profile && connectionMachineIdentity(this.state.profile)
    return () =>
      this.client === client &&
      this.connectionGeneration === connectionGeneration &&
      this.rendererGeneration === rendererGeneration &&
      this.state.status === status &&
      (this.state.profile && connectionMachineIdentity(this.state.profile)) === machine
  }
  async connect(input: ConnectInput, resume = false): Promise<ConnectionState> {
    const profile = this.validateConnectInput(input)
    if (this.state.status === 'connecting') {
      const starting = this.localStarting
      // Native startup and history restoration can both request the same Local
      // environment. Join only its owned, validated acquisition; the saved
      // thread selects its own project after that acquisition completes.
      if (
        profile.transport === 'local' &&
        starting?.profileId === profile.id &&
        this.client === starting.client &&
        this.state.profile?.id === profile.id &&
        this.state.profile.transport === 'local'
      )
        return starting.promise
      throw new Error('A connection is already in progress')
    }
    const local =
      profile.transport === 'local' ? localExecutionOptions(this.options.local) : undefined
    const client = local ? new LocalClient(local) : new Client()
    if (client instanceof LocalClient) this.localClientOptions.set(client, local!)
    const resumeWorkspace = resume ? this.reconnect?.workspace : undefined
    this.disconnect(resume)
    this.client = client
    const promise = Promise.resolve().then(() =>
      this.connectClient(input, profile, client, resumeWorkspace, resume),
    )
    if (client instanceof LocalClient) {
      const starting = { client, profileId: profile.id, promise }
      this.localStarting = starting
      void promise
        .finally(() => {
          if (this.localStarting === starting) this.localStarting = undefined
        })
        .catch(() => {})
    }
    this.update({ status: 'connecting', profile })
    return promise
  }
  private async connectClient(
    input: ConnectInput,
    profile: ConnectionProfile,
    client: Client | LocalClient,
    resumeWorkspace: string | undefined,
    resume: boolean,
  ): Promise<ConnectionState> {
    let jump: ReturnType<typeof openProxyJump> | undefined
    try {
      if (this.client !== client) throw new Error('SSH connection cancelled')
      if (!(client instanceof LocalClient)) {
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
        await this.remoteRequest<void>(
          'Connecting to the SSH machine',
          (done) => {
            client.once('ready', () => done(null))
            client.on('error', (error) => done(error))
            client.once('close', () => {
              done(new Error('SSH connection closed'))
              if (this.client === client) {
                const previous = this.state
                this.forwarding.stop()
                this.cancelRemoteRequests(new Error('SSH connection closed'))
                this.workspaceGeneration++
                this.workspaceSelection = undefined
                this.closeTerminal()
                this.jump?.stream.destroy()
                this.jump = undefined
                this.client = undefined
                this.sftp = undefined
                this.terminal = undefined
                this.update({
                  ...previous,
                  status: 'disconnected',
                  profile: previous.profile,
                  error:
                    previous.status === 'connected'
                      ? 'The SSH connection closed. Life is reconnecting; remote agents keep running.'
                      : previous.error,
                })
                this.emit('disconnected')
                if (previous.status === 'connected') {
                  // Credentials remain in this process only. Saved connection
                  // profiles and logs never receive passwords or passphrases.
                  this.reconnect = {
                    input: { ...input },
                    workspace: previous.workspace,
                    attempts: 0,
                  }
                  this.scheduleReconnect()
                }
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
          },
          { timeoutMs: 90000 },
        )
        if (this.client !== client) throw new Error('SSH connection cancelled')
        client.on('error', (error) => this.emit('diagnostic', error.message))
      }
      // Machine access is independent of any saved project. A moved or deleted
      // last-used folder must not prevent connecting and choosing another one.
      const home =
        client instanceof LocalClient
          ? await this.remoteRequest<string>(
              'Resolving the local home directory',
              (done) =>
                localRealpath(this.localClientOptions.get(client)?.env?.HOME ?? homedir(), done),
              { rendererOwned: false, timeoutMs: 5000 },
            )
          : (await this.exec('cd "$HOME" && pwd -P', { rendererOwned: false })).trim()
      if (this.client !== client) throw new Error('SSH connection cancelled')
      if (!home.startsWith('/'))
        throw new Error('The remote home must resolve to an absolute POSIX path')
      let versions: Pick<ConnectionState, 'codex' | 'claude'> = {}
      if (!(client instanceof LocalClient)) {
        versions = { codex: 'unknown', claude: 'unknown' }
        try {
          versions = providerVersions(
            await this.exec(PROVIDER_VERSION_COMMAND, {
              rendererOwned: false,
              timeoutMs: 5000,
              maxOutputBytes: 16000,
            }),
          )
        } catch (error) {
          if (this.client !== client) throw error
          // CLI wrappers can stall or print excessive startup output. Discovery
          // is optional: retain machine access so the terminal can repair them.
          this.emit('diagnostic', `Provider version discovery failed: ${(error as Error).message}`)
        }
      }
      if (this.client !== client) throw new Error('SSH connection cancelled')
      const sftp = await this.remoteRequest<SFTPWrapper | LocalFiles>(
        'Opening remote file access',
        (done) => client.sftp(done),
        { discard: (value) => value.end() },
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
      const previousLookup = new AbortController()
      const previousLookupTimer = setTimeout(() => previousLookup.abort(), 1000)
      try {
        const previous =
          profile.workspace === '~'
            ? home
            : profile.workspace.startsWith('~/')
              ? posix.join(home, profile.workspace.slice(2))
              : posix.isAbsolute(profile.workspace)
                ? profile.workspace
                : posix.join(home, profile.workspace)
        const canonical = await this.remoteRequest<string>(
          'Resolving the previous project',
          (done) => sftp.realpath(previous, done),
          { signal: previousLookup.signal },
        )
        if (this.client !== client) throw new Error('SSH connection cancelled')
        const stat = await this.remoteRequest<import('ssh2').Stats>(
          'Checking the previous project',
          (done) => sftp.stat(canonical, done),
          { signal: previousLookup.signal },
        )
        lastWorkspace = posix.isAbsolute(canonical) && stat.isDirectory() ? canonical : undefined
      } catch {
        // The stored project is optional. The picker can choose any other folder.
      } finally {
        clearTimeout(previousLookupTimer)
      }
      let workspace: string | undefined
      const desiredWorkspace =
        resumeWorkspace || (profile.transport === 'local' ? profile.workspace : undefined)
      if (desiredWorkspace) {
        const restoration = new AbortController()
        const restorationDeadline = setTimeout(() => restoration.abort(), 5000)
        try {
          // Automatic recovery restores the retained context before publishing
          // connected. Publishing an intermediate no-project state would make
          // the renderer open its picker or start a competing restoration.
          const canonical = await this.remoteRequest<string>(
            'Restoring the active project',
            (done) => sftp.realpath(desiredWorkspace, done),
            { signal: restoration.signal },
          )
          if (this.client !== client) throw new Error('SSH connection cancelled')
          if (!posix.isAbsolute(canonical))
            throw new Error('The active project did not resolve to an absolute POSIX path')
          const stat = await this.remoteRequest<import('ssh2').Stats>(
            'Checking the restored project',
            (done) => sftp.stat(canonical, done),
            { signal: restoration.signal },
          )
          if (this.client !== client) throw new Error('SSH connection cancelled')
          if (!stat.isDirectory()) throw new Error('The active project is no longer a directory')
          await this.remoteRequest<import('ssh2').FileEntryWithStats[]>(
            'Opening the restored project',
            (done) => sftp.readdir(canonical, done),
            { signal: restoration.signal },
          )
          if (this.client !== client) throw new Error('SSH connection cancelled')
          workspace = canonical
        } catch (error) {
          if (this.client !== client) throw error
          // A moved, removed, or unreadable project cannot prevent reconnecting
          // to the machine or to providers that still own their remote cwd.
          this.emit('diagnostic', (error as Error).message)
        } finally {
          clearTimeout(restorationDeadline)
        }
      }
      if (this.client !== client) throw new Error('SSH connection cancelled')
      if (client instanceof LocalClient)
        void this.startProviderVersionDiscovery(client).catch(() => {})
      this.update({
        status: 'connected',
        profile,
        home,
        lastWorkspace,
        ...(workspace ? { workspace } : {}),
        ...versions,
        ...(client instanceof LocalClient ? { providerVersionsStatus: 'checking' as const } : {}),
        providerVersionsRevision: ++this.providerVersionGeneration,
      })
      if (!(client instanceof LocalClient)) this.forwarding.start(profile.port)
      return this.state
    } catch (error) {
      const proxyDiagnostic = jump?.diagnostic()
      const failureMessage = proxyDiagnostic
        ? `OpenSSH ProxyJump failed: ${proxyDiagnostic}. Jump hosts need key/agent authentication and must already be trusted in OpenSSH known_hosts.`
        : (error as Error).message || 'SSH connection cancelled'
      if (this.client !== client) throw new Error(failureMessage)
      const message = this.state.error || failureMessage
      this.disconnect(resume)
      this.update({ status: 'disconnected', profile, error: message })
      throw new Error(message)
    }
  }
  /** Refreshes read-only CLI discovery on the machine, independent of project selection. */
  async refreshProviderVersions(): Promise<ConnectionState> {
    const client = this.client
    if (!client || this.state.status !== 'connected') throw new Error('Connect to a machine first')
    if (this.providerVersionsStarting?.client === client)
      return this.providerVersionsStarting.promise
    return this.startProviderVersionDiscovery(client)
  }
  private startProviderVersionDiscovery(client: Client | LocalClient): Promise<ConnectionState> {
    const promise = Promise.resolve().then(() => this.discoverProviderVersions(client))
    const starting = { client, promise }
    this.providerVersionsStarting = starting
    void promise
      .finally(() => {
        if (this.providerVersionsStarting === starting) this.providerVersionsStarting = undefined
      })
      .catch(() => {})
    return promise
  }
  async whenProviderVersionsReady(): Promise<ConnectionState> {
    const client = this.client
    if (!client || this.state.status !== 'connected') throw new Error('Connect to a machine first')
    if (client instanceof LocalClient && this.providerVersionsStarting?.client === client)
      return this.providerVersionsStarting.promise
    return this.state
  }
  private async discoverProviderVersions(client: Client | LocalClient): Promise<ConnectionState> {
    if (this.client !== client || this.state.status !== 'connected')
      throw new Error('The connected machine changed while checking provider versions')
    const generation = ++this.providerVersionGeneration
    if (client instanceof LocalClient)
      this.update({ ...this.state, providerVersionsStatus: 'checking' })
    let versions: Pick<ConnectionState, 'codex' | 'claude'>
    try {
      versions = providerVersions(
        await this.exec(PROVIDER_VERSION_COMMAND, {
          rendererOwned: false,
          timeoutMs: client instanceof LocalClient ? 5000 : 10000,
          maxOutputBytes: 16000,
        }),
      )
    } catch (error) {
      if (
        client instanceof LocalClient &&
        this.client === client &&
        this.state.status === 'connected' &&
        generation === this.providerVersionGeneration
      ) {
        this.emit('diagnostic', `Provider version discovery failed: ${(error as Error).message}`)
        this.update({
          ...this.state,
          codex: 'unknown',
          claude: 'unknown',
          providerVersionsStatus: 'failed',
        })
        return this.state
      }
      throw error
    }
    if (
      this.client !== client ||
      this.state.status !== 'connected' ||
      generation !== this.providerVersionGeneration
    ) {
      throw new Error('The connected machine changed while checking provider versions')
    }
    this.update({
      ...this.state,
      ...versions,
      providerVersionsRevision: generation,
      ...(client instanceof LocalClient ? { providerVersionsStatus: 'ready' as const } : {}),
    })
    return this.state
  }
  private scheduleReconnect() {
    const reconnect = this.reconnect
    if (!reconnect || reconnect.timer) return
    const delay = Math.min(15000, 1000 * 2 ** Math.min(reconnect.attempts++, 4))
    reconnect.timer = setTimeout(() => {
      reconnect.timer = undefined
      if (this.reconnect !== reconnect) return
      void this.connect(reconnect.input, true).then(
        () => {
          if (this.reconnect !== reconnect) return
          reconnect.attempts = 0
        },
        () => {
          if (this.reconnect === reconnect) this.scheduleReconnect()
        },
      )
    }, delay)
    reconnect.timer.unref()
  }
  trust(id: string, accepted: boolean) {
    const reply = this.pendingTrust.get(id)
    if (!reply) throw new Error('This host key request expired')
    reply(accepted)
  }
  disconnect(preserveReconnect = false) {
    this.connectionGeneration++
    if (!preserveReconnect) {
      if (this.reconnect?.timer) clearTimeout(this.reconnect.timer)
      this.reconnect = undefined
    }
    this.forwarding.stop()
    this.localStarting = undefined
    this.providerVersionsStarting = undefined
    this.cancelRemoteRequests(new Error('SSH connection cancelled'))
    this.workspaceGeneration++
    this.workspaceSelection = undefined
    for (const reply of this.pendingTrust.values()) reply(false)
    this.pendingTrust.clear()
    this.closeTerminal()
    this.sftp = undefined
    const client = this.client
    this.client = undefined
    if (client instanceof LocalClient) {
      this.localClientsClosing.set(
        client,
        new Promise<void>((resolve) => {
          client.once('close', () => {
            this.localClientsClosing.delete(client)
            resolve()
          })
        }),
      )
    }
    this.update({ status: 'disconnected' })
    this.emit('disconnected')
    client?.end()
    this.jump?.stream.destroy()
    this.jump = undefined
  }
  readonly disconnectAndWaitEffect = Effect.fn('SSHConnection.disconnectAndWait')(function* (
    this: SSHConnection,
  ) {
    this.disconnect()
    yield* Effect.promise(async () => {
      await Promise.all(this.localClientsClosing.values())
    }).pipe(
      Effect.timeoutOrElse({
        duration: 5000,
        orElse: () =>
          Effect.fail(
            new SSHRequestError({
              operation: 'Closing the Local environment',
              message: 'Local process cleanup did not finish within 5 seconds',
              cause: undefined,
            }),
          ),
      }),
    )
  })
  disconnectAndWait(): Promise<void> {
    return runEffect(this.disconnectAndWaitEffect())
  }
  private async remoteDirectory(path?: string, signal?: AbortSignal) {
    const sftp = this.sftp
    const client = this.client
    const home = this.state.home
    const rendererGeneration = this.rendererGeneration
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
      if (rendererGeneration !== this.rendererGeneration || signal?.aborted)
        throw new Error('The Life interface changed. Retry this operation.')
    }
    const canonical = await this.remoteRequest<string>(
      'Resolving the remote directory',
      (done) => sftp.realpath(requested, done),
      { rendererOwned: true, signal },
    )
    current()
    if (!posix.isAbsolute(canonical))
      throw new Error('The remote directory must resolve to an absolute POSIX path')
    const stat = await this.remoteRequest<import('ssh2').Stats>(
      'Checking the remote directory',
      (done) => sftp.stat(canonical, done),
      { rendererOwned: true, signal },
    )
    current()
    if (!stat.isDirectory()) throw new Error('Choose an existing remote directory')
    return { canonical, sftp, current }
  }
  async listDirectories(path?: string): Promise<RemoteDirectoryList> {
    const { canonical, sftp, current } = await this.remoteDirectory(path)
    current()
    const files = await this.remoteRequest<import('ssh2').FileEntryWithStats[]>(
      'Listing remote directories',
      (done) => sftp.readdir(canonical, done),
      { rendererOwned: true },
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
    const selection = new AbortController()
    this.workspaceSelection = selection
    try {
      const { canonical, sftp, current } = await this.remoteDirectory(path, selection.signal)
      current()
      // Ensure the folder can actually be browsed before replacing the current
      // project. Invalid selections leave its terminal and agent sessions intact.
      await this.remoteRequest<import('ssh2').FileEntryWithStats[]>(
        'Opening the selected project',
        (done) => sftp.readdir(canonical, done),
        { rendererOwned: true, signal: selection.signal },
      )
      current()
      if (this.state.workspace === canonical) return this.state
      const profile = { ...this.state.profile!, workspace: canonical }
      const ownsSelection = () => {
        try {
          current()
          return this.workspaceSelection === selection
        } catch {
          return false
        }
      }
      await this.remoteRequest<void>(
        'Saving the selected project',
        (done) => {
          void this.store
            .saveIfCurrent(profile, ownsSelection, () => {
              // The final ownership check and publication are synchronous with the
              // durable profile commit, so a replacement renderer cannot see half a selection.
              current()
              this.workspaceGeneration++
              this.cancelRemoteRequests(new Error('The selected project changed'), 'project')
              this.closeTerminal()
              this.emit('workspace-changing')
              this.update({ ...this.state, profile, workspace: canonical })
            })
            .then(
              (saved) =>
                done(saved ? null : new Error('The Life interface changed. Retry this operation.')),
              (error) => done(error),
            )
        },
        { rendererOwned: true, signal: selection.signal, cancel: () => selection.abort() },
      )
      current()
      return this.state
    } finally {
      if (this.workspaceSelection === selection) this.workspaceSelection = undefined
    }
  }
  channel(
    command: string,
    pty?: { cols: number; rows: number },
    signal?: AbortSignal,
    timeoutMs = 30000,
    rendererOwned = true,
  ): Promise<ClientChannel> {
    const client = this.client
    if (!client) return Promise.reject(new Error('Connect to a machine first'))
    if (signal?.aborted) return Promise.reject(new Error('Remote command cancelled'))
    return this.remoteRequest<ClientChannel>(
      'Opening the remote command',
      (done) =>
        client.exec(
          remoteCommand(command),
          pty ? { pty: { term: 'xterm-256color', ...pty } } : {},
          (error, channel) => {
            if (error || !channel) {
              done(
                error ?? new Error('The remote command did not acknowledge its channel'),
                channel,
              )
              return
            }
            if (this.client !== client || signal?.aborted) {
              done(new Error('SSH connection cancelled'), channel)
              return
            }
            const exit = Deferred.makeUnsafe<boolean>()
            this.nativeChannelExit.set(channel, { exit })
            // Observe inside the exec acknowledgement: ssh2 can deliver the
            // native exit before the acquisition Promise hands off the channel.
            channel.once('exit', () => Deferred.doneUnsafe(exit, Effect.succeed(true)))
            channel.once('close', () => Deferred.doneUnsafe(exit, Effect.succeed(false)))
            done(null, channel)
          },
        ),
      { signal, timeoutMs, rendererOwned, discard: (channel) => channel.close() },
    )
  }
  async durableChannel(
    command: string,
    onOpening?: (channel: ClientChannel) => void,
    provider: Provider = 'codex',
  ): Promise<ClientChannel> {
    const ownsEnvironment = this.captureEnvironmentOwnership()
    const transport = this.state.profile?.transport === 'local' ? 'local' : 'ssh'
    if (this.nativeRecoveryPolicy) {
      await runEffect(validateNativeRecoveryPlatformPolicyEffect(this.nativeRecoveryPolicy))
      await runEffect(this.nativeRecoveryPolicy.assertFreshSshStartEffect(transport))
      if (!ownsEnvironment())
        throw new Error('The native provider environment changed before launch')
      if (this.nativeRecoveryPolicy.mode === 'unsupported-clean') {
        const channel = await this.channel(command, undefined, undefined, 30000, false)
        try {
          this.attachNativeExitRelease(channel)
          onOpening?.(channel)
        } catch (cause) {
          channel.close()
          throw cause
        }
        return channel
      }
      if (!this.nativeRecovery)
        throw new NativeRecoveryError({
          operation: 'launch',
          path: 'ssh',
          reason: 'ownership',
          message: 'Native recovery has no owned durable registry; no provider was launched.',
        })
    }
    return this.openDurableChannel(command, provider, onOpening)
  }
  private attachNativeExitRelease(channel: ClientChannel): void {
    const observation = this.nativeChannelExit.get(channel)
    if (!observation)
      throw new NativeRecoveryError({
        operation: 'observe-attached-exit',
        path: 'ssh',
        reason: 'uncertain',
        message: 'The attached provider has no owned native exit observation.',
      })
    const closeAndWaitEffect = Effect.fn('SSHConnection.closeAttachedNativeAndWait')(function* (
      timeoutMs = 8000,
    ) {
      if (observation.release) return yield* Deferred.await(observation.release)
      const released = Deferred.makeUnsafe<boolean>()
      observation.release = released
      if (!(yield* Deferred.isDone(observation.exit))) {
        yield* Effect.sync(() => {
          try {
            channel.signal('TERM')
          } catch {
            Deferred.doneUnsafe(observation.exit, Effect.succeed(false))
          }
        })
      }
      const confirmed = yield* Deferred.await(observation.exit).pipe(
        Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(false) }),
      )
      yield* Effect.sync(() => {
        try {
          channel.close()
        } catch {
          // The attachment may already have closed after the native exit.
        }
      })
      yield* Deferred.succeed(released, confirmed)
      return confirmed
    }, Effect.uninterruptible)
    Object.assign(channel, { closeAndWaitEffect })
  }
  async restoreDurableChannel(
    snapshot: NativeRecoverySnapshot,
    onOpening?: (channel: ClientChannel) => void,
  ): Promise<ClientChannel> {
    const ownsEnvironment = this.captureEnvironmentOwnership()
    if (this.nativeRecoveryPolicy) {
      await runEffect(validateNativeRecoveryPlatformPolicyEffect(this.nativeRecoveryPolicy))
      await runEffect(this.nativeRecoveryPolicy.assertNativeRecoveryEffect('restore'))
    }
    if (!ownsEnvironment())
      throw new Error('The original native environment changed before recovery')
    if (!this.nativeRecovery)
      throw new NativeRecoveryError({
        operation: 'restore',
        path: snapshot.transport.id,
        reason: 'ownership',
        message: 'The original native recovery registry is unavailable.',
      })
    return this.openDurableChannel(
      snapshot.transport.launchCommand,
      snapshot.transport.provider,
      onOpening,
      snapshot,
    )
  }
  private retainDurableHost(): { host: DurableChannelHost; release: () => void } {
    const selected = this.client
    if (!(selected instanceof LocalClient)) return { host: this, release: () => {} }
    if (this.state.status !== 'connected' || this.state.profile?.transport !== 'local')
      throw new Error('Connect to the original Local environment first')
    let owned = this.localDurableHosts.get(selected)
    if (!owned) {
      owned = {
        host: new LocalDurableHost(
          this.state,
          this.localClientOptions.get(selected) ?? localExecutionOptions(this.options.local),
        ),
        references: 0,
      }
      this.localDurableHosts.set(selected, owned)
    }
    // Discovery can advance on this same owned connection. Existing provider
    // descriptors retain their recorded versions; a new launch sees this result.
    owned.host.state = { ...owned.host.state, codex: this.state.codex, claude: this.state.claude }
    const context = owned
    context.references++
    let released = false
    return {
      host: context.host,
      release: () => {
        if (released) return
        released = true
        if (--context.references !== 0) return
        if (this.localDurableHosts.get(selected) === context)
          this.localDurableHosts.delete(selected)
        const closing = context.host.end()
        this.localClientsClosing.set(context.host.client, closing)
        void closing
          .finally(() => this.localClientsClosing.delete(context.host.client))
          .catch(() => {})
      },
    }
  }
  private async openDurableChannel(
    command: string,
    provider: Provider,
    onOpening?: (channel: ClientChannel) => void,
    snapshot?: NativeRecoverySnapshot,
  ): Promise<ClientChannel> {
    const context = this.retainDurableHost()
    try {
      return (await DurableRemoteChannel.open(
        context.host,
        command,
        (channel) => {
          channel.once('close', context.release)
          onOpening?.(channel as unknown as ClientChannel)
        },
        this.nativeRecovery
          ? {
              store: this.nativeRecovery,
              provider,
              ...(snapshot ? { snapshot, deferRecoveryInputs: true } : {}),
            }
          : undefined,
      )) as unknown as ClientChannel
    } catch (cause) {
      context.release()
      throw cause
    }
  }
  agentBrokerRoot(id: string): string | undefined {
    if (this.state.profile?.transport !== 'local') return
    const client = this.client
    const local =
      client instanceof LocalClient ? this.localClientOptions.get(client) : this.options.local
    return local?.brokerDirectory ? posix.join(local.brokerDirectory, id) : undefined
  }
  agentBrokerCommand(config: RemoteAgentBrokerConfig): string {
    if (this.state.profile?.transport !== 'local') return buildRemoteAgentBrokerCommand(config)
    const client = this.client
    const local =
      client instanceof LocalClient ? this.localClientOptions.get(client) : this.options.local
    return buildRemoteAgentBrokerCommand(config, {
      executable: process.execPath,
      inheritedRunAsNode: (local?.env ?? process.env).ELECTRON_RUN_AS_NODE,
    })
  }
  readonly execEffect = Effect.fn('SSHConnection.exec')(function* (
    this: SSHConnection,
    command: string,
    options: SSHExecOptions = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 30000
    const started = yield* Clock.currentTimeMillis
    const rendererOwned = options.rendererOwned !== false
    const client = this.client
    const rendererGeneration = this.rendererGeneration
    const owned = yield* Effect.acquireRelease(
      Effect.callback<{ channel: ClientChannel; closed: boolean }, SSHCommandError>(
        (resume, signal) => {
          let resource: { channel: ClientChannel; closed: boolean } | undefined
          const discard = () => {
            if (!resource || resource.closed) return
            resource.closed = true
            try {
              resource.channel.close()
            } catch {
              // An obsolete acknowledgement may refer to a closed transport.
            }
          }
          const opening = this.channel(
            command,
            undefined,
            options.signal ? AbortSignal.any([signal, options.signal]) : signal,
            timeoutMs,
            rendererOwned,
          ).then(
            (channel) => {
              resource = { channel, closed: false }
              if (signal.aborted) discard()
              else resume(Effect.succeed(resource))
            },
            (cause) =>
              resume(
                Effect.fail(
                  new SSHCommandError({
                    message: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
                ),
              ),
          )
          return Effect.promise(async () => {
            discard()
            // Promise adapters can still be delivering an acknowledged
            // channel when interruption arrives. Await that handoff so the
            // acquiring fiber cannot finish before its resource is disposed.
            await opening
            discard()
          })
        },
      ),
      (resource) =>
        Effect.sync(() => {
          if (!resource.closed) {
            try {
              resource.channel.close()
            } catch {
              // The transport may already have disappeared during interruption.
            }
          }
        }),
      { interruptible: true },
    )
    const channel = owned.channel
    if (
      this.client !== client ||
      (rendererOwned && rendererGeneration !== this.rendererGeneration)
    ) {
      return yield* new SSHCommandError({
        message:
          this.client !== client
            ? 'SSH connection cancelled'
            : 'The Life interface changed. Retry this operation.',
        cause: undefined,
      })
    }
    const remaining = Math.max(1, timeoutMs - ((yield* Clock.currentTimeMillis) - started))
    return yield* Effect.callback<string, SSHCommandError>((resume) => {
      let output = ''
      let stderr = ''
      let settled = false
      let exitCode: number | undefined
      let outputBytes = 0
      const decoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      const cleanup = () => {
        this.pendingRemoteRequests.delete(fail)
        options.signal?.removeEventListener('abort', aborted)
        channel.off('data', onData)
        channel.stderr.off('data', onStderr)
        channel.off('exit', onExit)
        channel.off('close', onClose)
      }
      const fail = (cause: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        resume(
          Effect.fail(
            new SSHCommandError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
          ),
        )
      }
      const aborted = () => fail(new Error('Remote command cancelled'))
      const onData = (chunk: Buffer) => {
        if (settled) return
        outputBytes += chunk.length
        if (outputBytes > (options.maxOutputBytes ?? 4_000_000)) {
          fail(
            new Error(
              options.maxOutputBytes
                ? 'Remote output exceeds the command output limit'
                : 'Remote output exceeds 4 MB',
            ),
          )
        } else output += decoder.write(chunk)
      }
      const onStderr = (chunk: Buffer) => {
        if (!settled) stderr = (stderr + stderrDecoder.write(chunk)).slice(-8192)
      }
      const onExit = (code: number) => {
        exitCode = code
      }
      const onClose = (code?: number | null) => {
        owned.closed = true
        if (settled) return
        stderr = (stderr + stderrDecoder.end()).slice(-8192)
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
        cleanup()
        resume(Effect.succeed(output + decoder.end()))
      }
      this.pendingRemoteRequests.set(fail, { project: false, renderer: rendererOwned })
      options.signal?.addEventListener('abort', aborted, { once: true })
      channel.on('data', onData)
      channel.stderr.on('data', onStderr)
      // Keep an inert error listener through finalization: ssh2 may emit a late
      // channel error while its parent connection closes.
      channel.on('error', fail)
      channel.on('exit', onExit)
      channel.on('close', onClose)
      if (options.signal?.aborted) aborted()
      if (options.input !== undefined && !settled) {
        try {
          channel.end(options.input)
        } catch (error) {
          fail(error)
        }
      }
      return Effect.sync(() => {
        settled = true
        cleanup()
      })
    }).pipe(
      Effect.timeoutOrElse({
        duration: remaining,
        orElse: () =>
          Effect.fail(
            new SSHCommandError({
              message: `Remote command timed out after ${timeoutMs / 1000} seconds`,
              cause: undefined,
            }),
          ),
      }),
    )
  }, Effect.scoped)

  exec(command: string, options: SSHExecOptions = {}): Promise<string> {
    return runEffect(this.execEffect(command, options))
  }
  private async safePath(path?: string) {
    const root = this.state.workspace
    const sftp = this.sftp
    const generation = this.workspaceGeneration
    const rendererGeneration = this.rendererGeneration
    if (!root || !sftp) throw new Error('Connect to a workspace first')
    const requested = path ? (posix.isAbsolute(path) ? path : posix.join(root, path)) : root
    if (requested.includes('\0')) throw new Error('Invalid path')
    const canonical = await this.remoteRequest<string>(
      'Resolving the remote file',
      (done) => sftp.realpath(requested, done),
      { project: true },
    )
    const current = () => {
      if (this.sftp !== sftp) throw new Error('SSH connection cancelled')
      if (this.workspaceGeneration !== generation) throw new Error('The selected project changed')
      if (this.rendererGeneration !== rendererGeneration)
        throw new Error('The Life interface changed. Retry this operation.')
    }
    current()
    const relative = posix.relative(root, canonical)
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))
      throw new Error('This file is outside the workspace')
    return { canonical, sftp, current }
  }
  async list(path?: string): Promise<FileEntry[]> {
    const { canonical, sftp, current } = await this.safePath(path)
    current()
    const entries = await this.remoteRequest<import('ssh2').FileEntryWithStats[]>(
      'Listing project files',
      (done) => sftp.readdir(canonical, done),
      { project: true },
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
    current()
    const stat = await this.remoteRequest<import('ssh2').Stats>(
      'Checking the remote file',
      (done) => sftp.stat(canonical, done),
      { project: true },
    )
    current()
    if (stat.size > 1_000_000) throw new Error('File preview supports files up to 1 MB')
    let stream: Readable | undefined
    const buffer = await this.remoteRequest<Buffer>(
      'Reading the remote file',
      (done) => {
        const chunks: Buffer[] = []
        let bytes = 0
        let ended = false
        stream = sftp.createReadStream(canonical)
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 1_000_000) {
            done(new Error('File preview supports files up to 1 MB'))
            return
          }
          chunks.push(chunk)
        })
        stream.once('error', (error: Error) => done(error))
        stream.once('end', () => {
          ended = true
          done(null, Buffer.concat(chunks, bytes))
        })
        stream.once('close', () => {
          if (!ended) done(new Error('Remote file closed before its contents were received'))
        })
      },
      { project: true, cancel: () => stream?.destroy() },
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
    const rendererGeneration = this.rendererGeneration
    const channel = await this.channel(
      `cd ${shellQuote(this.state.workspace || '')} && exec "$SHELL" -l`,
      { cols: 100, rows: 18 },
    )
    if (this.terminalGeneration !== generation || this.rendererGeneration !== rendererGeneration) {
      channel.close()
      return
    }
    this.terminal = channel
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    const output = (decoder: StringDecoder, data: Buffer) => {
      if (this.terminal !== channel) return
      const text = decoder.write(data)
      if (text) this.emit('terminal', text)
    }
    channel.on('data', (data: Buffer) => output(stdout, data))
    channel.stderr.on('data', (data: Buffer) => output(stderr, data))
    channel.on('error', (error: Error) => {
      if (this.terminal === channel) this.emit('terminal', `\r\n[${error.message}]\r\n`)
    })
    channel.on('close', () => {
      if (this.terminal === channel) {
        const remaining = stdout.end() + stderr.end()
        if (remaining) this.emit('terminal', remaining)
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
