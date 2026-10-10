import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent } from '../src/shared/types'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>

class ClaudeChannel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  sent: Wire[] = []
  signals: string[] = []

  write(raw: string) {
    const message = JSON.parse(raw) as Wire
    this.sent.push(message)
    if (message.type === 'control_request')
      queueMicrotask(() =>
        this.reply({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response:
              message.request.subtype === 'initialize'
                ? { session_state: 'idle', current_permission_mode: 'default' }
                : {},
          },
        }),
      )
    return true
  }

  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }

  signal(signal: string) {
    this.signals.push(signal)
  }

  close() {
    this.destroyed = true
    this.emit('close')
  }

  responses(requestId: string) {
    return this.sent.filter(
      (message) => message.type === 'control_response' && message.response.request_id === requestId,
    )
  }
}

const form = {
  subtype: 'elicitation',
  mcp_server_name: 'configuration-server',
  message: 'Select this task’s configuration.',
  title: 'Configure the task',
  display_name: 'Configuration service',
  description: 'Only the values you submit will be sent.',
  requested_schema: {
    type: 'object',
    properties: {
      count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10 },
      ratio: { type: 'number', minimum: 0, maximum: 1 },
      enabled: { type: 'boolean' },
      choice: { type: 'string', enum: ['first', 'second'] },
      selections: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      optional: { type: 'string', default: 'never submit automatically' },
    },
    required: ['count', 'ratio', 'enabled', 'choice'],
  },
}
const answers = {
  count: ['3'],
  ratio: ['0.5'],
  enabled: ['false'],
  choice: ['first'],
  selections: ['b'],
}
const content = { count: 3, ratio: 0.5, enabled: false, choice: 'first', selections: ['b'] }
const urlRequest = {
  subtype: 'elicitation',
  mcp_server_name: 'external-service',
  mode: 'url',
  message: 'Visit the service to complete this task.',
  title: 'Continue with the external service',
  display_name: 'External service',
  description: 'Complete the interaction in your browser.',
  url: 'https://service.example.test/consent',
  elicitation_id: 'external-consent',
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
})

async function fixture() {
  const channel = new ClaudeChannel()
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    claude: '2.1.296 (Claude Code)',
  }
  ssh.channel = vi.fn(async () => channel as unknown as ClientChannel)
  ssh.exec = vi.fn(async () => {
    throw new Error('Native request tests must not run inference or shell commands')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  await agents.start({
    sessionId: 'local',
    provider: 'claude',
    prompt: 'A user-authored request',
    mode: 'review',
  })
  channel.reply({ type: 'system', subtype: 'init', session_id: 'root-session' })
  const request = (requestId: string, nativeRequest: Wire = form, extra: Wire = {}) =>
    channel.reply({
      type: 'control_request',
      request_id: requestId,
      request: nativeRequest,
      ...extra,
    })
  const finishRoot = () =>
    channel.reply({
      type: 'result',
      session_id: 'root-session',
      subtype: 'success',
      is_error: false,
      result: '',
    })
  return { agents, events, channel, ssh, request, finishRoot }
}

function nativeResponse(requestId: string, response: Wire) {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  }
}

