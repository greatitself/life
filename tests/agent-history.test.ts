import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import {
  AgentHistory,
  codexHistoryItem,
  codexHistorySummary,
  parseClaudeHistoryRecord,
} from '../src/main/agent-history'
import type { ConnectionState } from '../src/shared/types'

const execute = promisify(execFile)
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

class HistoryChannel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  requests: Array<{ id?: number; method: string; params: Record<string, unknown> }> = []
  respond: (method: string, params: Record<string, unknown>) => unknown = () => ({})
  write(raw: string) {
    const message = JSON.parse(raw)
    this.requests.push(message)
    if (message.id)
      queueMicrotask(() => {
        const result = this.respond(message.method, message.params)
        this.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              id: message.id,
              ...(result && typeof result === 'object' && 'error' in result ? result : { result }),
            }) + '\n',
          ),
        )
      })
    return true
  }
  signal() {}
  close() {
    this.destroyed = true
    this.emit('close')
  }
}

async function hostFixture(records: unknown[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'life-host-history-'))
  const root = join(directory, 'custom claude home')
  const project = join(root, 'projects', '-work-example')
  await mkdir(project, { recursive: true })
  const path = join(project, 'saved-session.jsonl')
  await writeFile(
    path,
    records
      .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
      .join('\n') + '\n',
  )
  const channel = new HistoryChannel()
  const ssh = Object.assign(new EventEmitter(), {
    state: { status: 'connected', home: directory } as ConnectionState,
    channel: vi.fn(async () => channel as unknown as ClientChannel),
    exec: vi.fn(
      async (command: string, options: { signal?: AbortSignal; maxOutputBytes?: number } = {}) => {
        const result = await execute('/bin/sh', ['-c', command], {
          env: { ...process.env, CLAUDE_CONFIG_DIR: root },
          signal: options.signal,
          maxBuffer: options.maxOutputBytes || 4_000_000,
        })
        return result.stdout
      },
    ),
  })
  const history = new AgentHistory(ssh)
  cleanup.push(async () => {
    history.cancelAll()
    await rm(directory, { recursive: true, force: true })
  })
  return { history, ssh, channel, path, project, root, directory }
}

const user = (uuid: string, text: string) => ({
  type: 'user',
  uuid,
  sessionId: 'saved-session',
  timestamp: '2026-10-09T12:00:00.000Z',
  cwd: '/work/example',
  message: { role: 'user', content: text },
})
const assistant = (uuid: string, content: unknown[]) => ({
  type: 'assistant',
  uuid,
  sessionId: 'saved-session',
  timestamp: '2026-10-09T12:00:01.000Z',
  cwd: '/work/example',
  message: {
    role: 'assistant',
    id: 'shared-assistant-message-id',
    model: 'claude-sonnet-4-6',
    content,
  },
})

