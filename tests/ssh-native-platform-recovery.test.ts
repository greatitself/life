import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { Effect, Exit, Scope } from 'effect'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableRemoteChannel, type DurableChannelHost } from '../src/main/durable-remote-channel'
import { LocalClient } from '../src/main/local-transport'
import { nativeMachineIdentity, sameNativeMachine } from '../src/main/native-machine-identity'
import {
  assessNativeRecoveryPlatformEffect,
  blockedNativeRecoveryPlatformPolicy,
  type NativeRecoveryPlatformPolicy,
} from '../src/main/native-recovery-platform'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import type { NativeRecoverySnapshot } from '../src/main/native-recovery-types'
import type { RemoteAgentBrokerConfig } from '../src/main/remote-agent-broker'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import { connectionMachineIdentity } from '../src/shared/connection-identity'
import type { ConnectionState } from '../src/shared/types'

const directories: string[] = []
const scopes: Scope.Closeable[] = []
const connections: SSHConnection[] = []
const durableChannels: DurableRemoteChannel[] = []
const attachments: Attachment[] = []

class Attachment extends Duplex {
  readonly stderr = new PassThrough()
  readonly inputs: Record<string, unknown>[] = []
  readonly close = vi.fn(() => this.destroy())
  readonly signal = vi.fn()
  constructor() {
    super({ autoDestroy: false })
    attachments.push(this)
  }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    for (const line of chunk.toString().split('\n'))
      if (line) this.inputs.push(JSON.parse(line) as Record<string, unknown>)
    done()
  }
  frame(value: Record<string, unknown>) {
    this.push(JSON.stringify(value) + '\n')
  }
  asClient() {
    return this as unknown as ClientChannel
  }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const channel of durableChannels.splice(0)) await channel.detach()
  for (const connection of connections.splice(0)) await connection.disconnectAndWait()
  for (const attachment of attachments.splice(0)) {
    attachment.destroy()
    attachment.stderr.destroy()
  }
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'life ssh native ownership '))
  directories.push(directory)
  return directory
}

async function recoveryStore(directory: string): Promise<NativeRecoveryStoreHandle> {
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  return Effect.runPromise(
    NativeRecoveryStore.make({ directory, exclusiveRuntime: true }).pipe(Scope.provide(scope)),
  )
}

const sshState: ConnectionState = {
  status: 'connected',
  home: '/home/fixture',
  profile: {
    id: 'ssh-fixture',
    name: 'SSH fixture',
    host: 'fixture.invalid',
    username: 'fixture',
    port: 22,
    auth: 'agent',
    privateKeyPath: '',
    workspace: '/project',
  },
}

function attachedConnection(
  policy?: NativeRecoveryPlatformPolicy,
  nativeRecovery?: NativeRecoveryStoreHandle,
) {
  const connection = new SSHConnection(
    new Store(join(tmpdir(), 'life-attached-native-unit')),
    {},
    nativeRecovery,
    policy,
  )
  const attachment = new Attachment()
  const exec = vi.fn((_command, _options, done) => done(null, attachment.asClient()))
  const client = { exec, end: vi.fn() }
  Object.assign(connection, { client })
  connection.state = { ...sshState, profile: { ...sshState.profile! } }
  connections.push(connection)
  return { connection, attachment, exec, client }
}

type AttachedRelease = ClientChannel & {
  closeAndWaitEffect(timeoutMs?: number): Effect.Effect<boolean>
}

async function acquireAttached(
  value: ReturnType<typeof attachedConnection>,
): Promise<AttachedRelease> {
  // Exercise the Main-only adapter on the actual host without fabricating a
  // Windows policy. The Windows public policy route is separately conditional.
  const channel = await value.connection.channel(
    'native provider',
    undefined,
    undefined,
    30000,
    false,
  )
  Reflect.apply(Reflect.get(value.connection, 'attachNativeExitRelease'), value.connection, [
    channel,
  ])
  return channel as AttachedRelease
}

