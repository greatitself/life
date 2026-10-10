import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeAdvisoryEvent,
  claudeLaunchCommand,
  claudeRestoresUsageTotals,
  ClaudeMessageBlocks,
} from '../src/main/claude-protocol'

describe('Claude launch permissions', () => {
  it.each([
    ['0', false],
    ['1000', true],
  ])('enables live bypass only for a non-root remote user (uid %s)', (uid, bypass) => {
    const directory = mkdtempSync(join(tmpdir(), 'life claude launch '))
    try {
      writeFileSync(join(directory, 'id'), `#!/bin/sh\nprintf '%s\\n' '${uid}'\n`, { mode: 0o755 })
      writeFileSync(join(directory, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
      const literal = 'literal $HOME `whoami` "quotes" 研究'
      const output = execFileSync(
        '/bin/sh',
        [
          '-c',
          claudeLaunchCommand(directory, [
            'claude',
            '-p',
            '--permission-mode',
            'default',
            '--settings',
            literal,
          ]),
        ],
        {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          encoding: 'utf8',
        },
      )
        .trim()
        .split('\n')
      expect(output).toEqual([
        '-p',
        '--permission-mode',
        'default',
        '--settings',
        literal,
        ...(bypass ? ['--allow-dangerously-skip-permissions'] : []),
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Claude content-block reconciliation', () => {
  it('recognizes result summaries already represented by completed content blocks', () => {
    const blocks = new ClaudeMessageBlocks()
    expect(blocks.matchesText('New final result')).toBe(false)
    blocks.assistant({ id: 'reply', content: [{ type: 'text', text: 'Before' }] }, 'before')
    blocks.assistant(
      { id: 'reply', content: [{ type: 'tool_use', id: 'tool', name: 'Read' }] },
      'tool',
    )
    blocks.assistant({ id: 'reply', content: [{ type: 'text', text: 'After' }] }, 'after')
    expect(blocks.matchesText('Before\nAfter')).toBe(true)
    expect(blocks.matchesText('BeforeAfter')).toBe(true)
    expect(blocks.matchesText('After')).toBe(true)
    expect(blocks.matchesText('New final result')).toBe(false)
    expect(blocks.hasEnvelope('after')).toBe(true)
    expect(blocks.hasEnvelope('after', 'child')).toBe(false)
  })

  it.each(['Agent', 'Task'])(
    'routes the initial %s stream block to its native child row',
    (name) => {
      const blocks = new ClaudeMessageBlocks()
      blocks.stream({ type: 'message_start', message: { id: 'reply' } })
      expect(
        blocks.stream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'delegate', name, input: {} },
        }),
      ).toEqual([
        expect.objectContaining({ type: 'subagent', agentId: 'delegate', itemId: 'delegate' }),
      ])
    },
  )

  it('keeps text/tool/text blocks sharing one API message ID in their original positions', () => {
    const blocks = new ClaudeMessageBlocks()
    const first = blocks.assistant(
      { id: 'api-message', content: [{ type: 'text', text: 'Before' }] },
      'first',
    )
    blocks.assistant(
      { id: 'api-message', content: [{ type: 'tool_use', id: 'tool', name: 'Read' }] },
      'tool',
    )
    const last = blocks.assistant(
      { id: 'api-message', content: [{ type: 'text', text: 'After' }] },
      'last',
    )
    expect(first).toEqual([
      { type: 'text', itemId: 'api-message', text: 'Before', status: 'replace' },
    ])
    expect(last).toEqual([
      { type: 'text', itemId: 'api-message:block:2', text: 'After', status: 'replace' },
    ])
    expect(blocks.text('api-message')).toBe('Before\nAfter')
  })

  it('replaces a streamed block snapshot without erasing another block or duplicating its deltas', () => {
    const blocks = new ClaudeMessageBlocks()
    blocks.stream({ type: 'message_start', message: { id: 'api-message' } })
    blocks.stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    expect(
      blocks.stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Before' },
      }),
    ).toEqual([{ type: 'text', itemId: 'api-message', text: 'Before' }])
    expect(
      blocks.assistant({ id: 'api-message', content: [{ type: 'text', text: 'Before' }] }, 'first'),
    ).toEqual([{ type: 'text', itemId: 'api-message', text: 'Before', status: 'replace' }])
    blocks.stream({ type: 'content_block_stop', index: 0 })
    blocks.stream({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'read', name: 'Read' },
    })
    blocks.assistant(
      { id: 'api-message', content: [{ type: 'tool_use', id: 'read', name: 'Read' }] },
      'tool',
    )
    blocks.stream({ type: 'content_block_stop', index: 1 })
    blocks.stream({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    })
    const delta = blocks.stream({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'Af' },
    })[0]
    const complete = blocks.assistant(
      { id: 'api-message', content: [{ type: 'text', text: 'After' }] },
      'last',
    )[0]
    expect(delta.itemId).toBe('api-message:block:2')
    expect(complete).toEqual({
      type: 'text',
      itemId: delta.itemId,
      text: 'After',
      status: 'replace',
    })
    expect(blocks.text('api-message')).toBe('Before\nAfter')
  })

  it('keeps provider thinking separate from user-facing text', () => {
    const blocks = new ClaudeMessageBlocks()
    blocks.stream({ type: 'message_start', message: { id: 'api-message' } })
    blocks.stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    })
    expect(
      blocks.stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Provider explanation' },
      }),
    ).toEqual([
      { type: 'reasoning', itemId: 'api-message:thinking:0', text: 'Provider explanation' },
    ])
    expect(
      blocks.assistant(
        { id: 'api-message', content: [{ type: 'thinking', thinking: 'Provider explanation' }] },
        'thinking',
      ),
    ).toEqual([
      {
        type: 'reasoning',
        itemId: 'api-message:thinking:0',
        text: 'Provider explanation',
        status: 'replace',
      },
    ])
    blocks.stream({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    })
    expect(
      blocks.assistant(
        { id: 'api-message', content: [{ type: 'text', text: 'Answer' }] },
        'answer',
      )[0].itemId,
    ).toBe('api-message:block:1')
    expect(blocks.text('api-message')).toBe('Answer')
  })

  it('deduplicates replayed complete envelopes and keeps child streams independent', () => {
    const blocks = new ClaudeMessageBlocks()
    const content = { id: 'api-message', content: [{ type: 'text', text: 'Parent' }] }
    blocks.assistant(content, 'envelope')
    expect(blocks.assistant(content, 'envelope')).toEqual([])
    expect(
      blocks.assistant(
        { ...content, content: [{ type: 'text', text: 'Child' }] },
        'envelope',
        'delegate',
      )[0].text,
    ).toBe('Child')
    expect(blocks.text('api-message')).toBe('Parent')
    expect(blocks.text('api-message', 'delegate')).toBe('Child')
  })

  it('retains an in-progress child block when a new root turn starts', () => {
    const blocks = new ClaudeMessageBlocks()
    blocks.stream({ type: 'message_start', message: { id: 'child-message' } }, 'delegate')
    blocks.stream(
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      'delegate',
    )
    blocks.stream(
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'First ' } },
      'delegate',
    )
    blocks.assistant(
      { id: 'root-message', content: [{ type: 'text', text: 'Root finished' }] },
      'root',
    )
    blocks.resetRoot()
    const delta = blocks.stream(
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'second' } },
      'delegate',
    )[0]
    expect(delta.itemId).toBe('child-message:block:2')
    expect(blocks.text('child-message', 'delegate')).toBe('First second')
  })
})

