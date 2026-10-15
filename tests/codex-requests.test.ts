import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents, codexModelOption } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent } from '../src/shared/types'
import {
  codexApprovalChoices,
  codexApprovalPresentation,
  codexElicitationQuestions,
  codexRequestResponse,
} from '../src/main/codex-requests'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>
const permissions = {
  network: { enabled: true },
  fileSystem: {
    read: ['/project/reference'],
    write: ['/project/result'],
    entries: [{ path: { type: 'path', path: '/project/result' }, access: 'write' }],
  },
}
const form = {
  mode: 'form',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 2, maxLength: 20, default: 'do not use' },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      enabled: { type: 'boolean' },
      choice: { type: 'string', oneOf: [{ const: 'a', title: 'Choice A' }, { const: 'b' }] },
      tags: { type: 'array', items: { type: 'string', enum: ['one', 'two'] }, maxItems: 2 },
      optional: { type: 'string', default: 'not an answer' },
    },
    required: ['name', 'count', 'enabled', 'choice'],
  },
}

describe('Codex native request responses', () => {
  it('grants exactly the requested access for one turn and leaves the request unchanged', () => {
    expect(codexRequestResponse('item/permissions/requestApproval', { permissions }, true)).toEqual(
      {
        permissions,
        scope: 'turn',
      },
    )
    expect(
      codexRequestResponse('item/permissions/requestApproval', { permissions }, false),
    ).toEqual({
      permissions: {},
      scope: 'turn',
    })
    expect(permissions.fileSystem.write).toEqual(['/project/result'])
  })

  it('omits unrequested permission categories rather than broadening a grant', () => {
    expect(
      codexRequestResponse(
        'item/permissions/requestApproval',
        { permissions: { network: null, fileSystem: permissions.fileSystem, unrequested: true } },
        true,
      ),
    ).toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: 'turn' })
  })

  it('maps explicit primitive form answers to their requested types without inserting defaults', () => {
    expect(
      codexRequestResponse('mcpServer/elicitation/request', form, true, {
        name: ['Ada'],
        count: ['3'],
        enabled: ['false'],
        choice: ['a'],
        tags: ['one', 'two'],
      }),
    ).toEqual({
      action: 'accept',
      content: { name: 'Ada', count: 3, enabled: false, choice: 'a', tags: ['one', 'two'] },
      _meta: null,
    })
    const questions = codexElicitationQuestions(form)
    expect(questions.find((question) => question.id === 'optional')).toMatchObject({
      required: false,
    })
    expect(questions.find((question) => question.id === 'choice')?.options?.[0]).toEqual({
      label: 'Choice A',
      value: 'a',
    })
    expect(questions.find((question) => question.id === 'tags')).toMatchObject({ multiple: true })
    expect(JSON.stringify(questions)).not.toContain('do not use')
  })

  it('accepts the native nullable required list without requiring or defaulting optional fields', () => {
    // Codex 0.162.1's generated McpElicitationSchema permits required: null.
    const optionalForm = {
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { note: { type: 'string', title: null, description: null, default: 'unused' } },
        required: null,
      },
    }
    expect(codexElicitationQuestions(optionalForm)).toEqual([
      expect.objectContaining({ id: 'note', required: false }),
    ])
    expect(codexRequestResponse('mcpServer/elicitation/request', optionalForm, true)).toEqual({
      action: 'accept',
      content: {},
      _meta: null,
    })
    expect(
      codexRequestResponse('mcpServer/elicitation/request', optionalForm, true, {
        note: ['  user answer  '],
      }).content,
    ).toEqual({ note: '  user answer  ' })
  })

  it.each([
    [{ name: ['A'] }, /length/],
    [{ count: ['1.5'] }, /number limits/],
    [{ count: ['NaN'] }, /valid number/],
    [{ enabled: ['yes'] }, /Yes or No/],
    [{ choice: ['unknown'] }, /offered answers/],
    [{ tags: ['one', 'one'] }, /selection limits/],
    [{ name: [] }, /Answer Name/],
    [{ unexpected: ['extra'] }, /did not request/],
  ])('keeps malformed form input pending: %j', (override, message) => {
    expect(() =>
      codexRequestResponse('mcpServer/elicitation/request', form, true, {
        name: ['Ada'],
        count: ['3'],
        enabled: ['true'],
        choice: ['a'],
        ...override,
      }),
    ).toThrow(message)
  })

  it('declines forms without parsing or sending their answers', () => {
    expect(
      codexRequestResponse('mcpServer/elicitation/request', {}, false, { name: ['private'] }),
    ).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    })
  })

  it('preserves explicitly submitted empty strings, empty enum values and empty required arrays', () => {
    const emptyForm = {
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          choice: { type: 'string', enum: ['', 'one'] },
          choices: { type: 'array', items: { type: 'string', enum: ['one'] } },
        },
        required: ['text', 'choice', 'choices'],
      },
    }
    const questions = codexElicitationQuestions(emptyForm)
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'text', allowEmpty: true }),
        expect.objectContaining({ id: 'choice', isOther: false, allowEmpty: true }),
        expect.objectContaining({ id: 'choices', isOther: false, allowEmpty: true }),
      ]),
    )
    expect(
      codexRequestResponse('mcpServer/elicitation/request', emptyForm, true, {
        text: [''],
        choice: [''],
        choices: [],
      }),
    ).toMatchObject({ content: { text: '', choice: '', choices: [] } })
    expect(() =>
      codexRequestResponse('mcpServer/elicitation/request', emptyForm, true, {}),
    ).toThrow(/Answer text/)
  })

  it('supports current MCP titled multi-select item unions without a redundant string type', () => {
    const titledForm = {
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: {
          selections: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: {
              anyOf: [
                { const: 'alpha', title: 'Alpha display' },
                { const: 'beta', title: 'Beta display' },
              ],
            },
          },
        },
        required: ['selections'],
      },
    }
    expect(codexElicitationQuestions(titledForm)[0]).toMatchObject({
      multiple: true,
      isOther: false,
      allowEmpty: false,
      options: [
        { label: 'Alpha display', value: 'alpha' },
        { label: 'Beta display', value: 'beta' },
      ],
    })
    expect(
      codexRequestResponse('mcpServer/elicitation/request', titledForm, true, {
        selections: ['alpha', 'beta'],
      }),
    ).toMatchObject({ content: { selections: ['alpha', 'beta'] } })
    expect(() =>
      codexRequestResponse('mcpServer/elicitation/request', titledForm, true, {
        selections: ['Alpha display'],
      }),
    ).toThrow(/offered answers/)
  })

  it('confirms URL elicitations explicitly without generating form data', () => {
    expect(codexRequestResponse('mcpServer/elicitation/request', { mode: 'url' }, true)).toEqual({
      action: 'accept',
      content: null,
      _meta: null,
    })
  })

  it('does not turn Allow once into a session or policy grant when the provider restricts choices', () => {
    expect(() =>
      codexRequestResponse(
        'item/commandExecution/requestApproval',
        {
          availableDecisions: ['acceptForSession', 'decline'],
        },
        true,
      ),
    ).toThrow(/does not offer approval for one action/)
    expect(codexRequestResponse('item/commandExecution/requestApproval', {}, true)).toEqual({
      decision: 'accept',
    })
  })

  it('presents the ordered native choices with their actual scope and maps explicit selections exactly', () => {
    const execpolicy = {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'run', 'build'] },
    }
    const networkAllow = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'reference.example', action: 'allow' },
      },
    }
    const networkDeny = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'reference.example', action: 'deny' },
      },
    }
    const availableDecisions = [
      'accept',
      'acceptForSession',
      execpolicy,
      networkAllow,
      networkDeny,
      'decline',
      'cancel',
    ]
    const params = { availableDecisions }
    const choices = codexApprovalChoices(
      'item/commandExecution/requestApproval',
      params,
    ).approvalChoices!
    expect(choices.map(({ id, label, outcome }) => ({ id, label, outcome }))).toEqual([
      { id: 'codex-approval:0', label: 'Allow once', outcome: 'approved' },
      { id: 'codex-approval:1', label: 'Allow for this session', outcome: 'approved' },
      { id: 'codex-approval:2', label: 'Allow and save command rule', outcome: 'approved' },
      { id: 'codex-approval:3', label: 'Always allow reference.example', outcome: 'approved' },
      { id: 'codex-approval:4', label: 'Always deny reference.example', outcome: 'declined' },
      { id: 'codex-approval:5', label: 'Decline', outcome: 'declined' },
      { id: 'codex-approval:6', label: 'Cancel this turn', outcome: 'cancelled' },
    ])
    expect(choices[1].description).toContain('session approval cache')
    expect(choices[2].description).toContain(JSON.stringify(['npm', 'run', 'build']))
    expect(choices[3].description).toContain('persistent')
    expect(choices[6].description).toContain('interrupts')
    choices.forEach((choice, index) => {
      expect(
        codexRequestResponse('item/commandExecution/requestApproval', params, true, {}, choice.id),
      ).toEqual({ decision: availableDecisions[index] })
    })
  })

  it('keeps offered choice indexes and surfaces unsupported decisions without granting them', () => {
    const params = {
      availableDecisions: [
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: 'not-an-array' } },
        'acceptForSession',
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'example.test', action: 'allow', extraGrant: true },
          },
        },
        'cancel',
      ],
    }
    expect(codexApprovalChoices('item/commandExecution/requestApproval', params)).toMatchObject({
      approvalChoices: [{ id: 'codex-approval:1' }, { id: 'codex-approval:3' }],
      approvalChoicesUnsupported: expect.stringContaining('2 unsupported approval choices'),
    })
    for (const decisionId of [
      'codex-approval:0',
      'codex-approval:2',
      'codex-approval:4',
      'accept',
      'codex-approval:01',
    ])
      expect(() =>
        codexRequestResponse('item/commandExecution/requestApproval', params, true, {}, decisionId),
      ).toThrow(/choice|choices/)
  })

  it('honors empty or malformed advertised lists and keeps the null/absent legacy response', () => {
    for (const availableDecisions of [[], 'accept', { decision: 'accept' }]) {
      const params = { availableDecisions }
      expect(codexApprovalChoices('item/commandExecution/requestApproval', params)).toMatchObject({
        approvalChoices: [],
        approvalChoicesUnsupported: expect.any(String),
      })
      for (const accepted of [true, false])
        expect(() =>
          codexRequestResponse('item/commandExecution/requestApproval', params, accepted),
        ).toThrow()
    }
    for (const availableDecisions of [undefined, null]) {
      expect(
        codexApprovalChoices('item/commandExecution/requestApproval', { availableDecisions }),
      ).toEqual({})
      expect(
        codexRequestResponse(
          'item/commandExecution/requestApproval',
          { availableDecisions },
          false,
        ),
      ).toEqual({ decision: 'decline' })
    }
    expect(() =>
      codexRequestResponse(
        'item/commandExecution/requestApproval',
        {
          availableDecisions: ['cancel'],
        },
        false,
      ),
    ).toThrow(/does not offer decline/)
  })

  it('rejects choice IDs for permissions, input, elicitation, and legacy requests', () => {
    for (const method of [
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
      'item/tool/requestUserInput',
      'item/commandExecution/requestApproval',
    ])
      expect(() => codexRequestResponse(method, {}, true, {}, 'codex-approval:0')).toThrow(
        /does not offer native approval choices/,
      )
  })

  it('does not fabricate an approval response for an unknown native request method', () => {
    expect(() =>
      codexRequestResponse(
        'item/commandExecution/future/requestApproval',
        { availableDecisions: ['acceptForSession'] },
        true,
      ),
    ).toThrow(/does not support/)
  })

  it('displays the action, reason, working directory and requested permission scope', () => {
    const presentation = codexApprovalPresentation('item/commandExecution/requestApproval', {
      command: 'curl example.test',
      reason: 'Read reference material',
      cwd: '/project',
      networkApprovalContext: { host: 'example.test', protocol: 'https' },
      additionalPermissions: permissions,
    })
    expect(presentation.title).toContain('example.test')
    for (const value of [
      'curl example.test',
      'Read reference material',
      '/project',
      'https://example.test',
      '/project/result',
    ])
      expect(presentation.text).toContain(value)
  })
})

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  sent: Wire[] = []
  holdAccountUsage = false
  models: Wire[] = [
    {
      model: 'test-model',
      displayName: 'Test model',
      inputModalities: ['text', 'image'],
      isDefault: true,
    },
  ]
  accountUsage: Wire = {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
      credits: { hasCredits: true, unlimited: false, balance: '5' },
      planType: 'pro',
    },
    ordinaryUsageAllowed: true,
  }
  write(raw: string) {
    const message = JSON.parse(raw)
    this.sent.push(message)
    if (this.holdAccountUsage && message.method === 'account/rateLimits/read') return true
    if (message.id != null && message.method)
      queueMicrotask(() => {
        const result =
          message.method === 'thread/start'
            ? { thread: { id: 'remote' } }
            : message.method === 'turn/start'
              ? { turn: { id: 'turn-1' } }
              : message.method === 'model/list'
                ? { data: this.models }
                : message.method === 'account/rateLimits/read'
                  ? this.accountUsage
                  : {}
        this.reply({ id: message.id, result })
      })
    return true
  }
  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }
  signal() {}
  close() {
    this.destroyed = true
    this.emit('close')
  }
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
})
async function fixture() {
  const channel = new Channel()
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    codex: 'codex-cli 0.162.0',
  }
  ssh.channel = vi.fn(async () => channel as unknown as ClientChannel)
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  await agents.start({
    sessionId: 'local',
    provider: 'codex',
    model: 'test-model',
    prompt: 'User input',
    mode: 'ask-for-approval',
  })
  const request = (method: string, extra: Wire = {}, id: string | number = 'request-1') =>
    channel.reply({
      id,
      method,
      params: { threadId: 'remote', turnId: 'turn-1', itemId: 'item-1', ...extra },
    })
  const pending = () =>
    events.findLast((event) => event.type === 'approval' || event.type === 'question')!
  return { agents, channel, ssh, events, request, pending }
}

