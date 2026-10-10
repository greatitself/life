import { describe, expect, it } from 'vitest'
import type { Message } from '../src/renderer/state'
import {
  activityAnchor,
  activitySummary,
  completedTurnResponse,
  createTurnGroupProjector,
  groupThreadTurns,
  messagePhaseLabel,
  outputPreview,
  providerPlanSteps,
  previewNavigableMessages,
  subagentPresentation,
  threadOutputSequence,
  threadHasRunningChildren,
  threadTurnStartedAt,
  toolOutputSections,
} from '../src/renderer/thread-presentation'

function message(
  id: string,
  role: Message['role'],
  turn: number,
  patch: Partial<Message> = {},
): Message {
  return { id, role, turn, text: id, ...patch }
}

describe('thread output presentation', () => {
  it('keeps Stop available for background children after the parent has finished', () => {
    const parent = message('parent', 'assistant', 1, { status: 'running' })
    expect(threadHasRunningChildren({ messages: [parent], pending: [] })).toBe(false)
    for (const child of [
      message('child', 'tool', 1, { agentId: 'worker', status: 'running' }),
      message('spawn', 'tool', 1, { kind: 'subagent', status: 'initializing' }),
    ]) {
      expect(threadHasRunningChildren({ messages: [parent, child], pending: [] })).toBe(true)
      expect(
        threadHasRunningChildren({ messages: [{ ...child, status: 'interrupted' }], pending: [] }),
      ).toBe(false)
    }
    expect(
      threadHasRunningChildren({
        messages: [],
        pending: [{ sessionId: 'parent', type: 'approval', agentId: 'worker' }],
      }),
    ).toBe(true)
  })
  it('replaces completed Codex activity with its parent final response without changing stored history', () => {
    const user = message('user', 'user', 1, { finishStatus: 'completed' })
    const progress = message('progress', 'assistant', 1, { phase: 'commentary' })
    const reasoning = message('reasoning', 'assistant', 1, { kind: 'reasoning' })
    const final = message('final', 'assistant', 1, { phase: 'final_answer' })
    const child = message('child', 'assistant', 1, { phase: 'final_answer', agentId: 'child' })
    const messages = [user, progress, reasoning, final, child]
    const group = groupThreadTurns(messages)[0]
    expect(completedTurnResponse(group, false, 'completed')).toBe(final)
    expect(completedTurnResponse(group, true, 'running')).toBeUndefined()
    expect(group.messages).toEqual([progress, reasoning, final, child])
    expect(messages).toEqual([user, progress, reasoning, final, child])
  })

  it('uses the last unphased Claude response on completion and preserves unsuccessful or uncertain work', () => {
    const user = message('user', 'user', 1)
    const progress = message('progress', 'assistant', 1)
    const final = message('final', 'assistant', 1)
    const reasoning = message('reasoning', 'assistant', 1, { kind: 'reasoning' })
    const group = groupThreadTurns([user, progress, final, reasoning])[0]
    expect(completedTurnResponse(group, false, 'completed')).toBe(final)
    for (const status of ['running', 'reconnecting', 'unknown', 'failed', 'interrupted']) {
      expect(completedTurnResponse(group, false, status)).toBeUndefined()
    }
    group.messages.push(message('error', 'error', 1))
    expect(completedTurnResponse(group, false, 'completed')).toBeUndefined()
  })

  it('uses a current unsuccessful or uncertain turn state before an older request completion marker', () => {
    const group = groupThreadTurns([
      message('user', 'user', 1, { finishStatus: 'completed' }),
      message('final', 'assistant', 1, { phase: 'final_answer' }),
    ])[0]
    for (const status of ['running', 'reconnecting', 'unknown', 'failed', 'interrupted']) {
      expect(completedTurnResponse(group, false, status)).toBeUndefined()
    }
    expect(completedTurnResponse(group, false, 'completed')?.id).toBe('final')
  })

  it('shows retry errors during work and returns to the final response after recovery succeeds', () => {
    const final = message('final', 'assistant', 1, { phase: 'final_answer' })
    const group = groupThreadTurns([
      message('user', 'user', 1, { finishStatus: 'completed' }),
      message('retry', 'error', 1, { details: { recoverable: true } }),
      final,
    ])[0]
    expect(completedTurnResponse(group, true, 'running')).toBeUndefined()
    expect(completedTurnResponse(group, false, 'completed')).toBe(final)
  })

  it('does not mistake a progress update or a child response for the final result', () => {
    const group = groupThreadTurns([
      message('user', 'user', 1, { finishStatus: 'completed' }),
      message('progress', 'assistant', 1, { phase: 'commentary' }),
      message('child', 'assistant', 1, { phase: 'final_answer', parentItemId: 'child-task' }),
    ])[0]
    expect(completedTurnResponse(group, false, 'completed')).toBeUndefined()
  })

  it('keeps independent child work and unresolved requests visible after the parent answers', () => {
    const user = message('user', 'user', 1, { finishStatus: 'completed' })
    const final = message('final', 'assistant', 1, { phase: 'final_answer' })
    for (const activity of [
      message('child-command', 'tool', 1, { agentId: 'child', status: 'running' }),
      message('child-start', 'tool', 1, { kind: 'subagent', status: 'initializing' }),
      message('approval', 'tool', 1, { kind: 'event', status: 'waiting' }),
    ]) {
      const group = groupThreadTurns([user, final, activity])[0]
      expect(completedTurnResponse(group, false, 'completed')).toBeUndefined()
      activity.status = 'completed'
      expect(completedTurnResponse(group, false, 'completed')).toBe(final)
    }
  })

  it('uses the original turn request for elapsed time after steering and across later turns', () => {
    const original = message('original', 'user', 1, { createdAt: 10 })
    const steering = message('steering', 'user', 1, { submission: 'steering', createdAt: 90 })
    const next = message('next', 'user', 2, { createdAt: 100 })
    expect(threadTurnStartedAt({ turn: 1, messages: [original, steering] })).toBe(10)
    expect(threadTurnStartedAt({ turn: 2, messages: [original, steering, next] })).toBe(100)
    expect(threadTurnStartedAt({ turn: 3, messages: [original, steering, next] })).toBeUndefined()
  })

  it('reuses unaffected turn props while streaming and refreshes a delayed child update', () => {
    const project = createTurnGroupProjector()
    const request = message('request', 'user', 1)
    const child = message('child', 'tool', 1, { agentId: 'child', status: 'running' })
    const next = message('next', 'user', 2)
    const response = message('response', 'assistant', 2)
    const original = project([request, child, next, response])
    const streamed = project([request, child, next, { ...response, text: 'More output' }])
    expect(streamed[0]).toBe(original[0])
    expect(streamed[1]).not.toBe(original[1])
    const childFinished = project([
      request,
      { ...child, status: 'completed' },
      next,
      streamed[1].messages[0],
    ])
    expect(childFinished[0]).not.toBe(streamed[0])
    expect(childFinished[1]).toBe(streamed[1])
    expect(project([request, child])[0]).not.toBe(childFinished[0])
  })

  it('keeps every human request and the final response navigable after activity is hidden', () => {
    const user = message('user', 'user', 1, { finishStatus: 'completed' })
    const progress = message('progress', 'assistant', 1, { phase: 'commentary' })
    const steering = message('steering', 'user', 1, { text: 'Use the other approach.' })
    const final = message('final', 'assistant', 1, { phase: 'final_answer' })
    const messages = [user, progress, steering, final]
    expect(
      previewNavigableMessages({
        messages,
        busy: false,
        turn: 1,
        turnStatus: 'completed',
      } as import('../src/renderer/state').Thread),
    ).toEqual([user, steering, final])
  })

  it('uses reported action text rather than a reasoning-summary label', () => {
    expect(
      activitySummary(
        message('reasoning', 'assistant', 1, {
          kind: 'reasoning',
          title: 'Reasoning summary',
          text: '**Inspecting the renderer**\nDetails.',
        }),
      ),
    ).toBe('Inspecting the renderer')
    expect(activitySummary(message('plan', 'assistant', 1, { kind: 'plan' }))).toBe(
      'Updated the plan',
    )
  })

  it('keeps steering inside its running turn and associates delayed output with its recorded turn', () => {
    const request = message('request', 'user', 1)
    const progress = message('progress', 'assistant', 1)
    const steering = message('steering', 'user', 1, { text: 'Use the other approach.' })
    const command = message('command', 'tool', 1)
    const nextRequest = message('next-request', 'user', 2)
    const delayed = message('late-first-turn', 'tool', 1)
    const response = message('next-response', 'assistant', 2)
    const input = [request, progress, steering, command, nextRequest, delayed, response]

    const groups = groupThreadTurns(input)

    expect(groups.map((group) => group.turn)).toEqual([1, 2])
    expect(groups[0].user).toBe(request)
    expect(groups[0].messages).toEqual([progress, steering, command, delayed])
    expect(groups[1].user).toBe(nextRequest)
    expect(groups[1].messages).toEqual([response])
    expect(groups.flatMap((group) => [group.user, ...group.messages]).filter(Boolean)).toHaveLength(
      input.length,
    )
    expect(input).toEqual([request, progress, steering, command, nextRequest, delayed, response])
  })

  it('retains imported output with no user request and uses stable distinct anchors for each turn', () => {
    const imported = message('imported', 'assistant', 0)
    const tool = message('historical-tool', 'tool', 0)
    const request = message('new-request', 'user', 1)
    const groups = groupThreadTurns([imported, tool, request])

    expect(groups[0].user).toBeUndefined()
    expect(groups[0].messages).toEqual([imported, tool])
    expect(groups[1].user).toBe(request)
    expect(groups[0].key).not.toBe(groups[1].key)
    expect(
      groupThreadTurns([imported, tool, request, message('stream', 'assistant', 1)]).map(
        (group) => group.key,
      ),
    ).toEqual(groups.map((group) => group.key))
  })

  it('never moves the last assistant update past subsequent tools or errors', () => {
    const messages = [
      message('progress', 'assistant', 3, { phase: 'commentary' }),
      message('first-tool', 'tool', 3),
      message('explanation', 'assistant', 3),
      message('steering', 'user', 3),
      message('last-tool', 'tool', 3),
      message('failure', 'error', 3),
    ]
    const sequence = threadOutputSequence({ key: 'three', turn: 3, messages })

    expect(sequence.map((entry) => entry.id)).toEqual([
      'progress',
      'first-tool',
      'explanation',
      'steering',
      'last-tool',
      'failure',
    ])
    sequence.forEach((entry, index) => expect(entry).toBe(messages[index]))
  })

  it('uses provider phase metadata rather than guessing phases from assistant wording', () => {
    expect(messagePhaseLabel(message('summary', 'assistant', 1, { kind: 'reasoning' }))).toBe(
      'Reasoning summary',
    )
    expect(messagePhaseLabel(message('plan', 'assistant', 1, { kind: 'plan' }))).toBe('Plan')
    expect(messagePhaseLabel(message('progress', 'assistant', 1, { phase: 'commentary' }))).toBe(
      'Progress update',
    )
    expect(messagePhaseLabel(message('final', 'assistant', 1, { phase: 'final_answer' }))).toBe(
      'Response',
    )
    expect(
      messagePhaseLabel(
        message('untyped', 'assistant', 1, { text: 'Final answer: I am thinking about a plan.' }),
      ),
    ).toBeUndefined()
  })

  it('renders actual provider plan steps and statuses without shortening content or guessing a plan', () => {
    const fullStep = 'Inspect <exact> provider data.\n' + 'Keep all fields.\n'.repeat(500)
    const details = {
      plan: [
        { step: fullStep, status: 'completed' },
        { text: 'Validate streamed output.', status: 'in_progress' },
        { content: 'Report the result.', status: 'pending' },
        { status: 'pending' },
        null,
      ],
    }
    const plan = message('provider-plan', 'assistant', 1, { kind: 'plan', details })
    expect(providerPlanSteps(plan)).toEqual([
      { text: fullStep, status: 'completed' },
      { text: 'Validate streamed output.', status: 'in_progress' },
      { text: 'Report the result.', status: 'pending' },
    ])
    expect(plan.details).toBe(details)
    expect(
      providerPlanSteps(
        message('alternate', 'assistant', 1, {
          kind: 'plan',
          details: { steps: [{ step: 'Alternate provider format.', status: 'unknown_status' }] },
        }),
      ),
    ).toEqual([{ text: 'Alternate provider format.', status: 'unknown_status' }])
    expect(providerPlanSteps(message('not-plan', 'assistant', 1, { details }))).toEqual([])
    expect(
      providerPlanSteps(
        message('unstructured-plan', 'assistant', 1, {
          kind: 'plan',
          text: '1. A text-only plan.',
        }),
      ),
    ).toEqual([])
  })

  it('keeps exact command input, complete output and provider data as separate inspectable sections', () => {
    const input = 'printf "<done>\\n"\ncat notes.txt\n'
    const output = '<done>\n' + 'large tool output\r\n'.repeat(10_000) + 'last byte\n'
    const details = {
      agentId: 'agent-one',
      status: 'completed',
      result: { files: ['a.ts'], value: '<raw>' },
    }
    const tool = message('tool', 'tool', 1, { input, text: output, details })

    expect(toolOutputSections(tool)).toEqual([
      { label: 'Input', text: input },
      { label: 'Output', text: output },
      { label: 'Provider details', text: JSON.stringify(details, null, 2) },
    ])
    expect(tool.input).toBe(input)
    expect(tool.text).toBe(output)
    expect(tool.details).toBe(details)
  })

  it('does not duplicate input echoed as output or provider details already displayed verbatim', () => {
    const input = '{\n  "command": "pwd"\n}'
    const details = { command: 'pwd' }
    expect(toolOutputSections(message('echo', 'tool', 1, { input, text: input, details }))).toEqual(
      [{ label: 'Input', text: input }],
    )
    expect(toolOutputSections(message('no-output', 'tool', 1, { text: '', details: {} }))).toEqual(
      [],
    )
    expect(toolOutputSections(message('whitespace', 'tool', 1, { text: ' \n\t' }))).toEqual([
      { label: 'Output', text: ' \n\t' },
    ])
  })

  it('bounds mounted previews while preserving exact unabridged output for copying and inspection', () => {
    const raw = 'START:<file>\r\n' + 'important output\n'.repeat(20_000) + '\nEND:untouched'
    const tool = message('large-output', 'tool', 1, { text: raw })
    const preview = outputPreview(tool.text, 1000)

    expect(preview.shortened).toBe(true)
    expect(preview.characters).toBe(raw.length)
    expect(preview.text.startsWith('START:<file>\r\n')).toBe(true)
    expect(preview.text.endsWith('\nEND:untouched')).toBe(true)
    expect(preview.text.length).toBeLessThan(1200)
    expect(preview.text).toContain('characters in the full output')
    expect(toolOutputSections(tool)).toEqual([{ label: 'Output', text: raw }])
    expect(tool.text).toBe(raw)
    expect(outputPreview('exact\n', 6)).toEqual({
      text: 'exact\n',
      shortened: false,
      characters: 6,
    })
  })

  it('never mounts the entire output when a caller supplies a zero preview budget', () => {
    const raw = 'private long provider payload\n'.repeat(10_000)
    const preview = outputPreview(raw, 0)
    expect(preview.shortened).toBe(true)
    expect(preview.characters).toBe(raw.length)
    expect(preview.text.length).toBeLessThan(200)
    expect(preview.text).not.toContain('private long provider payload')
  })

  it('bounds repetitive short-line logs even when their complete body fits the character budget', () => {
    const raw = Array.from({ length: 100 }, (_, index) => `log ${index}`).join('\n')
    expect(raw.length).toBeLessThan(6000)
    const tool = message('many-lines', 'tool', 1, { text: raw })
    const preview = outputPreview(tool.text)

    expect(preview.shortened).toBe(true)
    expect(preview.characters).toBe(raw.length)
    expect(preview.text.split('\n').length).toBeLessThanOrEqual(35)
    expect(preview.text.startsWith('log 0\n')).toBe(true)
    expect(preview.text.endsWith('log 99')).toBe(true)
    expect(toolOutputSections(tool)).toEqual([{ label: 'Output', text: raw }])
    expect(tool.text).toBe(raw)
  })
})

