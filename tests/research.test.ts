import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../src/shared/types'
import {
  buildResearchGraph,
  createProject,
  deleteProject,
  exportResearchBackup,
  importResearchBackup,
  readProjects,
  reconcileProjects,
  RESEARCH_STORAGE_KEY,
  saveProjects,
  updateProject,
} from '../src/renderer/research'

const profile: ConnectionProfile = {
  id: 'research-machine',
  name: 'Research server',
  host: 'research.example.com',
  port: 22,
  username: 'researcher',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '~/projects/experiment',
}

afterEach(() => vi.unstubAllGlobals())

describe('research registry', () => {
  it('infers actual saved workspaces without demo projects or duplicate profile links', () => {
    expect(readProjects([], { getItem: () => null })).toEqual([])
    const projects = readProjects([profile], { getItem: () => null })
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      id: 'profile:research-machine',
      title: 'Research server',
      summary: 'Workspace: ~/projects/experiment',
      status: 'active',
      profileId: profile.id,
      dependencies: [],
    })
    const edited = updateProject(projects, projects[0].id, {
      title: 'Ablation study',
      notes: 'Run 2',
    })
    expect(reconcileProjects(edited, [profile, profile])).toEqual(edited)
    expect(reconcileProjects(edited, [])).toEqual(edited)
    const linked = createProject({ id: 'custom', title: 'Custom project', profileId: profile.id })
    expect(reconcileProjects([linked], [profile])).toEqual([linked])
  })

  it('recovers workspaces when storage is malformed, blocked, oversized, or absent', () => {
    for (const getItem of [
      () => '{broken',
      () => 'x'.repeat(4_000_001),
      () => {
        throw new Error('Blocked')
      },
    ]) {
      expect(readProjects([profile], { getItem })[0].profileId).toBe(profile.id)
    }
    vi.stubGlobal('localStorage', undefined)
    expect(readProjects([profile])[0].profileId).toBe(profile.id)
    expect(() => saveProjects([])).not.toThrow()
  })

  it('sanitizes persisted records and strips unexpected fields, controls, and dangling dependencies', () => {
    const raw = JSON.stringify([
      { invalid: true },
      {
        id: 'first',
        title: '\u0000Important\u202eresearch',
        notes: 'Line one\r\nLine two\u0000',
        summary: 17,
        status: 'invented',
        tags: ['Methods', 'Methods', '', 'x'.repeat(100), 12],
        dependencies: ['first', 'missing', 'second', 'second', 12],
        profileId: profile.id,
        createdAt: 100,
        updatedAt: 20,
        password: 'must not persist',
      },
      { id: 'first', title: 'Duplicate' },
      { id: 'second', title: 'Other work', dependencies: ['first'] },
      { id: 'bad\nid', title: 'Invalid identifier' },
    ])
    const projects = readProjects([], { getItem: () => raw })
    expect(projects.map((project) => project.id)).toEqual(['first', 'second'])
    expect(projects[0]).toEqual({
      id: 'first',
      title: 'Importantresearch',
      notes: 'Line one\nLine two',
      summary: '',
      status: 'planned',
      tags: ['Methods', 'x'.repeat(48)],
      dependencies: ['second'],
      profileId: profile.id,
      createdAt: 100,
      updatedAt: 100,
    })
    expect(projects[1].dependencies).toEqual(['first'])
  })

  it('bounds project content and record count without mutating caller data', () => {
    const project = createProject({
      id: 'one',
      title: '😀'.repeat(200),
      summary: 's'.repeat(3_000),
      notes: 'n'.repeat(9_000),
      tags: Array.from({ length: 20 }, (_, i) => `Tag ${i}`),
    })
    expect(Array.from(project.title)).toHaveLength(160)
    expect(project.summary).toHaveLength(2_000)
    expect(project.notes).toHaveLength(8_000)
    expect(project.tags).toHaveLength(12)
    const projects = Array.from({ length: 250 }, (_, i) =>
      createProject({ id: `p${i}`, title: `P${i}` }),
    )
    expect(reconcileProjects(projects, [])).toHaveLength(200)
    expect(projects).toHaveLength(250)
  })

  it('updates only editable identity-preserving fields and removes deleted dependency links', () => {
    const first = createProject({ id: 'first', title: 'First', createdAt: 123 })
    const second = createProject({ id: 'second', title: 'Second', dependencies: ['first'] })
    const updated = updateProject([first, second], 'first', {
      id: 'replacement',
      createdAt: 999,
      title: 'Changed',
      status: 'complete',
      dependencies: ['first', 'missing', 'second'],
      profileId: profile.id,
    })
    expect(updated[0]).toMatchObject({
      id: 'first',
      createdAt: 123,
      title: 'Changed',
      status: 'complete',
      dependencies: ['second'],
    })
    expect(first.title).toBe('First')
    const withoutProfile = updateProject(updated, 'first', { profileId: undefined })
    expect(withoutProfile[0].profileId).toBeUndefined()
    expect(updateProject(withoutProfile, 'first', { title: undefined })[0].title).toBe('Changed')
    expect(deleteProject(withoutProfile, 'first')).toEqual([{ ...second, dependencies: [] }])
  })

  it('writes sanitized records under the documented key and surfaces persistence failures', () => {
    const project = createProject({ id: 'project', title: 'Project' })
    const setItem = vi.fn()
    saveProjects([{ ...project, secret: 'secret' } as typeof project], { setItem })
    expect(setItem).toHaveBeenCalledWith(RESEARCH_STORAGE_KEY, JSON.stringify([project]))
    expect(() =>
      saveProjects([project], {
        setItem: () => {
          throw new Error('Quota exceeded')
        },
      }),
    ).toThrow('Quota exceeded')
  })
})

