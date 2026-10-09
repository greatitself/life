import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { z } from 'zod'
import type { ClientChannel } from 'ssh2'
import type { ConnectionState, Provider } from '../shared/types'
import type {
  HostHistoryList,
  HostHistoryMessage,
  HostHistoryPage,
  HostHistorySession,
} from '../shared/agent-history'
import { hostHistoryWorkspacePurpose } from '../shared/agent-history'
import { shellQuote } from '../shared/validation'
import { LIFE_VERSION } from '../shared/version'
import { CodexRPC, CodexRequestError } from './codex-rpc'

type Wire = Record<string, unknown>
const object = (value: unknown): Wire =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : {}
const array = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(object) : [])
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const stamp = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}
const cleanTitle = (value: unknown) =>
  string(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 300)
const safeWorkspace = (value: unknown) => {
  const path = string(value)
  return posix.isAbsolute(path) && path.length <= 4096 && !/[\x00-\x1f]/.test(path)
    ? path
    : undefined
}
const requestId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._:-]+$/)
const listSchema = z
  .object({
    provider: z.enum(['codex', 'claude', 'all']).default('all'),
    query: z.string().max(300).default(''),
    cursor: z.string().max(16000).optional(),
    limit: z.number().int().min(1).max(80).default(40),
    refresh: z.boolean().default(false),
    requestId: requestId.optional(),
  })
  .strict()
const readSchema = z
  .object({
    id: z.string().min(1).max(250),
    cursor: z.string().max(16000).optional(),
    limit: z.number().int().min(1).max(200).default(100),
    requestId: requestId.optional(),
  })
  .strict()
interface HistorySSH {
  state: ConnectionState
  exec(
    command: string,
    options?: { signal?: AbortSignal; maxOutputBytes?: number; timeoutMs?: number },
  ): Promise<string>
  channel(
    command: string,
    pty?: undefined,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ClientChannel>
  on(event: string, callback: (...args: unknown[]) => void): unknown
}
interface Descriptor {
  id: string
  provider: Provider
  remoteId: string
  path: string
  size: number
  updatedAt: number
  parentRemoteId?: string
  summary?: HostHistorySession
}
interface ParseContext {
  turn: number
  tools: Map<string, string>
}
interface ListCursor {
  kind: 'list'
  machine: string
  provider: string
  query: string
  codex?: string
  codexDone?: boolean
  codexArchived?: boolean
  claude: number
  claudeDone?: boolean
}
interface ReadCursor {
  kind: 'read'
  machine: string
  id: string
  mode: 'items' | 'turns' | 'file'
  providerCursor?: string
  offset: number
  turn: number
  lastTurnId?: string
  tools?: Array<[string, string]>
  boundaryBytes?: number
  boundaryItemId?: string
  boundaryTurnId?: string
  snapshotReady?: boolean
}
const encodeCursor = (value: ListCursor | ReadCursor) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')
function decodeCursor(value?: string): Wire {
  if (!value) return {}
  try {
    const parsed = object(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
    if (!Object.keys(parsed).length) throw new Error()
    return parsed
  } catch {
    throw new Error('This history page expired. Refresh host history and try again.')
  }
}

function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Host history request cancelled.'))
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup()
      reject(new Error('Host history request cancelled.'))
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

/** Preserve text and tool blocks without turning tool results into user messages. */
export function historyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    const entry = object(value)
    if (typeof entry.text === 'string') return entry.text
    if (typeof entry.content === 'string') return entry.content
    return value == null ? '' : JSON.stringify(value, null, 2)
  }
  return value
    .map((value) => {
      if (typeof value === 'string') return value
      const entry = object(value)
      if (typeof entry.text === 'string') return entry.text
      if (typeof entry.thinking === 'string') return entry.thinking
      if (entry.type === 'image' || entry.type === 'image_url' || entry.type === 'input_image')
        return '[Image attachment stored in the original provider session]'
      if (entry.type === 'localImage' || entry.type === 'local_image')
        return `[Image: ${string(entry.path)}]`
      if (entry.type === 'audio' || entry.type === 'localAudio')
        return `[Audio: ${string(entry.path || entry.url)}]`
      if (entry.type === 'skill' || entry.type === 'mention')
        return `[${string(entry.type)}: ${string(entry.name)} ${string(entry.path)}]`
      return JSON.stringify(entry, null, 2)
    })
    .filter(Boolean)
    .join('\n')
}

