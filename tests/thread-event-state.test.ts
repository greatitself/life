import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyEvent,
  finishThreadTurn,
  readThreads,
  resolveAgentRequest,
  type Thread,
} from '../src/renderer/state'
import { normalizeImportedThreadHistory } from '../src/renderer/thread-metadata'
import type { AgentEvent } from '../src/shared/types'

const exactUserText = '  Please inspect this code.\n\n```ts\nconst value = "  untouched  ";\n```\n'

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread',
    profileId: 'machine',
    workspace: '/srv/project',
    provider: 'codex',
    title: 'Untitled thread',
    remoteId: 'provider-conversation',
    messages: [{ id: 'user-1', role: 'user', text: exactUserText, turn: 1, createdAt: 10 }],
    busy: true,
    turnStatus: 'running',
    model: 'model-a',
    mode: 'review',
    updatedAt: 10,
    turn: 1,
    pending: [],
    ...overrides,
  }
}

function event(type: AgentEvent['type'], values: Partial<AgentEvent> = {}): AgentEvent {
  return { sessionId: 'thread', type, ...values }
}

function stream(initial: Thread, events: AgentEvent[]): Thread {
  return events.reduce(applyEvent, initial)
}

afterEach(() => vi.unstubAllGlobals())

describe('provider events remain visible and distinct in a thread', () => {
  it('keeps commentary and final output separate even when the provider reuses an item identifier', () => {
    const updated = stream(thread(), [
      event('text', { itemId: 'answer', phase: 'commentary', text: 'I will inspect ' }),
      event('text', { itemId: 'answer', phase: 'commentary', text: 'the code.\n' }),
      event('text', { itemId: 'answer', phase: 'final_answer', text: 'The answer is ' }),
      event('text', { itemId: 'answer', phase: 'final_answer', text: '42.\n' }),
      event('text', {
        itemId: 'answer',
        phase: 'final_answer',
        status: 'replace',
        text: 'The answer is 42.\n\n```ts\nreturn 42;\n```',
      }),
    ])
    expect(updated.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
    expect(updated.messages.find((message) => message.phase === 'commentary')?.text).toBe(
      'I will inspect the code.\n',
    )
    expect(updated.messages.find((message) => message.phase === 'final_answer')?.text).toBe(
      'The answer is 42.\n\n```ts\nreturn 42;\n```',
    )
    expect(new Set(updated.messages.map((message) => message.id)).size).toBe(
      updated.messages.length,
    )
    expect(updated.messages[0].text).toBe(exactUserText)
  })

  it('preserves reasoning, plans, statuses and subagent details instead of dropping provider information', () => {
    const plan = { steps: [{ step: 'Inspect code', status: 'in_progress' }] }
    const child = {
      task: 'Check edge cases',
      result: 'Two cases covered',
      children: [{ id: 'grandchild', status: 'completed' }],
    }
    const updated = stream(thread(), [
      event('reasoning', { itemId: 'analysis', text: 'Checking invariants.\n', provider: 'codex' }),
      event('plan', { itemId: 'plan', text: '1. Inspect code\n2. Validate', details: plan }),
      event('status', {
        itemId: 'status',
        text: 'Waiting for the remote process',
        status: 'running',
      }),
      event('subagent', {
        itemId: 'child-item',
        text: 'Two cases covered',
        agentId: 'child-id',
        agentName: 'Edge case reviewer',
        parentItemId: 'delegation',
        provider: 'claude',
        status: 'completed',
        details: child,
      }),
    ])
    expect(updated.messages.find((message) => message.kind === 'reasoning')).toMatchObject({
      text: 'Checking invariants.\n',
      provider: 'codex',
    })
    expect(updated.messages.find((message) => message.kind === 'plan')).toMatchObject({
      text: '1. Inspect code\n2. Validate',
      details: plan,
    })
    expect(updated.messages.find((message) => message.kind === 'status')).toMatchObject({
      text: 'Waiting for the remote process',
      status: 'running',
    })
    expect(updated.messages.find((message) => message.kind === 'subagent')).toMatchObject({
      text: 'Two cases covered',
      agentId: 'child-id',
      agentName: 'Edge case reviewer',
      parentItemId: 'delegation',
      provider: 'claude',
      details: child,
      status: 'completed',
    })
    expect(updated.busy).toBe(true)
    expect(updated.turnStatus).toBe('running')
  })

  it('joins arbitrary plan delta chunks exactly before replacing them with the final provider snapshot', () => {
    const deltas = stream(thread(), [
      event('plan', { itemId: 'plan', text: '1. Ins' }),
      event('plan', { itemId: 'plan', text: 'pect files\n2. Val' }),
      event('plan', { itemId: 'plan', text: 'idate\n' }),
    ])
    expect(deltas.messages.find((message) => message.kind === 'plan')?.text).toBe(
      '1. Inspect files\n2. Validate\n',
    )
    const snapshot = applyEvent(
      deltas,
      event('plan', {
        itemId: 'plan',
        text: '1. Inspect files — complete\n2. Validate — complete\n',
        status: 'replace',
      }),
    )
    expect(snapshot.messages.find((message) => message.kind === 'plan')?.text).toBe(
      '1. Inspect files — complete\n2. Validate — complete\n',
    )
  })

  it('retains every structured provider plan step when the protocol supplies a raw array', () => {
    const plan = [
      { step: 'Inspect code', status: 'completed' },
      { step: 'Validate queued messages', status: 'in_progress' },
    ]
    const updated = applyEvent(
      thread(),
      event('plan', { itemId: 'plan', text: 'Checking the remaining step', details: plan }),
    )
    expect(updated.messages.find((message) => message.kind === 'plan')).toMatchObject({
      text: 'Checking the remaining step',
      details: { plan },
    })
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([updated]) })
    expect(readThreads()[0].messages.find((message) => message.kind === 'plan')?.details).toEqual({
      plan,
    })
  })

  it('accumulates tool output while retaining exact input and the completed tool payload', () => {
    const input = "printf 'line one\\nline two\\n'"
    const updated = stream(thread(), [
      event('tool', {
        itemId: 'command',
        title: 'Run command',
        input,
        text: '',
        status: 'running',
        details: { command: input, cwd: '/srv/project' },
      }),
      event('tool-output', { itemId: 'command', text: 'line one\n' }),
      event('tool-output', { itemId: 'command', text: 'line two\n' }),
      event('tool', { itemId: 'command', text: 'line one\nline two\n', status: 'completed' }),
    ])
    const tool = updated.messages.find((message) => message.role === 'tool')
    expect(tool).toMatchObject({
      input,
      title: 'Run command',
      text: 'line one\nline two\n',
      status: 'completed',
      details: { command: input, cwd: '/srv/project' },
    })
    expect(tool?.createdAt).toBeTypeOf('number')
    expect(tool?.finishedAt).toBeTypeOf('number')
    expect(updated.messages.filter((message) => message.role === 'tool')).toHaveLength(1)
  })

  it('keeps JSON tool input separate from streamed output when the initial provider item uses text for its input', () => {
    const input = '{\n  "command": "npm test",\n  "cwd": "/srv/project"\n}'
    const updated = stream(thread(), [
      event('tool', { itemId: 'command', title: 'Run checks', text: input, status: 'running' }),
      event('tool-output', { itemId: 'command', text: 'Running tests...\n' }),
      event('tool-output', { itemId: 'command', text: 'Passed 24 checks.\n' }),
      event('tool', {
        itemId: 'command',
        text: 'Running tests...\nPassed 24 checks.\n',
        status: 'completed',
      }),
    ])
    expect(updated.messages.find((message) => message.role === 'tool')).toMatchObject({
      input,
      text: 'Running tests...\nPassed 24 checks.\n',
      status: 'completed',
    })
  })

  it('keeps streamed output when a terminal tool event contains no replacement output', () => {
    const updated = stream(thread(), [
      event('tool', {
        itemId: 'command',
        title: 'Check project',
        input: 'npm test',
        status: 'running',
      }),
      event('tool-output', { itemId: 'command', text: 'Passed 12 tests.\n' }),
      event('tool', { itemId: 'command', text: '', status: 'completed' }),
    ])
    expect(updated.messages.find((message) => message.role === 'tool')).toMatchObject({
      input: 'npm test',
      text: 'Passed 12 tests.\n',
      status: 'completed',
    })
  })

  it('keeps both streamed output and a distinct final tool result without duplicating full snapshots', () => {
    const updated = stream(thread(), [
      event('tool', { itemId: 'command', input: 'run-checks', status: 'running' }),
      event('tool-output', { itemId: 'command', text: 'Running checks...\n' }),
      event('tool', { itemId: 'command', text: 'Exit code: 0', status: 'completed' }),
    ])
    expect(updated.messages.find((message) => message.role === 'tool')?.text).toBe(
      'Running checks...\nExit code: 0',
    )
  })

  it('does not reopen a completed tool or discard its terminal details when late output arrives', () => {
    const completed = stream(thread(), [
      event('tool', { itemId: 'command', input: 'run-checks', status: 'running' }),
      event('tool', {
        itemId: 'command',
        text: 'Checks passed.\n',
        status: 'completed',
        details: { exitCode: 0 },
      }),
    ])
    const finishedAt = completed.messages.find((message) => message.role === 'tool')?.finishedAt
    const updated = stream(completed, [
      event('tool-output', { itemId: 'command', text: 'Final timing: 1s\n' }),
      event('tool', { itemId: 'command', status: 'running' }),
    ])
    expect(updated.messages.find((message) => message.role === 'tool')).toMatchObject({
      input: 'run-checks',
      text: 'Checks passed.\nFinal timing: 1s\n',
      status: 'completed',
      finishedAt,
      details: { exitCode: 0 },
    })
  })

  it('keeps concurrent subagents distinct when they use the same item identifier', () => {
    const updated = stream(thread(), [
      event('subagent', {
        itemId: 'result',
        agentId: 'agent-a',
        agentName: 'Parser reviewer',
        text: 'Parser result',
        parentItemId: 'delegation-a',
        status: 'completed',
      }),
      event('subagent', {
        itemId: 'result',
        agentId: 'agent-b',
        agentName: 'Queue reviewer',
        text: 'Queue result',
        parentItemId: 'delegation-b',
        status: 'completed',
      }),
    ])
    const children = updated.messages.filter((message) => message.kind === 'subagent')
    expect(children).toHaveLength(2)
    expect(children.map((message) => message.text)).toEqual(['Parser result', 'Queue result'])
    expect(new Set(children.map((message) => message.id)).size).toBe(2)
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'treats the valid child ID %s as a literal record key when assigning its parent turn',
    (agentId) => {
      const updated = applyEvent(
        thread({ agentTurns: { existing: 1 } }),
        event('subagent', {
          itemId: 'child-item',
          agentId,
          text: 'Running review',
          status: 'running',
        }),
      )
      expect(updated.messages.find((message) => message.agentId === agentId)?.turn).toBe(1)
      expect(Object.hasOwn(updated.agentTurns || {}, agentId)).toBe(true)
      expect(updated.agentTurns?.[agentId]).toBe(1)
    },
  )

  it('keeps a child agent running independently after its parent turn completes', () => {
    const running = stream(thread(), [
      event('subagent', {
        itemId: 'child-session',
        agentId: 'child-agent',
        agentName: 'Independent reviewer',
        text: 'Reviewing the project',
        status: 'running',
      }),
      event('tool', {
        itemId: 'child-command',
        agentId: 'child-agent',
        input: 'run-child-checks',
        status: 'running',
      }),
    ])
    const parentDone = applyEvent(running, event('complete', { status: 'completed' }))
    expect(parentDone.turnStatus).toBe('completed')
    expect(parentDone.busy).toBe(false)
    for (const child of parentDone.messages.filter(
      (message) => message.agentId === 'child-agent',
    )) {
      expect(child.status).toBe('running')
      expect(child.finishedAt).toBeUndefined()
    }
    const childDone = stream(parentDone, [
      event('tool', { itemId: 'child-command', agentId: 'child-agent', status: 'completed' }),
      event('subagent', {
        itemId: 'child-session',
        agentId: 'child-agent',
        text: 'Review complete',
        status: 'completed',
      }),
    ])
    for (const child of childDone.messages.filter((message) => message.agentId === 'child-agent'))
      expect(child.status).toBe('completed')
    expect(childDone.turnStatus).toBe('completed')
    expect(childDone.busy).toBe(false)
  })

  it('updates the existing child activity in its original turn after a parent follow-up starts', () => {
    const firstTurn = stream(thread(), [
      event('tool', {
        itemId: 'child-command',
        agentId: 'child-agent',
        input: 'run-child-checks',
        status: 'running',
      }),
      event('complete', { status: 'completed' }),
    ])
    const nextParentTurn = {
      ...firstTurn,
      turn: 2,
      busy: true,
      turnStatus: 'running' as const,
      messages: [
        ...firstTurn.messages,
        { id: 'user-2', role: 'user' as const, text: 'New parent request', turn: 2 },
      ],
    }
    const updated = applyEvent(
      nextParentTurn,
      event('tool', {
        itemId: 'child-command',
        agentId: 'child-agent',
        text: 'Child checks passed.\n',
        status: 'completed',
      }),
    )
    const childRows = updated.messages.filter((message) => message.agentId === 'child-agent')
    expect(childRows).toHaveLength(1)
    expect(childRows[0]).toMatchObject({
      turn: 1,
      input: 'run-child-checks',
      text: 'Child checks passed.\n',
      status: 'completed',
    })
    expect(updated.turn).toBe(2)
    expect(updated.turnStatus).toBe('running')
    expect(updated.busy).toBe(true)
  })

  it.each(['error', 'complete'] as const)(
    'records a child %s without settling or failing the running parent turn',
    (type) => {
      const original = thread({
        queue: [{ id: 'queued', text: 'Next parent request', createdAt: 20, attachments: [] }],
        pending: [event('approval', { requestId: 'parent-approval' })],
      })
      const running = applyEvent(
        original,
        event('tool', {
          itemId: 'child-command',
          agentId: 'child-agent',
          status: 'running',
          input: 'run-child-checks',
        }),
      )
      const updated = applyEvent(
        running,
        event(type, {
          agentId: 'child-agent',
          itemId: 'child-session',
          status: type === 'error' ? 'failed' : 'completed',
          text: type === 'error' ? 'Child check failed' : 'Child check finished',
          details: { lifecycle: 'turn' },
        }),
      )
      expect(updated.turnStatus).toBe('running')
      expect(updated.busy).toBe(true)
      expect(updated.pending).toEqual(original.pending)
      expect(updated.queue?.[0].paused).not.toBe(true)
      expect(updated.messages[0].finishStatus).toBeUndefined()
      expect(updated.messages.find((message) => message.kind === 'subagent')).toMatchObject({
        text: type === 'error' ? 'Child check failed' : 'Child check finished',
        status: type === 'error' ? 'failed' : 'completed',
        agentId: 'child-agent',
      })
    },
  )

  it('shows a child status without reviving or replacing the completed parent status', () => {
    const original = thread({
      busy: false,
      turnStatus: 'completed',
      agentStatus: 'completed',
      statusText: 'Parent request completed',
    })
    const updated = applyEvent(
      original,
      event('status', {
        itemId: 'child-status',
        agentId: 'child-agent',
        status: 'running',
        text: 'Child is still checking edge cases',
      }),
    )
    expect(updated.busy).toBe(false)
    expect(updated.turnStatus).toBe('completed')
    expect(updated.agentStatus).toBe('completed')
    expect(updated.statusText).toBe('Parent request completed')
    expect(updated.messages.find((message) => message.agentId === 'child-agent')).toMatchObject({
      text: 'Child is still checking edge cases',
      status: 'running',
    })
  })

  it('ignores another conversation’s events before they can mutate the current transcript', () => {
    const original = thread()
    for (const type of ['text', 'complete', 'error', 'title', 'settings', 'session'] as const) {
      expect(
        applyEvent(original, {
          sessionId: 'another-thread',
          type,
          text: 'Another conversation',
          title: 'Another title',
          remoteId: 'another-provider-conversation',
          details: { model: 'another-model' },
        }),
      ).toBe(original)
    }
  })

  it('updates provider-generated titles without rewriting user text or adding artificial chat messages', () => {
    const original = thread()
    const renamed = applyEvent(original, event('title', { title: 'Investigate parser edge cases' }))
    expect(renamed.title).toBe('Investigate parser edge cases')
    expect(renamed.messages).toEqual(original.messages)
    expect(renamed.remoteId).toBe(original.remoteId)
    expect(applyEvent(renamed, event('title', { text: 'Parser edge case research' })).title).toBe(
      'Parser edge case research',
    )
  })

  it('ignores empty titles while retaining the last useful provider title', () => {
    const original = thread({ title: 'Useful provider title' })
    expect(applyEvent(original, event('title', { title: '  \n\t' })).title).toBe(original.title)
    expect(applyEvent(original, event('title', {})).messages).toEqual(original.messages)
  })

  it('does not turn live settings acknowledgements into assistant messages', () => {
    const original = thread()
    const updated = applyEvent(
      original,
      event('settings', {
        details: { model: 'model-b', reasoningEffort: 'high', serviceTier: 'fast' },
      }),
    )
    expect(updated.messages).toEqual(original.messages)
    expect(updated.busy).toBe(true)
    expect(updated.remoteId).toBe('provider-conversation')
    expect(updated.agentSettings).toMatchObject({
      model: 'model-b',
      reasoningEffort: 'high',
      serviceTier: 'fast',
    })
  })
})