describe('connected-host Claude Code history', () => {
  it('keeps Research history labeled and suppresses app-internal Studio and title metadata jobs', async () => {
    const fixture = await hostFixture()
    for (const [id, folder] of [
      ['research-native', 'research/goal/conversation'],
      ['studio-native', 'customization/studio-session'],
      ['title-native', 'metadata/title-job'],
      ['external-research', undefined],
    ] as const) {
      const workspace = folder ? join(fixture.directory, '.life', folder) : '/work/research'
      await writeFile(
        join(fixture.project, `${id}.jsonl`),
        JSON.stringify({ ...user(id, 'Original user text'), sessionId: id, cwd: workspace }) + '\n',
      )
    }
    const list = await fixture.history.list({ provider: 'claude' })
    expect(list.sessions.map((session) => session.remoteId).sort()).toEqual([
      'external-research',
      'research-native',
      'saved-session',
    ])
    expect(
      list.sessions.find((session) => session.remoteId === 'research-native')?.lifePurpose,
    ).toBe('research')
    expect(
      list.sessions.find((session) => session.remoteId === 'external-research')?.lifePurpose,
    ).toBeUndefined()
  })
  it('uses a custom config directory, generated title, provider model and original resumable session ID without changing provider files', async () => {
    const fixture = await hostFixture([
      { type: 'ai-title', aiTitle: 'Early title', sessionId: 'saved-session' },
      user('u1', 'This user message is not the chat title'),
      assistant('a1', [{ type: 'thinking', thinking: 'Inspecting the output.' }]),
      assistant('a2', [{ type: 'text', text: 'The complete result.' }]),
      {
        type: 'ai-title',
        aiTitle: 'Provider generated research title',
        sessionId: 'saved-session',
      },
    ])
    const original = await readFile(fixture.path)
    const listed = await fixture.history.list({ provider: 'claude' })
    expect(listed.warnings).toEqual([])
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({
      id: 'claude:saved-session',
      remoteId: 'saved-session',
      title: 'Provider generated research title',
      workspace: '/work/example',
      model: 'claude-sonnet-4-6',
    })
    const read = await fixture.history.read({ id: listed.sessions[0].id })
    expect(read.messages.map((message) => message.text)).toEqual([
      'This user message is not the chat title',
      'Inspecting the output.',
      'The complete result.',
    ])
    expect(new Set(read.messages.map((message) => message.id)).size).toBe(3)
    expect(await readFile(fixture.path)).toEqual(original)
    expect(fixture.ssh.channel).not.toHaveBeenCalled()
  })

  it('keeps tool calls, tool results and provider context distinct from human messages', async () => {
    const fixture = await hostFixture([
      user('u1', 'Run the check'),
      { ...user('context', 'Provider-internal context'), isMeta: true },
      assistant('a1', [
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'pwd' } },
      ]),
      {
        ...user('result', ''),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: [{ type: 'text', text: '/work/example' }],
            },
          ],
        },
      },
      assistant('a2', [{ type: 'text', text: 'Check completed.' }]),
    ])
    const page = await fixture.history.read({ id: 'claude:saved-session' })
    expect(page.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(page.messages.filter((message) => message.role === 'tool')).toHaveLength(3)
    expect(page.messages.find((message) => message.text === '/work/example')).toMatchObject({
      role: 'tool',
      title: 'Bash',
      turn: 1,
    })
    expect(
      page.messages.find((message) => message.text === 'Provider-internal context'),
    ).toMatchObject({ role: 'tool', kind: 'event' })
  })

  it('indexes subagents under their parent rather than adding them to the top-level chat list', async () => {
    const fixture = await hostFixture([user('u1', 'Parent task')])
    const child = join(fixture.project, 'saved-session', 'subagents')
    await mkdir(child, { recursive: true })
    await writeFile(
      join(child, 'agent-reviewer.jsonl'),
      JSON.stringify({
        ...user('child-u', 'Review task'),
        isSidechain: true,
        agentId: 'reviewer',
      }) + '\n',
    )
    const list = await fixture.history.list({ provider: 'claude' })
    expect(list.sessions.map((session) => session.id)).toEqual(['claude:saved-session'])
    const page = await fixture.history.read({ id: 'claude:saved-session' })
    expect(page.subagents).toHaveLength(1)
    expect(page.subagents[0]).toMatchObject({
      id: 'claude:subagent:saved-session:reviewer',
      parentRemoteId: 'saved-session',
      agentName: 'reviewer',
    })
  })

  it('paginates by UTF-8 byte offsets without losing Unicode messages or malformed-record tolerance', async () => {
    const fixture = await hostFixture([
      user('u1', '🧪 First'),
      'malformed JSON record',
      user('u2', '第二条消息'),
      assistant('a1', [{ type: 'text', text: 'Complete ✓' }]),
    ])
    const first = await fixture.history.read({ id: 'claude:saved-session', limit: 1 })
    expect(first.messages.map((message) => message.text)).toEqual(['🧪 First'])
    expect(first.nextCursor).toBeTruthy()
    const second = await fixture.history.read({
      id: 'claude:saved-session',
      cursor: first.nextCursor,
      limit: 1,
    })
    expect(second.messages.map((message) => message.text)).toEqual(['第二条消息'])
    expect(second.messages[0].turn).toBe(2)
    expect(second.warnings).toHaveLength(1)
    const third = await fixture.history.read({
      id: 'claude:saved-session',
      cursor: second.nextCursor,
      limit: 1,
    })
    expect(third.messages.map((message) => message.text)).toEqual(['Complete ✓'])
    expect(third.nextCursor).toBeUndefined()
  })

  it('retains tool names when a result arrives on the next saved history page', async () => {
    const fixture = await hostFixture([
      user('u1', 'Run it'),
      assistant('call', [
        { type: 'tool_use', id: 'call-id', name: 'Bash', input: { command: 'pwd' } },
      ]),
      {
        ...user('result', ''),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-id', content: '/work/example' }],
        },
      },
    ])
    const first = await fixture.history.read({ id: 'claude:saved-session', limit: 2 })
    const second = await fixture.history.read({
      id: 'claude:saved-session',
      cursor: first.nextCursor,
      limit: 1,
    })
    expect(second.messages[0]).toMatchObject({
      role: 'tool',
      title: 'Bash',
      text: '/work/example',
      turn: 1,
    })
  })

  it('freezes imported Claude history before later Life prompts are appended to the provider transcript', async () => {
    const fixture = await hostFixture([
      user('old-1', 'Old first prompt'),
      user('old-2', 'Old second prompt'),
    ])
    const first = await fixture.history.read({ id: 'claude:saved-session', limit: 1 })
    const original = await readFile(fixture.path, 'utf8')
    await writeFile(
      fixture.path,
      original + JSON.stringify(user('life-3', 'New prompt already displayed in Life')) + '\n',
    )
    const remaining = await fixture.history.read({
      id: 'claude:saved-session',
      cursor: first.nextCursor,
    })
    expect(remaining.messages.map((message) => message.text)).toEqual(['Old second prompt'])
    expect(remaining.nextCursor).toBeUndefined()
  })

  it('keeps identically named Claude subagents distinct under separate parent sessions and imports the latest model', async () => {
    const fixture = await hostFixture([
      user('root-u', 'Task'),
      assistant('old-model', [{ type: 'text', text: 'Earlier model' }]),
      {
        ...assistant('new-model', [{ type: 'text', text: 'Latest model' }]),
        message: {
          model: 'claude-opus-4-6',
          role: 'assistant',
          content: [{ type: 'text', text: 'Latest model' }],
        },
      },
    ])
    await writeFile(
      join(fixture.project, 'second-parent.jsonl'),
      JSON.stringify(user('second-u', 'Other root')) + '\n',
    )
    for (const parent of ['saved-session', 'second-parent']) {
      const directory = join(fixture.project, parent, 'subagents')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'agent-shared.jsonl'),
        JSON.stringify({
          ...user(`child-${parent}`, `Child of ${parent}`),
          agentId: 'shared',
          isSidechain: true,
        }) + '\n',
      )
    }
    const first = await fixture.history.read({ id: 'claude:saved-session' })
    const second = await fixture.history.read({ id: 'claude:second-parent' })
    expect(first.session.model).toBe('claude-opus-4-6')
    expect(first.subagents[0].id).toBe('claude:subagent:saved-session:shared')
    expect(second.subagents[0].id).toBe('claude:subagent:second-parent:shared')
    expect((await fixture.history.read({ id: first.subagents[0].id })).messages[0].text).toBe(
      'Child of saved-session',
    )
    expect((await fixture.history.read({ id: second.subagents[0].id })).messages[0].text).toBe(
      'Child of second-parent',
    )
  })

  it('retries metadata discovery under a replacement request after the first caller was cancelled', async () => {
    const fixture = await hostFixture([user('u1', 'Existing conversation')])
    fixture.ssh.exec.mockImplementationOnce(
      async (_command, options = {}) =>
        new Promise<string>((_resolve, reject) => {
          if (options.signal?.aborted) reject(new Error('cancelled initial discovery'))
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('cancelled initial discovery')),
            { once: true },
          )
        }),
    )
    const first = fixture.history.list({ provider: 'claude', requestId: 'first-list' })
    const failure = first.catch((error) => error)
    await vi.waitFor(() => expect(fixture.ssh.exec).toHaveBeenCalled())
    fixture.history.cancel('first-list')
    const replacement = await fixture.history.list({
      provider: 'claude',
      requestId: 'replacement-list',
    })
    expect((await failure).message).toContain('cancelled')
    expect(replacement.warnings).toEqual([])
    expect(replacement.sessions).toHaveLength(1)
  })

  it('reads a large individual tool record intact across bounded chunks', async () => {
    const text = 'Unicode 🧬 output\n'.repeat(90_000)
    const fixture = await hostFixture([
      user('u1', 'Check output'),
      {
        ...user('tool-output', ''),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'large-tool', content: text }],
        },
      },
    ])
    const first = await fixture.history.read({ id: 'claude:saved-session', limit: 1 })
    const second = await fixture.history.read({
      id: 'claude:saved-session',
      cursor: first.nextCursor,
    })
    expect(second.messages[0].text).toBe(text)
    expect(second.nextCursor).toBeUndefined()
  }, 20_000)

  it('rejects forged offsets and cross-machine pagination before executing file commands', async () => {
    const fixture = await hostFixture([user('u1', 'First'), user('u2', 'Second')])
    const first = await fixture.history.read({ id: 'claude:saved-session', limit: 1 })
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())
    const before = fixture.ssh.exec.mock.calls.length
    await expect(
      fixture.history.read({
        id: 'claude:saved-session',
        cursor: Buffer.from(JSON.stringify({ ...cursor, offset: -1 })).toString('base64url'),
      }),
    ).rejects.toThrow('Invalid history pagination cursor')
    await expect(
      fixture.history.read({
        id: 'claude:saved-session',
        cursor: Buffer.from(JSON.stringify({ ...cursor, machine: 'another-host' })).toString(
          'base64url',
        ),
      }),
    ).rejects.toThrow('expired')
    expect(fixture.ssh.exec.mock.calls.length).toBe(before)
  })

  it('cancels a pending remote discovery and prevents late results entering a new host', async () => {
    const fixture = await hostFixture()
    fixture.ssh.exec.mockImplementation(
      async (_command, options = {}) =>
        new Promise((resolve, reject) => {
          const signal = options.signal
          if (signal?.aborted) reject(new Error('cancelled'))
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
    )
    const pending = fixture.history.list({ provider: 'claude', requestId: 'cancel-this' })
    await vi.waitFor(() => expect(fixture.ssh.exec).toHaveBeenCalled())
    fixture.history.cancel('cancel-this')
    await expect(pending).rejects.toThrow('cancelled')
    expect(fixture.ssh.channel).not.toHaveBeenCalled()
  })
})