describe('Claude native observability', () => {
  it('displays native usage warnings without treating their percentage as permission to run', () => {
    expect(
      claudeAdvisoryEvent({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', utilization: 0.5 },
      }),
    ).toBeUndefined()
    const rejected = claudeAdvisoryEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', utilization: 0.5, resetsAt: 100 },
    })
    expect(rejected).toMatchObject({
      type: 'status',
      text: 'Claude has reached its usage limit.',
      details: { rateLimitInfo: { status: 'rejected', resetsAt: 100 } },
    })
    expect(rejected).not.toHaveProperty('status', 'completed')
  })

  it('retains automatic denials as failed native tool calls', () => {
    expect(
      claudeAdvisoryEvent({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'command',
        agent_id: 'child',
        message: 'Denied by a configured rule.',
      }),
    ).toMatchObject({
      type: 'tool',
      itemId: 'command',
      title: 'Bash',
      status: 'failed',
      text: 'Denied by a configured rule.',
      details: { agent_id: 'child' },
    })
  })

  it('reports retries and compaction without ending a turn', () => {
    expect(
      claudeAdvisoryEvent({
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 3000,
      }),
    ).toMatchObject({
      type: 'status',
      text: 'Claude is retrying the request (attempt 2).',
      details: { retry_delay_ms: 3000 },
    })
    expect(
      claudeAdvisoryEvent({ type: 'system', subtype: 'status', status: 'compacting' }),
    ).toMatchObject({ type: 'status', status: 'compacting' })
    expect(claudeAdvisoryEvent({ type: 'system', subtype: 'status', status: null })).toMatchObject({
      type: 'status',
      status: 'running',
      text: '',
    })
  })

  it.each([
    ['2.1.276', false],
    ['2.1.277', true],
    ['2.1.296 (Claude Code)', true],
    ['claude 2.1.278', true],
    ['claude test', false],
  ])('detects usage restore support from %s', (version, restored) => {
    expect(claudeRestoresUsageTotals(version)).toBe(restored)
  })
})
