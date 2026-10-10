import { afterEach, describe, expect, it, vi } from 'vitest'
import { configPatchSchema } from '../src/shared/customization'
import { webPermissionMode } from '../src/shared/permissions'
import { agentSettingsSchema, startSchema } from '../src/shared/validation'
import { readThreads } from '../src/renderer/state'
import {
  createStudioSession,
  encodeStudioSessions,
  parseStudioSessions,
} from '../src/renderer/studio-history'
import type { PermissionMode } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())

describe('native web permissions', () => {
  it('migrates older web choices without retaining Plan or broadening access', () => {
    expect(webPermissionMode('codex', 'review')).toBe('ask-for-approval')
    expect(webPermissionMode('codex', 'edit')).toBe('ask-for-approval')
    expect(webPermissionMode('codex', 'plan')).toBe('read-only')
    expect(webPermissionMode('claude', 'plan')).toBe('review')
    expect(webPermissionMode('claude', 'auto-review')).toBe('review')
    expect(webPermissionMode('codex', 'auto')).toBe('ask-for-approval')
  })

  it.each<PermissionMode>([
    'ask-for-approval',
    'read-only',
    'auto-review',
    'full-access',
    'auto',
    'dontAsk',
  ])('keeps %s through validation, settings, and history reload', (mode) => {
    expect(
      startSchema.parse({ sessionId: 'thread', provider: 'codex', prompt: 'Hi', mode }).mode,
    ).toBe(mode)
    expect(agentSettingsSchema.parse({ sessionId: 'thread', mode }).mode).toBe(mode)
    expect(configPatchSchema.parse({ defaultMode: mode }).defaultMode).toBe(mode)
    const session = createStudioSession('codex', 1, 'thread')
    session.thread.mode = mode
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([session.thread]) })
    expect(readThreads()[0].mode).toBe(mode)
    expect(parseStudioSessions(encodeStudioSessions([session]))[0].thread.mode).toBe(mode)
  })
})