export function codexHistorySummary(value: unknown): HostHistorySession | undefined {
  const thread = object(value)
  const remoteId = string(thread.id)
  if (!remoteId || remoteId.length > 200) return undefined
  const source =
    typeof thread.source === 'string' ? thread.source : JSON.stringify(thread.source || 'unknown')
  const spawned = object(
    object(object(thread.source).subAgent || object(thread.source).subagent).thread_spawn,
  )
  const parentRemoteId = string(thread.parentThreadId || spawned.parent_thread_id)
  return {
    id: `codex:${remoteId}`,
    provider: 'codex',
    remoteId,
    // Codex's name is the generated/persisted title; preview is a prompt excerpt.
    title: cleanTitle(thread.name || thread.title) || 'Untitled Codex session',
    workspace: safeWorkspace(thread.cwd),
    model: string(thread.model) || undefined,
    reasoningEffort: string(thread.reasoningEffort) || undefined,
    createdAt: stamp(thread.createdAt),
    updatedAt: stamp(thread.updatedAt || thread.recencyAt),
    parentRemoteId: parentRemoteId || undefined,
    agentName:
      cleanTitle(thread.agentNickname || thread.agentRole || spawned.agent_nickname) || undefined,
    source,
  }
}

/** The official item API keeps rich outputs and subagent relationships together. */
export function codexHistoryItem(
  value: unknown,
  turn: number,
  turnId?: string,
): HostHistoryMessage[] {
  const entry = object(value)
  const item = object(entry.item || value)
  const id =
    string(item.id) || createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 24)
  const base = {
    id: `codex:${turnId || turn}:${id}`,
    turn,
    turnId,
    createdAt: stamp(entry.startedAtMs) || undefined,
    finishedAt: stamp(entry.completedAtMs) || undefined,
  }
  switch (item.type) {
    case 'userMessage':
      return [{ ...base, role: 'user', text: historyContent(item.content) }]
    case 'agentMessage':
      return [
        {
          ...base,
          role: 'assistant',
          text: string(item.text),
          ...(item.phase === 'commentary' || item.phase === 'final_answer'
            ? { phase: item.phase }
            : {}),
        },
      ]
    case 'plan':
      return [{ ...base, role: 'assistant', kind: 'plan', title: 'Plan', text: string(item.text) }]
    case 'reasoning':
      return [
        {
          ...base,
          role: 'assistant',
          kind: 'reasoning',
          title: 'Reasoning',
          text: [historyContent(item.summary), historyContent(item.content)]
            .filter(Boolean)
            .join('\n\n'),
        },
      ]
    case 'commandExecution':
      return [
        {
          ...base,
          role: 'tool',
          title: string(item.command) || 'Command',
          input: string(item.command),
          text: string(item.aggregatedOutput),
          status: string(item.status) || 'completed',
        },
      ]
    case 'functionCallOutput':
      return [
        {
          ...base,
          role: 'tool',
          title: string(item.name) || 'Tool output',
          text: historyContent(item.output),
          status: 'completed',
        },
      ]
    case 'fileChange':
      return [
        {
          ...base,
          role: 'tool',
          title: 'File changes',
          text: JSON.stringify(item.changes || [], null, 2),
          status: string(item.status) || 'completed',
        },
      ]
    case 'mcpToolCall':
      return [
        {
          ...base,
          role: 'tool',
          title: `${string(item.server)} / ${string(item.tool)}`,
          input: JSON.stringify(item.arguments, null, 2),
          text: historyContent(item.result || item.error),
          status: string(item.status) || 'completed',
        },
      ]
    case 'dynamicToolCall':
      return [
        {
          ...base,
          role: 'tool',
          title: string(item.tool) || 'Tool',
          input: JSON.stringify(item.arguments, null, 2),
          text: historyContent(item.contentItems),
          status: string(item.status) || 'completed',
        },
      ]
    case 'collabAgentToolCall':
      return [
        {
          ...base,
          role: 'tool',
          kind: 'subagent',
          title: `Subagents · ${string(item.tool)}`,
          text: JSON.stringify(
            { receivers: item.receiverThreadIds, prompt: item.prompt, states: item.agentsStates },
            null,
            2,
          ),
          status: string(item.status) || 'completed',
          parentAgentId: string(item.senderThreadId) || undefined,
          agentId: Array.isArray(item.receiverThreadIds)
            ? string(item.receiverThreadIds[0]) || undefined
            : undefined,
        },
      ]
    case 'subAgentActivity':
      return [
        {
          ...base,
          role: 'tool',
          kind: 'subagent',
          title: `Subagent · ${string(item.kind)}`,
          text: string(item.agentPath),
          agentId: string(item.agentThreadId),
          status: 'completed',
        },
      ]
    // Hooks are provider-supplied instructions, not an additional user message.
    case 'hookPrompt':
      return [
        {
          ...base,
          role: 'tool',
          kind: 'event',
          title: 'Provider hook',
          text: historyContent(item.fragments),
          status: 'completed',
        },
      ]
    default:
      return [
        {
          ...base,
          role: 'tool',
          kind: 'event',
          title: string(item.type) || 'Provider event',
          text: JSON.stringify(item, null, 2),
          status: 'completed',
        },
      ]
  }
}