describe('subagent presentation', () => {
  it('represents the launch task, provider identity and nesting without shortening the task', () => {
    const task = 'Review the parser and preserve every field.\n' + 'Details matter.\n'.repeat(500)
    const launched = message('launch', 'tool', 1, {
      title: 'collabAgentToolCall',
      status: 'running',
      agentId: 'provider-agent-id',
      agentName: 'Parser review',
      parentItemId: 'parent-tool:item/one',
      input: JSON.stringify({ task_name: 'fallback-name', agent_id: 'fallback-id', prompt: task }),
    })
    expect(subagentPresentation(launched)).toEqual({
      name: 'Parser review',
      id: 'provider-agent-id',
      parentItemId: 'parent-tool:item/one',
      task,
      status: 'running',
      participants: [],
    })
  })

  it('uses structured task names and preserves every participant identity and status', () => {
    const waiting = message('wait', 'tool', 2, {
      title: 'wait_agent',
      status: 'completed',
      input: JSON.stringify({ task_name: 'Integration checks', message: 'Report exact failures.' }),
      details: {
        agentsStates: {
          'agent-one': { agentName: 'Backend review', status: 'completed' },
          'agent-two': { name: 'UI review', status: 'running' },
          'agent-three': 'failed',
        },
      },
    })
    expect(subagentPresentation(waiting)).toMatchObject({
      name: 'Integration checks',
      task: 'Report exact failures.',
      participants: [
        { id: 'agent-one', name: 'Backend review', status: 'completed' },
        { id: 'agent-two', name: 'UI review', status: 'running' },
        { id: 'agent-three', name: 'agent-three', status: 'failed' },
      ],
    })
  })

  it('supports Claude task descriptions and remains readable with malformed legacy inputs', () => {
    expect(
      subagentPresentation(
        message('claude-task', 'tool', 1, {
          title: 'Agent',
          input: JSON.stringify({
            description: 'Audit attachments',
            subagent_type: 'Explore',
            prompt: 'Check upload handling.',
          }),
        }),
      ),
    ).toMatchObject({
      name: 'Audit attachments',
      task: 'Check upload handling.',
      status: 'completed',
    })
    expect(
      subagentPresentation(
        message('legacy', 'tool', 1, {
          title: 'TaskOutput',
          input: 'unstructured previous tool input',
          details: { agents_states: { 'raw-id': 'completed' } },
        }),
      ),
    ).toMatchObject({
      name: 'TaskOutput',
      participants: [{ id: 'raw-id', name: 'raw-id', status: 'completed' }],
    })
  })

  it('encodes provider IDs into stable DOM anchors without allowing raw selector or markup characters', () => {
    const id = 'turn:1/agent <review>#panel?query="quoted"'
    const anchor = activityAnchor(id)
    expect(anchor).not.toMatch(/[\s<>"#?]/)
    expect(decodeURIComponent(anchor.slice('activity-'.length))).toBe(id)
    expect(activityAnchor(id)).toBe(anchor)
    expect(activityAnchor('one')).not.toBe(activityAnchor('two'))
  })
})
