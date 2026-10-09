import { describe, expect, it, vi } from 'vitest'
import { RendererDocumentAdmission, RendererRecoveryBudget } from '../src/main/renderer-recovery'
import { ThreadContextController } from '../src/renderer/thread-context'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'

describe('renderer recovery restart budget', () => {
  it('restarts an initial crash but requires a decision for repeated crashes', () => {
    const recovery = new RendererRecoveryBudget()
    expect(recovery.allowAutomaticRecovery(0)).toBe(true)
    expect(recovery.allowAutomaticRecovery(1)).toBe(false)
    expect(recovery.allowAutomaticRecovery(10_000)).toBe(false)
    expect(recovery.allowAutomaticRecovery(40_000)).toBe(false)
  })

  it('permits a later isolated crash only after a full minute without failures', () => {
    const recovery = new RendererRecoveryBudget()
    expect(recovery.allowAutomaticRecovery(0)).toBe(true)
    expect(recovery.allowAutomaticRecovery(59_999)).toBe(false)
    expect(recovery.allowAutomaticRecovery(60_000)).toBe(false)
    expect(recovery.allowAutomaticRecovery(120_000)).toBe(true)
    expect(recovery.allowAutomaticRecovery(120_001)).toBe(false)
  })
})

describe('renderer document admission during native recovery', () => {
  it('keeps snapshots and rescue controls usable while rejecting fresh native work', () => {
    const admission = new RendererDocumentAdmission()
    admission.commitMainDocument()
    admission.suspend()
    for (const channel of [
      'connection:state',
      'profiles:list',
      'source-code:get',
      'window:restart',
      'window:initial-recovery',
    ])
      expect(admission.allows(channel), channel).toBe(true)
    for (const channel of [
      'connection:select-workspace',
      'connection:connect',
      'connection:execute',
      'agent:start',
      'profiles:save',
      'source-code:apply',
      'terminal:write',
    ])
      expect(admission.allows(channel), channel).toBe(false)
    const oldRevision = admission.documentRevision
    admission.commitMainDocument()
    expect(admission.documentRevision).toBeGreaterThan(oldRevision)
    expect(admission.allows('connection:select-workspace')).toBe(true)
  })

  it('rejects an old controller’s queued selection after its first request is cancelled', async () => {
    const admission = new RendererDocumentAdmission()
    admission.commitMainDocument()
    const profile: ConnectionProfile = {
      id: 'machine',
      name: 'Research machine',
      host: 'research.example',
      port: 22,
      username: 'researcher',
      auth: 'key',
      privateKeyPath: '/keys/id_ed25519',
      workspace: '/project-c',
    }
    let state: ConnectionState = { status: 'connected', profile, workspace: profile.workspace }
    let cancelFirst!: (error: Error) => void
    const requests: string[] = []
    const client = {
      state: async () => state,
      connect: async () => state,
      selectWorkspace: vi.fn(async (workspace: string) => {
        if (!admission.allows('connection:select-workspace'))
          throw new Error('Life is restarting its interface')
        requests.push(workspace)
        if (workspace === '/project-a')
          return new Promise<ConnectionState>((_resolve, reject) => {
            cancelFirst = reject
          })
        state = { ...state, workspace }
        return state
      }),
    }
    const oldController = new ThreadContextController()
    const thread = { id: 'a', profileId: profile.id, workspace: '/project-a', remoteId: 'saved-a' }
    const first = oldController.restore(thread, [profile], client)
    await vi.waitFor(() => expect(requests).toEqual(['/project-a']))
    const queued = oldController.restore(
      { ...thread, id: 'b', workspace: '/project-b', remoteId: 'saved-b' },
      [profile],
      client,
    )
    // Recovery suspends IPC before cancelling A, while the old document and its
    // controller are still alive and the native persistence barrier is pending.
    admission.suspend()
    cancelFirst(new Error('The Life interface changed'))
    expect(await first).toEqual({ kind: 'superseded' })
    expect(await queued).toMatchObject({ kind: 'project', path: '/project-b' })
    expect(requests).toEqual(['/project-a'])
    expect(state.workspace).toBe('/project-c')
    admission.commitMainDocument()
    expect(
      await new ThreadContextController().restore(
        { ...thread, id: 'c', workspace: '/project-c', remoteId: 'saved-c' },
        [profile],
        client,
      ),
    ).toMatchObject({ kind: 'ready', connection: { workspace: '/project-c' } })
    expect(requests).toEqual(['/project-a'])
  })
})