describe('research graph source', () => {
  it('uses safe generated IDs and escaped labels so hostile titles cannot insert Mermaid statements', () => {
    const attack = '"]; evil["<img src=x onerror=alert(1)>"]\nclick p0 "https://evil.test"'
    const project = createProject({ id: 'user --> attacker', title: attack, profileId: profile.id })
    const { source, nodeIds } = buildResearchGraph(
      [project],
      { direction: 'LR', groupBy: 'machine' },
      [{ ...profile, name: attack }],
    )
    expect(nodeIds).toEqual({ p0: 'user --> attacker' })
    expect(source).not.toContain('user --> attacker')
    expect(source).not.toContain('<img')
    expect(source).not.toContain('\nclick')
    expect(source).not.toContain('"]; evil[')
    expect(source).toContain('#34;#93;#59; evil#91;#34;#60;img')
    expect(source.split('\n').filter((line) => line.startsWith('    p0['))).toHaveLength(1)
  })

  it('produces the same graph for reordered projects and draws prerequisites toward their dependents', () => {
    const before = createProject({ id: 'a', title: 'Collect data' })
    const after = createProject({ id: 'z', title: 'Evaluate', dependencies: ['a', 'a', 'missing'] })
    const forward = buildResearchGraph([before, after], { direction: 'TB', groupBy: 'none' }, [])
    const reverse = buildResearchGraph([after, before], { direction: 'TB', groupBy: 'none' }, [])
    expect(forward).toEqual(reverse)
    expect(forward.nodeIds).toEqual({ p0: 'a', p1: 'z' })
    expect(forward.source).toContain('flowchart TB')
    expect(forward.source.split('\n').filter((line) => line.includes('-->'))).toEqual([
      '  p0 --> p1',
    ])
    expect(forward.source).toContain('class p0 researchPlanned')
  })

  it('retains genuine cyclic research relationships while omitting dangling or self links', () => {
    const a = createProject({ id: 'a', title: 'A', dependencies: ['b', 'a', 'unknown'] })
    const b = createProject({ id: 'b', title: 'B', dependencies: ['a'] })
    const { source } = buildResearchGraph([a, b], { direction: 'LR', groupBy: 'none' }, [])
    expect(source.split('\n').filter((line) => line.includes('-->'))).toEqual([
      '  p1 --> p0',
      '  p0 --> p1',
    ])
    expect(source).not.toContain('undefined')
  })

  it('groups actual statuses or machines and provides no invented nodes for an empty registry', () => {
    const active = createProject({
      id: 'a',
      title: 'Active work',
      status: 'active',
      profileId: profile.id,
    })
    const complete = createProject({ id: 'b', title: 'Complete work', status: 'complete' })
    const byStatus = buildResearchGraph(
      [active, complete],
      { direction: 'LR', groupBy: 'status' },
      [],
    )
    expect(byStatus.source).toContain('subgraph status0["Active"]')
    expect(byStatus.source).toContain('subgraph status3["Complete"]')
    expect(byStatus.source).not.toContain('subgraph status1')
    const byMachine = buildResearchGraph(
      [active, complete],
      { direction: 'LR', groupBy: 'machine' },
      [profile],
    )
    expect(byMachine.source).toContain('subgraph machine0["Unassigned"]')
    expect(byMachine.source).toContain('subgraph machine1["Research server"]')
    const removed = buildResearchGraph([active], { direction: 'LR', groupBy: 'machine' }, [])
    expect(removed.source).toContain('["Unavailable workspace"]')
    expect(buildResearchGraph([], { direction: 'LR', groupBy: 'none' }, [])).toEqual({
      source: 'flowchart LR',
      nodeIds: {},
    })
  })
})

