import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { researchCommand } from '../src/shared/research-command'
import {
  createResearchMethod,
  researchOperationCatalog,
  type ResearchOperation,
} from '../src/shared/research-method'
import { researchMethodGuide, researchMethodSchema } from '../src/shared/research-method-protocol'
import { parseResearchGoal } from '../src/renderer/research-files'
import {
  researchInvocationGuidance,
  researchWorkspaceGuidance,
} from '../src/renderer/research-guidance'
import {
  legacyResearchConversationInstructions,
  legacyResearchInstructions,
  researchConversationInstructions,
  researchFileWorker,
  researchInstructions,
  researchReadme,
} from '../src/renderer/research-storage'
import { researchPrompt, type ResearchGoal } from '../src/renderer/workbench'

interface WorkerResult {
  value?: Record<string, any>
  error?: string
}

const roots: string[] = []
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'life-research-method-storage-'))
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

function initialization() {
  return {
    op: 'init',
    readme: researchReadme,
    instructions: researchInstructions,
    previousInstructions: [legacyResearchInstructions],
    methodGuide: researchMethodGuide,
    methodSchema: researchMethodSchema,
  }
}

function init(root: string) {
  return call(root, initialization())
}

function shellCall(root: string, command: string): WorkerResult {
  const result = spawnSync('sh', ['-c', command], {
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
    id: 'measured-goal',
    directory: 'goal-files',
    title: 'Evaluate a proposed mechanism',
    goal: 'Decompose acceptance criteria and compare reproducible observations.',
    problems: [
      {
        id: 'problem-one',
        title: 'Missing mechanism',
        description: 'Find the relationship between constituents.',
        notes: 'Do not confuse a hypothesis with an observation.',
        status: 'open',
        updatedAt: 2,
      },
      {
        id: 'problem-two',
        title: 'Insufficient evidence',
        description: 'Design a reproducible falsification test.',
        notes: '',
        status: 'blocked',
        updatedAt: 3,
      },
    ],
    createdAt: 1,
    updatedAt: 3,
    threadId: 'native-existing-conversation',
    method: createResearchMethod(),
  }
}

function setup() {
  const root = temporary()
  expect(init(root).error).toBeUndefined()
  const value = goal()
  const directory = join(root, '.life/research', value.directory!)
  mkdirSync(directory)
  const original = JSON.stringify(value, null, 2) + '\n'
  writeFileSync(join(directory, 'goal.json'), original)
  return { root, directory, value, original }
}

function context(
  root: string,
  value: ResearchGoal,
  operation: ResearchOperation,
  problemId?: string,
  invocationId = randomUUID(),
) {
  const operator = researchOperationCatalog.find((row) => row.id === operation)!
  return call(root, {
    op: 'context',
    directory: value.directory,
    instructions: researchConversationInstructions,
    previousInstructions: [
      legacyResearchInstructions,
      legacyResearchConversationInstructions,
      researchInstructions,
    ],
    invocationId,
    operation: { ...operator },
    ...(problemId ? { problemId, problemDirectory: problemId } : {}),
  })
}

function readContext(directory: string) {
  return JSON.parse(readFileSync(join(directory, '.life-context.json'), 'utf8')) as Record<
    string,
    any
  >
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('file-backed research method instructions on a real filesystem', () => {
  it('removes legacy approach guidance from Research conversations and keeps the user prompt unchanged', () => {
    const { root, directory, value, original } = setup()
    const researchRoot = join(root, '.life/research')
    const legacyInvocation = randomUUID()
    expect(
      context(root, value, 'anti-abstraction', undefined, legacyInvocation).error,
    ).toBeUndefined()
    const legacySnapshot = readFileSync(
      join(directory, '.life-invocations', legacyInvocation + '.json'),
      'utf8',
    )

    const workspace = researchWorkspaceGuidance()
    expect(call(root, { ...initialization(), ...workspace }).error).toBeUndefined()
    expect(workspace.methodGuide).toContain("The user's message determines the research approach.")
    expect(workspace.methodGuide).not.toContain(
      'immutable operator selected for this submitted request',
    )
    expect(readFileSync(join(researchRoot, '.life-method.md'), 'utf8')).toBe(workspace.methodGuide)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(researchRoot, name), 'utf8')).toBe(workspace.instructions)
    }

    const literal = '  Challenge the premise, then follow the evidence.\n  '
    for (const problemId of [undefined, value.problems[0].id]) {
      const invocationId = randomUUID()
      // A restored selection or queue item must not add guidance to a Research request.
      const guidance = researchInvocationGuidance()
      expect(guidance).not.toHaveProperty('operation')
      const result = call(root, {
        op: 'context',
        directory: value.directory,
        ...guidance,
        invocationId,
        ...(problemId ? { problemId, problemDirectory: problemId } : {}),
      })
      expect(result.error).toBeUndefined()
      const conversation = problemId ? join(directory, 'problems', problemId) : directory
      const metadata = readContext(conversation)
      expect(metadata).toMatchObject({ goalId: value.id, invocationId })
      if (problemId) expect(metadata.problemId).toBe(problemId)
      expect(metadata).not.toHaveProperty('operation')
      expect(JSON.parse(readFileSync(join(conversation, metadata.invocationFile), 'utf8'))).toEqual(
        metadata,
      )
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        expect(readFileSync(join(conversation, name), 'utf8')).toBe(guidance.instructions)
        expect(guidance.instructions).not.toContain(
          'The operation in .life-context.json belongs to this invocation',
        )
      }
      expect(
        researchPrompt(
          { goal: value, ...(problemId ? { problem: value.problems[0] } : {}) },
          literal,
          root,
        ),
      ).toBe(literal)
    }
    expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(original)
    expect(
      readFileSync(join(directory, '.life-invocations', legacyInvocation + '.json'), 'utf8'),
    ).toBe(legacySnapshot)
  })

  it('preserves custom instruction files when upgrading Research guidance', () => {
    const { root, directory, value } = setup()
    const researchRoot = join(root, '.life/research')
    const custom = '# My research instructions\nUse the procedure I describe in my message.\n'
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      writeFileSync(join(researchRoot, name), custom)
      writeFileSync(join(directory, name), custom)
    }
    expect(
      call(root, { ...initialization(), ...researchWorkspaceGuidance() }).error,
    ).toBeUndefined()
    expect(
      call(root, {
        op: 'context',
        directory: value.directory,
        ...researchInvocationGuidance(),
        invocationId: randomUUID(),
      }).error,
    ).toBeUndefined()
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(researchRoot, name), 'utf8')).toBe(custom)
      expect(readFileSync(join(directory, name), 'utf8')).toBe(custom)
    }
  })

  it('writes the complete operator guide and schema as standalone files, without inventing findings', () => {
    const root = temporary()
    expect(init(root)).toEqual({ value: { ok: true } })
    const directory = join(root, '.life/research')
    expect(readFileSync(join(directory, '.life-method.md'), 'utf8')).toBe(researchMethodGuide)
    expect(readFileSync(join(directory, '.life-method-schema.json'), 'utf8')).toBe(
      researchMethodSchema,
    )
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(directory, name), 'utf8')).toBe(researchInstructions)
    }
    const schema = JSON.parse(researchMethodSchema)
    expect(schema.properties.version).toEqual({ const: 1 })
    expect(schema.properties.activeOperation.enum).toEqual(
      researchOperationCatalog.map((operator) => operator.id),
    )
    for (const operator of researchOperationCatalog) {
      expect(researchMethodGuide).toContain('(' + operator.id + ')')
      expect(researchMethodGuide).toContain(operator.artifactGuidance)
    }
    expect(researchOperationCatalog).toHaveLength(12)
    expect(call(root, { op: 'scan' })).toEqual({ value: { entries: [] } })
    expect(existsSync(join(directory, 'goal.json'))).toBe(false)
  })

  it('resolves guide, schema, goal and map paths correctly for overview and separate problem conversations', () => {
    const { root, directory, value, original } = setup()
    const researchRoot = join(root, '.life/research')
    for (const problemId of [undefined, ...value.problems.map((row) => row.id)]) {
      const invocationId = randomUUID()
      const result = context(root, value, 'anti-abstraction', problemId, invocationId)
      expect(result.error).toBeUndefined()
      const conversation = problemId ? join(directory, 'problems', problemId) : directory
      const metadata = readContext(conversation)
      expect(result.value!.directory).toBe(conversation)
      expect(metadata).toMatchObject({
        format: 'life-research-context',
        version: 1,
        goalId: value.id,
        conversation: problemId ? 'problem' : 'goal',
        invocationId,
        operation: researchOperationCatalog.find((row) => row.id === 'anti-abstraction'),
      })
      if (problemId) expect(metadata.problemId).toBe(problemId)
      else expect(metadata).not.toHaveProperty('problemId')
      expect(resolve(conversation, metadata.methodGuideFile)).toBe(
        join(researchRoot, '.life-method.md'),
      )
      expect(resolve(conversation, metadata.methodSchemaFile)).toBe(
        join(researchRoot, '.life-method-schema.json'),
      )
      expect(resolve(conversation, metadata.goalDirectory)).toBe(directory)
      expect(resolve(conversation, metadata.goalFile)).toBe(join(directory, 'goal.json'))
      expect(resolve(conversation, metadata.readmeFile)).toBe(join(researchRoot, 'README.md'))
      expect(resolve(conversation, metadata.lockFile)).toBe(join(researchRoot, '.life.lock'))
      for (const [format, filename] of Object.entries({
        json: 'map.json',
        mermaid: 'map.mmd',
        html: 'map.html',
      })) {
        expect(resolve(conversation, metadata.mapFiles[format])).toBe(join(directory, filename))
      }
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        expect(readFileSync(join(conversation, name), 'utf8')).toBe(
          researchConversationInstructions,
        )
      }
    }
    expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(original)
  })

  it('snapshots every operator for its invocation without changing the literal request or goal selection', () => {
    const { root, directory, value, original } = setup()
    const problem = value.problems[0]
    const literal = '  /life is literal text\r\nCompare electrons, protons and neutrons. 😀\n  '
    for (const operator of researchOperationCatalog) {
      const invocationId = randomUUID()
      expect(context(root, value, operator.id, problem.id, invocationId).error).toBeUndefined()
      const metadata = readContext(join(directory, 'problems', problem.id))
      expect(metadata.invocationId).toBe(invocationId)
      expect(metadata.executionId).toBe(invocationId)
      expect(metadata.invocationFile).toBe('.life-invocations/' + invocationId + '.json')
      expect(metadata.operation).toEqual(operator)
      const nativeDirectory = join(directory, 'problems', problem.id)
      const snapshot = readFileSync(join(nativeDirectory, metadata.invocationFile), 'utf8')
      expect(JSON.parse(snapshot)).toEqual(metadata)
      expect(snapshot).toBe(readFileSync(join(nativeDirectory, '.life-context.json'), 'utf8'))
      expect(metadata).not.toHaveProperty('prompt')
      expect(metadata).not.toHaveProperty('request')
      expect(JSON.stringify(metadata)).not.toContain(literal)
      expect(researchPrompt({ goal: value, problem }, literal, root)).toBe(literal)
      expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(original)
      expect(JSON.parse(original).method.activeOperation).toBe('explore')
    }
  })

  it('keeps a submitted operator snapshot when the goal operator changes and another problem opens', () => {
    const { root, directory, value } = setup()
    const first = value.problems[0]
    const second = value.problems[1]
    expect(context(root, value, 'constructive-interference', first.id).error).toBeUndefined()
    const firstFile = join(directory, 'problems', first.id, '.life-context.json')
    const saved = readFileSync(firstFile, 'utf8')
    const changed = { ...value, method: { ...value.method, activeOperation: 'verify' } }
    writeFileSync(join(directory, 'goal.json'), JSON.stringify(changed))
    expect(context(root, value, 'counterfactual', second.id).error).toBeUndefined()
    expect(readFileSync(firstFile, 'utf8')).toBe(saved)
    expect(readContext(join(directory, 'problems', first.id)).operation.id).toBe(
      'constructive-interference',
    )
    expect(readContext(join(directory, 'problems', second.id)).operation.id).toBe('counterfactual')
    expect(
      JSON.parse(readFileSync(join(directory, 'goal.json'), 'utf8')).method.activeOperation,
    ).toBe('verify')
  })

  it('keeps immutable invocation snapshots across operator changes and rejects identity reuse before replacing the current context', () => {
    const { root, directory, value, original } = setup()
    const problemId = value.problems[0].id
    const nativeDirectory = join(directory, 'problems', problemId)
    const firstId = randomUUID()
    expect(context(root, value, 'anti-abstraction', problemId, firstId).error).toBeUndefined()
    const firstPath = join(nativeDirectory, '.life-invocations', firstId + '.json')
    const first = readFileSync(firstPath)
    const secondId = randomUUID()
    expect(context(root, value, 'abstraction', problemId, secondId).error).toBeUndefined()
    const currentPath = join(nativeDirectory, '.life-context.json')
    const secondPath = join(nativeDirectory, '.life-invocations', secondId + '.json')
    const current = readFileSync(currentPath)
    const second = readFileSync(secondPath)
    expect(readFileSync(firstPath)).toEqual(first)
    expect(JSON.parse(current.toString())).toMatchObject({
      executionId: secondId,
      invocationId: secondId,
      operation: { id: 'abstraction' },
    })
    expect(context(root, value, 'verify', problemId, firstId).error).toBe(
      'Research invocation metadata is immutable',
    )
    expect(readFileSync(firstPath)).toEqual(first)
    expect(readFileSync(secondPath)).toEqual(second)
    expect(readFileSync(currentPath)).toEqual(current)
    expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(original)
    expect(
      readdirSync(nativeDirectory).filter((name) => name.startsWith('.life-context-')),
    ).toEqual([])
  })

  it('permits exact invocation retries without changing their snapshot bytes', () => {
    const { root, directory, value } = setup()
    const invocationId = randomUUID()
    expect(
      context(root, value, 'causal-intervention', undefined, invocationId).error,
    ).toBeUndefined()
    const file = join(directory, '.life-invocations', invocationId + '.json')
    const bytes = readFileSync(file)
    expect(
      context(root, value, 'causal-intervention', undefined, invocationId).error,
    ).toBeUndefined()
    expect(readFileSync(file)).toEqual(bytes)
    expect(readFileSync(join(directory, '.life-context.json'))).toEqual(bytes)
    expect(readdirSync(join(directory, '.life-invocations'))).toEqual([invocationId + '.json'])
  })

  it('preserves user-authored root and conversation instructions byte for byte on repeated preparation', () => {
    const { root, directory, value, original } = setup()
    const problem = value.problems[0]
    expect(context(root, value, 'ground', problem.id).error).toBeUndefined()
    const files = [
      ...['AGENTS.md', 'CLAUDE.md'].map((name) => join(root, '.life/research', name)),
      ...['AGENTS.md', 'CLAUDE.md'].map((name) => join(directory, name)),
      ...['AGENTS.md', 'CLAUDE.md'].map((name) => join(directory, 'problems', problem.id, name)),
    ]
    const bytes = Buffer.from(
      '# My conventions\r\n  Preserve λ and trailing space.  \r\n\0',
      'utf8',
    )
    for (const file of files) writeFileSync(file, bytes)
    expect(init(root).error).toBeUndefined()
    expect(context(root, value, 'abstraction').error).toBeUndefined()
    expect(context(root, value, 'verify', problem.id).error).toBeUndefined()
    for (const file of files) expect(readFileSync(file)).toEqual(bytes)
    expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(original)
  })

  it('upgrades only known app-generated instructions while retaining legacy metadata and native references', () => {
    const root = temporary()
    const researchRoot = join(root, '.life/research')
    const directory = join(researchRoot, 'goal-files')
    const problemDirectory = join(directory, 'problems/problem-one')
    mkdirSync(problemDirectory, { recursive: true })
    const legacy = {
      ...goal(),
      customMetadata: { experiment: 42, rawObservation: 'Keep this unchanged\r\n' },
      problems: goal().problems.map((problem) => ({
        ...problem,
        customProblemMetadata: { providerHandle: problem.id },
      })),
    }
    const goalBytes = JSON.stringify(legacy, null, 2) + '\r\n'
    writeFileSync(join(directory, 'goal.json'), goalBytes)
    const oldContext = {
      format: 'life-research-context',
      version: 1,
      conversation: 'problem',
      goalId: legacy.id,
      problemId: legacy.problems[0].id,
      goalDirectory: '../..',
      goalFile: '../../goal.json',
      readmeFile: '../../../README.md',
      lockFile: '../../../.life.lock',
      mapFiles: {
        json: '../../map.json',
        mermaid: '../../map.mmd',
        html: '../../map.html',
      },
    }
    writeFileSync(join(problemDirectory, '.life-context.json'), JSON.stringify(oldContext))
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      writeFileSync(join(researchRoot, name), legacyResearchInstructions)
      writeFileSync(join(directory, name), legacyResearchConversationInstructions)
      writeFileSync(join(problemDirectory, name), legacyResearchConversationInstructions)
    }
    expect(init(root).error).toBeUndefined()
    expect(context(root, legacy, 'explore').error).toBeUndefined()
    expect(context(root, legacy, 'abstraction', legacy.problems[0].id).error).toBeUndefined()
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(researchRoot, name), 'utf8')).toBe(researchInstructions)
      expect(readFileSync(join(directory, name), 'utf8')).toBe(researchConversationInstructions)
      expect(readFileSync(join(problemDirectory, name), 'utf8')).toBe(
        researchConversationInstructions,
      )
    }
    expect(readContext(problemDirectory)).toMatchObject(oldContext)
    expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(goalBytes)
    expect(readContext(problemDirectory).methodGuideFile).toBe('../../../.life-method.md')
    expect(readContext(problemDirectory).methodSchemaFile).toBe('../../../.life-method-schema.json')
  })

  it.each(['.life-method.md', '.life-method-schema.json', 'AGENTS.md', 'CLAUDE.md'])(
    'rejects a symlinked %s before it can overwrite data outside the research workspace',
    (name) => {
      const { root } = setup()
      const outside = temporary()
      const target = join(outside, 'keep.txt')
      const bytes = Buffer.from('User-owned bytes remain exact\r\n')
      writeFileSync(target, bytes)
      const link = join(root, '.life/research', name)
      rmSync(link)
      symlinkSync(target, link)
      expect(init(root).error).toContain('ordinary files and directories')
      expect(readFileSync(target)).toEqual(bytes)
      expect(readdirSync(outside)).toEqual(['keep.txt'])
    },
  )

  it('rejects a symlinked native context instead of following or replacing its target', () => {
    const { root, directory, value, original } = setup()
    const outside = temporary()
    const target = join(outside, 'context.json')
    const bytes = Buffer.from('{"private":"unrelated"}\n')
    writeFileSync(target, bytes)
    symlinkSync(target, join(directory, '.life-context.json'))
    expect(context(root, value, 'verify').error).toContain('ordinary files and directories')
    expect(readFileSync(target)).toEqual(bytes)
    expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(original)
    expect(readdirSync(directory).some((name) => name.startsWith('.life-context-'))).toBe(false)
  })
})

