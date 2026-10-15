import { describe, expect, it, vi } from 'vitest'
import {
  RendererDocumentAdmission,
  RendererRecoveryBudget,
  RendererReloadFlights,
  isNativeMainDocumentNavigation,
  requestsRendererReload,
} from '../src/main/renderer-recovery'
import { ThreadContextController } from '../src/renderer/thread-context'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'

describe('native document navigation policy', () => {
  it('leaves renderer attempts admitted until the idle native reload actually begins', () => {
    const admission = new RendererDocumentAdmission()
    admission.commitMainDocument()
    const revision = admission.documentRevision
    const rendererFrame = {}
    for (const isMainFrame of [true, false]) {
      const attempt = { isMainFrame, isSameDocument: false, initiator: rendererFrame }
      if (isNativeMainDocumentNavigation(attempt)) admission.suspend()
      expect(admission.allows('agent:respond')).toBe(true)
      expect(admission.allows('terminal:write')).toBe(true)
      expect(admission.documentRevision).toBe(revision)
    }
    const actualNativeReload = { isMainFrame: true, isSameDocument: false, initiator: null }
    if (isNativeMainDocumentNavigation(actualNativeReload)) admission.suspend()
    expect(admission.allows('agent:respond')).toBe(false)
    expect(admission.allows('terminal:write')).toBe(false)
    expect(admission.allows('conversations:checkpoint')).toBe(true)
    admission.commitMainDocument()
    expect(admission.allows('agent:respond')).toBe(true)
  })

  it('ignores native subframes and same-document fragment or history changes', () => {
    expect(
      isNativeMainDocumentNavigation({
        isMainFrame: false,
        isSameDocument: false,
        initiator: null,
      }),
    ).toBe(false)
    expect(
      isNativeMainDocumentNavigation({
        isMainFrame: true,
        isSameDocument: true,
        initiator: null,
      }),
    ).toBe(false)
  })

  it.each([
    'http://127.0.0.1:5173/',
    'http://127.0.0.1:5173/?mode=life#workspace',
    'file:///tmp/Life%20app/out/renderer/index.html',
  ])('only defers a renderer reload of its exact existing document: %s', (currentURL) => {
    expect(requestsRendererReload(currentURL, currentURL)).toBe(true)
    for (const foreign of [
      '',
      `${currentURL}foreign`,
      `${currentURL}?foreign`,
      'https://example.com/',
      'http://127.0.0.1:5174/',
      'javascript:location.reload()',
      'about:blank',
    ])
      expect(requestsRendererReload(currentURL, foreign)).toBe(false)
  })

  it('does not defer a renderer request before its first native document exists', () => {
    expect(requestsRendererReload('', '')).toBe(false)
    expect(requestsRendererReload('', 'http://127.0.0.1:5173/')).toBe(false)
  })

  it('keeps a fresh document request when a deferred old document completes late', () => {
    const owner = {}
    const flights = new RendererReloadFlights<object, object>()
    const oldDocument = {}
    const freshDocument = {}
    expect(flights.replace(owner, 1, oldDocument)).toBeUndefined()
    expect(flights.get(owner, 1)).toBe(oldDocument)
    expect(flights.get(owner, 2)).toBeUndefined()
    expect(flights.replace(owner, 2, freshDocument)).toBe(oldDocument)
    flights.clear(oldDocument)
    expect(flights.get(owner, 2)).toBe(freshDocument)
    expect(flights.get(owner, 1)).toBeUndefined()
    flights.clear(freshDocument)
    expect(flights.get(owner, 2)).toBeUndefined()
  })

  it('separates native documents while the preceding admission revision is still held', () => {
    const flights = new RendererReloadFlights<object, object>()
    const owner = {}
    const oldFlight = {}
    const newFlight = {}
    flights.replace(owner, 1, oldFlight, 'native-old-document')
    expect(flights.get(owner, 1, 'native-old-document')).toBe(oldFlight)
    expect(flights.get(owner, 1, 'native-new-document')).toBeUndefined()
    expect(flights.replace(owner, 1, newFlight, 'native-new-document')).toBe(oldFlight)
    flights.clear(oldFlight)
    expect(flights.get(owner, 1, 'native-new-document')).toBe(newFlight)
    expect(flights.get(owner, 1, 'native-old-document')).toBeUndefined()
  })

  it('does not coalesce two different windows with equal document revisions', () => {
    const flights = new RendererReloadFlights<object, object>()
    const firstWindow = {}
    const secondWindow = {}
    const request = {}
    flights.replace(firstWindow, 1, request)
    expect(flights.get(firstWindow, 1)).toBe(request)
    expect(flights.get(secondWindow, 1)).toBeUndefined()
  })
})

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
      'conversations:load',
      'conversations:loadEncoded',
      'conversations:save',
      'conversations:checkpoint',
      'agent:update-recovery-owner',
      'agent:acknowledge-recovery-history',
      'agent:prepare-recovery-cache',
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