describe('Codex server request lifecycle', () => {
  it('rejects unknown native approval methods instead of offering a fabricated fallback', async () => {
    const { channel, events, request } = await fixture()
    request('item/commandExecution/future/requestApproval', {
      availableDecisions: ['acceptForSession'],
    })
    expect(events.some((event) => event.type === 'approval')).toBe(false)
    expect(channel.sent.findLast((message) => message.id === 'request-1')).toMatchObject({
      error: { code: -32601 },
    })
    expect(channel.sent.findLast((message) => message.id === 'request-1')).not.toHaveProperty(
      'result',
    )
  })
  it('approves a network-only native choice without adding or changing its advertised policy', async () => {
    const { agents, channel, events, request, pending } = await fixture()
    const nativeDecision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'reference.example', action: 'allow' },
      },
    }
    request('item/commandExecution/requestApproval', {
      availableDecisions: [nativeDecision, 'cancel'],
      networkApprovalContext: { host: 'reference.example', protocol: 'https' },
    })
    expect(pending().approvalChoices?.map((choice) => choice.label)).toEqual([
      'Always allow reference.example',
      'Cancel this turn',
    ])
    await agents.respond('local', pending().requestId!, true, undefined, 'codex-approval:0')
    expect(channel.sent.findLast((message) => message.id === 'request-1')?.result).toEqual({
      decision: nativeDecision,
    })
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      status: 'approved',
      details: { decisionId: 'codex-approval:0' },
    })
  })

  it.each([
    ['acceptForSession', 'approved'],
    ['cancel', 'cancelled'],
    ['decline', 'declined'],
    [
      {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host: 'example.test', action: 'deny' },
        },
      },
      'declined',
    ],
  ])('resolves the selected native %j with its own outcome %s', async (decision, outcome) => {
    const { agents, channel, events, request, pending } = await fixture()
    request('item/commandExecution/requestApproval', { availableDecisions: [decision] })
    await agents.respond('local', pending().requestId!, true, undefined, 'codex-approval:0')
    expect(channel.sent.findLast((message) => message.id === 'request-1')?.result).toEqual({
      decision,
    })
    expect(events.findLast((event) => event.type === 'request-resolved')?.status).toBe(outcome)
  })

  it('keeps a rejected choice pending and sends nothing until an exact offered choice is selected', async () => {
    const { agents, channel, events, request, pending } = await fixture()
    request('item/commandExecution/requestApproval', {
      availableDecisions: [
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'example.test', action: 'grant-all' },
          },
        },
        'acceptForSession',
        'decline',
      ],
    })
    const requestId = pending().requestId!
    for (const decisionId of ['codex-approval:0', 'codex-approval:99', 'acceptForSession'])
      await expect(agents.respond('local', requestId, true, undefined, decisionId)).rejects.toThrow(
        /choice|choices/,
      )
    expect(channel.sent.some((message) => message.id === 'request-1')).toBe(false)
    expect(events.some((event) => event.type === 'request-resolved')).toBe(false)
    await agents.respond('local', requestId, false, undefined, 'codex-approval:2')
    expect(channel.sent.findLast((message) => message.id === 'request-1')?.result).toEqual({
      decision: 'decline',
    })
    await expect(
      agents.respond('local', requestId, false, undefined, 'codex-approval:2'),
    ).rejects.toThrow(/no longer pending/)
  })

  it('stops a native request that offers no decline without granting or saving a policy', async () => {
    const { agents, channel, events, request, pending } = await fixture()
    request('item/commandExecution/requestApproval', {
      availableDecisions: [
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'example.test', action: 'allow' },
          },
        },
      ],
    })
    const requestId = pending().requestId!
    await agents.stop('local')
    expect(channel.sent.some((message) => message.id === 'request-1')).toBe(false)
    expect(channel.sent.some((message) => message.method === 'turn/interrupt')).toBe(true)
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      requestId,
      status: 'cancelled',
    })
  })

  it('uses an advertised cancel when stopping a native request', async () => {
    const { agents, channel, request } = await fixture()
    request('item/commandExecution/requestApproval', {
      availableDecisions: ['acceptForSession', 'cancel'],
    })
    await agents.stop('local')
    expect(channel.sent.findLast((message) => message.id === 'request-1')?.result).toEqual({
      decision: 'cancel',
    })
  })

  it('routes native permission requests and replies with the requested turn-scoped subset', async () => {
    const { agents, channel, request, pending } = await fixture()
    request('item/permissions/requestApproval', {
      permissions,
      reason: 'Read reference',
      cwd: '/project',
    })
    expect(pending()).toMatchObject({
      type: 'approval',
      itemId: 'item-1',
      details: { method: 'item/permissions/requestApproval', permissions },
    })
    await agents.respond('local', pending().requestId!, true)
    expect(channel.sent.findLast((message) => message.id === 'request-1')).toEqual({
      id: 'request-1',
      result: { permissions, scope: 'turn' },
    })
  })

  it('prevents responses to provider-cleared approvals and scopes wire IDs by conversation', async () => {
    const { agents, channel, events, request, pending } = await fixture()
    request('item/commandExecution/requestApproval', { command: 'touch output' }, 77)
    const requestId = pending().requestId!
    channel.reply({
      method: 'serverRequest/resolved',
      params: { threadId: 'remote', requestId: '77' },
    })
    expect(events.some((event) => event.type === 'request-resolved')).toBe(false)
    channel.reply({
      method: 'serverRequest/resolved',
      params: { threadId: 'remote', requestId: 77 },
    })
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      requestId,
    })
    await expect(agents.respond('local', requestId, true)).rejects.toThrow(/no longer pending/)
    expect(channel.sent.filter((message) => message.id === 77)).toHaveLength(0)
  })

  it('keeps a rejected MCP form editable and sends only a validated explicit answer', async () => {
    const { agents, channel, request, pending } = await fixture()
    request('mcpServer/elicitation/request', {
      ...form,
      serverName: 'reference',
      message: 'Choose a reference',
    })
    const requestId = pending().requestId!
    await expect(agents.respond('local', requestId, true, { name: ['Ada'] })).rejects.toThrow(
      /Answer count/,
    )
    expect(channel.sent.some((message) => message.id === 'request-1')).toBe(false)
    await agents.respond('local', requestId, true, {
      name: ['Ada'],
      count: ['2'],
      enabled: ['true'],
      choice: ['a'],
    })
    expect(channel.sent.findLast((message) => message.id === 'request-1')?.result).toMatchObject({
      action: 'accept',
      content: { name: 'Ada', count: 2, enabled: true, choice: 'a' },
    })
  })

  it('keeps a native optional-only MCP form pending until the user answers it', async () => {
    const { agents, channel, request, pending, events } = await fixture()
    request('mcpServer/elicitation/request', {
      mode: 'form',
      serverName: 'reference',
      message: 'An optional note',
      requestedSchema: {
        type: 'object',
        properties: { note: { type: 'string' } },
        required: null,
      },
    })
    expect(pending()).toMatchObject({
      type: 'question',
      questions: [expect.objectContaining({ id: 'note', required: false })],
    })
    expect(channel.sent.some((message) => message.id === 'request-1')).toBe(false)
    expect(
      events.some(
        (event) =>
          event.details &&
          typeof event.details === 'object' &&
          'declined' in event.details &&
          event.details.declined,
      ),
    ).toBe(false)
    await agents.respond('local', pending().requestId!, true, {})
    expect(channel.sent.findLast((message) => message.id === 'request-1')?.result).toEqual({
      action: 'accept',
      content: {},
      _meta: null,
    })
  })

  it('declines unsupported MCP schemas without inventing values or failing the active turn', async () => {
    const { channel, events, request } = await fixture()
    request('mcpServer/elicitation/request', {
      mode: 'form',
      requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
    })
    expect(channel.sent.findLast((message) => message.id === 'request-1')?.result).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.findLast((event) => event.type === 'status')?.details).toMatchObject({
      declined: true,
    })
  })

  it('clears only a completed subagent’s requests while the parent remains running', async () => {
    const { channel, request, pending, events, agents } = await fixture()
    channel.reply({
      method: 'thread/started',
      params: { thread: { id: 'child', parentThreadId: 'remote' } },
    })
    request('item/commandExecution/requestApproval', {
      threadId: 'child',
      turnId: 'child-turn',
      command: 'touch child-output',
    })
    const requestId = pending().requestId!
    channel.reply({
      method: 'turn/completed',
      params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } },
    })
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      requestId,
      agentId: 'child',
    })
    await expect(agents.respond('local', requestId, true)).rejects.toThrow(/no longer pending/)
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('keeps retrying provider errors observable with their recovery metadata', async () => {
    const { channel, events, agents } = await fixture()
    channel.reply({
      method: 'error',
      params: {
        threadId: 'remote',
        turnId: 'turn-1',
        willRetry: true,
        error: { message: 'Reconnecting stream', codexErrorInfo: 'responseStreamDisconnected' },
      },
    })
    expect(events.findLast((event) => event.text === 'Reconnecting stream')).toMatchObject({
      type: 'status',
      details: { recoverable: true, willRetry: true },
    })
    expect(agents.hasRunningSessions()).toBe(true)
  })
})

