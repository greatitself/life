import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentQuestion, ModelOption, Provider, StartInput } from '../shared/types'
import { shellQuote } from '../shared/validation'
import { SSHConnection } from './ssh'
import { JsonLines } from './json-lines'
import { LIFE_VERSION } from '../shared/version'

type Wire = Record<string, unknown>
const object = (value: unknown): Wire => (value && typeof value === 'object' ? (value as Wire) : {})
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const array = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(object) : [])

class RPC {
  private next = 1
  private closed = false
  private pending = new Map<
    number,
    { resolve: (v: Wire) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  constructor(
    readonly channel: ClientChannel,
    receive: (message: Wire) => void,
  ) {
    const lines = new JsonLines((message) => {
      if (typeof message.id === 'number' && !message.method && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error)
          pending.reject(new Error(string(object(message.error).message) || 'Agent request failed'))
        else pending.resolve(object(message.result))
      } else receive(message)
    })
    channel.on('data', (chunk: Buffer) => lines.push(chunk))
    channel.on('error', (error: Error) => {
      this.closed = true
      this.rejectAll(error)
    })
    channel.on('close', () => {
      this.closed = true
      this.rejectAll(
        new Error('Codex disconnected. Check the remote installation and login, then retry.'),
      )
    })
  }
  send(message: Wire) {
    if (this.closed || this.channel.destroyed) throw new Error('Codex is disconnected')
    this.channel.write(JSON.stringify(message) + '\n')
  }
  request(method: string, params: Wire = {}, timeout = 60000): Promise<Wire> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out. Check the remote agent login in the terminal.`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  private rejectAll(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }
}
interface Session {
  input: StartInput
  remoteId?: string
  turnId?: string
  channel?: ClientChannel
  busy: boolean
  messageId?: string
  streamed: Set<string>
  stderr: string
  approvals: Map<string, { wireId: unknown; method: string; params: Wire }>
  startup?: Promise<void>
  stopRequested: boolean
  stopping?: Promise<void>
  ignoredTurns: Set<string>
  controls: Map<
    string,
    { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >
  workspace: string
  appliedModel?: string
  phase: 'initializing' | 'startingTurn' | 'running'
}
export class Agents {
  private codex?: RPC
  private codexStarting?: Promise<RPC>
  private sessions = new Map<string, Session>()
  private threads = new Map<string, string>()
  private generation = 0
  private defaultCodexModel?: string
  constructor(
    private ssh: SSHConnection,
    private emit: (event: AgentEvent) => void,
  ) {
    ssh.on('disconnected', () => this.close())
  }
  private event(sessionId: string, event: Omit<AgentEvent, 'sessionId'>) {
    this.emit({ sessionId, ...event })
  }
  private async getCodex(): Promise<RPC> {
    if (this.codex) return this.codex
    if (this.codexStarting) return this.codexStarting
    const generation = this.generation
    const starting = (async () => {
      const channel = await this.ssh.channel(
        `cd ${shellQuote(this.ssh.state.workspace!)} && exec codex app-server --listen stdio://`,
      )
      if (this.generation !== generation) {
        channel.close()
        throw new Error('SSH connection cancelled')
      }
      const rpc = new RPC(channel, (message) => {
        if (this.generation === generation) this.receiveCodex(message, rpc)
      })
      let stderr = ''
      channel.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8192)
      })
      channel.on('close', () => {
        if (this.codex && this.codex !== rpc) return
        if (this.codex === rpc) {
          this.codex = undefined
          this.threads.clear()
        }
        if (this.generation !== generation) return
        for (const [id, s] of this.sessions)
          if (s.input.provider === 'codex' && s.busy && !s.stopRequested) {
            s.busy = false
            s.approvals.clear()
            this.event(id, {
              type: 'error',
              text: stderr || 'Codex closed the connection. Reconnect and try again.',
            })
          }
      })
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'life_desktop', title: 'Life', version: LIFE_VERSION },
          capabilities: { experimentalApi: false },
        })
        if (this.generation !== generation) throw new Error('SSH connection cancelled')
        rpc.send({ method: 'initialized', params: {} })
        this.codex = rpc
        return rpc
      } catch (error) {
        channel.close()
        throw error
      }
    })()
    this.codexStarting = starting
    try {
      return await starting
    } finally {
      if (this.codexStarting === starting) this.codexStarting = undefined
    }
  }
  async models(provider: Provider): Promise<ModelOption[]> {
    if (provider === 'claude')
      return [
        { id: '', name: 'Claude default' },
        { id: 'sonnet', name: 'Sonnet' },
        { id: 'opus', name: 'Opus' },
        { id: 'haiku', name: 'Haiku' },
      ]
    const result = await (await this.getCodex()).request('model/list', {})
    const defaultModel = array(result.data).find((model) => model.isDefault)
    if (defaultModel) this.defaultCodexModel = string(defaultModel.model || defaultModel.id)
    return [
      { id: '', name: 'Codex default' },
      ...array(result.data)
        .map((m) => ({
          id: string(m.model || m.id),
          name: string(m.displayName || m.model || m.id),
        }))
        .filter((m) => m.id),
    ]
  }
  async start(input: StartInput) {
    if (this.ssh.state.status !== 'connected') throw new Error('Connect to a machine first')
    const version = this.ssh.state[input.provider]
    if (!version || version === 'missing')
      throw new Error(
        `${input.provider === 'codex' ? 'Codex' : 'Claude Code'} is not installed on this machine. Install and sign in using the terminal.`,
      )
    const old = this.sessions.get(input.sessionId)
    if (old?.busy) throw new Error('This thread is already running')
    if (old && old.input.provider !== input.provider)
      throw new Error('Start a new thread to change providers')
    // Each turn owns its asynchronous callbacks; an earlier cancelled startup
    // must not resume against the next turn's input or stop flag.
    const session: Session = {
      input,
      busy: true,
      approvals: new Map(),
      streamed: new Set(),
      stderr: '',
      remoteId: old?.remoteId || input.remoteId,
      channel: old?.channel,
      stopRequested: false,
      ignoredTurns: old?.ignoredTurns || new Set(),
      controls: new Map(),
      workspace: this.ssh.state.workspace!,
      appliedModel: old?.appliedModel,
      phase: 'initializing',
    }
    this.sessions.set(input.sessionId, session)
    const startup =
      input.provider === 'codex' ? this.startCodex(session) : this.startClaude(session)
    session.startup = startup
    try {
      await startup
    } catch (error) {
      if (!session.stopRequested) {
        session.busy = false
        throw error
      }
    } finally {
      if (session.startup === startup) session.startup = undefined
    }
  }
  private async startCodex(session: Session) {
    const rpc = await this.getCodex()
    const { input } = session
    if (this.sessions.get(input.sessionId) !== session || session.stopRequested) return
    const approvalPolicy = input.mode === 'review' ? 'untrusted' : 'on-request'
    const sandbox = input.mode === 'plan' ? 'read-only' : 'workspace-write'
    if (!input.model && session.appliedModel && !this.defaultCodexModel) await this.models('codex')
    if (session.stopRequested || this.sessions.get(input.sessionId) !== session) return
    if (!session.remoteId || !this.threads.has(session.remoteId)) {
      const result = await rpc.request(session.remoteId ? 'thread/resume' : 'thread/start', {
        ...(session.remoteId ? { threadId: session.remoteId } : {}),
        cwd: session.workspace,
        approvalPolicy,
        sandbox,
        ...(input.model ? { model: input.model } : {}),
      })
      if (this.sessions.get(input.sessionId) !== session)
        throw new Error('SSH connection cancelled')
      if (!input.model && result.model) this.defaultCodexModel = string(result.model)
      session.remoteId = string(object(result.thread).id)
      if (!session.remoteId) throw new Error('Codex did not return a thread ID')
      this.threads.set(session.remoteId, input.sessionId)
      this.event(input.sessionId, { type: 'session', remoteId: session.remoteId })
    }
    if (session.stopRequested) return
    session.phase = 'startingTurn'
    const result = await rpc.request('turn/start', {
      threadId: session.remoteId,
      input: [{ type: 'text', text: input.prompt }],
      cwd: session.workspace,
      approvalPolicy,
      ...(input.model || this.defaultCodexModel
        ? { model: input.model || this.defaultCodexModel }
        : {}),
      sandboxPolicy:
        input.mode === 'plan'
          ? { type: 'readOnly' }
          : { type: 'workspaceWrite', writableRoots: [session.workspace], networkAccess: false },
    })
    session.turnId = string(object(result.turn).id)
    session.appliedModel = input.model
    session.phase = 'running'
  }
  private receiveCodex(message: Wire, rpc: RPC) {
    const method = string(message.method)
    const params = object(message.params)
    const remoteId = string(params.threadId || object(params.thread).id)
    const sessionId = this.threads.get(remoteId)
    if (!sessionId) {
      if (message.id != null && method)
        rpc.send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    const turnId = string(params.turnId || object(params.turn).id)
    if (
      !session.busy ||
      (turnId &&
        (session.ignoredTurns.has(turnId) || (session.turnId && session.turnId !== turnId)))
    ) {
      if (message.id != null && method)
        rpc.send({
          id: message.id,
          error: { code: -32000, message: 'The turn is no longer active' },
        })
      return
    }
    const item = object(params.item)
    if (method === 'item/agentMessage/delta')
      this.event(sessionId, {
        type: 'text',
        text: string(params.delta),
        itemId: string(params.itemId),
      })
    if (
      (method === 'item/started' || method === 'item/completed') &&
      item.type !== 'agentMessage' &&
      item.type !== 'userMessage' &&
      item.type !== 'reasoning'
    ) {
      this.event(sessionId, {
        type: 'tool',
        itemId: string(item.id),
        title:
          item.type === 'commandExecution'
            ? string(item.command)
            : item.type === 'fileChange'
              ? 'Editing files'
              : string(item.type),
        text:
          string(item.aggregatedOutput) ||
          (item.changes ? JSON.stringify(item.changes, null, 2) : ''),
        status: method === 'item/completed' ? string(item.status) || 'completed' : 'running',
      })
    }
    if (method === 'item/completed' && item.type === 'agentMessage')
      this.event(sessionId, {
        type: 'text',
        itemId: string(item.id),
        text: string(item.text),
        status: 'replace',
      })
    if (method === 'item/commandExecution/outputDelta')
      this.event(sessionId, {
        type: 'tool-output',
        itemId: string(params.itemId),
        text: string(params.delta),
      })
    if (method === 'turn/started') session.turnId = string(object(params.turn).id)
    if (method === 'turn/completed') {
      if (turnId) session.ignoredTurns.add(turnId)
      if (session.stopRequested) return
      session.busy = false
      session.approvals.clear()
      const turn = object(params.turn)
      this.event(sessionId, {
        type: turn.status === 'failed' ? 'error' : 'complete',
        status: string(turn.status),
        text: string(object(turn.error).message),
      })
    }
    if (method === 'error')
      this.event(sessionId, {
        type: params.willRetry ? 'status' : 'error',
        text: string(object(params.error).message),
      })
    if (message.id != null && method) {
      const requestId = randomUUID()
      if (
        /requestApproval$/.test(method) &&
        (method.includes('commandExecution') || method.includes('fileChange'))
      ) {
        session.approvals.set(requestId, { wireId: message.id, method, params })
        this.event(sessionId, {
          type: 'approval',
          requestId,
          title: method.includes('fileChange') ? 'Allow file changes?' : 'Allow this command?',
          text: string(params.command || params.reason) || 'Codex needs permission to continue.',
        })
      } else if (method === 'item/tool/requestUserInput') {
        session.approvals.set(requestId, { wireId: message.id, method, params })
        this.event(sessionId, {
          type: 'question',
          requestId,
          questions: array(params.questions) as unknown as AgentQuestion[],
        })
      } else
        rpc.send({
          id: message.id,
          error: { code: -32601, message: 'Life does not support this server request yet' },
        })
    }
  }
  private async startClaude(session: Session) {
    const { input } = session
    if (session.channel) {
      // A new process lets each turn apply the selected model and permission mode.
      const oldChannel = session.channel
      session.channel = undefined
      oldChannel.end()
      oldChannel.close()
    }
    const args = [
      'claude',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      input.mode === 'plan' ? 'plan' : input.mode === 'edit' ? 'acceptEdits' : 'default',
    ]
    if (input.model) args.push(`--model=${input.model}`)
    if (session.remoteId) args.push(`--resume=${session.remoteId}`)
    const channel = await this.ssh.channel(
      `cd ${shellQuote(session.workspace)} && exec ${args.map(shellQuote).join(' ')}`,
    )
    if (this.sessions.get(input.sessionId) !== session || session.stopRequested) {
      channel.close()
      return
    }
    session.channel = channel
    session.stderr = ''
    const lines = new JsonLines((message) => {
      if (session.channel !== channel || this.sessions.get(input.sessionId) !== session) return
      if (message.type === 'control_response') {
        const response = object(message.response)
        const requestId = string(response.request_id)
        const pending = session.controls.get(requestId)
        if (!pending) return
        session.controls.delete(requestId)
        clearTimeout(pending.timer)
        if (response.subtype === 'error')
          pending.reject(new Error(string(response.error) || 'Claude control request failed'))
        else pending.resolve(object(response.response))
      } else this.receiveClaude(session, message)
    })
    channel.on('data', (chunk: Buffer) => lines.push(chunk))
    channel.stderr.on('data', (chunk: Buffer) => {
      if (session.channel === channel)
        session.stderr = (session.stderr + chunk.toString()).slice(-8192)
    })
    const failed = (error: Error) => {
      if (session.channel !== channel) return
      for (const pending of session.controls.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      session.controls.clear()
      session.channel = undefined
      session.approvals.clear()
      if (session.busy && !session.stopRequested) {
        session.busy = false
        this.event(input.sessionId, { type: 'error', text: error.message })
      }
    }
    channel.on('error', (error: Error) => failed(error))
    channel.on('close', () =>
      failed(
        new Error(
          session.stderr ||
            'Claude Code exited before completing this turn. Check its remote login.',
        ),
      ),
    )
    try {
      await this.claudeControl(session, { subtype: 'initialize', hooks: null }, 60000)
      if (session.stopRequested || session.channel !== channel) return
      session.phase = 'running'
      channel.write(
        JSON.stringify({
          type: 'user',
          session_id: session.remoteId || '',
          message: { role: 'user', content: [{ type: 'text', text: input.prompt }] },
          parent_tool_use_id: null,
        }) + '\n',
      )
    } catch (error) {
      channel.close()
      throw error
    }
  }
  private claudeControl(session: Session, request: Wire, timeout: number): Promise<Wire> {
    const channel = session.channel
    if (!channel || channel.destroyed)
      return Promise.reject(new Error('Claude Code is disconnected'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.controls.delete(requestId)
        reject(
          new Error(
            `Claude ${string(request.subtype)} timed out. Check its remote login in the terminal.`,
          ),
        )
      }, timeout)
      session.controls.set(requestId, { resolve, reject, timer })
      try {
        channel.write(
          JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n',
        )
      } catch (error) {
        clearTimeout(timer)
        session.controls.delete(requestId)
        reject(error)
      }
    })
  }
  private receiveClaude(session: Session, message: Wire) {
    const id = session.input.sessionId
    if (message.type === 'control_cancel_request') {
      session.approvals.delete(string(message.request_id))
      return
    }
    if (!session.busy && message.type !== 'system') return
    if (typeof message.session_id === 'string' && message.session_id !== session.remoteId) {
      session.remoteId = message.session_id
      this.event(id, { type: 'session', remoteId: message.session_id })
    }
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      const event = object(message.event)
      const delta = object(event.delta)
      if (event.type === 'message_start')
        session.messageId = string(object(event.message).id) || randomUUID()
      if (delta.type === 'text_delta') {
        const itemId = session.messageId || 'response'
        session.streamed.add(itemId)
        this.event(id, { type: 'text', itemId, text: string(delta.text) })
      }
      const block = object(event.content_block)
      if (event.type === 'content_block_start' && block.type === 'tool_use')
        this.event(id, {
          type: 'tool',
          itemId: string(block.id),
          title: string(block.name),
          status: 'running',
        })
    }
    if (message.type === 'assistant') {
      const content = object(message.message)
      const itemId = string(content.id) || session.messageId || randomUUID()
      const text = array(content.content)
        .filter((b) => b.type === 'text')
        .map((b) => string(b.text))
        .join('\n')
      if (text && !message.parent_tool_use_id)
        this.event(id, { type: 'text', itemId, text, status: 'replace' })
      for (const tool of array(content.content).filter((b) => b.type === 'tool_use'))
        this.event(id, {
          type: 'tool',
          itemId: string(tool.id),
          title: string(tool.name),
          text: JSON.stringify(tool.input, null, 2),
          status: 'running',
        })
    }
    if (message.type === 'user')
      for (const result of array(object(message.message).content).filter(
        (b) => b.type === 'tool_result',
      ))
        this.event(id, {
          type: 'tool',
          itemId: string(result.tool_use_id),
          text:
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          status: result.is_error ? 'failed' : 'completed',
        })
    if (message.type === 'control_request') {
      const request = object(message.request)
      const requestId = string(message.request_id)
      if (request.subtype === 'can_use_tool') {
        session.approvals.set(requestId, {
          wireId: requestId,
          method: string(request.tool_name),
          params: request,
        })
        const toolInput = object(request.input)
        if (request.tool_name === 'AskUserQuestion')
          this.event(id, {
            type: 'question',
            requestId,
            questions: array(toolInput.questions).map((q, i) => ({
              id: string(q.question) || String(i),
              question: string(q.question),
              header: string(q.header),
              options: array(q.options).map((o) => ({
                label: string(o.label),
                description: string(o.description),
              })),
            })),
          })
        else
          this.event(id, {
            type: 'approval',
            requestId,
            title: `Allow ${string(request.tool_name)}?`,
            text: string(toolInput.command) || JSON.stringify(toolInput, null, 2),
          })
      } else
        session.channel?.write(
          JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: requestId,
              error: 'Unsupported control request',
            },
          }) + '\n',
        )
    }
    if (message.type === 'result') {
      if (session.stopRequested) return
      session.busy = false
      session.approvals.clear()
      if (message.is_error)
        this.event(id, {
          type: 'error',
          text:
            (Array.isArray(message.errors) ? message.errors.join('\n') : '') ||
            string(message.result) ||
            string(message.subtype),
        })
      else this.event(id, { type: 'complete', status: 'completed' })
    }
  }
  async respond(
    sessionId: string,
    requestId: string,
    accepted: boolean,
    answers?: Record<string, string[]>,
  ) {
    const session = this.sessions.get(sessionId)
    const approval = session?.approvals.get(requestId)
    if (!session || !approval) throw new Error('This request is no longer pending')
    if (session.input.provider === 'codex') {
      const result =
        approval.method === 'item/tool/requestUserInput'
          ? {
              answers: Object.fromEntries(
                Object.entries(answers || {}).map(([key, value]) => [key, { answers: value }]),
              ),
            }
          : { decision: accepted ? 'accept' : 'decline' }
      if (!this.codex) throw new Error('Codex is disconnected')
      this.codex.send({ id: approval.wireId, result })
    } else {
      const original = object(approval.params.input)
      const updatedInput =
        approval.method === 'AskUserQuestion'
          ? {
              ...original,
              answers: Object.fromEntries(
                Object.entries(answers || {}).map(([key, value]) => [key, value.join(', ')]),
              ),
            }
          : original
      if (!session.channel || session.channel.destroyed)
        throw new Error('Claude Code is disconnected')
      session.channel.write(
        JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: approval.wireId,
            response: accepted
              ? { behavior: 'allow', updatedInput }
              : { behavior: 'deny', message: 'The user declined this action' },
          },
        }) + '\n',
      )
    }
    session.approvals.delete(requestId)
  }
  async stop(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session || !session.busy) return
    if (session.stopping) return session.stopping
    session.stopRequested = true
    const stopping = this.stopSession(sessionId, session)
    session.stopping = stopping
    try {
      await stopping
    } finally {
      if (session.stopping === stopping) session.stopping = undefined
    }
  }
  private async stopSession(sessionId: string, session: Session) {
    // No user prompt has been sent during initialization. Finish immediately;
    // the startup checks the turn identity before issuing any remote work.
    if (session.phase === 'initializing') {
      session.channel?.signal('TERM')
      session.channel?.close()
      session.busy = false
      session.approvals.clear()
      this.event(sessionId, { type: 'complete', status: 'interrupted' })
      return
    }
    await session.startup?.catch(() => {})
    if (this.sessions.get(sessionId) !== session) return
    for (const id of [...session.approvals.keys()]) await this.respond(sessionId, id, false)
    if (
      session.input.provider === 'codex' &&
      session.turnId &&
      !session.ignoredTurns.has(session.turnId)
    ) {
      try {
        await this.codex?.request(
          'turn/interrupt',
          { threadId: session.remoteId, turnId: session.turnId },
          10000,
        )
      } catch (error) {
        // A failed interrupt must not leave the remote agent silently running.
        if (!session.ignoredTurns.has(session.turnId)) {
          this.codex?.channel.signal('TERM')
          this.codex?.channel.close()
        }
        this.event(sessionId, {
          type: 'status',
          text: `Codex interruption failed; its connection was closed. ${(error as Error).message}`,
        })
      }
      session.ignoredTurns.add(session.turnId)
    } else if (session.channel) {
      const channel = session.channel
      try {
        await this.claudeControl(session, { subtype: 'interrupt' }, 10000)
      } catch (error) {
        this.event(sessionId, {
          type: 'status',
          text: `Claude did not acknowledge the interrupt; its process was terminated. ${(error as Error).message}`,
        })
      } finally {
        channel.signal('TERM')
        channel.close()
      }
    }
    session.busy = false
    session.approvals.clear()
    this.event(sessionId, { type: 'complete', status: 'interrupted' })
  }
  async dispose(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.stop(sessionId)
    if (this.sessions.get(sessionId) !== session) return
    session.stopRequested = true
    session.channel?.signal('TERM')
    session.channel?.close()
    for (const pending of session.controls.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Agent session disposed'))
    }
    session.controls.clear()
    if (session.remoteId && this.threads.get(session.remoteId) === sessionId)
      this.threads.delete(session.remoteId)
    this.sessions.delete(sessionId)
  }
  close() {
    this.generation++
    this.codex?.channel.signal('TERM')
    this.codex?.channel.close()
    this.codex = undefined
    this.codexStarting = undefined
    this.defaultCodexModel = undefined
    this.threads.clear()
    for (const [id, session] of this.sessions) {
      const channel = session.channel
      session.channel = undefined
      for (const pending of session.controls.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('SSH disconnected'))
      }
      session.controls.clear()
      channel?.signal('TERM')
      channel?.close()
      if (session.busy)
        this.event(id, {
          type: 'error',
          text: 'SSH disconnected. Reconnect to continue this thread.',
        })
      session.busy = false
      session.stopRequested = true
    }
    this.sessions.clear()
  }
}
