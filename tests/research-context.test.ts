import { afterEach, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  makeResearchScope,
  researchConversationInstructions,
  researchFileWorker,
  researchInstructions,
  researchReadme,
  researchStorageName,
} from '../src/renderer/research-storage'
import {
  researchConversationDirectory,
  researchPrompt,
  type ResearchGoal,
} from '../src/renderer/workbench'

interface WorkerResult {
  value?: Record<string, unknown>
  error?: string
}

const roots: string[] = []
const execute = promisify(execFile)
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'life-research-context-'))
  roots.push(root)
  return root
}

function call(root: string, request: Record<string, unknown>): WorkerResult {
  const result = spawnSync(process.execPath, ['-e', researchFileWorker, JSON.stringify(request)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  })
  expect(result.status, result.stderr).toBe(0)
  const prefix = 'LIFE_RESEARCH_RESULT='
  const line = result.stdout.split(/\r?\n/).find((line) => line.startsWith(prefix))
  expect(line, result.stdout).toBeDefined()
  return JSON.parse(line!.slice(prefix.length)) as WorkerResult
}

function goal(): ResearchGoal {
  return {
    id: 'evidence-goal',
    directory: 'goal-files',
    title: 'Evaluate agent planning',
    goal: 'Compare measured evidence from independent experiments.',
    problems: [
      {
        id: 'problem-a',
        title: 'Accuracy',
        description: 'Measure accuracy.',
        notes: 'First finding',
        status: 'open',
        updatedAt: 2,
      },
      {
        id: 'problem-b',
        title: 'Latency',
        description: 'Measure latency.',
        notes: 'Second finding',
        status: 'blocked',
        updatedAt: 3,
      },
    ],
    threadId: 'overview-conversation',
    createdAt: 1,
    updatedAt: 3,
  }
}

function writeGoal(root: string, value: ResearchGoal, expected: string | null = null) {
  const stage = randomUUID()
  const content = JSON.stringify(value, null, 2) + '\n'
  expect(
    call(root, { op: 'stage', stage, offset: 0, data: Buffer.from(content).toString('base64') })
      .error,
  ).toBeUndefined()
  const result = call(root, {
    op: 'commit',
    directory: researchStorageName(value),
    stage,
    expected,
  })
  expect(result.error).toBeUndefined()
  return { revision: result.value!.revision as string, content }
}

function setup() {
  const root = temporary()
  expect(
    call(root, { op: 'init', readme: researchReadme, instructions: researchInstructions }).error,
  ).toBeUndefined()
  const value = goal()
  const saved = writeGoal(root, value)
  const goalRoot = join(root, '.life/research', researchStorageName(value))
  const scope = makeResearchScope({
    status: 'connected',
    home: root,
    profile: {
      id: 'machine',
      name: 'Machine',
      host: 'localhost',
      port: 22,
      username: 'researcher',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/projects/app',
    },
  })!
  return { root, goalRoot, scope, value, saved }
}

function createContext(root: string, value: ResearchGoal, problemId?: string) {
  return call(root, {
    op: 'context',
    directory: researchStorageName(value),
    ...(problemId ? { problemId, problemDirectory: researchStorageName({ id: problemId }) } : {}),
    instructions: researchConversationInstructions,
  })
}

