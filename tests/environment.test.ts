import { describe, expect, it } from 'vitest'
import { describeEnvironment } from '../src/renderer/environment'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'

const profile: ConnectionProfile = {
  id: 'research-machine',
  name: 'Research workstation',
  host: 'research.example.test',
  port: 22,
  username: 'researcher',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/srv/previous-project',
  sshConfig: { alias: 'research', path: '/home/researcher/.ssh/config' },
}

function connected(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    status: 'connected',
    profile,
    workspace: '/srv/current-project',
    codex: 'codex-cli 0.161.0',
    claude: '2.1.0 (Claude Code)',
    ...overrides,
  }
}

describe('active environment descriptions', () => {
  it('describes the connected machine and the actual selected project', () => {
    const description = describeEnvironment(connected())
    expect(description).toMatchObject({
      profile,
      status: 'connected',
      statusLabel: 'Connected',
      machineName: 'Research workstation',
      authority: 'researcher@research.example.test',
      workspace: '/srv/current-project',
      projectName: 'current-project',
      scopeLabel: 'Agents',
      sshAlias: 'research',
      sshConfigPath: '/home/researcher/.ssh/config',
    })
    expect(description.providerStatuses).toEqual([
      {
        provider: 'codex',
        label: 'Codex',
        availability: 'available',
        detail: 'codex-cli 0.161.0',
      },
      {
        provider: 'claude',
        label: 'Claude Code',
        availability: 'available',
        detail: '2.1.0 (Claude Code)',
      },
    ])
  })

  it('prefers the live connection over a different saved profile', () => {
    const saved = { ...profile, id: 'other', name: 'Other machine', workspace: '/other' }
    expect(describeEnvironment(connected(), saved).profile).toBe(profile)
  })

  it('does not present the remembered project as active before project selection', () => {
    const description = describeEnvironment(
      connected({ workspace: undefined, lastWorkspace: '/srv/remembered-project' }),
    )
    expect(description.workspace).toBeUndefined()
    expect(description.projectName).toBeUndefined()
  })

  it('shows a saved machine and folder while disconnected, without stale provider availability', () => {
    const state = connected({ status: 'disconnected' })
    const saved = { ...profile, id: 'saved', name: 'Saved machine', workspace: '/srv/saved' }
    const description = describeEnvironment(state, saved)
    expect(description).toMatchObject({
      profile: saved,
      machineName: 'Saved machine',
      statusLabel: 'Disconnected',
      workspace: '/srv/saved',
      projectName: 'saved',
    })
    expect(description.providerStatuses.map((item) => item.availability)).toEqual([
      'unknown',
      'unknown',
    ])
  })

  it('does not reuse an old connection workspace while another machine is connecting', () => {
    const description = describeEnvironment({ status: 'connecting', profile })
    expect(description.statusLabel).toBe('Connecting')
    expect(description.workspace).toBeUndefined()
    expect(description.providerStatuses.every((item) => item.availability === 'unknown')).toBe(true)
  })

  it('uses an explicit research workspace and research label', () => {
    expect(
      describeEnvironment(connected(), undefined, '/root/.life/research', 'research'),
    ).toMatchObject({
      workspace: '/root/.life/research',
      projectName: 'research',
      scopeLabel: 'Research',
    })
  })

  it('allows an explicit empty override to clear the project without falling back', () => {
    const description = describeEnvironment(connected(), profile, '', 'customization')
    expect(description.workspace).toBeUndefined()
    expect(description.projectName).toBeUndefined()
    expect(description.scopeLabel).toBe('Customize Life')
  })

  it('preserves meaningful spaces in paths while treating a blank override as no project', () => {
    expect(describeEnvironment(connected(), profile, '/srv/project name ').workspace).toBe(
      '/srv/project name ',
    )
    expect(describeEnvironment(connected(), profile, '  ').workspace).toBeUndefined()
  })

  it.each([
    ['/srv/project///', 'project'],
    ['C:\\Users\\researcher\\project\\', 'project'],
    ['/', '/'],
    ['///', '/'],
    ['C:\\', 'C:\\'],
    ['C:/', 'C:/'],
    ['\\\\server\\share\\', 'share'],
  ])('names the project represented by %s', (workspace, name) => {
    expect(describeEnvironment(connected(), profile, workspace).projectName).toBe(name)
  })

  it('falls back to the host when a saved profile has no display name', () => {
    expect(
      describeEnvironment({ status: 'disconnected' }, { ...profile, name: '   ' }).machineName,
    ).toBe(profile.host)
  })

  it('shows an unselected environment clearly', () => {
    expect(describeEnvironment({ status: 'disconnected' })).toMatchObject({
      machineName: 'No environment selected',
      authority: 'No machine selected',
      workspace: undefined,
      projectName: undefined,
    })
  })

  it.each([
    ['research.example.test', 2222, 'researcher@research.example.test:2222'],
    ['2001:db8::1', 2222, 'researcher@[2001:db8::1]:2222'],
    ['[2001:db8::1]', 2222, 'researcher@[2001:db8::1]:2222'],
    ['2001:db8::1', 22, 'researcher@2001:db8::1'],
  ])('formats SSH authority for %s:%s', (host, port, expected) => {
    expect(describeEnvironment(connected({ profile: { ...profile, host, port } })).authority).toBe(
      expected,
    )
  })

  it('distinguishes missing providers from providers that have not been checked', () => {
    expect(
      describeEnvironment(connected({ codex: 'missing', claude: '' })).providerStatuses,
    ).toEqual([
      { provider: 'codex', label: 'Codex', availability: 'missing', detail: 'Not installed' },
      {
        provider: 'claude',
        label: 'Claude Code',
        availability: 'unknown',
        detail: 'Availability not checked',
      },
    ])
  })

  it('does not report an old missing provider check as current while disconnected', () => {
    const description = describeEnvironment(connected({ status: 'disconnected', codex: 'missing' }))
    expect(description.providerStatuses[0].availability).toBe('unknown')
  })
})