describe('provider approvals and questions remain in the transcript after resolution', () => {
  const questions = [
    {
      id: 'scope',
      header: 'Review scope',
      question: 'Which files should I inspect?',
      options: [
        { label: 'Current project', description: 'Inspect every tracked source file.' },
        { label: 'Changed files', description: 'Inspect only the current diff.' },
      ],
    },
    {
      id: 'checks',
      question: 'Which validation should I run?',
      options: [
        { label: 'Unit tests', description: 'Run the relevant unit checks.' },
        { label: 'Desktop checks', description: 'Exercise the complete Electron application.' },
      ],
    },
  ]

  it('updates duplicate live requests as one transcript row and one pending provider control', () => {
    const request = event('question', {
      requestId: 'request-question',
      title: 'Choose a review scope',
      questions,
      details: { providerControlId: 'native-request', tool: 'request_user_input' },
    })
    const updated = stream(thread(), [
      request,
      {
        ...request,
        text: 'Please choose the review scope.',
        details: { ...(request.details as object), attempt: 2 },
      },
    ])
    const rows = updated.messages.filter((message) => message.kind === 'event')
    expect(rows).toHaveLength(1)
    expect(updated.pending).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      role: 'tool',
      text: 'Please choose the review scope.',
      title: 'Choose a review scope',
      status: 'waiting',
      details: {
        providerControlId: 'native-request',
        tool: 'request_user_input',
        attempt: 2,
        requestType: 'question',
        requestId: 'request-question',
        questions,
      },
    })
    expect(updated.messages[0].text).toBe(exactUserText)
  })

  it('retains original options and provider payload when an existing request receives a partial update', () => {
    const requested = applyEvent(
      thread(),
      event('question', {
        requestId: 'question',
        title: 'Review choices',
        questions,
        details: { originalControlId: 'native-control' },
      }),
    )
    const updated = applyEvent(
      requested,
      event('question', {
        requestId: 'question',
        text: 'The same review choices still need an answer.',
        details: { attempt: 2 },
      }),
    )
    expect(updated.messages.filter((message) => message.kind === 'event')).toHaveLength(1)
    expect(updated.messages.find((message) => message.kind === 'event')).toMatchObject({
      title: 'Review choices',
      text: 'The same review choices still need an answer.',
      details: { originalControlId: 'native-control', attempt: 2, questions },
    })
    expect(updated.pending).toHaveLength(1)
    expect(updated.pending[0].questions).toEqual(questions)
  })

  it('retains exact answers and all original question options after the native provider accepts a response', () => {
    const answers = { scope: ['  Changed files\n'], checks: ['Unit tests', '  custom check  '] }
    const requested = applyEvent(
      thread(),
      event('question', { requestId: 'question', questions, title: 'Review choices' }),
    )
    const answered = resolveAgentRequest(requested, 'question', true, answers, 1000)
    expect(answered.pending).toEqual([])
    expect(answered.messages.find((message) => message.kind === 'event')).toMatchObject({
      text: questions.map((question) => question.question).join('\n\n'),
      status: 'answered',
      finishedAt: 1000,
      details: {
        requestType: 'question',
        requestId: 'question',
        questions,
        response: { accepted: true, answers },
      },
    })
    expect(answered.messages.filter((message) => message.role === 'user')).toEqual([
      requested.messages[0],
    ])
    expect(answered.busy).toBe(true)
    expect(answered.turnStatus).toBe('running')
  })

  it('retains the original question and every option after the user declines it', () => {
    const requested = applyEvent(
      thread(),
      event('question', {
        requestId: 'question',
        questions,
        text: 'Please choose a validation scope.',
      }),
    )
    const declined = resolveAgentRequest(requested, 'question', false, undefined, 1000)
    expect(declined.pending).toEqual([])
    expect(declined.messages.find((message) => message.kind === 'event')).toMatchObject({
      text: 'Please choose a validation scope.',
      status: 'declined',
      finishedAt: 1000,
      details: { questions, response: { accepted: false } },
    })
    expect(declined.messages[0].text).toBe(exactUserText)
  })

  it.each([true, false])(
    'records approval accepted=%s as a provider control without adding a user prompt',
    (accepted) => {
      const requested = applyEvent(
        thread(),
        event('approval', {
          requestId: 'approval',
          title: 'Allow validation command?',
          text: 'npm test -- --run tests/thread-event-state.test.ts',
          input: 'npm test -- --run tests/thread-event-state.test.ts',
          details: { cwd: '/srv/project', reason: 'Validate the requested change' },
        }),
      )
      const resolved = resolveAgentRequest(requested, 'approval', accepted, undefined, 1000)
      expect(resolved.pending).toEqual([])
      expect(resolved.messages.find((message) => message.kind === 'event')).toMatchObject({
        title: 'Allow validation command?',
        text: 'npm test -- --run tests/thread-event-state.test.ts',
        input: 'npm test -- --run tests/thread-event-state.test.ts',
        status: accepted ? 'approved' : 'declined',
        finishedAt: 1000,
        details: {
          requestType: 'approval',
          requestId: 'approval',
          cwd: '/srv/project',
          reason: 'Validate the requested change',
          response: { accepted },
        },
      })
      expect(resolved.messages.filter((message) => message.role === 'user')).toEqual([
        requested.messages[0],
      ])
      expect(resolved.messages.filter((message) => message.role === 'assistant')).toEqual([])
      expect(resolved.busy).toBe(true)
    },
  )

  it('resolves only the selected request while retaining other pending provider controls', () => {
    const requested = stream(thread(), [
      event('approval', { requestId: 'first', text: 'Allow first command?' }),
      event('question', { requestId: 'second', questions }),
    ])
    const resolved = resolveAgentRequest(requested, 'first', true, undefined, 1000)
    expect(resolved.pending.map((request) => request.requestId)).toEqual(['second'])
    expect(resolved.messages.filter((message) => message.kind === 'event')).toHaveLength(2)
    expect(
      resolved.messages.find((message) => message.details?.requestId === 'second'),
    ).toMatchObject({ status: 'waiting', details: { questions } })
  })

  it('keeps a child approval replyable after the parent completes its own turn', () => {
    const requested = stream(thread(), [
      event('approval', { requestId: 'parent-request', text: 'Allow parent command?' }),
      event('approval', {
        requestId: 'child-request',
        agentId: 'child-agent',
        text: 'Allow child validation command?',
        details: { command: 'npm test', cwd: '/srv/project' },
      }),
    ])
    const parentDone = applyEvent(requested, event('complete', { status: 'completed' }))
    expect(parentDone.pending.map((request) => request.requestId)).toEqual(['child-request'])
    expect(
      parentDone.messages.find((message) => message.details?.requestId === 'parent-request')
        ?.status,
    ).toBe('cancelled')
    expect(
      parentDone.messages.find((message) => message.details?.requestId === 'child-request'),
    ).toMatchObject({
      status: 'waiting',
      text: 'Allow child validation command?',
      agentId: 'child-agent',
      details: { command: 'npm test', cwd: '/srv/project' },
    })
    const approved = resolveAgentRequest(parentDone, 'child-request', true, undefined, 1000)
    expect(approved.pending).toEqual([])
    expect(
      approved.messages.find((message) => message.details?.requestId === 'child-request')?.status,
    ).toBe('approved')
    expect(approved.turnStatus).toBe('completed')
    expect(approved.busy).toBe(false)
  })

  it('cancels only a finished child’s unresolved requests while keeping sibling provider controls replyable', () => {
    const requested = stream(thread(), [
      event('approval', {
        requestId: 'child-a-request',
        agentId: 'child-a',
        text: 'Allow child A?',
      }),
      event('question', { requestId: 'child-b-request', agentId: 'child-b', questions }),
      event('approval', { requestId: 'parent-request', text: 'Allow parent command?' }),
    ])
    const childDone = applyEvent(
      requested,
      event('subagent', {
        agentId: 'child-a',
        itemId: 'child-a-session',
        status: 'completed',
        text: 'Child A is done',
        details: { lifecycle: 'turn' },
      }),
    )
    expect(childDone.pending.map((request) => request.requestId)).toEqual([
      'child-b-request',
      'parent-request',
    ])
    expect(
      childDone.messages.find((message) => message.details?.requestId === 'child-a-request')
        ?.status,
    ).toBe('cancelled')
    expect(
      childDone.messages.find((message) => message.details?.requestId === 'child-b-request')
        ?.status,
    ).toBe('waiting')
    expect(
      childDone.messages.find((message) => message.details?.requestId === 'parent-request')?.status,
    ).toBe('waiting')
    expect(childDone.turnStatus).toBe('running')
    expect(childDone.busy).toBe(true)
  })

  it('resolves the latest occurrence of a reused request ID without rewriting an older response', () => {
    const firstAnswers = { scope: ['  First answer\n'] }
    const firstResolved = resolveAgentRequest(
      applyEvent(thread(), event('question', { requestId: 'reused-request', questions })),
      'reused-request',
      true,
      firstAnswers,
      100,
    )
    const secondRequested = applyEvent(
      { ...firstResolved, turn: 2, pending: [] },
      event('question', { requestId: 'reused-request', questions, title: 'Second turn choices' }),
    )
    const secondAnswers = { scope: ['  Second answer\n'] }
    const secondResolved = resolveAgentRequest(
      secondRequested,
      'reused-request',
      true,
      secondAnswers,
      200,
    )
    const records = secondResolved.messages.filter(
      (message) => message.details?.requestId === 'reused-request',
    )
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      turn: 1,
      finishedAt: 100,
      details: { response: { accepted: true, answers: firstAnswers } },
    })
    expect(records[1]).toMatchObject({
      turn: 2,
      finishedAt: 200,
      details: { response: { accepted: true, answers: secondAnswers } },
    })
    expect(secondResolved.pending).toEqual([])
  })

  it.each(['failed', 'interrupted'] as const)(
    'retains unresolved request information after a %s turn without replaying its pending control',
    (status) => {
      const requested = applyEvent(
        thread({ queue: [{ id: 'queued', text: 'Continue', createdAt: 20, attachments: [] }] }),
        event('question', { requestId: 'question', questions, details: { original: true } }),
      )
      const completed = applyEvent(requested, event('complete', { status }))
      expect(completed.pending).toEqual([])
      expect(completed.queue?.[0].paused).toBe(true)
      expect(completed.messages.find((message) => message.kind === 'event')).toMatchObject({
        status: 'cancelled',
        details: { original: true, requestId: 'question', requestType: 'question', questions },
      })
      vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([completed]) })
      const restored = readThreads()[0]
      expect(restored.pending).toEqual([])
      expect(restored.messages.find((message) => message.kind === 'event')?.details).toEqual(
        completed.messages.find((message) => message.kind === 'event')?.details,
      )
    },
  )

  it('restores an unanswered request as read-only interrupted history', () => {
    const requested = applyEvent(thread(), event('question', { requestId: 'question', questions }))
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([requested]) })
    const restored = readThreads()[0]
    expect(restored.pending).toEqual([])
    expect(restored.messages.find((message) => message.kind === 'event')).toMatchObject({
      status: 'interrupted',
      details: { requestId: 'question', questions },
    })
  })

  it('preserves answered question records across restart without replaying the provider response', () => {
    const answers = { scope: ['  Changed files\n'], checks: ['Unit tests'] }
    const answered = resolveAgentRequest(
      applyEvent(thread(), event('question', { requestId: 'question', questions })),
      'question',
      true,
      answers,
      1000,
    )
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([answered]) })
    const restored = readThreads()[0]
    expect(restored.pending).toEqual([])
    expect(restored.messages.find((message) => message.kind === 'event')).toMatchObject({
      status: 'answered',
      finishedAt: 1000,
      details: { questions, response: { accepted: true, answers } },
    })
  })
})