async function concurrentContext(
  root: string,
  value: ResearchGoal,
  problemId: string,
  participant: 'a' | 'b',
  synchronizePath: string,
) {
  // Both real processes observe the absent shared path before either creates it. This makes the
  // first-open race reproducible instead of depending on the runner's process scheduling.
  const synchronization = `
const contextTestFs = require('node:fs');
const contextTestExists = contextTestFs.existsSync.bind(contextTestFs);
let contextTestSynchronized = false;
contextTestFs.existsSync = (file) => {
  const exists = contextTestExists(file);
  if (!contextTestSynchronized && !exists && file === ${JSON.stringify(synchronizePath)}) {
    contextTestSynchronized = true;
    contextTestFs.writeFileSync(${JSON.stringify(join(root, 'ready-' + participant))}, 'ready');
    const deadline = Date.now() + 4000;
    while (!contextTestExists(${JSON.stringify(join(root, 'ready-' + (participant === 'a' ? 'b' : 'a')))})) {
      if (Date.now() > deadline) throw Error('Context test synchronization timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
  return exists;
};
`
  const request = {
    op: 'context',
    directory: researchStorageName(value),
    problemId,
    problemDirectory: researchStorageName({ id: problemId }),
    instructions: researchConversationInstructions,
  }
  const { stdout } = await execute(
    process.execPath,
    ['-e', synchronization + researchFileWorker, JSON.stringify(request)],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_000_000,
    },
  )
  const prefix = 'LIFE_RESEARCH_RESULT='
  const line = stdout.split(/\r?\n/).find((line) => line.startsWith(prefix))
  expect(line, stdout).toBeDefined()
  return JSON.parse(line!.slice(prefix.length)) as WorkerResult
}

