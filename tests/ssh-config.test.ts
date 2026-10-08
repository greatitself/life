import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { createServer, connect as connectTCP, type Socket } from 'node:net'
import { Server, utils, type Connection } from 'ssh2'
import protocolConstants from 'ssh2/lib/protocol/constants.js'
import {
  configTokens,
  discoverSSHConfigAliases,
  listSSHConfig,
  proxyJumpArguments,
  resolveSSHConfig,
  sshConfigTransportOptions,
} from '../src/main/ssh-config'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import { SSHFixture } from './helpers/ssh-fixture'
import { profileSchema, sshConfigAliasSchema } from '../src/shared/validation'
import type { HostKeyRequest } from '../src/shared/types'

let directory: string
let config: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-ssh-config-'))
  config = join(directory, 'config')
  await mkdir(join(directory, 'included configs'))
  await mkdir(join(directory, 'keys'))
  await writeFile(join(directory, 'keys', 'alpha'), 'test key availability')
  await writeFile(
    join(directory, 'included configs', '01.conf'),
    'Host = beta\n HostName 192.0.2.20\n User researcher\n Port 2200\n',
  )
  await writeFile(
    join(directory, 'included configs', '02.conf'),
    'Host gamma\n HostName 192.0.2.30\n User assistant\n ProxyJump bastion\n',
  )
  await writeFile(
    config,
    [
      `Include "${join(directory, 'included configs', '*.conf')}"`,
      'Host alpha duplicate !excluded *.wild [ab]',
      ' HostName 192.0.2.10',
      ' User scientist',
      ' Port 2222',
      ` IdentityFile "${join(directory, 'keys', '%n')}"`,
      ' IdentitiesOnly yes',
      ' ServerAliveInterval 7',
      ' ServerAliveCountMax 4',
      ' ConnectTimeout 12',
      'Host duplicate',
      ' User ignored-second-value',
      'Host *',
      ' Compression yes',
      '',
    ].join('\n'),
  )
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('OpenSSH config discovery and resolution', () => {
  it('tokenizes comments, quoted paths, and equals syntax', () => {
    expect(configTokens(' Include = "path with spaces/*.conf" other.conf # comment')).toEqual([
      'Include',
      'path with spaces/*.conf',
      'other.conf',
    ])
    expect(configTokens('Host=alpha beta !other *.example')).toEqual([
      'Host',
      'alpha',
      'beta',
      '!other',
      '*.example',
    ])
  })
  it('discovers concrete aliases in ordered wildcard Includes and excludes patterns/negations', async () => {
    expect(await discoverSSHConfigAliases(config)).toEqual(['alpha', 'beta', 'duplicate', 'gamma'])
  })
  it('uses OpenSSH precedence, expands local identity tokens, and reports existing keys', async () => {
    const alpha = await resolveSSHConfig('alpha', config)
    expect(alpha).toMatchObject({
      alias: 'alpha',
      host: '192.0.2.10',
      port: 2222,
      username: 'scientist',
      identityFiles: [join(directory, 'keys', 'alpha')],
      availableIdentityFiles: [join(directory, 'keys', 'alpha')],
      identitiesOnly: true,
      unsupportedOptions: [],
    })
    expect(alpha.options.compression).toEqual(['yes'])
    expect((await resolveSSHConfig('duplicate', config)).username).toBe('scientist')
    expect((await resolveSSHConfig('gamma', config)).proxyJump).toBe('bastion')
    expect(sshConfigTransportOptions(alpha)).toMatchObject({
      readyTimeout: 12000,
      keepaliveInterval: 7000,
      keepaliveCountMax: 4,
      algorithms: { compress: ['zlib@openssh.com', 'zlib', 'none'] },
    })
  })
  it('lists the actual resolved connection options and handles a missing config', async () => {
    const result = await listSSHConfig(config)
    expect(result.error).toBeUndefined()
    expect(result.hosts).toHaveLength(4)
    expect(result.hosts.find((host) => host.alias === 'beta')).toMatchObject({
      host: '192.0.2.20',
      port: 2200,
      username: 'researcher',
    })
    expect(await listSSHConfig(join(directory, 'does-not-exist'))).toMatchObject({
      hosts: [],
      error: expect.stringMatching(/no SSH config/i),
    })
  })
  it('preserves config references in saved profiles while rejecting option and control injection', () => {
    expect(sshConfigAliasSchema.safeParse('-oProxyCommand=evil').success).toBe(false)
    expect(sshConfigAliasSchema.safeParse('name;evil').success).toBe(false)
    const profile = {
      id: 'test',
      name: 'Research',
      host: 'localhost',
      port: 22,
      username: 'scientist',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '~/research',
      sshConfig: { alias: 'alpha', path: config },
    }
    expect(profileSchema.parse(profile).sshConfig).toEqual(profile.sshConfig)
    expect(
      profileSchema.safeParse({
        ...profile,
        sshConfig: { alias: 'alpha', path: '/tmp/config\nmalicious' },
      }).success,
    ).toBe(false)
  })
  it('makes unsupported ProxyCommand and forwarding options visible', async () => {
    const path = join(directory, 'unsupported')
    await writeFile(
      path,
      'Host blocked\n HostName 192.0.2.1\n ProxyCommand example %h %p\n LocalForward 3000 localhost:3000\n',
    )
    expect((await resolveSSHConfig('blocked', path)).unsupportedOptions).toEqual(
      expect.arrayContaining(['proxycommand', 'localforward']),
    )
  })
  it('expands IdentityAgent environment references and refuses unset configured agents', async () => {
    const path = join(directory, 'agent-config')
    const previous = process.env.LIFE_TEST_SSH_AGENT
    process.env.LIFE_TEST_SSH_AGENT = join(directory, 'agent socket')
    try {
      await writeFile(path, 'Host custom-agent\n IdentityAgent $LIFE_TEST_SSH_AGENT\n')
      expect((await resolveSSHConfig('custom-agent', path)).identityAgent).toBe(
        join(directory, 'agent socket'),
      )
      delete process.env.LIFE_TEST_SSH_AGENT
      await expect(resolveSSHConfig('custom-agent', path)).rejects.toThrow(
        /unset environment variable LIFE_TEST_SSH_AGENT/,
      )
    } finally {
      if (previous === undefined) delete process.env.LIFE_TEST_SSH_AGENT
      else process.env.LIFE_TEST_SSH_AGENT = previous
    }
  })
  it('passes ProxyJump ports safely as arguments and handles multiple jumps and IPv6 targets', async () => {
    const resolved = await resolveSSHConfig('gamma', config)
    expect(
      proxyJumpArguments(config, {
        ...resolved,
        proxyJump: 'first,scientist@last:2222',
        host: '2001:db8::1',
        port: 2200,
      }),
    ).toEqual(
      expect.arrayContaining([
        '-J',
        'first',
        '-p',
        '2222',
        '-W',
        '[2001:db8::1]:2200',
        '--',
        'scientist@last',
      ]),
    )
    expect(() =>
      proxyJumpArguments(config, { ...resolved, proxyJump: '-oProxyCommand=evil' }),
    ).toThrow(/unsupported/i)
  })
  it('intersects configured algorithm allowlists with the running ssh2 crypto capabilities', async () => {
    const resolved = await resolveSSHConfig('alpha', config)
    const available = protocolConstants.SUPPORTED_CIPHER[0]
    const options = {
      ...resolved.options,
      ciphers: [`unavailable-cipher,${available}`],
    }
    expect(sshConfigTransportOptions({ ...resolved, options }).algorithms?.cipher).toEqual([
      available,
    ])
    expect(() =>
      sshConfigTransportOptions({
        ...resolved,
        options: { ...options, ciphers: ['unavailable-cipher'] },
      }),
    ).toThrow(/no algorithm supported/)
  })
})