describe('turn outcomes retain their meaning', () => {
  it.each(['completed', 'interrupted', 'failed'] as const)(
    'records a %s provider completion without confusing it with a successful turn',
    (status) => {
      const updated = applyEvent(thread(), event('complete', { status }))
      expect(updated.turnStatus).toBe(status)
      expect(updated.busy).toBe(false)
      expect(updated.pending).toEqual([])
      expect(updated.messages[0]).toMatchObject({ text: exactUserText, finishStatus: status })
      expect(updated.messages[0].finishedAt).toBeTypeOf('number')
    },
  )

  it('retains failed output and pauses queued follow-ups when the agent errors', () => {
    const original = thread({
      queue: [{ id: 'queued', text: 'Continue later', createdAt: 20, attachments: [] }],
      pending: [event('approval', { requestId: 'approval' })],
    })
    const updated = applyEvent(original, event('error', { text: 'Transport closed unexpectedly' }))
    expect(updated.turnStatus).toBe('failed')
    expect(updated.busy).toBe(false)
    expect(updated.pending).toEqual([])
    expect(updated.queue?.[0].paused).toBe(true)
    expect(updated.messages[0].finishStatus).toBe('failed')
    expect(updated.messages.at(-1)).toMatchObject({
      role: 'error',
      text: 'Transport closed unexpectedly',
    })
  })

  it('does not conflate a reconnecting transport with completed provider work', () => {
    const updated = applyEvent(
      thread(),
      event('status', { status: 'reconnecting', text: 'Reconnecting to the running agent' }),
    )
    expect(updated.turnStatus).toBe('reconnecting')
    expect(updated.messages[0].finishStatus).toBeUndefined()
    expect(updated.remoteId).toBe('provider-conversation')
  })

  it('keeps an unrecognized provider terminal status uncertain and pauses follow-ups', () => {
    const updated = applyEvent(
      thread({ queue: [{ id: 'queued', text: 'Follow up', attachments: [], createdAt: 20 }] }),
      event('complete', { status: 'cancelled-by-external-process' }),
    )
    expect(updated.turnStatus).toBe('unknown')
    expect(updated.messages[0].finishStatus).toBe('unknown')
    expect(updated.queue?.[0].paused).toBe(true)
  })

  it('marks an unfinished tool uncertain when its turn outcome is unknown', () => {
    const running = applyEvent(
      thread(),
      event('tool', { itemId: 'command', input: 'long-running-check', status: 'running' }),
    )
    const unknown = applyEvent(running, event('complete', { status: 'transport-lost' }))
    expect(unknown.messages.find((message) => message.role === 'tool')).toMatchObject({
      input: 'long-running-check',
      status: 'unknown',
    })
    expect(unknown.messages.find((message) => message.role === 'tool')?.finishedAt).toBeTypeOf(
      'number',
    )
  })

  it('clears an uncertain tool timestamp when the provider confirms that it is still running', () => {
    const running = applyEvent(
      thread(),
      event('tool', { itemId: 'command', input: 'long-running-check', status: 'running' }),
    )
    const unknown = applyEvent(running, event('complete', { status: 'transport-lost' }))
    const resumed = stream(unknown, [
      event('status', { status: 'resumed' }),
      event('tool', { itemId: 'command', status: 'running' }),
      event('tool-output', { itemId: 'command', text: 'Continuing from existing process.\n' }),
    ])
    const tool = resumed.messages.find((message) => message.role === 'tool')
    expect(tool).toMatchObject({
      input: 'long-running-check',
      status: 'running',
      text: 'Continuing from existing process.\n',
    })
    expect(tool?.finishedAt).toBeUndefined()
    expect(resumed.turnStatus).toBe('running')
    expect(resumed.busy).toBe(true)
  })

  it('uses genuine completion time after an uncertain turn resumes instead of its transport-loss time', () => {
    const original = thread({
      messages: [
        { id: 'user', role: 'user', text: exactUserText, turn: 1, createdAt: 10 },
        {
          id: 'assistant',
          role: 'assistant',
          text: 'Working on the request',
          turn: 1,
          createdAt: 20,
        },
      ],
    })
    const unknown = finishThreadTurn(original, 'unknown', 100)
    const resumed = applyEvent(unknown, event('status', { status: 'resumed' }))
    const completed = finishThreadTurn(resumed, 'completed', 1000)
    for (const message of completed.messages) {
      expect(message.finishedAt).toBe(1000)
      expect(message.finishStatus).toBe('completed')
    }
    expect(completed.messages[0].text).toBe(exactUserText)
  })
})