export function parseClaudeHistoryRecord(
  value: unknown,
  context: ParseContext,
  fallbackId: string,
): HostHistoryMessage[] {
  const record = object(value)
  const message = object(record.message)
  const role = string(record.type)
  const id = string(record.uuid) || fallbackId
  const base = {
    id: `claude:${id}`,
    turn: context.turn,
    createdAt: stamp(record.timestamp) || undefined,
    agentId: string(record.agentId) || undefined,
    parentAgentId: string(record.parentAgentId) || undefined,
  }
  if (!['user', 'assistant'].includes(role)) {
    if (role === 'system' && record.subtype === 'compact_boundary')
      return [
        {
          ...base,
          role: 'tool',
          kind: 'event',
          title: 'Context compacted',
          text: historyContent(record.compactMetadata),
          status: 'completed',
        },
      ]
    return []
  }
  if (role === 'user' && record.isMeta === true)
    return [
      {
        ...base,
        role: 'tool',
        kind: 'event',
        title: 'Provider context',
        text: historyContent(message.content),
        status: 'completed',
      },
    ]
  const content = message.content
  if (typeof content === 'string') {
    if (role === 'user') context.turn++
    return [{ ...base, turn: context.turn, role: role as 'user' | 'assistant', text: content }]
  }
  if (!Array.isArray(content)) return []
  const blocks = array(content)
  const hasUserText = role === 'user' && blocks.some((block) => block.type !== 'tool_result')
  if (hasUserText) context.turn++
  const output: HostHistoryMessage[] = []
  let text: Wire[] = []
  const flush = () => {
    if (!text.length) return
    output.push({
      ...base,
      id: `${base.id}:${output.length}`,
      turn: context.turn,
      role: role as 'user' | 'assistant',
      text: historyContent(text),
    })
    text = []
  }
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      flush()
      const toolId = string(block.id)
      const name = string(block.name) || 'Tool'
      context.tools.set(toolId, name)
      output.push({
        ...base,
        id: `${base.id}:${toolId || output.length}`,
        turn: context.turn,
        role: 'tool',
        title: name,
        input: JSON.stringify(block.input, null, 2),
        text: JSON.stringify(block.input, null, 2),
        status: 'completed',
        ...(name === 'Agent' || name === 'Task' ? { kind: 'subagent' as const } : {}),
      })
    } else if (block.type === 'tool_result') {
      flush()
      const toolId = string(block.tool_use_id)
      output.push({
        ...base,
        id: `${base.id}:${toolId || output.length}`,
        turn: context.turn,
        role: 'tool',
        title: context.tools.get(toolId) || 'Tool result',
        text: historyContent(block.content),
        status: block.is_error ? 'failed' : 'completed',
      })
    } else if (block.type === 'thinking') {
      flush()
      output.push({
        ...base,
        id: `${base.id}:reasoning:${output.length}`,
        turn: context.turn,
        role: 'assistant',
        kind: 'reasoning',
        title: 'Reasoning',
        text: string(block.thinking),
      })
    } else if (block.type === 'redacted_thinking') {
      flush()
      output.push({
        ...base,
        id: `${base.id}:redacted:${output.length}`,
        turn: context.turn,
        role: 'tool',
        kind: 'event',
        title: 'Protected reasoning',
        text: 'The provider did not expose the text of this reasoning block.',
        status: 'completed',
      })
    } else text.push(block)
  }
  flush()
  return output
}