describe('real SSH connections through config aliases', () => {
  let fixture: SSHFixture
  let connection: SSHConnection
  let sequence = 0
  beforeAll(async () => {
    fixture = await new SSHFixture().start()
  })
  afterAll(async () => {
    connection?.disconnect()
    await fixture.close()
  })

  async function newConnection() {
    connection?.disconnect()
    const store = new Store(join(directory, 'settings-' + ++sequence))
    await store.init()
    connection = new SSHConnection(store)
    connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
    return connection
  }

  it('re-resolves a linked config when connecting and uses the resolved host/user/port', async () => {
    const path = join(directory, 'fixture-config')
    await writeFile(
      path,
      `Host research\n HostName 127.0.0.1\n User fixture\n Port ${fixture.port}\n ServerAliveInterval 5\n`,
    )
    await newConnection()
    const state = await connection.connect({
      ...fixture.input(),
      host: 'stale.invalid',
      port: 1,
      username: 'stale',
      sshConfig: { alias: 'research', path },
    })
    expect(state).toMatchObject({
      status: 'connected',
      profile: {
        host: '127.0.0.1',
        port: fixture.port,
        username: 'fixture',
        sshConfig: { alias: 'research', path },
      },
    })
    expect(await connection.exec('printf config-connected')).toBe('config-connected')
  })

  it('rejects unsupported config behavior before attempting a network connection', async () => {
    const path = join(directory, 'blocked-config')
    await writeFile(path, 'Host blocked\n HostName 127.0.0.1\n ProxyCommand example %h %p\n')
    await newConnection()
    await expect(
      connection.connect({ ...fixture.input(), sshConfig: { alias: 'blocked', path } }),
    ).rejects.toThrow(/cannot apply: proxycommand/)
    expect(connection.state.status).toBe('disconnected')
  })

  it('uses a real local OpenSSH ProxyJump tunnel and keeps target fingerprint verification', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const key = utils.parseKey(privateKey)
    if (key instanceof Error || Array.isArray(key))
      throw new Error('Could not parse fixture jump key')
    const sockets = new Set<Socket>()
    const clients = new Set<Connection>()
    const jump = new Server({ hostKeys: [privateKey] }, (client) => {
      clients.add(client)
      client.on('error', () => {})
      client.on('close', () => clients.delete(client))
      client.on('authentication', (context) => context.accept())
      client.on('ready', () =>
        client.on('tcpip', (accept, reject, info) => {
          if (info.destIP !== '127.0.0.1' || info.destPort !== fixture.port) {
            reject()
            return
          }
          const socket = connectTCP(fixture.port, '127.0.0.1', () => {
            const channel = accept()
            socket.pipe(channel).pipe(socket)
            channel.on('error', () => socket.destroy())
            channel.on('close', () => socket.destroy())
          })
          sockets.add(socket)
          socket.on('error', () => {
            try {
              reject()
            } catch {}
          })
          socket.on('close', () => sockets.delete(socket))
        }),
      )
    })
    const transport = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      jump.injectSocket(socket)
    })
    await new Promise<void>((resolve) => transport.listen(0, '127.0.0.1', resolve))
    const address = transport.address()
    if (!address || typeof address === 'string')
      throw new Error('Could not listen for jump fixture')
    const knownHosts = join(directory, 'jump-known-hosts')
    const hostKey = key.getPublicSSH().toString('base64')
    await writeFile(knownHosts, `[127.0.0.1]:${address.port} ${key.type} ${hostKey}\n`)
    const path = join(directory, 'jump-config')
    await writeFile(
      path,
      `Host research\n HostName 127.0.0.1\n User fixture\n Port ${fixture.port}\n ProxyJump bastion\nHost bastion\n HostName 127.0.0.1\n User fixture\n Port ${address.port}\n UserKnownHostsFile "${knownHosts}"\n BatchMode yes\n`,
    )
    await newConnection()
    const requests: HostKeyRequest[] = []
    connection.on('host-key', (request: HostKeyRequest) => requests.push(request))
    try {
      const state = await connection.connect({
        ...fixture.input(),
        sshConfig: { alias: 'research', path },
      })
      expect(state.status).toBe('connected')
      expect(requests).toHaveLength(1)
      expect(requests[0].host).toBe(`127.0.0.1:${fixture.port}`)
      expect(await connection.exec('printf through-jump')).toBe('through-jump')
    } finally {
      connection.disconnect()
      for (const client of clients) client.end()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => transport.close(() => resolve()))
    }
  }, 20000)
})
