import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentHistory } from '../src/main/agent-history'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import type { HostKeyRequest } from '../src/shared/types'
import { SSHFixture } from './helpers/ssh-fixture'

describe('existing Codex history over real SSH', () => {
  it('freezes the last item with descending pagination and imports every original output without modifying provider files', async () => {
    const fixture = await new SSHFixture().start()
    const store = new Store(join(fixture.root, 'history-settings'))
    await store.init()
    const connection = new SSHConnection(store)
    const history = new AgentHistory(connection)
    connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
    const id = 'existing-native-history'
    const path = join(fixture.root, '.codex', 'life-native-qa-history.json')
    const entries = [
      {
        turnId: 'existing-turn',
        item: {
          id: 'first',
          type: 'userMessage',
          content: [{ type: 'text', text: '  Existing exact user message\n' }],
        },
      },
      {
        turnId: 'existing-turn',
        item: { id: 'reason', type: 'reasoning', summary: ['Complete visible reasoning.'] },
      },
      {
        turnId: 'existing-turn',
        item: {
          id: 'answer',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'The complete existing answer.',
        },
      },
      {
        turnId: 'existing-turn',
        item: {
          id: 'last',
          type: 'commandExecution',
          command: 'pwd',
          aggregatedOutput: '/work/native\n',
          status: 'completed',
        },
      },
    ]
    const data = {
      sessions: [
        {
          id,
          name: 'Provider generated native title',
          cwd: fixture.workspace,
          model: 'fixture-model',
          source: 'cli',
          createdAt: 1791547200,
          updatedAt: 1791547201,
        },
      ],
      items: { [id]: entries },
    }
    try {
      await mkdir(join(fixture.root, '.codex'), { recursive: true })
      await writeFile(path, JSON.stringify(data))
      await connection.connect(fixture.input())
      const listed = await history.list({ provider: 'codex' })
      expect(listed.sessions[0]).toMatchObject({
        remoteId: id,
        title: 'Provider generated native title',
      })
      const first = await history.read({ id: 'codex:' + id, limit: 1 })
      expect(first.messages.map((message) => message.text)).toEqual([
        '  Existing exact user message\n',
      ])
      expect(first.nextCursor).toBeTruthy()
      // The provider file can grow after import begins. Its captured last item
      // must prevent a newly appended message from entering this old snapshot.
      entries.push({
        turnId: 'new-turn',
        item: {
          id: 'new',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'New output after the snapshot.',
        },
      })
      const afterAppend = JSON.stringify(data)
      await writeFile(path, afterAppend)
      const messages = [...first.messages]
      let cursor = first.nextCursor
      for (let page = 0; cursor && page < 6; page++) {
        const next = await history.read({ id: 'codex:' + id, cursor, limit: 1 })
        messages.push(...next.messages)
        cursor = next.nextCursor
      }
      expect(cursor).toBeUndefined()
      expect(messages.map((message) => message.text)).toEqual([
        '  Existing exact user message\n',
        'Complete visible reasoning.',
        'The complete existing answer.',
        '/work/native\n',
      ])
      expect(messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'tool',
      ])
      expect(messages[1].kind).toBe('reasoning')
      expect(await readFile(path, 'utf8')).toBe(afterAppend)
      const logs = await fixture.log()
      const snapshots = logs.filter((entry) => entry.message?.method === 'thread/items/list')
      expect(snapshots[0].message?.params).toMatchObject({ limit: 1, sortDirection: 'desc' })
      expect(
        snapshots.slice(1).every((entry) => entry.message?.params.sortDirection === 'asc'),
      ).toBe(true)
      expect(
        logs.some((entry) =>
          ['thread/start', 'thread/resume', 'turn/start'].includes(entry.message?.method as string),
        ),
      ).toBe(false)
    } finally {
      history.cancelAll()
      connection.disconnect()
      await fixture.close()
    }
  })
})
