import { randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import type { AgentEvent } from '../shared/types'
import { shellQuote } from '../shared/validation'
import { JsonLines } from './json-lines'

type Wire = Record<string, unknown>
const object = (value: unknown): Wire => (value && typeof value === 'object' ? (value as Wire) : {})
const string = (value: unknown) => (typeof value === 'string' ? value : '')

/** Promptless metadata controls, with bounded requests and deterministic cleanup. */
export function claudeMetadataControls(channel: ClientChannel) {
  const pending = new Map<
    string,
    { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  let stderr = ''
  const fail = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  const lines = new JsonLines((message) => {
    if (message.type !== 'control_response') return
    const response = object(message.response)
    const requestId = string(response.request_id)
    const request = pending.get(requestId)
    if (!request) return
    pending.delete(requestId)
    clearTimeout(request.timer)
    if (response.subtype === 'error')
      request.reject(new Error(string(response.error) || 'Claude metadata request failed'))
    else request.resolve(object(response.response))
  })
  const data = (chunk: Buffer) => lines.push(chunk)
  const errorData = (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192)
  }
  const closed = () => fail(new Error(stderr || 'Claude metadata connection closed'))
  channel.on('data', data)
  channel.stderr.on('data', errorData)
  channel.on('error', fail)
  channel.on('close', closed)
  return {
    request(request: Wire, timeout = 15000): Promise<Wire> {
      if (channel.destroyed) return Promise.reject(new Error('Claude metadata connection closed'))
      const requestId = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`Claude ${string(request.subtype)} metadata request timed out`))
        }, timeout)
        pending.set(requestId, { resolve, reject, timer })
        try {
          channel.write(
            JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n',
          )
        } catch (error) {
          pending.delete(requestId)
          clearTimeout(timer)
          reject(error)
        }
      })
    },
    close() {
      fail(new Error('Claude metadata request cancelled'))
      channel.off('data', data)
      channel.stderr.off('data', errorData)
      channel.off('error', fail)
      channel.off('close', closed)
    },
  }
}

/** Root may use review/edit modes, but Claude refuses even enabling bypass as root. */
export function claudeLaunchCommand(workspace: string, args: string[]): string {
  const command = `exec env CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 ${args.map(shellQuote).join(' ')}`
  return `cd ${shellQuote(workspace)} && if [ "$(id -u)" = 0 ]; then ${command}; else ${command} ${shellQuote('--allow-dangerously-skip-permissions')}; fi`
}

export function claudeRestoresUsageTotals(version: string): boolean {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const [, major, minor, patch] = match.map(Number)
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 277)))
}

export function claudeAdvisoryEvent(message: Wire): Output | undefined {
  if (message.type === 'rate_limit_event') {
    const info = object(message.rate_limit_info)
    if (info.status === 'allowed') return undefined
    return {
      type: 'status',
      itemId: `claude-rate-limit-${string(info.rateLimitType) || 'account'}`,
      title: 'Claude usage limit',
      text:
        info.status === 'rejected'
          ? 'Claude has reached its usage limit.'
          : 'Claude is nearing its usage limit.',
      details: { rateLimitInfo: info },
    }
  }
  if (message.type === 'tool_progress')
    return {
      type: 'tool',
      itemId: string(message.tool_use_id),
      title: string(message.tool_name),
      status: 'running',
      details: message,
    }
  if (message.type !== 'system') return undefined
  if (message.subtype === 'permission_denied')
    return {
      type: 'tool',
      itemId: string(message.tool_use_id),
      title: string(message.tool_name),
      status: 'failed',
      text:
        string(message.message || message.decision_reason) || 'Claude Code denied this tool call.',
      details: message,
    }
  if (message.subtype === 'api_retry')
    return {
      type: 'status',
      itemId: `claude-retry-${string(message.uuid) || 'request'}`,
      title: 'Claude is retrying',
      text: `Claude is retrying the request${typeof message.attempt === 'number' ? ` (attempt ${message.attempt})` : ''}.`,
      details: message,
    }
  if (message.subtype === 'status')
    return {
      type: 'status',
      status: message.status === 'compacting' ? 'compacting' : 'running',
      text: message.status === 'compacting' ? 'Claude is compacting the conversation.' : '',
      details: message,
    }
  if (message.subtype === 'compact_boundary')
    return {
      type: 'status',
      title: 'Conversation compacted',
      text: 'Claude compacted the conversation.',
      details: message.compact_metadata,
    }
  if (message.subtype === 'local_command_output')
    return {
      type: 'text',
      itemId: `command-${string(message.uuid) || randomUUID()}`,
      text: string(message.content),
      status: 'replace',
    }
  if (message.subtype === 'informational')
    return {
      type: 'status',
      itemId: `notice-${string(message.uuid) || randomUUID()}`,
      text: string(message.content),
      details: { level: message.level, preventContinuation: message.prevent_continuation },
    }
  return undefined
}

