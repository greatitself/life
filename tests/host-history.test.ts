import { describe, expect, it } from 'vitest'
import { appendHostHistory, hostHistoryThread } from '../src/renderer/host-history'
import type { HostHistoryPage } from '../src/shared/agent-history'
import { hostHistoryWorkspacePurpose } from '../src/shared/agent-history'

function page(turn = 1, nextCursor?: string, continuationOf?: string): HostHistoryPage {
  return {
    session: {
      id: 'codex:native-session',
      provider: 'codex',
      remoteId: 'native-session',
      title: 'Generated title',
      workspace: '/work/original',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
      createdAt: 1000,
      updatedAt: 2000,
      source: 'cli',
    },
    messages: [
      {
        id: `codex:native-turn-${turn}:user`,
        role: 'user',
        text: `Original user turn ${turn}`,
        turn,
      },
    ],
    subagents: [],
    warnings: [],
    nextCursor,
    continuationOf,
  }
}

describe('host history display import', () => {
  it('keeps reserved Research, Studio and metadata sessions out of Agents imports', () => {
    const history = page()
    for (const [folder, label] of [
      ['research/goal/conversation', 'Research'],
      ['customization/studio-session', 'Life Studio'],
      ['metadata/title-job', 'title task'],
    ] as const) {
      history.session.workspace = `/root-directory/.life/${folder}`
      expect(() => hostHistoryThread(history, 'profile', '/root-directory')).toThrow(label)
    }
  })
  it('classifies reserved machine directories without mistaking an ordinary research project for Life Research', () => {
    expect(hostHistoryWorkspacePurpose('/work/research', '/root-directory')).toBeUndefined()
    expect(
      hostHistoryWorkspacePurpose('/root-directory/research', '/root-directory'),
    ).toBeUndefined()
    expect(
      hostHistoryWorkspacePurpose('/root-directory/.life/research-other', '/root-directory'),
    ).toBeUndefined()
    expect(hostHistoryWorkspacePurpose('/work/.life/research', '/root-directory')).toBeUndefined()
    expect(
      hostHistoryWorkspacePurpose('/root-directory//.life/research/goal', '/root-directory/'),
    ).toBe('research')
    expect(
      hostHistoryWorkspacePurpose(
        '/root-directory/.life/research/../metadata/title',
        '/root-directory',
      ),
    ).toBe('metadata')
    const history = page()
    history.session.workspace = '/work/research'
    expect(hostHistoryThread(history, 'profile', '/root-directory').workspace).toBe(
      '/work/research',
    )
  })
  it('rejects importing a standalone subagent while preserving its parent routing identity', () => {
    const history = page()
    history.session.parentRemoteId = 'parent-session'
    expect(() => hostHistoryThread(history, 'profile')).toThrow('parent conversation')
  })
  it('retains the exact remote session, original folder, generated title, model and visible history continuation', () => {
    const thread = hostHistoryThread(page(1, 'native-page-2'), 'machine-profile')
    expect(thread).toMatchObject({
      profileId: 'machine-profile',
      remoteId: 'native-session',
      workspace: '/work/original',
      title: 'Generated title',
      titleSource: 'provider',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
      busy: false,
      importedHistory: {
        provider: 'codex',
        remoteId: 'native-session',
        nextCursor: 'native-page-2',
      },
    })
    expect(thread.messages[0].text).toBe('Original user turn 1')
  })
  it('keeps unknown folders explicit instead of assigning the currently selected project', () => {
    const history = page()
    delete history.session.workspace
    const thread = hostHistoryThread(history, 'machine-profile')
    expect(thread.workspace).toBeUndefined()
    expect(thread.workspaceUnknown).toBe(true)
  })
  it('places remaining native history before subsequent Life activity and preserves the correct active turn', () => {
    const thread = hostHistoryThread(page(1, 'next'), 'machine-profile')
    thread.turn = 2
    thread.busy = true
    thread.agentTurns = { reviewer: 2 }
    thread.messages.push(
      { id: 'local-user-id', role: 'user', text: 'Follow-up from Life', turn: 2 },
      { id: '2:active-item', role: 'assistant', text: 'Partial running output', turn: 2 },
    )
    const merged = appendHostHistory(thread, page(2, undefined, 'next'))
    expect(merged.messages.map((message) => message.text)).toEqual([
      'Original user turn 1',
      'Original user turn 2',
      'Follow-up from Life',
      'Partial running output',
    ])
    expect(merged.messages.map((message) => message.turn)).toEqual([1, 2, 3, 3])
    expect(merged.messages.at(-1)?.id).toBe('3:active-item')
    expect(merged).toMatchObject({ busy: true, turn: 3, agentTurns: { reviewer: 3 } })
    expect(merged.importedHistory?.nextCursor).toBeUndefined()
  })
  it('deduplicates repeated native pages and never duplicates an ordinary existing Life thread', () => {
    const thread = hostHistoryThread(page(), 'machine-profile')
    expect(appendHostHistory(thread, page()).messages).toHaveLength(1)
    delete thread.importedHistory
    thread.messages[0].id = 'local-message-uuid'
    expect(appendHostHistory(thread, page())).toBe(thread)
  })
  it('rejects history from another session before it changes any displayed messages', () => {
    const thread = hostHistoryThread(page(), 'machine-profile')
    const other = page()
    other.session.remoteId = 'different'
    expect(() => appendHostHistory(thread, other)).toThrow('different provider conversation')
  })
  it('opens an existing imported conversation without merging a fresh provider snapshot containing Life turns', () => {
    const thread = hostHistoryThread(page(1, 'original-continuation'), 'machine-profile')
    thread.messages.push({
      id: 'local-user',
      role: 'user',
      text: 'Already displayed Life prompt',
      turn: 2,
    })
    thread.turn = 2
    const fresh = page(2, 'new-snapshot-continuation')
    fresh.messages[0].text = 'Already displayed Life prompt'
    expect(appendHostHistory(thread, fresh)).toBe(thread)
    expect(
      thread.messages.filter((message) => message.text === 'Already displayed Life prompt'),
    ).toHaveLength(1)
  })
})
