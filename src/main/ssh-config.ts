import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import type {
  Algorithms,
  CipherAlgorithm,
  ConnectConfig,
  KexAlgorithm,
  MacAlgorithm,
  ServerHostKeyAlgorithm,
} from 'ssh2'
import protocolConstants from 'ssh2/lib/protocol/constants.js'
import type { SSHConfigHost, SSHConfigList } from '../shared/types'
import { sshConfigAliasSchema, sshConfigPathSchema } from '../shared/validation'

const run = promisify(execFile)
const sshDirectory = () => join(homedir(), '.ssh')

export function sshConfigPath(value?: string) {
  const path =
    value == null || !value.trim()
      ? join(sshDirectory(), 'config')
      : sshConfigPathSchema.parse(value)
  return resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
}

// Only tokenize to discover concrete aliases. OpenSSH remains the authority for resolution.
export function configTokens(rawLine: string): string[] {
  const line = rawLine.replace(/^(\s*[^=\s]+)\s*=\s*/, '$1 ')
  const tokens: string[] = []
  let token = ''
  let quoted = false
  let escaped = false
  for (const character of line) {
    if (escaped) {
      token += character
      escaped = false
    } else if (character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
    else if (character === '#' && !quoted) break
    else if ((/\s/.test(character) || (character === '=' && tokens.length === 0)) && !quoted) {
      if (token) {
        tokens.push(token)
        token = ''
      }
    } else token += character
  }
  if (escaped) token += '\\'
  if (token) tokens.push(token)
  return tokens
}

function expandEnvironment(value: string) {
  return value.replace(
    /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
    (_, name: string) => process.env[name] ?? '',
  )
}

function expandLocal(
  value: string,
  host?: { alias: string; host: string; username: string; port: number },
) {
  let expanded = expandEnvironment(value)
  expanded = expanded.replace(/%[%dhrpnu]/g, (token) => {
    const values: Record<string, string> = {
      '%%': '%',
      '%d': homedir(),
      '%u': userInfo().username,
      '%h': host?.host ?? '',
      '%n': host?.alias ?? '',
      '%r': host?.username ?? '',
      '%p': String(host?.port ?? 22),
    }
    return values[token]
  })
  return expanded.startsWith('~/') ? join(homedir(), expanded.slice(2)) : expanded
}

function wildcardPattern(part: string) {
  // SSH config Include supports shell glob patterns, including character classes.
  let expression = '^'
  for (let i = 0; i < part.length; i++) {
    const character = part[i]
    if (character === '*') expression += '.*'
    else if (character === '?') expression += '.'
    else if (character === '[') {
      const end = part.indexOf(']', i + 1)
      if (end === -1) expression += '\\['
      else {
        const contents = part.slice(i + 1, end).replace(/^!/, '^')
        expression += '[' + contents + ']'
        i = end
      }
    } else expression += character.replace(/[\\^$+?.()|{}]/g, '\\$&')
  }
  return new RegExp(expression + '$')
}

async function expandInclude(value: string): Promise<string[]> {
  const expanded = expandLocal(value)
  const path = resolve(isAbsolute(expanded) ? expanded : join(sshDirectory(), expanded))
  const root = parse(path).root
  const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean)
  let candidates = [root]
  for (const part of parts) {
    if (!/[?*[]/.test(part)) candidates = candidates.map((parent) => join(parent, part))
    else {
      const pattern = wildcardPattern(part)
      const matches = await Promise.all(
        candidates.map(async (parent) => {
          try {
            return (await readdir(parent))
              .filter((entry) => pattern.test(entry))
              .map((entry) => join(parent, entry))
          } catch {
            return []
          }
        }),
      )
      candidates = matches.flat().sort()
      if (candidates.length > 500)
        throw new Error('SSH config Include expands to more than 500 files')
    }
  }
  return candidates
}

export async function discoverSSHConfigAliases(configPath?: string): Promise<string[]> {
  const aliases = new Set<string>()
  const visited = new Set<string>()
  async function visit(path: string, depth: number, required = false) {
    if (depth > 16 || visited.size > 500)
      throw new Error('SSH config Include nesting exceeds the supported limit')
    let canonical: string
    let contents: string
    try {
      canonical = await realpath(path)
      if (visited.has(canonical)) return
      contents = await readFile(canonical, 'utf8')
    } catch (error) {
      if (required || !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
      return
    }
    visited.add(canonical)
    if (Buffer.byteLength(contents) > 1_000_000)
      throw new Error('SSH config files must be smaller than 1 MB')
    for (const line of contents.split(/\r?\n/)) {
      const [keyword, ...values] = configTokens(line)
      if (keyword?.toLowerCase() === 'host') {
        for (const alias of values)
          if (!/[?*[]/.test(alias) && sshConfigAliasSchema.safeParse(alias).success)
            aliases.add(alias)
      } else if (keyword?.toLowerCase() === 'include') {
        for (const value of values)
          for (const include of await expandInclude(value)) await visit(include, depth + 1)
      }
    }
  }
  await visit(sshConfigPath(configPath), 0, true)
  return [...aliases].sort((a, b) => a.localeCompare(b))
}

export function parseSSHConfigOptions(output: string): Record<string, string[]> {
  const options: Record<string, string[]> = Object.create(null)
  for (const line of output.split(/\r?\n/)) {
    const match = /^([^\s]+)\s+(.+)$/.exec(line)
    if (!match) continue
    const keyword = match[1].toLowerCase()
    ;(options[keyword] ??= []).push(match[2].trim())
  }
  return options
}

export function unsupportedSSHConfigOptions(options: Record<string, string[]>): string[] {
  const unsupported: string[] = []
  const meaningful = (key: string, defaults: string[] = ['none', 'no', 'false']) =>
    options[key]?.some((value) => !defaults.includes(value.toLowerCase()))
  for (const key of [
    'proxycommand',
    'certificatefile',
    'pkcs11provider',
    'bindinterface',
    'remotecommand',
    'localforward',
    'remoteforward',
    'dynamicforward',
    'localcommand',
    'forwardx11',
    'hostbasedauthentication',
    'tunnel',
  ]) {
    if (meaningful(key)) unsupported.push(key)
  }
  if (meaningful('securitykeyprovider', ['internal', 'none']))
    unsupported.push('securitykeyprovider')
  if (meaningful('proxyusefdpass')) unsupported.push('proxyusefdpass')
  return unsupported
}

export async function resolveSSHConfig(
  aliasInput: string,
  configPath?: string,
): Promise<SSHConfigHost> {
  const alias = sshConfigAliasSchema.parse(aliasInput)
  const path = sshConfigPath(configPath)
  let stdout: string
  try {
    ;({ stdout } = await run('ssh', ['-G', '-F', path, '--', alias], {
      timeout: 10000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    }))
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT')
      throw new Error(
        'OpenSSH is required to read SSH config. Install the Windows OpenSSH Client, or create a manual connection.',
      )
    throw new Error(failure.stderr?.trim() || failure.message || 'Could not resolve SSH config')
  }
  const options = parseSSHConfigOptions(stdout)
  const first = (key: string) => options[key]?.[0]
  const connection = {
    alias,
    host: first('hostname') || alias,
    username: first('user') || userInfo().username,
    port: Number(first('port') || 22),
  }
  const identityFiles = (options.identityfile ?? [])
    .filter((file) => file !== 'none')
    .map((file) => expandLocal(file, connection))
  const availableIdentityFiles = (
    await Promise.all(
      identityFiles.map(async (file) => {
        try {
          await access(file)
          return (await stat(file)).isFile() ? file : undefined
        } catch {
          return undefined
        }
      }),
    )
  ).filter((file): file is string => file !== undefined)
  const rawAgent = first('identityagent')
  let identityAgent: string | undefined
  if (rawAgent && rawAgent !== 'none') {
    const variable =
      rawAgent === 'SSH_AUTH_SOCK'
        ? 'SSH_AUTH_SOCK'
        : /^\$(?:\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([a-zA-Z_][a-zA-Z0-9_]*))$/
            .exec(rawAgent)
            ?.slice(1)
            .find(Boolean)
    if (variable) {
      identityAgent = process.env[variable]
      if (!identityAgent)
        throw new Error(
          `SSH config IdentityAgent requires the unset environment variable ${variable}. Set it or change the configured agent.`,
        )
    } else identityAgent = expandLocal(rawAgent, connection)
  }
  return {
    ...connection,
    identityFiles,
    availableIdentityFiles,
    identityAgent,
    proxyJump: first('proxyjump') !== 'none' ? first('proxyjump') : undefined,
    proxyCommand: first('proxycommand') !== 'none' ? first('proxycommand') : undefined,
    identitiesOnly: first('identitiesonly') === 'yes',
    options,
    unsupportedOptions: unsupportedSSHConfigOptions(options),
  }
}

export async function listSSHConfig(configPath?: string): Promise<SSHConfigList> {
  const path = sshConfigPath(configPath)
  try {
    const aliases = await discoverSSHConfigAliases(path)
    const hosts: SSHConfigHost[] = []
    const errors: string[] = []
    // Limit concurrent OpenSSH processes for large config files.
    for (let offset = 0; offset < aliases.length; offset += 6) {
      const results = await Promise.allSettled(
        aliases.slice(offset, offset + 6).map((alias) => resolveSSHConfig(alias, path)),
      )
      for (let index = 0; index < results.length; index++) {
        const result = results[index]
        if (result.status === 'fulfilled') hosts.push(result.value)
        else errors.push(`${aliases[offset + index]}: ${(result.reason as Error).message}`)
      }
    }
    return { path, hosts, ...(errors.length ? { error: errors.join('\n') } : {}) }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    return {
      path,
      hosts: [],
      error:
        failure.code === 'ENOENT'
          ? 'No SSH config file found. Create a manual connection or choose another config path.'
          : failure.message,
    }
  }
}

export function proxyJumpArguments(configPath: string, config: SSHConfigHost) {
  const hops = config.proxyJump
    ?.split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)
  if (!hops?.length) throw new Error('No ProxyJump host configured')
  if (hops.some((hop) => !/^(?:ssh:\/\/)?[a-zA-Z0-9._@:[\]-]+$/.test(hop) || hop.startsWith('-')))
    throw new Error('Unsupported ProxyJump destination in SSH config')
  let last = hops[hops.length - 1]
  const destination =
    config.host.includes(':') && !config.host.startsWith('[')
      ? `[${config.host}]:${config.port}`
      : `${config.host}:${config.port}`
  const arguments_ = [
    '-F',
    sshConfigPath(configPath),
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=30',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
  ]
  if (hops.length > 1) arguments_.push('-J', hops.slice(0, -1).join(','))
  if (!last.startsWith('ssh://')) {
    const destinationParts = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(last)
    if (!destinationParts) throw new Error('Use brackets around IPv6 ProxyJump destinations')
    if (destinationParts[3]) {
      const port = Number(destinationParts[3])
      if (port < 1 || port > 65535) throw new Error('Invalid ProxyJump port')
      arguments_.push('-p', String(port))
      last = (destinationParts[1] ? destinationParts[1] + '@' : '') + destinationParts[2]
    }
  }
  arguments_.push('-W', destination, '--', last)
  return arguments_
}

export function openProxyJump(
  configPath: string,
  config: SSHConfigHost,
): { stream: Duplex; process: ChildProcessWithoutNullStreams; diagnostic: () => string } {
  const child = spawn('ssh', proxyJumpArguments(configPath, config), {
    stdio: 'pipe',
    windowsHide: true,
  })
  let stderr = ''
  // Duplex.from preserves backpressure and closes both sides when ssh2 disconnects.
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192)
  })
  child.on('error', (error) =>
    stream.destroy(new Error(`OpenSSH ProxyJump failed: ${error.message}`)),
  )
  child.on('exit', (code) => {
    if (code && !stream.destroyed)
      stream.destroy(
        new Error(
          `OpenSSH ProxyJump failed: ${stderr.trim() || `exit code ${code}`}. Jump hosts need key/agent authentication and must already be trusted in OpenSSH known_hosts.`,
        ),
      )
  })
  stream.once('close', () => {
    if (child.exitCode === null) child.kill()
  })
  return { stream, process: child, diagnostic: () => stderr.trim() }
}