describe('ordinary attached native exit evidence', () => {
  it('captures native exit inside exec acknowledgement before Promise handoff', async () => {
    const value = attachedConnection()
    value.exec.mockImplementation((_command, _options, done) => {
      done(null, value.attachment.asClient())
      value.attachment.emit('exit', null, 'TERM')
    })
    const channel = await acquireAttached(value)
    await expect(Effect.runPromise(channel.closeAndWaitEffect())).resolves.toBe(true)
    expect(value.attachment.signal).not.toHaveBeenCalled()
    expect(value.attachment.close).toHaveBeenCalledOnce()
    expect(channel).not.toHaveProperty('recoveryId')
    expect(channel).not.toHaveProperty('nativeRecoveryTracked')
  })

  it('joins simultaneous idle releases and waits for real exit before closing', async () => {
    const value = attachedConnection()
    const channel = await acquireAttached(value)
    const first = Effect.runPromise(channel.closeAndWaitEffect())
    const second = Effect.runPromise(channel.closeAndWaitEffect())
    await vi.waitFor(() => expect(value.attachment.signal).toHaveBeenCalledOnce())
    expect(value.attachment.signal).toHaveBeenCalledWith('TERM')
    expect(value.attachment.close).not.toHaveBeenCalled()
    value.attachment.emit('exit', 0)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(value.attachment.close).toHaveBeenCalledOnce()
  })

  it.each(['close', 'socket'] as const)(
    'does not infer native exit from %s teardown',
    async (kind) => {
      const value = attachedConnection()
      const channel = await acquireAttached(value)
      const released = Effect.runPromise(channel.closeAndWaitEffect())
      await vi.waitFor(() => expect(value.attachment.signal).toHaveBeenCalledOnce())
      if (kind === 'socket') value.connection.disconnect()
      value.attachment.emit('close', 0, 'TERM')
      await expect(released).resolves.toBe(false)
    },
  )

  it('keeps a timed-out release unconfirmed even when a later exit is observed', async () => {
    const value = attachedConnection()
    const channel = await acquireAttached(value)
    vi.useFakeTimers()
    const released = Effect.runPromise(channel.closeAndWaitEffect(20))
    await vi.advanceTimersByTimeAsync(20)
    await expect(released).resolves.toBe(false)
    value.attachment.emit('exit', 0)
    await expect(Effect.runPromise(channel.closeAndWaitEffect())).resolves.toBe(false)
    expect(value.attachment.signal).toHaveBeenCalledOnce()
    expect(value.attachment.close).toHaveBeenCalledOnce()
  })

  it('does not claim native exit when the SSH signal request throws', async () => {
    const value = attachedConnection()
    const channel = await acquireAttached(value)
    value.attachment.signal.mockImplementation(() => {
      throw new Error('socket is gone')
    })
    await expect(Effect.runPromise(channel.closeAndWaitEffect())).resolves.toBe(false)
  })
})