type Block = { type: string; text: string; complete: boolean }
type Message = { id: string; blocks: Map<number, Block>; current?: number }
type Output = Pick<AgentEvent, 'type' | 'itemId' | 'text' | 'status' | 'title' | 'details'>

/**
 * Claude emits a complete assistant envelope for each content block, sharing an
 * API message ID. Reconcile each block with its own deltas rather than replacing
 * earlier text when a later block in that message completes.
 */
export class ClaudeMessageBlocks {
  private messages = new Map<string, Message>()
  private active = new Map<string, string>()
  private envelopes = new Set<string>()

  resetRoot() {
    this.active.delete('root')
    for (const key of this.messages.keys()) if (key.startsWith('root\0')) this.messages.delete(key)
    for (const key of this.envelopes) if (key.startsWith('root\0')) this.envelopes.delete(key)
  }

  private message(stream: string, id?: string): Message {
    const identity = id || this.active.get(stream) || randomUUID()
    this.active.set(stream, identity)
    const key = `${stream}\0${identity}`
    let message = this.messages.get(key)
    if (!message) {
      message = { id: identity, blocks: new Map() }
      this.messages.set(key, message)
    }
    return message
  }

  private itemId(message: Message, index: number, type: string): string {
    if (type === 'thinking') return `${message.id}:thinking:${index}`
    return index === 0 ? message.id : `${message.id}:block:${index}`
  }

  stream(event: Wire, parent?: string): Output[] {
    const stream = parent || 'root'
    if (event.type === 'message_start') {
      this.message(stream, string(object(event.message).id) || randomUUID())
      return []
    }
    const message = this.message(stream)
    const index =
      typeof event.index === 'number' && Number.isSafeInteger(event.index) && event.index >= 0
        ? event.index
        : (message.current ?? 0)
    if (event.type === 'content_block_start') {
      const block = object(event.content_block)
      const type = string(block.type)
      message.current = index
      message.blocks.set(index, {
        type,
        text: type === 'thinking' ? string(block.thinking) : string(block.text),
        complete: false,
      })
      if (type === 'tool_use' || type === 'server_tool_use')
        // Native Agent/Task canonical blocks carry their complete delegation
        // input; a temporary generic tool row would otherwise remain running.
        return [
          {
            type: block.name === 'Agent' || block.name === 'Task' ? 'subagent' : 'tool',
            itemId: string(block.id),
            title: string(block.name),
            status: 'running',
            ...(block.name === 'Agent' || block.name === 'Task'
              ? { agentId: string(block.id) }
              : {}),
            details: block,
          },
        ]
      return []
    }
    if (event.type !== 'content_block_delta') return []
    const delta = object(event.delta)
    const type =
      delta.type === 'thinking_delta' ? 'thinking' : delta.type === 'text_delta' ? 'text' : ''
    if (!type) return []
    const text = type === 'thinking' ? string(delta.thinking) : string(delta.text)
    if (!text) return []
    let block = message.blocks.get(index)
    if (!block) {
      block = { type, text: '', complete: false }
      message.blocks.set(index, block)
    }
    block.text += text
    message.current = index
    return [
      {
        type: type === 'thinking' ? 'reasoning' : 'text',
        itemId: this.itemId(message, index, type),
        text,
      },
    ]
  }

  assistant(content: Wire, uuid?: string, parent?: string): Output[] {
    const stream = parent || 'root'
    if (uuid) {
      const key = `${stream}\0${uuid}`
      if (this.envelopes.has(key)) return []
      this.envelopes.add(key)
    }
    const message = this.message(stream, string(content.id) || undefined)
    const blocks = Array.isArray(content.content) ? content.content.map(object) : []
    const outputs: Output[] = []
    for (const [position, contentBlock] of blocks.entries()) {
      const type = string(contentBlock.type)
      const current =
        message.current === undefined ? undefined : message.blocks.get(message.current)
      const index =
        blocks.length > 1
          ? position
          : current && !current.complete && current.type === type
            ? message.current!
            : Math.max(-1, ...message.blocks.keys()) + 1
      const text = type === 'thinking' ? string(contentBlock.thinking) : string(contentBlock.text)
      message.blocks.set(index, { type, text, complete: true })
      message.current = index
      if ((type === 'text' || type === 'thinking') && text)
        outputs.push({
          type: type === 'thinking' ? 'reasoning' : 'text',
          itemId: this.itemId(message, index, type),
          text,
          status: 'replace',
        })
    }
    return outputs
  }

  hasEnvelope(uuid: string, parent?: string): boolean {
    return this.envelopes.has(`${parent || 'root'}\0${uuid}`)
  }

  matchesText(result: string): boolean {
    const message = this.message('root')
    const text = [...message.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .filter(([, block]) => block.type === 'text')
      .map(([, block]) => block.text)
    return (
      text.length > 0 &&
      (result === text.join('\n') || result === text.join('') || result === text.at(-1))
    )
  }

  text(id?: string, parent?: string): string {
    const message = this.message(parent || 'root', id)
    return [...message.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .filter(([, block]) => block.type === 'text')
      .map(([, block]) => block.text)
      .join('\n')
  }
}
