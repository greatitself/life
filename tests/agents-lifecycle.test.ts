import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, StartInput } from '../src/shared/types'

let channelSequence = 0
class Channel extends EventEmitter {
  private id = ++channelSequence
  stderr = new EventEmitter()
  destroyed = false
  initializationDelayed = false
  messages: Record<string, any>[] = []
  closeRequested = false
  resumedId?: string
  activeTurnId?: string
  write(raw: string) {
    const message = JSON.parse(raw)
    this.messages.push(message)
    queueMicrotask(() => {
      if (message.method === 'initialize' && !this.initializationDelayed)
        this.reply({ id: message.id, result: {} })
      if (message.method === 'thread/start' || message.method === 'thread/resume')
        this.reply({
          id: message.id,
          result: { thread: { id: this.resumedId || message.params.threadId || 'saved-id' } },
        })
      if (message.method === 'turn/start') {
        const turnId = `turn-${this.id}-${message.id}`
        this.activeTurnId = turnId
        this.reply({ id: message.id, result: { turn: { id: turnId } } })
        if (message.params.input?.[0]?.text === 'hang') return
        this.reply({
          method: 'turn/completed',
          params: {
            threadId: message.params.threadId,
            turn: { id: turnId, status: 'completed' },
          },
        })
      }
    })
    return true
  }
  signal() {}
  close() {
    this.closeRequested = true
    // SSH close is asynchronous; tests choose when the old notification arrives.
  }
  finishClose() {
    this.destroyed = true
    this.emit('close')
  }
  reply(message: Record<string, unknown>) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }
  initialize() {
    const message = this.messages.find((message) => message.method === 'initialize')!
    this.reply({ id: message.id, result: {} })
  }
  initializeClaude() {
    const message = this.messages.find((message) => message.request?.subtype === 'initialize')!
    this.reply({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id, response: {} },
    })
  }
}