function contextFile(directory: string) {
  return JSON.parse(readFileSync(join(directory, '.life-context.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

function assertReferences(
  context: Record<string, unknown>,
  directory: string,
  goalRoot: string,
  problem = false,
) {
  const prefix = problem ? '../../' : ''
  expect(context).toMatchObject({
    conversation: problem ? 'problem' : 'goal',
    goalFile: prefix + 'goal.json',
    goalDirectory: problem ? '../..' : '.',
    readmeFile: problem ? '../../../README.md' : '../README.md',
    lockFile: problem ? '../../../.life.lock' : '../.life.lock',
    mapFiles: { json: prefix + 'map.json', mermaid: prefix + 'map.mmd', html: prefix + 'map.html' },
  })
  expect(resolve(directory, context.goalDirectory as string)).toBe(goalRoot)
  expect(readFileSync(resolve(directory, context.readmeFile as string), 'utf8')).toBe(
    researchReadme,
  )
  for (const [format, file] of Object.entries(context.mapFiles as Record<string, string>)) {
    const expected = { json: 'map.json', mermaid: 'map.mmd', html: 'map.html' }[format]
    expect(isAbsolute(file)).toBe(false)
    expect(resolve(directory, file)).toBe(join(goalRoot, expected!))
  }
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('Research conversation file context', () => {
  it('provides goal overview context and both native provider instruction files without changing the source goal', () => {
    const { root, goalRoot, scope, value, saved } = setup()
    expect(createContext(root, value).error).toBeUndefined()
    expect(researchConversationDirectory({ goal: value }, scope)).toBe(goalRoot)
    const context = contextFile(goalRoot)
    expect(context).toMatchObject({ format: 'life-research-context', version: 1, goalId: value.id })
    expect(context).not.toHaveProperty('problemId')
    assertReferences(context, goalRoot, goalRoot)
    expect(isAbsolute(context.goalFile as string)).toBe(false)
    expect(resolve(goalRoot, context.goalFile as string)).toBe(join(goalRoot, 'goal.json'))
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(goalRoot, name), 'utf8')).toBe(researchConversationInstructions)
    }
    expect(readFileSync(join(goalRoot, 'goal.json'), 'utf8')).toBe(saved.content)
    expect(readFileSync(join(root, '.life/research/AGENTS.md'), 'utf8')).toBe(researchInstructions)
  })

  it('isolates two problem contexts and leaves the first untouched when the second opens', () => {
    const { root, goalRoot, scope, value, saved } = setup()
    const first = value.problems[0]
    const second = value.problems[1]
    expect(createContext(root, value, first.id).error).toBeUndefined()
    const firstRoot = researchConversationDirectory({ goal: value, problem: first }, scope)
    expect(firstRoot).toBe(join(goalRoot, 'problems', researchStorageName({ id: first.id })))
    const firstBytes = readFileSync(join(firstRoot, '.life-context.json'), 'utf8')
    const firstInstructions = readFileSync(join(firstRoot, 'AGENTS.md'), 'utf8')
    expect(createContext(root, value, second.id).error).toBeUndefined()
    const secondRoot = researchConversationDirectory({ goal: value, problem: second }, scope)
    expect(secondRoot).toBe(join(goalRoot, 'problems', researchStorageName({ id: second.id })))
    expect(secondRoot).not.toBe(firstRoot)
    expect(readFileSync(join(firstRoot, '.life-context.json'), 'utf8')).toBe(firstBytes)
    expect(readFileSync(join(firstRoot, 'AGENTS.md'), 'utf8')).toBe(firstInstructions)
    for (const [directory, problem] of [
      [firstRoot, first],
      [secondRoot, second],
    ] as const) {
      const context = contextFile(directory)
      expect(context).toMatchObject({
        format: 'life-research-context',
        version: 1,
        goalId: value.id,
        problemId: problem.id,
      })
      assertReferences(context, directory, goalRoot, true)
      expect(isAbsolute(context.goalFile as string)).toBe(false)
      expect(resolve(directory, context.goalFile as string)).toBe(join(goalRoot, 'goal.json'))
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        expect(readFileSync(join(directory, name), 'utf8')).toBe(researchConversationInstructions)
      }
    }
    expect(readFileSync(join(goalRoot, 'goal.json'), 'utf8')).toBe(saved.content)
  })

  it('prepares simultaneous problem contexts without competing over their shared parent folder', async () => {
    const { root, goalRoot, scope, value, saved } = setup()
    const results = await Promise.all(
      value.problems.map((problem, index) =>
        concurrentContext(
          root,
          value,
          problem.id,
          index === 0 ? 'a' : 'b',
          join(goalRoot, 'problems'),
        ),
      ),
    )
    for (const result of results) expect(result.error).toBeUndefined()
    for (const problem of value.problems) {
      const directory = researchConversationDirectory({ goal: value, problem }, scope)
      expect(contextFile(directory).problemId).toBe(problem.id)
      assertReferences(contextFile(directory), directory, goalRoot, true)
    }
    expect(readFileSync(join(goalRoot, 'goal.json'), 'utf8')).toBe(saved.content)
  })

  it('allows simultaneous preparation of the same context without racing native instruction creation', async () => {
    const { root, goalRoot, scope, value } = setup()
    const problem = value.problems[0]
    const directory = researchConversationDirectory({ goal: value, problem }, scope)
    const results = await Promise.all(
      (['a', 'b'] as const).map((participant) =>
        concurrentContext(root, value, problem.id, participant, join(directory, 'AGENTS.md')),
      ),
    )
    for (const result of results) expect(result.error).toBeUndefined()
    expect(contextFile(directory).problemId).toBe(problem.id)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(directory, name), 'utf8')).toBe(researchConversationInstructions)
    }
    expect(readdirSync(directory).filter((name) => name.startsWith('.life-context-'))).toEqual([])
  })

  it('resolves current goal metadata after edits rather than saving stale brief text in instructions', () => {
    const { root, goalRoot, scope, value, saved } = setup()
    const problem = value.problems[0]
    expect(createContext(root, value, problem.id).error).toBeUndefined()
    const directory = researchConversationDirectory({ goal: value, problem }, scope)
    const instructionsBefore = readFileSync(join(directory, 'AGENTS.md'), 'utf8')
    const changed = {
      ...value,
      title: 'Updated goal title',
      goal: 'New evidence',
      updatedAt: 4,
      problems: value.problems.map((row) =>
        row.id === problem.id ? { ...row, notes: 'Latest measured findings', updatedAt: 4 } : row,
      ),
    }
    const latest = writeGoal(root, changed, saved.revision)
    expect(createContext(root, changed, problem.id).error).toBeUndefined()
    const context = contextFile(directory)
    const source = JSON.parse(readFileSync(resolve(directory, context.goalFile as string), 'utf8'))
    expect(source.title).toBe('Updated goal title')
    expect(source.problems.find((row: { id: string }) => row.id === problem.id).notes).toBe(
      'Latest measured findings',
    )
    expect(readFileSync(join(goalRoot, 'goal.json'), 'utf8')).toBe(latest.content)
    expect(readFileSync(join(directory, 'AGENTS.md'), 'utf8')).toBe(instructionsBefore)
    expect(instructionsBefore).not.toContain(problem.description)
  })

  it('preserves user-owned instructions and unrelated goal artifacts on refresh', () => {
    const { root, goalRoot, scope, value, saved } = setup()
    const problem = value.problems[0]
    expect(createContext(root, value, problem.id).error).toBeUndefined()
    const directory = researchConversationDirectory({ goal: value, problem }, scope)
    for (const name of ['AGENTS.md', 'CLAUDE.md'])
      writeFileSync(join(directory, name), '# My research conventions\n')
    writeFileSync(join(goalRoot, 'map.mmd'), 'flowchart LR\n A --> B\n')
    writeFileSync(join(goalRoot, 'findings.txt'), 'Keep the recorded experiment.\n')
    expect(createContext(root, value, problem.id).error).toBeUndefined()
    for (const name of ['AGENTS.md', 'CLAUDE.md'])
      expect(readFileSync(join(directory, name), 'utf8')).toBe('# My research conventions\n')
    expect(readFileSync(join(goalRoot, 'map.mmd'), 'utf8')).toBe('flowchart LR\n A --> B\n')
    expect(readFileSync(join(goalRoot, 'findings.txt'), 'utf8')).toBe(
      'Keep the recorded experiment.\n',
    )
    expect(readFileSync(join(goalRoot, 'goal.json'), 'utf8')).toBe(saved.content)
  })

  it('rejects unknown problem IDs before creating an execution folder or altering an existing context', () => {
    const { root, goalRoot, scope, value } = setup()
    expect(createContext(root, value).error).toBeUndefined()
    const before = readFileSync(join(goalRoot, '.life-context.json'), 'utf8')
    const result = createContext(root, value, 'missing-problem')
    expect(result.error).toMatch(/problem/i)
    expect(readFileSync(join(goalRoot, '.life-context.json'), 'utf8')).toBe(before)
    expect(readdirSync(goalRoot)).not.toContain('problems')
    expect(researchConversationDirectory({ goal: value }, scope)).toBe(goalRoot)
  })

  it('maps legacy problem IDs to safe independent folders while preserving their exact identity', () => {
    const { root, goalRoot, scope, value, saved } = setup()
    const problem = { ...value.problems[0], id: '../legacy/problem' }
    const updated = { ...value, problems: [problem, value.problems[1]] }
    writeGoal(root, updated, saved.revision)
    expect(createContext(root, updated, problem.id).error).toBeUndefined()
    const directory = researchConversationDirectory({ goal: updated, problem }, scope)
    expect(directory).toBe(join(goalRoot, 'problems', researchStorageName({ id: problem.id })))
    expect(contextFile(directory).problemId).toBe(problem.id)
    assertReferences(contextFile(directory), directory, goalRoot, true)
  })

  it('keeps the exact user request separate from all file-based Research context', () => {
    const { root, scope, value } = setup()
    const target = { goal: value, problem: value.problems[0] }
    expect(createContext(root, value, target.problem.id).error).toBeUndefined()
    const request = '  Compare these outputs.\r\n/life is literal text here 😀\n  '
    expect(researchPrompt(target, request, scope.workspace)).toBe(request)
    expect(researchConversationInstructions).toContain('.life-context.json')
    expect(researchConversationInstructions).not.toContain(request)
  })
})