describe('restoring richer transcript metadata', () => {
  it('preserves provider output and the distinction between research and agent threads after restart', () => {
    const saved = thread({
      purpose: 'research',
      researchContext: { scopeKey: 'machine:/srv/project', goalId: 'goal', problemId: 'problem' },
      turnStatus: 'completed',
      messages: [
        { id: 'user', role: 'user', text: exactUserText, turn: 1, submission: 'steering' },
        {
          id: 'child',
          role: 'assistant',
          text: '  All edge cases covered.\n',
          turn: 1,
          kind: 'subagent',
          phase: 'commentary',
          agentId: 'child-id',
          agentName: 'Edge case reviewer',
          parentItemId: 'delegation',
          turnId: 'provider-turn-id',
          parentAgentId: 'parent-agent-id',
          provider: 'claude',
          details: { task: 'Inspect edge cases', status: 'completed' },
        },
      ],
    })
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([saved]) })
    const restored = readThreads()[0]
    expect(restored).toMatchObject({
      purpose: 'research',
      researchContext: saved.researchContext,
      remoteId: saved.remoteId,
      turnStatus: 'completed',
      busy: false,
    })
    expect(restored.messages[0]).toMatchObject({ text: exactUserText, submission: 'steering' })
    expect(restored.messages[1]).toMatchObject(saved.messages[1])
  })

  it('does not trust malformed saved metadata while preserving valid transcript text', () => {
    const saved = {
      ...thread(),
      purpose: 'not-a-real-purpose',
      turnStatus: 'not-a-real-status',
      researchContext: { scopeKey: 'valid-scope', goalId: 42 },
      messages: [
        {
          id: 'saved',
          role: 'assistant',
          text: 'Keep this exact output.\n',
          turn: 1,
          kind: 'not-a-real-kind',
          phase: 'system',
          provider: 'other-provider',
          submission: 'retry-with-hidden-instructions',
          agentId: 42,
          agentName: { name: 'unexpected' },
          parentItemId: false,
          turnId: 42,
          parentAgentId: ['invalid-parent'],
          details: ['invalid-record'],
        },
      ],
    }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([saved]) })
    const restored = readThreads()[0]
    expect(restored.purpose).toBeUndefined()
    expect(restored.researchContext).toBeUndefined()
    const message = restored.messages[0]
    expect(message.text).toBe('Keep this exact output.\n')
    for (const key of [
      'kind',
      'phase',
      'provider',
      'submission',
      'agentId',
      'agentName',
      'parentItemId',
      'turnId',
      'parentAgentId',
      'details',
    ] as const)
      expect(message[key]).toBeUndefined()
  })

  it.each(['attachment', 'event'] as const)(
    'preserves imported %s records without changing their original text',
    (kind) => {
      const saved = thread({
        importedHistory: {
          provider: 'claude',
          remoteId: 'existing-cli-session',
          importedAt: 100,
          nextCursor: 'next-history-page',
        },
        messages: [
          {
            id: 'imported-record',
            role: 'tool',
            text: '  Provider event payload.\n',
            turn: 2,
            kind,
            turnId: 'original-turn',
            agentId: 'child-agent',
            parentAgentId: 'root-agent',
            details: { original: true },
          },
        ],
      })
      vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([saved]) })
      const restored = readThreads()[0]
      expect(restored.importedHistory).toEqual(saved.importedHistory)
      expect(restored.messages[0]).toMatchObject(saved.messages[0])
    },
  )

  it.each(['running', 'reconnecting', 'unknown'] as const)(
    'restores an unfinished %s turn as uncertain instead of authorizing queued work',
    (turnStatus) => {
      const saved = thread({ turnStatus, busy: true })
      vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([saved]) })
      expect(readThreads()[0]).toMatchObject({
        turnStatus: 'unknown',
        busy: false,
        remoteId: 'provider-conversation',
      })
    },
  )
})