function fixture() {
  const channels: Channel[] = []
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    workspace: '/project',
    codex: 'codex-cli test',
    claude: 'claude test',
  }
  ssh.channel = vi.fn(async () => {
    const channel = new Channel()
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  const start = (extra: Partial<StartInput> = {}) =>
    agents.start({
      sessionId: 'local-thread',
      provider: 'codex',
      prompt: 'hello',
      model: 'test-model',
      mode: 'review',
      ...extra,
    })
  return { channels, ssh, events, agents, start }
}

describe('Codex transport restart lifecycle', () => {
  it('reports active conversations for a reconnect and drops completed turns from that snapshot', async () => {
    const { channels, agents, start } = fixture()
    try {
      await start({ prompt: 'hang' })
      expect(agents.runningSessionEvents()).toEqual([
        { sessionId: 'local-thread', type: 'status', status: 'running', provider: 'codex' },
      ])
      channels[0].reply({
        method: 'turn/completed',
        params: {
          threadId: 'saved-id',
          turn: { id: channels[0].activeTurnId, status: 'completed' },
        },
      })
      await vi.waitFor(() => expect(agents.runningSessionEvents()).toEqual([]))
    } finally {
      agents.close()
    }
  })

  it.each(['same-thread', 'different-thread'])(
    'does not close a replacement Codex transport or emit stale interruption events after a project switch (%s)',
    async (replacementIdentity) => {
      const { channels, ssh, events, agents, start } = fixture()
      try {
        await start({ prompt: 'hang' })
        const stopping = agents.stop('local-thread')
        await vi.waitFor(() =>
          expect(channels[0].messages.some((message) => message.method === 'turn/interrupt')).toBe(
            true,
          ),
        )
        const oldInterrupt = channels[0].messages.find(
          (message) => message.method === 'turn/interrupt',
        )!
        agents.close('Project changed')
        ssh.state.workspace = '/project-b'
        events.length = 0
        const replacementId =
          replacementIdentity === 'same-thread' ? 'local-thread' : 'project-b-thread'
        await start({ sessionId: replacementId, prompt: 'hang' })
        channels[0].reply({
          id: oldInterrupt.id,
          error: { code: -32000, message: 'Old interruption failed after project switch' },
        })
        await stopping
        expect(channels[1].closeRequested).toBe(false)
        expect(agents.hasRunningSessions()).toBe(true)
        expect(events.some((event) => event.type === 'complete' || event.type === 'error')).toBe(
          false,
        )
        expect(events.some((event) => event.text?.includes('interruption failed'))).toBe(false)
      } finally {
        agents.close()
      }
    },
  )

  it('suppresses an old Claude interruption rejection after the same thread starts in another project', async () => {
    const { channels, ssh, events, agents, start } = fixture()
    try {
      const starting = start({ provider: 'claude', prompt: 'old-hang' })
      await vi.waitFor(() =>
        expect(
          channels[0]?.messages.some((message) => message.request?.subtype === 'initialize'),
        ).toBe(true),
      )
      channels[0].initializeClaude()
      await starting
      const stopping = agents.stop('local-thread')
      await vi.waitFor(() =>
        expect(
          channels[0].messages.some((message) => message.request?.subtype === 'interrupt'),
        ).toBe(true),
      )
      agents.close('Project changed')
      ssh.state.workspace = '/project-b'
      events.length = 0
      const replacing = start({ provider: 'claude', prompt: 'new-hang' })
      await vi.waitFor(() =>
        expect(
          channels[1]?.messages.some((message) => message.request?.subtype === 'initialize'),
        ).toBe(true),
      )
      channels[1].initializeClaude()
      await Promise.all([stopping, replacing])
      expect(channels[1].closeRequested).toBe(false)
      expect(agents.hasRunningSessions()).toBe(true)
      expect(
        events.some(
          (event) => event.type === 'complete' || event.type === 'status' || event.type === 'error',
        ),
      ).toBe(false)
    } finally {
      agents.close()
    }
  })

  it('closes a Codex transport still initializing and clears its RPC timer when a project changes', async () => {
    vi.useFakeTimers()
    const { channels, ssh, agents, start } = fixture()
    ssh.channel = vi.fn(async () => {
      const channel = new Channel()
      channel.initializationDelayed = true
      channels.push(channel)
      return channel as unknown as ClientChannel
    })
    try {
      const starting = start()
      await vi.waitFor(() =>
        expect(channels[0]?.messages.some((message) => message.method === 'initialize')).toBe(true),
      )
      expect(vi.getTimerCount()).toBe(1)
      agents.close('Project changed')
      await starting
      expect(channels[0].closeRequested).toBe(true)
      expect(channels[0].destroyed).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(agents.hasRunningSessions()).toBe(false)
    } finally {
      agents.close()
      vi.useRealTimers()
    }
  })

  it('ignores a stale approval-response rejection while stopping a thread in a previous project', async () => {
    const { channels, ssh, events, agents, start } = fixture()
    let rejectApproval!: (error: Error) => void
    try {
      await start({ prompt: 'hang' })
      const turn = channels[0].messages.find((message) => message.method === 'turn/start')!
      channels[0].reply({
        id: 501,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'saved-id',
          turnId: `turn-${(channels[0] as unknown as { id: number }).id}-${turn.id}`,
          command: 'research',
        },
      })
      expect(events.some((event) => event.type === 'approval')).toBe(true)
      const responding = vi.spyOn(agents, 'respond').mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectApproval = reject
          }),
      )
      const stopping = agents.stop('local-thread')
      await vi.waitFor(() => expect(responding).toHaveBeenCalledOnce())
      agents.close('Project changed')
      ssh.state.workspace = '/project-b'
      events.length = 0
      await start({ sessionId: 'project-b-thread', prompt: 'hang' })
      rejectApproval(new Error('Old approval response failed after project change'))
      await expect(stopping).resolves.toBeUndefined()
      expect(channels[1].closeRequested).toBe(false)
      expect(agents.hasRunningSessions()).toBe(true)
      expect(events.some((event) => event.type === 'complete' || event.type === 'error')).toBe(
        false,
      )
    } finally {
      agents.close()
      vi.restoreAllMocks()
    }
  })

  it('ignores a stale close during replacement initialization and resumes the same conversation', async () => {
    const { channels, ssh, events, agents, start } = fixture()
    try {
      await start()
      const oldChannel = channels[0]
      oldChannel.emit('error', new Error('Transport failed'))
      ssh.channel = vi.fn(async () => {
        const replacement = new Channel()
        replacement.initializationDelayed = true
        channels.push(replacement)
        return replacement as unknown as ClientChannel
      })
      events.length = 0
      const replacing = start()
      await vi.waitFor(() => expect(channels).toHaveLength(2))
      await vi.waitFor(() =>
        expect(channels[1].messages.some((message) => message.method === 'initialize')).toBe(true),
      )
      oldChannel.finishClose()
      expect(events.some((event) => event.type === 'error')).toBe(false)
      channels[1].initialize()
      await replacing
      expect(
        channels[1].messages.find((message) => message.method === 'thread/resume')?.params,
      ).toMatchObject({ threadId: 'saved-id', excludeTurns: true })
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(events.some((event) => event.type === 'complete')).toBe(true)
    } finally {
      agents.close()
    }
  })

  it('clears Claude initialization controls immediately even when SSH close is not acknowledged', async () => {
    vi.useFakeTimers()
    const { channels, agents, start } = fixture()
    try {
      const starting = start({ provider: 'claude' })
      await vi.waitFor(() =>
        expect(
          channels[0]?.messages.some((message) => message.request?.subtype === 'initialize'),
        ).toBe(true),
      )
      expect(vi.getTimerCount()).toBe(1)
      await agents.stop('local-thread')
      await starting
      expect(channels[0].closeRequested).toBe(true)
      expect(channels[0].destroyed).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(agents.hasRunningSessions()).toBe(false)
    } finally {
      agents.close()
      vi.useRealTimers()
    }
  })

  it('resumes a remotely unloaded thread instead of sending a turn against its stale loaded binding', async () => {
    const { channels, agents, start } = fixture()
    try {
      await start()
      channels[0].reply({ method: 'thread/closed', params: { threadId: 'saved-id' } })
      await start()
      expect(
        channels[0].messages.filter((message) => message.method === 'thread/resume'),
      ).toHaveLength(1)
    } finally {
      agents.close()
    }
  })

  it('fails active turns immediately on transport loss before a delayed SSH close acknowledgement', async () => {
    const { channels, events, agents, start } = fixture()
    try {
      await start({ prompt: 'hang' })
      expect(agents.hasRunningSessions()).toBe(true)
      channels[0].emit('error', new Error('The Codex transport was lost'))
      expect(channels[0].destroyed).toBe(false)
      expect(events.find((event) => event.type === 'error')?.text).toBe(
        'The Codex transport was lost',
      )
      expect(agents.hasRunningSessions()).toBe(false)
      await start()
      expect(
        channels[1].messages.find((message) => message.method === 'thread/resume')?.params.threadId,
      ).toBe('saved-id')
      channels[0].finishClose()
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    } finally {
      agents.close()
    }
  })

  it('preserves a requested remote conversation when a provider returns an unexpected ID', async () => {
    const { channels, agents, start } = fixture()
    try {
      await start()
      channels[0].reply({ method: 'thread/closed', params: { threadId: 'saved-id' } })
      channels[0].resumedId = 'different-conversation'
      await expect(start()).rejects.toThrow(/different conversation/)
      channels[0].resumedId = undefined
      await start()
      const resumes = channels[0].messages.filter((message) => message.method === 'thread/resume')
      expect(resumes.every((message) => message.params.threadId === 'saved-id')).toBe(true)
    } finally {
      agents.close()
    }
  })
})