describe('issued platform policy at SSH launch', () => {
  it('rejects cloned and forged policies before native exec', async () => {
    const userData = await temporary()
    const issued = await Effect.runPromise(
      assessNativeRecoveryPlatformEffect({ userData, exclusiveRuntime: true }),
    )
    for (const forged of [
      { ...issued },
      { mode: 'unsupported-clean', assertFreshSshStartEffect: () => Effect.void },
    ]) {
      const value = attachedConnection(forged as NativeRecoveryPlatformPolicy)
      await expect(value.connection.durableChannel('native provider')).rejects.toMatchObject({
        operation: 'platform-policy',
      })
      expect(value.exec).not.toHaveBeenCalled()
    }
  })

  it('blocks fresh launch and cold restore with an issued blocked policy', async () => {
    const userData = await temporary()
    const value = attachedConnection(
      blockedNativeRecoveryPlatformPolicy(userData, new Error('protected state')),
    )
    await expect(value.connection.durableChannel('native provider')).rejects.toMatchObject({
      operation: 'platform-initialize',
    })
    await expect(
      value.connection.restoreDurableChannel({} as NativeRecoverySnapshot),
    ).rejects.toMatchObject({ operation: 'platform-initialize' })
    expect(value.exec).not.toHaveBeenCalled()
  })

  it('does not transfer native launch to a replacement environment during policy admission', async () => {
    const userData = await temporary()
    const policy = await Effect.runPromise(
      assessNativeRecoveryPlatformEffect({ userData, exclusiveRuntime: true }),
    )
    const value = attachedConnection(policy)
    const starting = value.connection.durableChannel('native provider')
    const replacement = { exec: vi.fn(), end: vi.fn() }
    Object.assign(value.connection, { client: replacement })
    value.connection.state = {
      ...sshState,
      profile: { ...sshState.profile!, id: 'replacement-machine', host: 'replacement.invalid' },
    }
    await expect(starting).rejects.toThrow('environment changed before launch')
    expect(value.exec).not.toHaveBeenCalled()
    expect(replacement.exec).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'requires the owned registry for an issued durable policy',
    async () => {
      const userData = await temporary()
      const policy = await Effect.runPromise(
        assessNativeRecoveryPlatformEffect({ userData, exclusiveRuntime: true }),
      )
      const value = attachedConnection(policy)
      await expect(value.connection.durableChannel('native provider')).rejects.toMatchObject({
        reason: 'ownership',
        operation: 'launch',
      })
      expect(value.exec).not.toHaveBeenCalled()
    },
  )

  it.runIf(process.platform === 'win32')(
    'uses only ordinary attached SSH on actual unsupported-clean Windows',
    async () => {
      const userData = await temporary()
      const policy = await Effect.runPromise(
        assessNativeRecoveryPlatformEffect({ userData, exclusiveRuntime: true }),
      )
      expect(policy.mode).toBe('unsupported-clean')
      const value = attachedConnection(policy)
      const broker = vi.spyOn(DurableRemoteChannel, 'open')
      let opening: ClientChannel | undefined
      const channel = await value.connection.durableChannel('native provider', (owned) => {
        opening = owned
      })
      expect(opening).toBe(channel)
      expect(channel).toHaveProperty('closeAndWaitEffect')
      expect(channel).not.toHaveProperty('recoveryId')
      expect(broker).not.toHaveBeenCalled()
      expect(value.exec).toHaveBeenCalledOnce()
      value.attachment.emit('exit', 0)
      await expect(
        Effect.runPromise((channel as AttachedRelease).closeAndWaitEffect()),
      ).resolves.toBe(true)
    },
  )
})

async function localConnection() {
  const root = await temporary()
  const home = join(root, 'original home café')
  const workspace = join(root, 'project')
  await mkdir(home)
  await mkdir(workspace)
  const nativeRecovery = await recoveryStore(join(root, 'registry'))
  const store = new Store(join(root, 'settings'), { localWorkspace: workspace })
  await store.init()
  const options = {
    local: {
      shell: '/bin/sh',
      env: {
        ...process.env,
        HOME: home,
        SHELL: '/bin/sh',
        ELECTRON_RUN_AS_NODE: 'original-user-setting',
      },
      brokerDirectory: join(root, 'original broker root'),
    },
  }
  const connection = new SSHConnection(store, options, nativeRecovery)
  connections.push(connection)
  const launches: {
    client: LocalClient
    config: RemoteAgentBrokerConfig
    snapshot: NativeRecoverySnapshot
  }[] = []
  const commands: { client: LocalClient; command: string }[] = []
  vi.spyOn(LocalClient.prototype, 'exec').mockImplementation(function (
    this: LocalClient,
    command,
    _options,
    done,
  ) {
    commands.push({ client: this, command })
    const attachment = new Attachment()
    const encoded = command.match(/eyJ[A-Za-z0-9+/=]+/)?.[0]
    if (encoded) {
      const config = JSON.parse(
        Buffer.from(encoded, 'base64').toString(),
      ) as RemoteAgentBrokerConfig
      void Effect.runPromise(nativeRecovery.readTransport(config.id)).then(
        (snapshot) => {
          launches.push({ client: this, config, snapshot })
          done(null, attachment.asClient())
          setImmediate(() => {
            attachment.frame({
              type: 'ready',
              protocol: 2,
              inputReceipts: 1,
              cursor: snapshot.outputCursor,
              lastInputSequence: snapshot.allocatedInputSequence,
              writerLease: { epoch: launches.length, token: `fixture-${launches.length}` },
            })
            attachment.frame({ type: 'replayComplete', replayCursor: snapshot.outputCursor })
          })
        },
        (error) => done(error),
      )
    } else {
      done(null, attachment.asClient())
      setImmediate(() => {
        attachment.push(
          command.includes('CODEX=')
            ? 'CODEX=codex-fixture-1\nCLAUDE=claude-fixture-1\n'
            : 'original execution\n',
        )
        attachment.push(null)
        attachment.stderr.end()
        attachment.emit('exit', 0)
        attachment.emit('close', 0)
      })
    }
    return this
  })
  await connection.connect(store.localProfile())
  await connection.whenProviderVersionsReady()
  const open = async () => {
    const channel = (await connection.durableChannel(
      'original provider command',
    )) as unknown as DurableRemoteChannel
    durableChannels.push(channel)
    return channel
  }
  return { root, home, store, nativeRecovery, options, connection, launches, commands, open }
}

describe.skipIf(process.platform === 'win32')('captured Local durable ownership', () => {
  it('commits the actual Local root before launch and restores the exact recorded root', async () => {
    const value = await localConnection()
    const first = await value.open()
    const recorded = await Effect.runPromise(value.nativeRecovery.readTransport(first.recoveryId!))
    const originalRoot = join(value.options.local.brokerDirectory, first.sessionId)
    expect(value.launches[0].snapshot.transport.brokerRoot).toBe(originalRoot)
    expect(value.launches[0].config).toMatchObject({
      id: first.sessionId,
      root: originalRoot,
      launch: true,
      expectedProtocol: 2,
    })
    expect(recorded.transport.providerVersion).toBe('codex-fixture-1')
    await first.detach()
    value.connection.disconnect()
    value.options.local.brokerDirectory = join(value.root, 'new selected broker root')
    await value.connection.connect(value.store.localProfile())
    await value.connection.whenProviderVersionsReady()
    value.connection.state = { ...value.connection.state, codex: 'different-installed-version' }
    const restored = (await value.connection.restoreDurableChannel(
      recorded,
    )) as unknown as DurableRemoteChannel
    durableChannels.push(restored)
    restored.resumeRecoveryOutput()
    await restored.waitForReplay()
    expect(value.launches[1].config).toMatchObject({
      id: first.sessionId,
      command: 'original provider command',
      root: originalRoot,
      launch: false,
      cursor: recorded.outputCursor,
      expectedProtocol: 2,
    })
    expect(value.launches[1].snapshot.transport.providerVersion).toBe('codex-fixture-1')
    expect(restored.recoveryDescriptor?.brokerRoot).toBe(originalRoot)
    expect(restored.recoveryDescriptor?.providerVersion).toBe('codex-fixture-1')
  })

  it('retains original Local execution across selection changes until the final reference closes', async () => {
    const value = await localConnection()
    const first = await value.open()
    const second = await value.open()
    const host = Reflect.get(first, 'host') as DurableChannelHost
    expect(Reflect.get(second, 'host')).toBe(host)
    const original = value.launches[0].client
    const selected = Reflect.get(value.connection, 'client') as LocalClient
    expect(original).not.toBe(selected)
    const end = vi.spyOn(original, 'end')
    const inheritedRuntime = value.options.local.env.ELECTRON_RUN_AS_NODE
    value.options.local.env.ELECTRON_RUN_AS_NODE = 'replacement-setting'
    value.options.local.brokerDirectory = join(value.root, 'replacement-root')
    value.connection.disconnect()
    const replacement = { exec: vi.fn(), end: vi.fn() }
    Object.assign(value.connection, { client: replacement })
    value.connection.state = sshState
    expect(host.state.status).toBe('connected')
    expect(host.state.profile?.id).toBe(value.store.localProfile().id)
    expect(host.state.home).toBe(value.home)
    const cleanup = await host.channel('cleanup original owner')
    cleanup.close()
    expect(value.commands.at(-1)?.client).toBe(original)
    expect(replacement.exec).not.toHaveBeenCalled()
    const encoded = host.agentBrokerCommand!({
      id: first.sessionId,
      command: 'original provider command',
      root: '/exact-recorded-root',
      launch: false,
      cursor: 0,
    }).match(/eyJ[A-Za-z0-9+/=]+/)![0]
    const config = JSON.parse(Buffer.from(encoded, 'base64').toString())
    expect(config.root).toBe('/exact-recorded-root')
    expect(config.localRuntime.inheritedRunAsNode).toBe(inheritedRuntime)
    await first.detach()
    expect(end).not.toHaveBeenCalled()
    await second.detach()
    await value.connection.disconnectAndWait()
    expect(end).toHaveBeenCalledOnce()
    expect(host.state.status).toBe('disconnected')
  })

  it('releases only its newly retained Local host when the opening callback fails', async () => {
    const value = await localConnection()
    const end = vi.spyOn(LocalClient.prototype, 'end')
    await expect(
      value.connection.durableChannel('never launch provider', () => {
        throw new Error('caller opening failed')
      }),
    ).rejects.toThrow('caller opening failed')
    await value.connection.disconnectAndWait()
    expect(value.launches).toEqual([])
    expect(end).toHaveBeenCalledTimes(2)
  })

  it('uses the shared installation-specific Local machine identity', async () => {
    const value = await localConnection()
    const profile = value.store.localProfile()
    expect(nativeMachineIdentity(profile)).toBe(connectionMachineIdentity(profile))
    expect(sameNativeMachine(profile, { ...profile, host: 'display changed' })).toBe(true)
    expect(sameNativeMachine(profile, { ...profile, id: 'local:other-installation' })).toBe(false)
  })
})