/** Reads existing sessions only. No turn/start, prompt injection, imports or file writes. */
export class AgentHistory {
  private rpc?: CodexRPC
  private rpcStarting?: Promise<CodexRPC>
  private rpcStartupSignal?: AbortSignal
  private generation = 0
  private requests = new Map<string, AbortController>()
  private catalog = new Map<string, HostHistorySession>()
  private claudeFiles: Descriptor[] = []
  private claudeScanned = 0
  private claudeIndexWarning?: string
  private claudeScanning?: Promise<void>
  private claudeScanSignal?: AbortSignal
  constructor(private ssh: HistorySSH) {
    ssh.on('disconnected', () => this.reset())
  }
  private machine() {
    const state = this.ssh.state
    if (state.status !== 'connected' || !state.home)
      throw new Error('Connect to a machine to browse its existing chats.')
    return `${state.profile?.id || ''}:${state.profile?.username || ''}@${state.profile?.host || ''}:${state.home}`
  }
  cancel(id: string) {
    requestId.parse(id)
    this.requests.get(id)?.abort()
  }
  cancelAll() {
    this.generation++
    for (const controller of this.requests.values()) controller.abort()
    this.requests.clear()
    this.rpc?.close(new Error('Host history browsing closed.'))
    this.rpc = undefined
    this.rpcStarting = undefined
    this.rpcStartupSignal = undefined
    this.claudeScanning = undefined
    this.claudeScanSignal = undefined
  }
  private reset() {
    this.cancelAll()
    this.rpcStarting = undefined
    this.catalog.clear()
    this.claudeFiles = []
    this.claudeScanned = 0
    this.claudeIndexWarning = undefined
    this.claudeScanning = undefined
  }
  private async run<T>(
    id: string | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.machine()
    const generation = this.generation
    const controller = new AbortController()
    const key = id || randomUUID()
    this.requests.get(key)?.abort()
    this.requests.set(key, controller)
    try {
      const result = await operation(controller.signal)
      if (generation !== this.generation || controller.signal.aborted)
        throw new Error('Host history request cancelled.')
      return result
    } finally {
      if (this.requests.get(key) === controller) this.requests.delete(key)
    }
  }
  private async codex(signal: AbortSignal): Promise<CodexRPC> {
    if (this.rpc && !this.rpc.closed) return this.rpc
    const generation = this.generation
    if (this.rpcStarting) {
      const pending = this.rpcStarting
      const owner = this.rpcStartupSignal
      try {
        return await untilCancelled(pending, signal)
      } catch (error) {
        if (signal.aborted || generation !== this.generation || !owner?.aborted) throw error
        if (this.rpcStarting === pending) {
          this.rpcStarting = undefined
          this.rpcStartupSignal = undefined
        }
        return this.codex(signal)
      }
    }
    const starting = (async () => {
      // A separate metadata connection cannot interrupt an active provider turn.
      const channel = await this.ssh.channel(
        'exec codex app-server --listen stdio://',
        undefined,
        signal,
        20000,
      )
      if (generation !== this.generation || signal.aborted) {
        channel.close()
        throw new Error('Host history request cancelled.')
      }
      const rpc = new CodexRPC(channel, () => {})
      try {
        await rpc.request(
          'initialize',
          {
            clientInfo: { name: 'life_history', title: 'Life history', version: LIFE_VERSION },
            capabilities: { experimentalApi: false },
          },
          20000,
          signal,
        )
        rpc.send({ method: 'initialized', params: {} })
        if (generation !== this.generation || signal.aborted)
          throw new Error('Host history request cancelled.')
        this.rpc = rpc
        return rpc
      } catch (error) {
        rpc.close(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    })()
    this.rpcStarting = starting
    this.rpcStartupSignal = signal
    try {
      return await starting
    } finally {
      if (this.rpcStarting === starting) {
        this.rpcStarting = undefined
        this.rpcStartupSignal = undefined
      }
    }
  }
  private async scanClaude(signal: AbortSignal, refresh: boolean): Promise<void> {
    if (!refresh && this.claudeScanned && Date.now() - this.claudeScanned < 30000) return
    const generation = this.generation
    if (this.claudeScanning) {
      const pending = this.claudeScanning
      const owner = this.claudeScanSignal
      try {
        return await untilCancelled(pending, signal)
      } catch (error) {
        if (signal.aborted || generation !== this.generation || !owner?.aborted) throw error
        if (this.claudeScanning === pending) {
          this.claudeScanning = undefined
          this.claudeScanSignal = undefined
        }
        return this.scanClaude(signal, refresh)
      }
    }
    const scan = (async () => {
      const root = (
        await this.ssh.exec('printf "%s" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"', {
          signal,
          maxOutputBytes: 8192,
        })
      ).trim()
      if (!safeWorkspace(root))
        throw new Error('Claude history directory did not resolve to an absolute path.')
      // POSIX find plus GNU/BSD stat: no Python, Node or extra remote package.
      // The output cap and request deadline also bound very large history trees.
      const projects = posix.join(root, 'projects')
      const command = `if [ -d ${shellQuote(projects)} ]; then find ${shellQuote(projects)} -type f -name '*.jsonl' -exec sh -c ${shellQuote('for f do m=$(stat -c "%Y %s" "$f" 2>/dev/null) || m=$(stat -f "%m %z" "$f" 2>/dev/null) || continue; printf "%s\\000%s\\000" "$m" "$f"; done')} sh {} + 2>/dev/null | head -c 2000000; fi`
      const output = await this.ssh.exec(command, {
        signal,
        maxOutputBytes: 2_100_000,
        timeoutMs: 30000,
      })
      const parts = output.split('\0')
      const files: Descriptor[] = []
      for (let index = 0; index + 1 < parts.length && files.length < 10000; index += 2) {
        const [mtime, size] = parts[index].split(' ').map(Number)
        const path = parts[index + 1]
        if (
          !safeWorkspace(path) ||
          !path.startsWith(projects + '/') ||
          !Number.isFinite(size) ||
          size < 0
        )
          continue
        const parentMatch = path.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/)
        const remoteId = parentMatch ? parentMatch[2] : posix.basename(path, '.jsonl')
        if (!remoteId || remoteId.length > 200) continue
        files.push({
          id: parentMatch ? `claude:subagent:${parentMatch[1]}:${remoteId}` : `claude:${remoteId}`,
          provider: 'claude',
          remoteId,
          path,
          size,
          updatedAt: mtime * 1000,
          parentRemoteId: parentMatch?.[1],
        })
      }
      files.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
      const seen = new Set<string>()
      if (generation !== this.generation || signal.aborted)
        throw new Error('Host history request cancelled.')
      this.claudeFiles = files.filter((file) => !seen.has(file.id) && Boolean(seen.add(file.id)))
      this.claudeIndexWarning =
        files.length >= 10000 || Buffer.byteLength(output) >= 2000000
          ? 'Claude history reached the bounded index limit of 10,000 transcripts or 2 MB of paths. Additional original sessions remain on the host.'
          : undefined
      this.claudeScanned = Date.now()
    })()
    this.claudeScanning = scan
    this.claudeScanSignal = signal
    try {
      await scan
    } finally {
      if (this.claudeScanning === scan) {
        this.claudeScanning = undefined
        this.claudeScanSignal = undefined
      }
    }
  }
  private async fileBytes(
    file: Descriptor,
    offset: number,
    count: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const output = await this.ssh.exec(
      `tail -c +${offset + 1} ${shellQuote(file.path)} | head -c ${count} | base64`,
      { signal, maxOutputBytes: Math.ceil(count * 1.5) + 8192, timeoutMs: 20000 },
    )
    return Buffer.from(output.replace(/\s/g, ''), 'base64')
  }
  private async claudeSummary(file: Descriptor, signal: AbortSignal): Promise<HostHistorySession> {
    if (file.summary) return file.summary
    // A generated title may precede megabytes of subsequent tool output. Read
    // just title records instead of deriving a title from the user's prompt.
    // One bounded channel avoids three SSH round trips for every sidebar row.
    const path = shellQuote(file.path)
    const metadata = await this.ssh.exec(
      `[ -f ${path} ] || exit 1; head -c ${Math.min(file.size, 128000)} ${path} | base64; printf '\\000'; tail -c ${file.size > 128000 ? 64000 : 0} ${path} | base64; printf '\\000'; LC_ALL=C grep -a -E ${shellQuote('"type"[[:space:]]*:[[:space:]]*"(ai-title|custom-title|summary)"')} ${path} | tail -c 128000 | base64`,
      { signal, maxOutputBytes: 460000, timeoutMs: 20000 },
    )
    const [first, last, titles] = metadata
      .split('\0')
      .map((part) => Buffer.from(part.replace(/\s/g, ''), 'base64').toString('utf8'))
    const summary: HostHistorySession = {
      id: file.id,
      provider: 'claude',
      remoteId: file.remoteId,
      title: 'Untitled Claude Code session',
      createdAt: 0,
      updatedAt: file.updatedAt,
      parentRemoteId: file.parentRemoteId,
      source: file.parentRemoteId ? 'subagent' : 'Claude Code',
    }
    for (const line of [first, last, titles].join('\n').split('\n')) {
      let record: Wire
      try {
        record = object(JSON.parse(line))
      } catch {
        continue
      }
      if (
        record.type === 'ai-title' ||
        record.type === 'custom-title' ||
        record.type === 'summary'
      ) {
        const title = cleanTitle(record.aiTitle || record.customTitle || record.summary)
        if (title) summary.title = title
      }
      summary.workspace ||= safeWorkspace(record.cwd)
      const model = string(object(record.message).model)
      if (model && record.type === 'assistant') summary.model = model
      const time = stamp(record.timestamp)
      if (time && (!summary.createdAt || time < summary.createdAt)) summary.createdAt = time
      summary.updatedAt = Math.max(summary.updatedAt, time)
      if (record.isSidechain === true && !summary.parentRemoteId)
        summary.parentRemoteId = string(record.parentSessionId) || 'subagent'
      summary.agentName ||= cleanTitle(record.agentName || record.agentId) || undefined
    }
    summary.createdAt ||= summary.updatedAt
    summary.lifePurpose = hostHistoryWorkspacePurpose(summary.workspace, this.ssh.state.home)
    file.summary = summary
    this.catalog.set(summary.id, summary)
    return summary
  }
  async list(input: unknown = {}): Promise<HostHistoryList> {
    const options = listSchema.parse(input)
    const machine = this.machine()
    const decoded = decodeCursor(options.cursor)
    if (
      options.cursor &&
      (decoded.kind !== 'list' ||
        decoded.machine !== machine ||
        decoded.provider !== options.provider ||
        decoded.query !== options.query)
    )
      throw new Error('This history page expired. Refresh host history and try again.')
    if (
      options.cursor &&
      (!Number.isSafeInteger(decoded.claude) ||
        Number(decoded.claude) < 0 ||
        Number(decoded.claude) > 10000 ||
        (decoded.codex !== undefined && typeof decoded.codex !== 'string'))
    )
      throw new Error('Invalid history pagination cursor.')
    const cursor: ListCursor = options.cursor
      ? (decoded as unknown as ListCursor)
      : { kind: 'list', machine, provider: options.provider, query: options.query, claude: 0 }
    return this.run(options.requestId, async (signal) => {
      const sessions: HostHistorySession[] = []
      const warnings: string[] = []
      const perProvider = options.provider === 'all' ? Math.ceil(options.limit / 2) : options.limit
      if (options.provider !== 'claude' && !cursor.codexDone) {
        try {
          const rpc = await this.codex(signal)
          let added = 0
          const seen = new Set<string>()
          for (let attempt = 0; attempt < 2; attempt++) {
            const archived = cursor.codexArchived === true
            const result = await rpc.request(
              'thread/list',
              {
                ...(cursor.codex ? { cursor: cursor.codex } : {}),
                limit: Math.max(1, perProvider - added),
                sortKey: 'updated_at',
                sortDirection: 'desc',
                archived,
                sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
                useStateDbOnly: true,
                ...(options.query ? { searchTerm: options.query } : {}),
              },
              20000,
              signal,
            )
            for (const value of array(result.data)) {
              const summary = codexHistorySummary(value)
              if (
                !summary ||
                summary.parentRemoteId ||
                value.ephemeral === true ||
                seen.has(summary.id)
              )
                continue
              summary.lifePurpose = hostHistoryWorkspacePurpose(
                summary.workspace,
                this.ssh.state.home,
              )
              if (summary.lifePurpose === 'customization' || summary.lifePurpose === 'metadata')
                continue
              seen.add(summary.id)
              if (archived) summary.archived = true
              this.catalog.set(summary.id, summary)
              sessions.push(summary)
              added++
            }
            cursor.codex = string(result.nextCursor) || undefined
            cursor.codexDone = !cursor.codex && archived
            if (!cursor.codex && !archived) cursor.codexArchived = true
            if (cursor.codex || cursor.codexDone || added >= perProvider) break
          }
        } catch (error) {
          if (signal.aborted) throw error
          warnings.push(`Codex history: ${error instanceof Error ? error.message : String(error)}`)
          cursor.codexDone = true
        }
      }
      if (options.provider !== 'codex' && !cursor.claudeDone) {
        try {
          await this.scanClaude(signal, options.refresh && !options.cursor)
          if (this.claudeIndexWarning) warnings.push(this.claudeIndexWarning)
          const query = options.query.toLocaleLowerCase()
          let inspected = 0
          let added = 0
          while (
            cursor.claude < this.claudeFiles.length &&
            added < perProvider &&
            inspected++ < 160
          ) {
            const file = this.claudeFiles[cursor.claude++]
            if (file.parentRemoteId) continue
            let summary: HostHistorySession
            try {
              summary = await this.claudeSummary(file, signal)
            } catch (error) {
              if (signal.aborted) throw error
              if (warnings.length < 20)
                warnings.push(
                  `Skipped unavailable Claude session ${file.remoteId}: ${error instanceof Error ? error.message : String(error)}`,
                )
              continue
            }
            if (
              summary.parentRemoteId ||
              summary.lifePurpose === 'customization' ||
              summary.lifePurpose === 'metadata' ||
              (query &&
                !`${summary.title} ${summary.workspace || ''} ${summary.remoteId}`
                  .toLocaleLowerCase()
                  .includes(query))
            )
              continue
            sessions.push(summary)
            added++
          }
          cursor.claudeDone = cursor.claude >= this.claudeFiles.length
        } catch (error) {
          if (signal.aborted) throw error
          warnings.push(
            `Claude Code history: ${error instanceof Error ? error.message : String(error)}`,
          )
          cursor.claudeDone = true
        }
      }
      const more =
        (options.provider !== 'claude' && !cursor.codexDone) ||
        (options.provider !== 'codex' && !cursor.claudeDone)
      return {
        sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
        warnings,
        nextCursor: more ? encodeCursor(cursor) : undefined,
      }
    })
  }
  async read(input: unknown): Promise<HostHistoryPage> {
    const options = readSchema.parse(input)
    const machine = this.machine()
    const decoded = decodeCursor(options.cursor)
    if (
      options.cursor &&
      (decoded.kind !== 'read' || decoded.machine !== machine || decoded.id !== options.id)
    )
      throw new Error('This history page expired. Open the session again.')
    if (
      options.cursor &&
      (!['items', 'turns', 'file'].includes(string(decoded.mode)) ||
        !Number.isSafeInteger(decoded.offset) ||
        Number(decoded.offset) < 0 ||
        !Number.isSafeInteger(decoded.turn) ||
        Number(decoded.turn) < 0 ||
        (decoded.providerCursor !== undefined && typeof decoded.providerCursor !== 'string'))
    )
      throw new Error('Invalid history pagination cursor.')
    if (
      decoded.tools !== undefined &&
      (!Array.isArray(decoded.tools) ||
        decoded.tools.length > 32 ||
        decoded.tools.some(
          (entry) =>
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            entry.some((value) => typeof value !== 'string' || value.length > 100),
        ))
    )
      throw new Error('Invalid history pagination cursor.')
    if (
      (decoded.boundaryBytes !== undefined &&
        (!Number.isSafeInteger(decoded.boundaryBytes) || Number(decoded.boundaryBytes) < 0)) ||
      (decoded.snapshotReady !== undefined && typeof decoded.snapshotReady !== 'boolean') ||
      ['boundaryItemId', 'boundaryTurnId', 'lastTurnId'].some(
        (key) =>
          decoded[key] !== undefined &&
          (typeof decoded[key] !== 'string' || String(decoded[key]).length > 2000),
      )
    )
      throw new Error('Invalid history snapshot cursor.')
    const cursor: ReadCursor = options.cursor
      ? (decoded as unknown as ReadCursor)
      : {
          kind: 'read',
          machine,
          id: options.id,
          mode: options.id.startsWith('codex:') ? 'items' : 'file',
          offset: 0,
          turn: 0,
        }
    return this.run(options.requestId, async (signal) => {
      if (options.id.startsWith('codex:')) return this.readCodex(options, cursor, signal)
      if (!options.id.startsWith('claude:'))
        throw new Error('Select a session from host history first.')
      await this.scanClaude(signal, false)
      const file = this.claudeFiles.find((file) => file.id === options.id)
      if (!file) throw new Error('This provider session no longer exists on the connected host.')
      const session = await this.claudeSummary(file, signal)
      cursor.boundaryBytes ??= file.size
      const boundary = cursor.boundaryBytes
      if (cursor.offset > boundary) throw new Error('Invalid history snapshot cursor.')
      const messages: HostHistoryMessage[] = []
      const warnings: string[] = []
      const context: ParseContext = { turn: cursor.turn, tools: new Map(cursor.tools || []) }
      // Read complete JSONL records in bounded pages, retaining byte offsets.
      // Base64 avoids corrupting a Unicode codepoint at a remote byte boundary.
      const remaining = boundary - cursor.offset
      const requested = Math.min(1_000_000, remaining)
      let bytes = await this.fileBytes(file, cursor.offset, requested, signal)
      let consumed = 0
      while (messages.length < options.limit && consumed < bytes.length) {
        let end = bytes.indexOf(10, consumed)
        if (end < 0 && remaining > requested && bytes.length === requested && consumed === 0) {
          // A single unusually large tool record is read explicitly up to 8 MB.
          for (let size = 2_000_000; end < 0 && size <= 8_000_000; size += 1_000_000) {
            bytes = await this.fileBytes(file, cursor.offset, Math.min(size, remaining), signal)
            end = bytes.indexOf(10)
            if (bytes.length < size || bytes.length >= remaining) break
          }
          if (end < 0 && bytes.length >= 8_000_000)
            throw new Error(
              'This individual provider record exceeds 8 MB. Its original transcript is unchanged; open it on the host to inspect the complete record.',
            )
        }
        if (end < 0) {
          if (cursor.offset + bytes.length < boundary) break
          end = bytes.length
        }
        const line = bytes.subarray(consumed, end).toString('utf8')
        const offset = cursor.offset + consumed
        consumed = Math.min(end + 1, bytes.length)
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          if (line.trim())
            warnings.push(`Skipped an incomplete or malformed provider record at byte ${offset}.`)
          continue
        }
        messages.push(...parseClaudeHistoryRecord(record, context, `${file.remoteId}:${offset}`))
      }
      cursor.offset += consumed
      cursor.turn = context.turn
      cursor.tools = [...context.tools]
        .slice(-32)
        .map(([id, title]) => [id.slice(0, 100), title.slice(0, 100)])
      const nextCursor = cursor.offset < boundary ? encodeCursor(cursor) : undefined
      const children = this.claudeFiles.filter((child) => child.parentRemoteId === file.remoteId)
      if (children.length > 100)
        warnings.push(
          `Showing 100 of ${children.length} saved subagent transcripts; all originals remain on the host.`,
        )
      const subagents: HostHistorySession[] = []
      for (let index = 0; index < Math.min(children.length, 100); index += 3) {
        const results = await Promise.allSettled(
          children
            .slice(index, Math.min(index + 3, 100))
            .map((child) => this.claudeSummary(child, signal)),
        )
        for (const result of results) {
          if (result.status === 'fulfilled') subagents.push(result.value)
          else if (signal.aborted) throw result.reason
          else if (warnings.length < 20)
            warnings.push(
              `A saved subagent transcript could not be read: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            )
        }
      }
      return { session, messages, subagents, nextCursor, warnings: warnings.slice(0, 20) }
    }).then((page) => ({ ...page, ...(options.cursor ? { continuationOf: options.cursor } : {}) }))
  }
  private async readCodex(
    options: ReturnType<typeof readSchema.parse>,
    cursor: ReadCursor,
    signal: AbortSignal,
  ): Promise<HostHistoryPage> {
    const rpc = await this.codex(signal)
    const remoteId = options.id.slice('codex:'.length)
    if (!remoteId || remoteId.length > 200 || /[\x00-\x1f]/.test(remoteId))
      throw new Error('Select a valid Codex session.')
    let session = this.catalog.get(options.id)
    if (!session) {
      const metadata = await rpc.request(
        'thread/read',
        { threadId: remoteId, includeTurns: false },
        20000,
        signal,
      )
      session = codexHistorySummary(metadata.thread)
      if (!session) throw new Error('Codex did not return this session’s metadata.')
      session.lifePurpose = hostHistoryWorkspacePurpose(session.workspace, this.ssh.state.home)
      this.catalog.set(session.id, session)
    }
    let result: Wire
    try {
      if (!cursor.snapshotReady) {
        const latest = await rpc.request(
          cursor.mode === 'turns' ? 'thread/turns/list' : 'thread/items/list',
          {
            threadId: remoteId,
            limit: 1,
            sortDirection: 'desc',
            ...(cursor.mode === 'turns' ? { itemsView: 'notLoaded' } : {}),
          },
          30000,
          signal,
        )
        const entry = array(latest.data)[0]
        if (cursor.mode === 'turns') cursor.boundaryTurnId = string(entry?.id) || undefined
        else cursor.boundaryItemId = string(object(entry?.item).id) || undefined
        cursor.snapshotReady = true
      }
      if (
        (cursor.mode === 'items' && !cursor.boundaryItemId) ||
        (cursor.mode === 'turns' && !cursor.boundaryTurnId)
      )
        return { session, messages: [], subagents: [], warnings: [] }
      result = await rpc.request(
        cursor.mode === 'turns' ? 'thread/turns/list' : 'thread/items/list',
        {
          threadId: remoteId,
          ...(cursor.providerCursor ? { cursor: cursor.providerCursor } : {}),
          limit: cursor.mode === 'turns' ? 10 : options.limit,
          sortDirection: 'asc',
          ...(cursor.mode === 'turns' ? { itemsView: 'full' } : {}),
        },
        30000,
        signal,
      )
    } catch (error) {
      const unsupported =
        error instanceof CodexRequestError &&
        (error.code === -32601 ||
          /unknown variant|method not found|unknown method/i.test(error.message))
      if (!unsupported || cursor.providerCursor) throw error
      if (cursor.mode === 'items') {
        cursor.mode = 'turns'
        cursor.snapshotReady = false
        cursor.boundaryItemId = undefined
        return this.readCodex(options, cursor, signal)
      }
      // Compatibility for pre-pagination app-server versions. The existing RPC
      // frame cap bounds this response; large old histories produce a clear error.
      result = await rpc.request(
        'thread/read',
        { threadId: remoteId, includeTurns: true },
        30000,
        signal,
      )
      result = { data: array(object(result.thread).turns), nextCursor: null }
      cursor.snapshotReady = true
      cursor.boundaryTurnId = string(array(result.data).at(-1)?.id) || undefined
    }
    const messages: HostHistoryMessage[] = []
    let lastTurn = cursor.lastTurnId || ''
    let reachedBoundary = false
    for (const value of array(result.data)) {
      const turnId = string(value.turnId || value.id)
      if (turnId && turnId !== lastTurn) {
        cursor.turn++
        lastTurn = turnId
      }
      if (cursor.mode === 'turns') {
        for (const item of array(value.items))
          messages.push(
            ...codexHistoryItem(
              {
                item,
                startedAtMs: stamp(value.startedAt),
                completedAtMs: stamp(value.completedAt),
              },
              cursor.turn,
              turnId,
            ),
          )
        if (value.error)
          messages.push({
            id: `codex:${turnId}:error`,
            role: 'error',
            text: historyContent(value.error),
            turn: cursor.turn,
            turnId,
          })
      } else messages.push(...codexHistoryItem(value, cursor.turn, turnId))
      if (
        (cursor.mode === 'turns' && turnId === cursor.boundaryTurnId) ||
        (cursor.mode === 'items' && string(object(value.item).id) === cursor.boundaryItemId)
      ) {
        reachedBoundary = true
        break
      }
    }
    cursor.providerCursor = !reachedBoundary ? string(result.nextCursor) || undefined : undefined
    cursor.lastTurnId = lastTurn
    return {
      session,
      messages,
      subagents: [],
      warnings: [],
      nextCursor: cursor.providerCursor ? encodeCursor(cursor) : undefined,
    }
  }
}