describe('Claude MCP elicitation integration', () => {
  it.each([undefined, 'form'])(
    'shows native forms and submits exact typed success envelopes (mode: %s)',
    async (mode) => {
      const { agents, events, channel, request, ssh } = await fixture()
      const native = mode === undefined ? form : { ...form, mode }
      request('form-input', native)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'question',
          requestId: 'form-input',
          questions: expect.arrayContaining([
            expect.objectContaining({ id: 'count', inputType: 'integer', required: true }),
            expect.objectContaining({ id: 'ratio', inputType: 'number' }),
            expect.objectContaining({ id: 'enabled', inputType: 'boolean' }),
            expect.objectContaining({ id: 'selections', multiple: true }),
            expect.objectContaining({ id: 'optional', required: false }),
          ]),
        }),
      )
      expect(channel.responses('form-input')).toEqual([])
      await agents.respond('local', 'form-input', true, answers)
      expect(channel.responses('form-input')).toEqual([
        nativeResponse('form-input', { action: 'accept', content }),
      ])
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'request-resolved',
          requestId: 'form-input',
          status: 'answered',
        }),
      )
      expect(ssh.exec).not.toHaveBeenCalled()
    },
  )

  it('shows native URL consent with the provider title, message, and URL and sends no fabricated form values', async () => {
    const { agents, events, channel, request } = await fixture()
    request('external-input', urlRequest)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval',
        requestId: 'external-input',
        title: urlRequest.title,
        text: expect.stringContaining(urlRequest.message),
        details: expect.objectContaining({
          url: urlRequest.url,
          elicitation_id: 'external-consent',
        }),
      }),
    )
    expect(
      events.some((event) => event.type === 'question' && event.requestId === 'external-input'),
    ).toBe(false)
    await agents.respond('local', 'external-input', true, { unrequested: ['never submit this'] })
    expect(channel.responses('external-input')).toEqual([
      nativeResponse('external-input', { action: 'accept' }),
    ])
  })

  it.each([form, urlRequest])(
    'declines native elicitations without disclosing any entered values: %j',
    async (native) => {
      const { agents, channel, request } = await fixture()
      request('declined-input', native)
      await agents.respond('local', 'declined-input', false, {
        unrequested: ['do not disclose this'],
      })
      expect(channel.responses('declined-input')).toEqual([
        nativeResponse('declined-input', { action: 'decline' }),
      ])
    },
  )

  it('keeps invalid form answers pending without replying and allows an explicit corrected retry', async () => {
    const { agents, events, channel, request } = await fixture()
    request('retry-input')
    await expect(
      agents.respond('local', 'retry-input', true, { ...answers, count: ['1.5'] }),
    ).rejects.toThrow(/number limits/)
    expect(channel.responses('retry-input')).toEqual([])
    expect(
      events.some(
        (event) => event.type === 'request-resolved' && event.requestId === 'retry-input',
      ),
    ).toBe(false)
    await agents.respond('local', 'retry-input', true, answers)
    expect(channel.responses('retry-input')).toEqual([
      nativeResponse('retry-input', { action: 'accept', content }),
    ])
    await expect(agents.respond('local', 'retry-input', true, answers)).rejects.toThrow(
      /no longer pending/,
    )
  })

  it.each([
    { ...form, mode: 'unsupported' },
    { ...form, requested_schema: { type: 'object', properties: { nested: { type: 'object' } } } },
    { ...form, requested_schema: null },
  ])(
    'declines unsupported incoming requests with a visible status instead of leaving a pending form: %j',
    async (native) => {
      const { agents, events, channel, request } = await fixture()
      request('unsupported-input', native)
      expect(channel.responses('unsupported-input')).toEqual([
        nativeResponse('unsupported-input', { action: 'decline' }),
      ])
      expect(
        events.some(
          (event) =>
            ['question', 'approval'].includes(event.type) &&
            event.requestId === 'unsupported-input',
        ),
      ).toBe(false)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'status',
          text: expect.stringMatching(/cannot|unsupported/i),
        }),
      )
      await expect(agents.respond('local', 'unsupported-input', true, answers)).rejects.toThrow(
        /no longer pending/,
      )
    },
  )

  it('routes child elicitation after the root becomes idle through the child identity and original request ID', async () => {
    const { agents, events, channel, request, finishRoot } = await fixture()
    finishRoot()
    expect(agents.hasRunningSessions()).toBe(false)
    request('child-input', form, { session_id: 'child-session', parent_tool_use_id: 'delegate' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'question',
        requestId: 'child-input',
        agentId: 'delegate',
        parentItemId: 'delegate',
      }),
    )
    await agents.respond('local', 'child-input', true, answers)
    expect(channel.responses('child-input')).toEqual([
      nativeResponse('child-input', { action: 'accept', content }),
    ])
    expect(events.filter((event) => event.type === 'complete' && !event.agentId)).toHaveLength(1)
    expect(
      events.some((event) => event.type === 'session' && event.remoteId === 'child-session'),
    ).toBe(false)
  })

  it('removes native control cancellations from pending requests and never responds after cancellation', async () => {
    const { agents, events, channel, request } = await fixture()
    request('cancelled-input')
    channel.reply({ type: 'control_cancel_request', request_id: 'cancelled-input' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'request-resolved',
        requestId: 'cancelled-input',
        status: 'cancelled',
      }),
    )
    await expect(agents.respond('local', 'cancelled-input', true, answers)).rejects.toThrow(
      /no longer pending/,
    )
    expect(channel.responses('cancelled-input')).toEqual([])
  })

  it('declines pending native forms on explicit Stop before terminating the provider process', async () => {
    const { agents, events, channel, request } = await fixture()
    request('stopped-input')
    await agents.stop('local')
    expect(channel.responses('stopped-input')).toEqual([
      nativeResponse('stopped-input', { action: 'decline' }),
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'request-resolved',
        requestId: 'stopped-input',
        status: 'declined',
      }),
    )
    expect(channel.signals).toContain('TERM')
    expect(channel.destroyed).toBe(true)
    await expect(agents.respond('local', 'stopped-input', true, answers)).rejects.toThrow(
      /no longer pending/,
    )
  })

  it('does not duplicate a form when the same native control request is replayed', async () => {
    const { agents, events, channel, request } = await fixture()
    request('replayed-input')
    request('replayed-input')
    expect(
      events.filter((event) => event.type === 'question' && event.requestId === 'replayed-input'),
    ).toHaveLength(1)
    await agents.respond('local', 'replayed-input', true, answers)
    expect(channel.responses('replayed-input')).toHaveLength(1)
  })
})