describe('compressed Research commands through the actual machine shell', () => {
  it('fits the full native initialization below the SSH exec budget and writes complete guide and schema bytes', async () => {
    const root = temporary()
    const input = initialization()
    const expanded = Buffer.byteLength(JSON.stringify({ worker: researchFileWorker, input }))
    expect(expanded).toBeGreaterThan(30_000)
    const command = await researchCommand(researchFileWorker, input)
    expect(Buffer.byteLength(command)).toBeLessThan(30_000)
    expect(shellCall(root, command)).toEqual({ value: { ok: true } })
    const researchRoot = join(root, '.life/research')
    expect(readFileSync(join(researchRoot, '.life-method.md'))).toEqual(
      Buffer.from(researchMethodGuide),
    )
    expect(readFileSync(join(researchRoot, '.life-method-schema.json'))).toEqual(
      Buffer.from(researchMethodSchema),
    )
    expect(readFileSync(join(researchRoot, 'AGENTS.md'))).toEqual(Buffer.from(researchInstructions))
    expect(readFileSync(join(researchRoot, 'CLAUDE.md'))).toEqual(Buffer.from(researchInstructions))
  })

  it('transfers Unicode and literal shell syntax as user data without executing command markers', async () => {
    const root = temporary()
    const markers = ['life-research-injected-one', 'life-research-injected-two']
    const literal =
      "  /life is literal\r\n研究 λ Ångström 😀\n'; touch life-research-injected-one; #\n" +
      '`touch life-research-injected-two` $(touch life-research-injected-two)\0\u0001\u001b  '
    const guide = researchMethodGuide + '\nLiteral supplied material:\n' + literal
    const schema =
      JSON.stringify({ ...JSON.parse(researchMethodSchema), suppliedLiteral: literal }, null, 2) +
      '\n'
    const instructions = researchInstructions + '\n' + literal
    const command = await researchCommand(researchFileWorker, {
      ...initialization(),
      readme: literal,
      instructions,
      methodGuide: guide,
      methodSchema: schema,
      prompt: literal,
    })
    expect(Buffer.byteLength(command)).toBeLessThan(30_000)
    expect(shellCall(root, command)).toEqual({ value: { ok: true } })
    const researchRoot = join(root, '.life/research')
    expect(readFileSync(join(researchRoot, 'README.md'))).toEqual(Buffer.from(literal))
    expect(readFileSync(join(researchRoot, '.life-method.md'))).toEqual(Buffer.from(guide))
    expect(readFileSync(join(researchRoot, '.life-method-schema.json'))).toEqual(
      Buffer.from(schema),
    )
    expect(
      JSON.parse(readFileSync(join(researchRoot, '.life-method-schema.json'), 'utf8'))
        .suppliedLiteral,
    ).toBe(literal)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(researchRoot, name))).toEqual(Buffer.from(instructions))
    }
    for (const marker of markers) expect(existsSync(join(root, marker))).toBe(false)
    expect(researchPrompt({ goal: goal() }, literal, root)).toBe(literal)
  })

  it('uploads random 16 KiB chunks under the SSH budget and reconstructs their exact SHA-256', async () => {
    const { root, directory, original } = setup()
    const chunks = [randomBytes(16_384), randomBytes(16_384)]
    const stage = randomUUID()
    for (const [index, bytes] of chunks.entries()) {
      const command = await researchCommand(researchFileWorker, {
        op: 'stage',
        stage,
        offset: index * 16_384,
        data: bytes.toString('base64'),
      })
      expect(Buffer.byteLength(command)).toBeLessThan(30_000)
      expect(shellCall(root, command)).toEqual({ value: { ok: true } })
    }
    const actual = readFileSync(join(root, '.life/research', '.life-stage-' + stage))
    const expected = Buffer.concat(chunks)
    expect(actual).toEqual(expected)
    expect(createHash('sha256').update(actual).digest('hex')).toBe(
      createHash('sha256').update(expected).digest('hex'),
    )
    expect(actual.length).toBe(32_768)
    expect(readFileSync(join(directory, 'goal.json'), 'utf8')).toBe(original)
    const discard = await researchCommand(researchFileWorker, { op: 'discard', stage })
    expect(shellCall(root, discard)).toEqual({ value: { ok: true } })
    expect(existsSync(join(root, '.life/research', '.life-stage-' + stage))).toBe(false)
  })
})

