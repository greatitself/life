import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindLegacyThreadWorkspace, readThreads, type Thread } from '../src/renderer/state'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'

const profile: ConnectionProfile = {
  id: 'machine',
  name: 'Research server',
  host: 'localhost',
  port: 22,
  username: 'researcher',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '~/projects/previous',
}
const legacy: Thread = {
  id: 'thread',
  profileId: profile.id,
  remoteId: 'provider-conversation',
  provider: 'codex',
  title: 'Previous project',
  messages: [],
  busy: false,
  model: '',
  mode: 'review',
  updatedAt: 1,
  turn: 0,
  pending: [],
}
const connected = (lastWorkspace?: string): ConnectionState => ({
  status: 'connected',
  profile,
  home: '/home/researcher',
  lastWorkspace,
})

afterEach(() => vi.unstubAllGlobals())

describe('project associations across upgrades and reconnects', () => {
  it('binds a legacy provider conversation to the canonical prior folder rather than its tilde or symlink spelling', () => {
    const migrated = bindLegacyThreadWorkspace(legacy, connected('/srv/projects/previous'))
    expect(migrated.workspace).toBe('/srv/projects/previous')
    expect(migrated.remoteId).toBe('provider-conversation')
    const changed = { ...connected('/srv/projects/new'), workspace: '/srv/projects/new' }
    expect(bindLegacyThreadWorkspace(migrated, changed)).toBe(migrated)
    expect(migrated.workspace).toBe('/srv/projects/previous')
  })

  it('keeps an unresolved old conversation unbound after choosing a new folder and reconnecting', () => {
    const unresolved = bindLegacyThreadWorkspace(legacy, connected())
    expect(unresolved.workspaceUnknown).toBe(true)
    expect(unresolved.workspace).toBeUndefined()
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([unresolved]) })
    const restored = readThreads()[0]
    expect(restored.workspaceUnknown).toBe(true)
    const reconnected = {
      ...connected('/srv/projects/new'),
      profile: { ...profile, workspace: '/srv/projects/new' },
      workspace: '/srv/projects/new',
    }
    expect(bindLegacyThreadWorkspace(restored, reconnected)).toBe(restored)
    expect(restored.workspace).toBeUndefined()
  })

  it('leaves local-only Life messages available for their first actual remote project', () => {
    const local = { ...legacy, remoteId: undefined }
    expect(bindLegacyThreadWorkspace(local, connected('/srv/projects/previous'))).toBe(local)
    expect(bindLegacyThreadWorkspace(local, connected())).toBe(local)
    expect(local.workspace).toBeUndefined()
    expect(local.workspaceUnknown).toBeUndefined()
  })

  it('does not migrate a different machine’s conversation and restores saved canonical associations', () => {
    expect(
      bindLegacyThreadWorkspace({ ...legacy, profileId: 'other-machine' }, connected()),
    ).toEqual({ ...legacy, profileId: 'other-machine' })
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify([{ ...legacy, workspace: '/srv/projects/previous' }]),
    })
    expect(readThreads()[0].workspace).toBe('/srv/projects/previous')
  })
})