export function sshConfigTransportOptions(config: SSHConfigHost): Partial<ConnectConfig> {
  const option = (key: string) => config.options[key]?.[0]
  // Capabilities depend on Electron's crypto runtime and available optional ssh2 bindings.
  // Intersect with the exact lists ssh2 uses to validate connect() algorithm options.
  const supported = {
    cipher: protocolConstants.SUPPORTED_CIPHER,
    serverHostKey: protocolConstants.SUPPORTED_SERVER_HOST_KEY,
    kex: protocolConstants.SUPPORTED_KEX,
    hmac: protocolConstants.SUPPORTED_MAC,
  }
  const algorithms: Algorithms = {
    compress: option('compression') === 'yes' ? ['zlib@openssh.com', 'zlib', 'none'] : ['none'],
  }
  for (const [keyword, algorithm] of [
    ['ciphers', 'cipher'],
    ['hostkeyalgorithms', 'serverHostKey'],
    ['kexalgorithms', 'kex'],
    ['macs', 'hmac'],
  ] as const) {
    const configured = option(keyword)
    if (!configured) continue
    const available = configured.split(',').filter((name) => supported[algorithm].includes(name))
    if (!available.length)
      throw new Error(
        `SSH config ${keyword} has no algorithm supported by Life. Use a compatible config entry or connect manually.`,
      )
    if (algorithm === 'cipher') algorithms.cipher = available as CipherAlgorithm[]
    else if (algorithm === 'serverHostKey')
      algorithms.serverHostKey = available as ServerHostKeyAlgorithm[]
    else if (algorithm === 'kex') algorithms.kex = available as KexAlgorithm[]
    else algorithms.hmac = available as MacAlgorithm[]
  }
  const timeout = Number(option('connecttimeout'))
  const keepalive = Number(option('serveraliveinterval'))
  const keepaliveCount = Number(option('serveralivecountmax'))
  return {
    algorithms,
    forceIPv4: option('addressfamily') === 'inet',
    forceIPv6: option('addressfamily') === 'inet6',
    ...(option('bindaddress') && option('bindaddress') !== 'none'
      ? { localAddress: option('bindaddress') }
      : {}),
    ...(Number.isFinite(timeout) && timeout > 0
      ? { readyTimeout: timeout * 1000, timeout: timeout * 1000 }
      : {}),
    ...(Number.isFinite(keepalive) && keepalive >= 0
      ? { keepaliveInterval: keepalive * 1000 }
      : {}),
    ...(Number.isFinite(keepaliveCount) && keepaliveCount > 0
      ? { keepaliveCountMax: keepaliveCount }
      : {}),
  }
}