describe('strict remote research method parsing', () => {
  it('gives a legacy goal an empty versioned method without inventing requirements, evidence or findings', () => {
    const { method: _method, ...legacy } = goal()
    const raw = JSON.stringify({ ...legacy, customMetadata: { keep: 'original' } })
    const parsed = parseResearchGoal(raw, legacy.directory!)
    expect(parsed.method).toEqual(createResearchMethod())
    expect(parsed.problems).toEqual(legacy.problems)
    expect(parsed).toMatchObject({
      id: legacy.id,
      threadId: legacy.threadId,
      customMetadata: { keep: 'original' },
    })
    expect(JSON.stringify(legacy)).not.toContain('"method"')
  })

  const invalidMethods: [string, unknown][] = [
    ['null method', null],
    ['array method', []],
    ['string method', 'not an object'],
    ['missing method version', {}],
    ['future method version', { ...createResearchMethod(), version: 2 }],
    ['unknown operator', { ...createResearchMethod(), activeOperation: 'invented-operation' }],
    ...[
      'requirements',
      'assumptions',
      'evidence',
      'candidates',
      'interactions',
      'validations',
      'inquiries',
    ].map((collection): [string, unknown] => [
      collection + ' is not an array',
      { ...createResearchMethod(), [collection]: {} },
    ]),
  ]
  it.each(invalidMethods)(
    'rejects %s so callers retain their previous valid goal',
    (_name, invalidMethod) => {
      const previous = parseResearchGoal(JSON.stringify(goal()), 'goal-files')
      const previousBytes = JSON.stringify(previous)
      let cached = previous
      expect(() => {
        cached = parseResearchGoal(
          JSON.stringify({ ...goal(), title: 'Invalid replacement', method: invalidMethod }),
          'goal-files',
        )
      }).toThrow(/Invalid research|Unknown research operation/)
      expect(cached).toBe(previous)
      expect(JSON.stringify(cached)).toBe(previousBytes)
      expect(cached.title).toBe('Evaluate a proposed mechanism')
    },
  )
})