describe('Codex account usage and input capabilities', () => {
  const image = {
    name: 'reference.png',
    mimeType: 'image/png',
    remotePath: '/project/reference.png',
  }
  it('reads native account limits without submitting another inference turn', async () => {
    const { agents, channel } = await fixture()
    const inferenceBefore = channel.sent.filter((message) => message.method === 'turn/start').length
    expect(await agents.usage('codex')).toMatchObject({
      provider: 'codex',
      status: 'available',
      machineIdentity: 'test-machine',
      ordinaryUsageAllowed: true,
      limits: [{ id: 'codex', primary: { usedPercent: 25, resetsAt: 1800000000 } }],
    })
    expect(channel.sent.filter((message) => message.method === 'turn/start')).toHaveLength(
      inferenceBefore,
    )
    expect(
      channel.sent.filter((message) => message.method === 'account/rateLimits/read'),
    ).toHaveLength(1)
  })

  it('merges account usage updates that carry no conversation identity', async () => {
    const { agents, channel, events } = await fixture()
    await agents.usage('codex')
    channel.reply({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1800000000 },
          planType: null,
          credits: null,
        },
      },
    })
    expect(events.findLast((event) => event.type === 'account-usage')).toMatchObject({
      sessionId: '',
      provider: 'codex',
      details: {
        machineIdentity: 'test-machine',
        ordinaryUsageAllowed: true,
        limits: [{ planType: 'pro', primary: { usedPercent: 30 }, credits: { balance: '5' } }],
      },
    })
  })

  it('clears old quota metadata when native authentication changes', async () => {
    const { agents, channel, events } = await fixture()
    await agents.usage('codex')
    channel.reply({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } })
    expect(events.findLast((event) => event.type === 'account-usage')?.details).toMatchObject({
      provider: 'codex',
      machineIdentity: 'test-machine',
      status: 'unavailable',
      accountType: 'plus',
      limits: [],
    })
    channel.reply({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 0 } } },
    })
    const latest = events.findLast((event) => event.type === 'account-usage')?.details as Wire
    expect(latest.limits[0].primary).toEqual({ usedPercent: 0 })
    expect(latest.limits[0].credits).toBeUndefined()
    expect(latest.ordinaryUsageAllowed).toBeUndefined()
  })

  it('rejects an obsolete quota read after an account change without losing machine scope', async () => {
    const { agents, channel } = await fixture()
    channel.holdAccountUsage = true
    const reading = agents.usage('codex')
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.method === 'account/rateLimits/read')).toBe(
        true,
      ),
    )
    const request = channel.sent.findLast(
      (message) => message.method === 'account/rateLimits/read',
    )!
    channel.reply({ method: 'account/updated', params: { authMode: null, planType: null } })
    channel.reply({ id: request.id, result: channel.accountUsage })
    expect(await reading).toMatchObject({
      provider: 'codex',
      machineIdentity: 'test-machine',
      status: 'unavailable',
      limits: [],
      message: 'Codex account changed while reading limits. Refresh account limits.',
    })
  })

  it('blocks image starts before a text-only model receives a user turn', async () => {
    const { agents, channel } = await fixture()
    channel.models[0].inputModalities = ['text']
    channel.reply({
      method: 'turn/completed',
      params: { threadId: 'remote', turn: { id: 'turn-1', status: 'completed' } },
    })
    await expect(
      agents.start({
        sessionId: 'local',
        provider: 'codex',
        model: 'test-model',
        mode: 'ask-for-approval',
        prompt: 'Read the image',
        attachments: [image],
      }),
    ).rejects.toThrow(/does not support image input/)
    expect(channel.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1)
  })

  it('does not publish an inactive machine’s account updates into the selected machine dashboard', async () => {
    const { agents, channel, ssh, events } = await fixture()
    await agents.usage('codex')
    ssh.state.profile = {
      id: 'other',
      name: 'Other machine',
      host: 'other.test',
      port: 22,
      username: 'researcher',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/other',
    }
    channel.reply({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 99 } } },
    })
    expect(events.some((event) => event.type === 'account-usage')).toBe(false)
  })

  it('blocks image steering to a text-only model without changing the active turn', async () => {
    const { agents, channel } = await fixture()
    channel.models[0].inputModalities = ['text']
    await expect(
      agents.steer({ sessionId: 'local', prompt: 'Read this image', attachments: [image] }),
    ).rejects.toThrow(/does not support image input/)
    expect(channel.sent.filter((message) => message.method === 'turn/steer')).toHaveLength(0)
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('preserves advertised modalities without inventing fields in legacy catalog responses', () => {
    expect(codexModelOption({ model: 'old-catalog' })).toEqual({
      id: 'old-catalog',
      name: 'old-catalog',
    })
    expect(
      codexModelOption({ model: 'text-only', inputModalities: ['text'] }).inputModalities,
    ).toEqual(['text'])
    expect(codexModelOption({ model: 'no-inputs', inputModalities: [] }).inputModalities).toEqual(
      [],
    )
  })

  it('allows legacy catalog image input when native modalities are unavailable', async () => {
    const { agents, channel } = await fixture()
    delete channel.models[0].inputModalities
    await agents.steer({ sessionId: 'local', prompt: 'Read this image', attachments: [image] })
    expect(channel.sent.find((message) => message.method === 'turn/steer')?.params.input).toEqual([
      { type: 'text', text: 'Read this image' },
      { type: 'localImage', path: '/project/reference.png' },
    ])
  })
})