describe('read-only Codex app-server history', () => {
  it('does not list ephemeral title jobs or reserved Studio sessions as Agents-project history', async () => {
    const fixture = await hostFixture()
    fixture.channel.respond = (method, params) =>
      method === 'thread/list'
        ? {
            data: params.archived
              ? []
              : [
                  {
                    id: 'research-native',
                    name: 'Research conversation',
                    cwd: join(fixture.directory, '.life/research/goal/conversation'),
                    source: 'appServer',
                  },
                  {
                    id: 'studio-native',
                    name: 'Studio request',
                    cwd: join(fixture.directory, '.life/customization/session'),
                    source: 'appServer',
                  },
                  {
                    id: 'metadata-native',
                    name: 'Generated title task',
                    cwd: join(fixture.directory, '.life/metadata/title-task'),
                    source: 'appServer',
                  },
                  {
                    id: 'ephemeral-title',
                    name: 'Ephemeral title',
                    ephemeral: true,
                    cwd: '/work/project',
                    source: 'appServer',
                  },
                  {
                    id: 'external-research',
                    name: 'Ordinary project',
                    cwd: '/work/research',
                    source: 'cli',
                  },
                ],
            nextCursor: null,
          }
        : {}
    const list = await fixture.history.list({ provider: 'codex' })
    expect(list.sessions.map((session) => session.remoteId).sort()).toEqual([
      'external-research',
      'research-native',
    ])
    expect(
      list.sessions.find((session) => session.remoteId === 'research-native')?.lifePurpose,
    ).toBe('research')
  })
  it('retries a cancelled Codex startup for the replacement browsing request', async () => {
    const fixture = await hostFixture()
    fixture.channel.respond = (method, params) =>
      method === 'thread/list'
        ? {
            data: params.archived
              ? []
              : [{ id: 'existing', name: 'Generated title', source: 'cli' }],
            nextCursor: null,
          }
        : {}
    fixture.ssh.channel.mockImplementationOnce(
      async (...args: unknown[]) =>
        new Promise<ClientChannel>((_resolve, reject) => {
          const signal = args[2] as AbortSignal
          if (signal?.aborted) reject(new Error('cancelled initial Codex startup'))
          signal?.addEventListener(
            'abort',
            () => reject(new Error('cancelled initial Codex startup')),
            { once: true },
          )
        }),
    )
    const first = fixture.history.list({ provider: 'codex', requestId: 'first-codex' })
    const failure = first.catch((error) => error)
    await vi.waitFor(() => expect(fixture.ssh.channel).toHaveBeenCalled())
    fixture.history.cancel('first-codex')
    const replacement = await fixture.history.list({
      provider: 'codex',
      requestId: 'replacement-codex',
    })
    expect((await failure).message).toContain('cancelled')
    expect(replacement.warnings).toEqual([])
    expect(replacement.sessions).toHaveLength(1)
    expect(fixture.ssh.channel).toHaveBeenCalledTimes(2)
  })

  it('stops imported Codex pages at the captured native boundary before newer Life turns', async () => {
    const fixture = await hostFixture()
    fixture.channel.respond = (method, params) => {
      if (method === 'thread/read')
        return { thread: { id: 'original', name: 'Generated title', source: 'cli' } }
      if (method !== 'thread/items/list') return {}
      const originalLast = {
        turnId: 'old-turn-2',
        item: { type: 'agentMessage', id: 'old-answer-2', text: 'Old answer two' },
      }
      if (params.sortDirection === 'desc') return { data: [originalLast], nextCursor: null }
      if (!params.cursor)
        return {
          data: [
            {
              turnId: 'old-turn-1',
              item: {
                type: 'userMessage',
                id: 'old-user-1',
                content: [{ type: 'text', text: 'Old prompt one' }],
              },
            },
          ],
          nextCursor: 'provider-page-2',
        }
      return {
        data: [
          originalLast,
          {
            turnId: 'new-life-turn',
            item: {
              type: 'userMessage',
              id: 'new-life-user',
              content: [{ type: 'text', text: 'Already displayed in Life' }],
            },
          },
        ],
        nextCursor: 'provider-page-3',
      }
    }
    const first = await fixture.history.read({ id: 'codex:original' })
    const second = await fixture.history.read({ id: 'codex:original', cursor: first.nextCursor })
    expect(second.messages.map((message) => message.text)).toEqual(['Old answer two'])
    expect(second.nextCursor).toBeUndefined()
    expect(
      fixture.channel.requests.filter(
        (request) =>
          request.method === 'thread/items/list' && request.params.sortDirection === 'desc',
      ),
    ).toHaveLength(1)
  })

  it('shows archived native sessions even when there are no active saved sessions', async () => {
    const fixture = await hostFixture()
    fixture.channel.respond = (method, params) =>
      method === 'thread/list'
        ? {
            data: params.archived
              ? [{ id: 'archived-native', name: 'Archived generated title', source: 'cli' }]
              : [],
            nextCursor: null,
          }
        : {}
    const list = await fixture.history.list({ provider: 'codex' })
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]).toMatchObject({
      remoteId: 'archived-native',
      title: 'Archived generated title',
      archived: true,
    })
    expect(list.nextCursor).toBeUndefined()
    expect(
      fixture.channel.requests
        .filter((request) => request.method === 'thread/list')
        .map((request) => request.params.archived),
    ).toEqual([false, true])
  })

  it('lists persisted generated titles from all root source kinds and sends no prompts or mutation requests', async () => {
    const fixture = await hostFixture()
    fixture.channel.respond = (method) =>
      method === 'thread/list'
        ? {
            data: [
              {
                id: 'codex-native',
                name: 'Generated task title',
                preview: 'Do not use this prompt as a title',
                cwd: '/work/native',
                model: 'gpt-6.1-sol',
                reasoningEffort: 'high',
                createdAt: 1791547200,
                updatedAt: 1791547201,
                source: 'cli',
              },
              {
                id: 'child',
                name: 'Child',
                parentThreadId: 'codex-native',
                source: { subAgent: 'review' },
              },
            ],
            nextCursor: null,
          }
        : {}
    const list = await fixture.history.list({ provider: 'codex' })
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]).toMatchObject({
      title: 'Generated task title',
      remoteId: 'codex-native',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
      workspace: '/work/native',
    })
    expect(fixture.channel.requests.map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/list',
      'thread/list',
    ])
    expect(fixture.channel.requests.at(-1)?.params).toMatchObject({
      useStateDbOnly: true,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
    })
    expect(JSON.stringify(fixture.channel.requests)).not.toContain('turn/start')
    expect(fixture.ssh.exec).not.toHaveBeenCalled()
  })

  it('pages real ThreadItemEntry shapes preserving tool output, reasoning and subagent metadata', async () => {
    const fixture = await hostFixture()
    fixture.channel.respond = (method, params) => {
      if (method === 'thread/read')
        return {
          thread: {
            id: 'codex-native',
            name: 'Generated title',
            cwd: '/work/native',
            source: 'cli',
          },
        }
      if (method === 'thread/items/list' && !params.cursor)
        if (params.sortDirection === 'desc')
          return {
            data: [{ turnId: 'turn-1', item: { type: 'collabAgentToolCall', id: 'spawn-1' } }],
            nextCursor: null,
          }
      if (method === 'thread/items/list' && !params.cursor)
        return {
          data: [
            {
              turnId: 'turn-1',
              item: {
                type: 'userMessage',
                id: 'user-1',
                content: [{ type: 'text', text: 'User said only this', text_elements: [] }],
              },
              startedAtMs: 1791547200000,
            },
            {
              turnId: 'turn-1',
              item: {
                type: 'reasoning',
                id: 'reason-1',
                summary: ['Checking'],
                content: ['Visible reasoning'],
              },
            },
          ],
          nextCursor: 'next-provider-page',
        }
      if (method === 'thread/items/list')
        return {
          data: [
            {
              turnId: 'turn-1',
              item: {
                type: 'commandExecution',
                id: 'cmd-1',
                command: 'pwd',
                aggregatedOutput: '/work/native\n',
                status: 'completed',
              },
            },
            {
              turnId: 'turn-1',
              item: {
                type: 'collabAgentToolCall',
                id: 'spawn-1',
                tool: 'spawnAgent',
                senderThreadId: 'codex-native',
                receiverThreadIds: ['subagent-1'],
                prompt: 'Review the task',
                agentsStates: { 'subagent-1': { status: 'completed' } },
                status: 'completed',
              },
            },
          ],
          nextCursor: null,
        }
      return {}
    }
    const first = await fixture.history.read({ id: 'codex:codex-native' })
    expect(first.messages.map((message) => message.text)).toEqual([
      'User said only this',
      'Checking\n\nVisible reasoning',
    ])
    const second = await fixture.history.read({
      id: 'codex:codex-native',
      cursor: first.nextCursor,
    })
    expect(second.messages[0]).toMatchObject({
      role: 'tool',
      title: 'pwd',
      text: '/work/native\n',
      turn: 1,
    })
    expect(second.messages[1]).toMatchObject({
      kind: 'subagent',
      agentId: 'subagent-1',
      parentAgentId: 'codex-native',
    })
    expect(second.nextCursor).toBeUndefined()
    expect(
      fixture.channel.requests.find((request) => request.method === 'thread/read')?.params
        .includeTurns,
    ).toBe(false)
  })

  it('supports older paginated turns when items/list is unavailable without restarting provider sessions', async () => {
    const fixture = await hostFixture()
    fixture.channel.respond = (method) => {
      if (method === 'thread/read')
        return { thread: { id: 'older', name: 'Older generated title', source: 'cli' } }
      if (method === 'thread/items/list')
        return { error: { code: -32601, message: 'Method not found' } }
      if (method === 'thread/turns/list')
        return {
          data: [
            {
              id: 'turn-old',
              items: [{ type: 'agentMessage', id: 'answer', text: 'Prior answer' }],
              startedAt: 1791547200,
              completedAt: 1791547201,
            },
          ],
          nextCursor: null,
        }
      return {}
    }
    const page = await fixture.history.read({ id: 'codex:older' })
    expect(page.messages[0]).toMatchObject({
      role: 'assistant',
      text: 'Prior answer',
      createdAt: 1791547200000,
    })
    expect(
      fixture.channel.requests.some((request) =>
        ['thread/resume', 'turn/start', 'thread/start'].includes(request.method),
      ),
    ).toBe(false)
  })

  it('returns partial results if one provider is unavailable rather than discarding the other history', async () => {
    const fixture = await hostFixture([user('u1', 'Saved Claude chat')])
    fixture.channel.respond = (method) =>
      method === 'thread/list'
        ? { error: { code: -32000, message: 'Codex history unavailable' } }
        : {}
    const page = await fixture.history.list()
    expect(page.sessions.map((session) => session.provider)).toEqual(['claude'])
    expect(page.warnings).toEqual(['Codex history: Codex history unavailable'])
  })
})

