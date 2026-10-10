import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeResearchScope,
  researchDirectory,
  researchFileWorker,
  researchInstructions,
  researchReadme,
  researchScopeMatches,
  shouldUseResearchConnection,
  researchStorageName,
} from '../src/renderer/research-storage'
import {
  researchConversationContext,
  researchGoalDirectory,
  researchPrompt,
  workspaceCatalog,
  researchLegacyDirectories,
  type ResearchGoal,
} from '../src/renderer/workbench'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'
import type { Thread } from '../src/renderer/state'

const roots: string[] = []

describe('web Research uses the connected machine', () => {
  const connection: ConnectionState = {
    status: 'connected',
    profile: {
      id: 'life-web-local',
      name: 'This machine',
      host: 'localhost',
      port: 22,
      username: 'researcher',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/workspace/project',
    },
    home: '/workspace',
    workspace: '/workspace/project',
  }
  const preview = makeResearchScope({
    ...connection,
    home: '/browser',
    profile: { ...connection.profile!, id: 'life-browser-preview', host: 'browser.local' },
  })!

  it('replaces a restored browser-preview scope before messages are prepared', () => {
    expect(shouldUseResearchConnection(preview, connection, true)).toBe(true)
  })

  it('follows a newly connected SSH machine and a changed machine root', () => {
    const scope = makeResearchScope(connection)!
    expect(
      shouldUseResearchConnection(
        scope,
        {
          ...connection,
          profile: { ...connection.profile!, id: 'ssh-host', host: 'research.example' },
          home: '/home/researcher',
        },
        true,
      ),
    ).toBe(true)
    expect(
      shouldUseResearchConnection(scope, { ...connection, home: '/different-root' }, true),
    ).toBe(true)
  })

  it('keeps the active scope when only the Agents project changes', () => {
    expect(
      shouldUseResearchConnection(
        makeResearchScope(connection),
        {
          ...connection,
          workspace: '/other/project',
        },
        true,
      ),
    ).toBe(false)
  })

  it('preserves disconnected work and desktop host selections', () => {
    expect(shouldUseResearchConnection(preview, { status: 'disconnected' }, true)).toBe(false)
    expect(shouldUseResearchConnection(preview, connection)).toBe(false)
    expect(shouldUseResearchConnection(undefined, connection)).toBe(true)
  })
})

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'life-research-storage-'))
  roots.push(root)
  return root
}
function call(root: string, request: Record<string, unknown>): { value?: any; error?: string } {
  const result = spawnSync(process.execPath, ['-e', researchFileWorker, JSON.stringify(request)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  })
  expect(result.status, result.stderr).toBe(0)
  const line = result.stdout
    .trim()
    .split('\n')
    .find((line) => line.startsWith('LIFE_RESEARCH_RESULT='))
  expect(line, result.stdout).toBeDefined()
  return JSON.parse(line!.slice('LIFE_RESEARCH_RESULT='.length))
}
function init(root: string, legacyWorkspaces: string[] = []) {
  return call(root, {
    op: 'init',
    readme: researchReadme,
    instructions: researchInstructions,
    legacyWorkspaces,
  })
}
function goal(id = 'goal-1'): ResearchGoal {
  return {
    id,
    title: 'A research question',
    goal: 'Evaluate the evidence',
    problems: [],
    createdAt: 1,
    updatedAt: 2,
    threadId: 'research-conversation',
  }
}
function writeGoal(root: string, value = goal(), expected: string | null = null) {
  const stage = randomUUID()
  const data = Buffer.from(JSON.stringify(value)).toString('base64')
  expect(call(root, { op: 'stage', stage, offset: 0, data }).error).toBeUndefined()
  return call(root, { op: 'commit', directory: value.id, stage, expected })
}
const profile: ConnectionProfile = {
  id: 'server',
  name: 'Research machine',
  host: 'host',
  port: 22,
  username: 'user',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/home/user/projects/app',
}
const connection: ConnectionState = {
  status: 'connected',
  profile,
  home: '/home/user',
  workspace: profile.workspace,
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('independent Research environment', () => {
  it('uses machine home and keeps the same scope while Agents projects change', () => {
    const scope = makeResearchScope(connection)!
    expect(scope.root).toBe('/home/user/.life/research')
    expect(scope.workspace).toBe('/home/user')
    expect(makeResearchScope({ ...connection, workspace: '/srv/another-project' })).toEqual(scope)
    expect(researchScopeMatches(scope, { ...connection, workspace: undefined })).toBe(true)
    expect(researchScopeMatches(scope, { ...connection, status: 'disconnected' })).toBe(false)
    expect(researchScopeMatches(scope, { ...connection, home: '/home/other' })).toBe(false)
    expect(
      researchScopeMatches(scope, { ...connection, profile: { ...profile, id: 'other' } }),
    ).toBe(false)
    expect(makeResearchScope({ ...connection, home: undefined })).toBeUndefined()
    expect(researchDirectory('/')).toBe('/.life/research')
    expect(researchDirectory('/root/')).toBe('/root/.life/research')
    expect(() => researchDirectory('relative')).toThrow('absolute')
  })

  it('keeps user text byte for byte and carries context separately', () => {
    const scope = makeResearchScope(connection)!
    const target = { goal: goal() }
    const input = '  /life is only a quoted example\nWhy?\r\n😀  '
    expect(researchPrompt(target, input, connection.workspace)).toBe(input)
    expect(researchConversationContext(target, scope)).toEqual({
      scopeKey: scope.key,
      goalId: 'goal-1',
    })
    expect(researchGoalDirectory(target, scope)).toBe('/home/user/.life/research/goal-1')
    expect(researchGoalDirectory({ goal: { ...goal(), directory: '../escape' } }, scope)).toBe(
      '/home/user/.life/research/goal-1',
    )
  })

  it('maps legacy metadata IDs to stable safe folders without dropping their identity', () => {
    expect(researchStorageName({ id: 'goal-1', directory: '../../escape' })).toBe('goal-1')
    const legacy = { id: '../a malformed legacy ID' }
    expect(researchStorageName(legacy)).toMatch(/^goal-[a-f0-9]+$/)
    expect(researchStorageName(legacy)).toBe(researchStorageName(legacy))
    expect(researchStorageName({ id: 'goal-1', directory: 'existing-goal' })).toBe('existing-goal')
  })

  it('excludes Research and customization conversations from Agents project catalog', () => {
    const ordinary = {
      id: 'agent',
      profileId: profile.id,
      workspace: '/home/user/project',
    } as Thread
    const research = {
      ...ordinary,
      id: 'research',
      purpose: 'research',
      workspace: '/home/user/.life/research/goal-1',
    } as Thread
    const customization = {
      ...ordinary,
      id: 'life',
      purpose: 'customization',
      workspace: '/home/user/.life/source',
    } as Thread
    expect(
      workspaceCatalog([], [ordinary, research, customization], { status: 'disconnected' }).map(
        (item) => item.workspace,
      ),
    ).toEqual(['/home/user/project'])
  })

  it('omits only known legacy Research roots and retains a real project named research', () => {
    const legacy = {
      id: 'research-conversation',
      profileId: profile.id,
      purpose: 'research',
      workspace: '/.research/old-goal',
    } as Thread
    const known = researchLegacyDirectories([legacy], new Set([legacy.id]))
    expect(known.has('/.research')).toBe(true)
    const profiles = [
      { ...profile, workspace: '/.research' },
      { ...profile, id: 'legitimate', workspace: '/home/user/research' },
    ]
    expect(
      workspaceCatalog(profiles, [], { status: 'disconnected' }, known).map(
        (item) => item.workspace,
      ),
    ).toEqual(['/home/user/research'])
    expect(
      workspaceCatalog([{ ...profile, workspace: '/.research' }], [], { status: 'disconnected' }),
    ).toHaveLength(1)
  })
})

describe('Research file protocol on a real filesystem', () => {
  it('creates .life/research and file-based instructions without a selected Agents project', () => {
    const root = temporary()
    expect(init(root)).toEqual({ value: { ok: true } })
    expect(readFileSync(join(root, '.life/research/AGENTS.md'), 'utf8')).toBe(researchInstructions)
    expect(readFileSync(join(root, '.life/research/README.md'), 'utf8')).toBe(researchReadme)
    expect(readdirSync(root)).toEqual(['.life'])
    expect(call(root, { op: 'scan' })).toEqual({ value: { entries: [] } })
  })

  it('atomically transfers goals and rejects stale writes without replacing current research', () => {
    const root = temporary()
    init(root)
    const created = writeGoal(root)
    expect(created.error).toBeUndefined()
    const file = join(root, '.life/research/goal-1/goal.json')
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
    expect(created.value.revision).toBe(digest)
    const before = readFileSync(file, 'utf8')
    expect(writeGoal(root, { ...goal(), title: 'Stale change' })).toEqual({
      error: 'RESEARCH_CHANGED',
    })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(writeGoal(root, { ...goal(), title: 'Fresh change' }, digest).error).toBeUndefined()
    const read = call(root, { op: 'read', directory: 'goal-1', file: 'goal.json', offset: 0 })
    expect(JSON.parse(Buffer.from(read.value.data, 'base64').toString()).title).toBe('Fresh change')
  })

  it('copies recognized legacy goals, maps, unknown metadata and artifacts and preserves originals', () => {
    const home = temporary()
    const oldWorkspace = temporary()
    const directory = join(oldWorkspace, '.research/goal-1')
    mkdirSync(join(directory, 'papers'), { recursive: true })
    const source = JSON.stringify({ ...goal(), customMetadata: { experiment: 42 } })
    writeFileSync(join(directory, 'goal.json'), source)
    writeFileSync(join(directory, 'map.mmd'), 'flowchart LR\na-->b')
    writeFileSync(join(directory, 'map.html'), '<main>A finding</main>')
    writeFileSync(join(directory, 'papers/evidence.txt'), 'Original evidence')
    expect(init(home, [oldWorkspace]).error).toBeUndefined()
    const migrated = join(home, '.life/research/goal-1')
    for (const name of ['goal.json', 'map.mmd', 'map.html', 'papers/evidence.txt']) {
      expect(readFileSync(join(migrated, name))).toEqual(readFileSync(join(directory, name)))
    }
    const migration = JSON.parse(readFileSync(join(home, '.life/research/migration.json'), 'utf8'))
    expect(migration.originalsRetained).toBe(true)
    expect(migration.entries[0]).toMatchObject({
      source: directory,
      destination: 'goal-1',
      conflict: false,
    })
    writeFileSync(join(migrated, 'map.mmd'), 'Newer map')
    expect(init(home, [oldWorkspace]).error).toBeUndefined()
    expect(readFileSync(join(migrated, 'map.mmd'), 'utf8')).toBe('Newer map')
    expect(readFileSync(join(directory, 'map.mmd'), 'utf8')).toBe('flowchart LR\na-->b')
  })

  it('retains colliding legacy goal copies without overwriting either original', () => {
    const home = temporary()
    const old = [temporary(), temporary()]
    old.forEach((root, index) => {
      mkdirSync(join(root, '.research/same'), { recursive: true })
      writeFileSync(
        join(root, '.research/same/goal.json'),
        JSON.stringify({ ...goal(), title: 'Version ' + index }),
      )
    })
    expect(init(home, old).error).toBeUndefined()
    const migration = JSON.parse(readFileSync(join(home, '.life/research/migration.json'), 'utf8'))
    expect(migration.entries).toHaveLength(2)
    expect(migration.entries[1].conflict).toBe(true)
    expect(
      readFileSync(
        join(home, '.life/research', migration.entries[1].destination, 'goal.json'),
        'utf8',
      ),
    ).toContain('Version 1')
    expect(call(home, { op: 'scan' }).value.entries).toHaveLength(1)
  })

  it('imports later-discovered legacy folders into an existing root without overwriting current maps', () => {
    const home = temporary()
    const first = temporary()
    const later = temporary()
    for (const [root, id] of [
      [first, 'first'],
      [later, 'later'],
    ]) {
      mkdirSync(join(root, '.research', id), { recursive: true })
      writeFileSync(join(root, '.research', id, 'goal.json'), JSON.stringify(goal(id)))
      writeFileSync(join(root, '.research', id, 'map.json'), JSON.stringify({ nodes: [{ id }] }))
    }
    expect(init(home, [first]).error).toBeUndefined()
    const currentMap = join(home, '.life/research/first/map.json')
    writeFileSync(currentMap, 'Current map remains here')
    expect(init(home, [first, later]).error).toBeUndefined()
    expect(readFileSync(currentMap, 'utf8')).toBe('Current map remains here')
    expect(readFileSync(join(home, '.life/research/later/map.json'), 'utf8')).toBe(
      JSON.stringify({ nodes: [{ id: 'later' }] }),
    )
    expect(init(home, [first, later]).error).toBeUndefined()
    const manifest = JSON.parse(readFileSync(join(home, '.life/research/migration.json'), 'utf8'))
    expect(manifest.entries).toHaveLength(2)
    expect(
      readdirSync(join(home, '.life')).filter((name) => name.startsWith('.research-migration-')),
    ).toEqual([])
  })

  it('does not leave staging folders when an existing migration manifest is damaged', () => {
    const home = temporary()
    init(home)
    writeFileSync(join(home, '.life/research/migration.json'), '{broken')
    expect(init(home).error).toBeDefined()
    expect(readdirSync(join(home, '.life'))).toEqual(['research'])
  })

  it('never treats arbitrary .research data as app-owned goals or follows artifact symlinks', () => {
    const home = temporary()
    const old = temporary()
    mkdirSync(join(old, '.research/not-a-goal'), { recursive: true })
    mkdirSync(join(old, '.research/goal-1'), { recursive: true })
    writeFileSync(join(old, '.research/not-a-goal/private.txt'), 'Unrelated private data')
    writeFileSync(join(old, '.research/goal-1/goal.json'), JSON.stringify(goal()))
    const outside = join(old, 'outside.txt')
    writeFileSync(outside, 'Not a research artifact')
    symlinkSync(outside, join(old, '.research/goal-1/link.txt'))
    expect(init(home, [old]).error).toBeUndefined()
    expect(readdirSync(join(home, '.life/research/goal-1'))).toEqual(['goal.json'])
    expect(readdirSync(join(old, '.research/not-a-goal'))).toEqual(['private.txt'])
  })

  it('rejects a symlinked .life root before writing outside the research environment', () => {
    const home = temporary()
    const outside = temporary()
    symlinkSync(outside, join(home, '.life'), 'dir')
    expect(init(home).error).toContain('ordinary files and directories')
    expect(readdirSync(outside)).toEqual([])
  })

  it('keeps existing instruction files and rejects path traversal and unsupported reads', () => {
    const root = temporary()
    init(root)
    const agents = join(root, '.life/research/AGENTS.md')
    const claude = join(root, '.life/research/CLAUDE.md')
    writeFileSync(agents, '# User research instructions')
    writeFileSync(claude, '# User Claude instructions')
    init(root)
    expect(readFileSync(agents, 'utf8')).toBe('# User research instructions')
    expect(readFileSync(claude, 'utf8')).toBe('# User Claude instructions')
    expect(
      call(root, { op: 'read', directory: '../escape', file: 'goal.json', offset: 0 }).error,
    ).toBe('Invalid goal directory')
    expect(
      call(root, { op: 'read', directory: 'goal', file: 'private-key', offset: 0 }).error,
    ).toBe('Invalid research file')
    expect(
      call(root, {
        op: 'stage',
        stage: randomUUID(),
        offset: 0,
        data: Buffer.alloc(32769).toString('base64'),
      }).error,
    ).toBe('Invalid write chunk')
  })
})