describe('research JSON backups', () => {
  it('preserves every project field, notes, and relationships across a backup round trip', () => {
    const first = createProject({
      id: 'first',
      title: 'Evaluation',
      summary: 'Do agents reproduce the result?',
      notes: 'First observation\nSecond observation',
      status: 'paused',
      tags: ['agents', 'evaluation'],
      profileId: profile.id,
      createdAt: 100,
      updatedAt: 300,
      dependencies: ['second'],
    })
    const second = createProject({ id: 'second', title: 'Methods', createdAt: 50, updatedAt: 200 })
    const source = exportResearchBackup([first, second])
    const backup = JSON.parse(source)
    expect(backup).toMatchObject({ app: 'Life', format: 'research-backup', version: 1 })
    expect(backup.projects).toEqual([first, second])
    expect(importResearchBackup(source, [])).toEqual({
      projects: [first, second],
      added: 2,
      updated: 0,
      skipped: 0,
    })
  })

  it('merges without duplicates, keeps newer local edits, and retains links into existing work', () => {
    const local = createProject({
      id: 'local',
      title: 'Local work',
      notes: 'New local notes',
      createdAt: 1,
      updatedAt: 200,
    })
    const old = createProject({ id: 'local', title: 'Old backup', createdAt: 1, updatedAt: 100 })
    const imported = createProject({
      id: 'imported',
      title: 'Imported work',
      createdAt: 1,
      updatedAt: 150,
    })
    const incoming = JSON.parse(exportResearchBackup([old, imported]))
    incoming.projects[1].dependencies = ['local']
    const result = importResearchBackup(JSON.stringify(incoming), [local])
    expect(result).toMatchObject({ added: 1, updated: 0, skipped: 1 })
    expect(result.projects).toEqual([local, { ...imported, dependencies: ['local'] }])
    const newer = exportResearchBackup([{ ...old, title: 'Updated backup', updatedAt: 300 }])
    expect(importResearchBackup(newer, result.projects)).toMatchObject({
      added: 0,
      updated: 1,
      skipped: 0,
    })
    expect(
      importResearchBackup(exportResearchBackup(result.projects), result.projects),
    ).toMatchObject({
      added: 0,
      updated: 0,
      skipped: 2,
    })
  })

  it('rejects invalid backups and excessive merges without changing current projects', () => {
    const projects = Array.from({ length: 200 }, (_, index) =>
      createProject({ id: `p${index}`, title: `Project ${index}` }),
    )
    expect(() => importResearchBackup('{broken', [])).toThrow('not valid JSON')
    expect(() => importResearchBackup('{}', [])).toThrow('Choose a Life research backup')
    expect(() =>
      importResearchBackup(
        JSON.stringify({ app: 'Life', format: 'research-backup', version: 2, projects: [] }),
        [],
      ),
    ).toThrow('version is not supported')
    expect(() =>
      importResearchBackup(
        exportResearchBackup([createProject({ id: 'new', title: 'New' })]),
        projects,
      ),
    ).toThrow('exceed 200 projects')
    expect(projects).toHaveLength(200)
    const malformed = JSON.stringify({
      app: 'Life',
      format: 'research-backup',
      version: 1,
      projects: [{ invalid: true }],
    })
    expect(() => importResearchBackup(malformed, projects)).toThrow('valid research projects')
  })
})