describe('provider-history parser safety', () => {
  it('does not replace a generated title with a first-message preview', () => {
    expect(codexHistorySummary({ id: 'id', preview: 'First user prompt' })?.title).toBe(
      'Untitled Codex session',
    )
  })
  it('preserves multiple Claude blocks sharing a message ID', () => {
    const context = { turn: 1, tools: new Map<string, string>() }
    const first = parseClaudeHistoryRecord(
      assistant('first-uuid', [{ type: 'thinking', thinking: 'Visible thinking' }]),
      context,
      'fallback',
    )
    const second = parseClaudeHistoryRecord(
      assistant('second-uuid', [{ type: 'text', text: 'Visible result' }]),
      context,
      'fallback',
    )
    expect(first[0].id).not.toBe(second[0].id)
    expect([first[0].text, second[0].text]).toEqual(['Visible thinking', 'Visible result'])
  })
  it('preserves unfamiliar public provider events instead of silently hiding them', () => {
    const messages = codexHistoryItem(
      { item: { id: 'future', type: 'futureEvent', usefulField: 'Preserve this' } },
      1,
    )
    expect(messages[0]).toMatchObject({ role: 'tool', kind: 'event', title: 'futureEvent' })
    expect(messages[0].text).toContain('Preserve this')
  })
})