describe('imported provider history metadata boundaries', () => {
  const imported = {
    provider: 'codex' as const,
    remoteId: 'existing-cli-session',
    importedAt: 100,
    nextCursor: 'next-history-page',
  }

  it.each(['codex', 'claude'] as const)(
    'accepts %s history at the documented string limits',
    (provider) => {
      const bounded = {
        provider,
        remoteId: 'r'.repeat(2000),
        importedAt: 100,
        nextCursor: 'c'.repeat(16000),
      }
      expect(normalizeImportedThreadHistory(bounded)).toEqual(bounded)
    },
  )

  it.each([
    null,
    false,
    'invalid',
    { ...imported, provider: 'other-provider' },
    { ...imported, remoteId: '' },
    { ...imported, remoteId: '   ' },
    { ...imported, remoteId: 'r'.repeat(2001) },
    { ...imported, remoteId: 'session\nother' },
    { ...imported, remoteId: 42 },
    { ...imported, importedAt: 0 },
    { ...imported, importedAt: -1 },
    { ...imported, importedAt: Number.NaN },
    { ...imported, importedAt: Number.POSITIVE_INFINITY },
    { ...imported, importedAt: '100' },
  ])('rejects invalid imported history metadata %j', (invalid) => {
    expect(normalizeImportedThreadHistory(invalid)).toBeUndefined()
  })

  it('preserves a valid host history pagination cursor longer than ten thousand characters', () => {
    const nextCursor = 'c'.repeat(12000)
    expect(normalizeImportedThreadHistory({ ...imported, nextCursor })?.nextCursor).toBe(nextCursor)
  })

  it.each([undefined, '', 'c'.repeat(16001), 'page\nextra', 42])(
    'drops an invalid optional pagination cursor %j while keeping its imported session',
    (nextCursor) => {
      expect(normalizeImportedThreadHistory({ ...imported, nextCursor })).toEqual({
        provider: imported.provider,
        remoteId: imported.remoteId,
        importedAt: imported.importedAt,
      })
    },
  )
})
