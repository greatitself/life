import type { ResearchScope } from './research-storage'
import { createWebResearchExampleMethod } from './web-research-example'

export const WEB_PREVIEW_PROFILE_ID = 'life-browser-preview'
export const WEB_PREVIEW_HOME = '/browser'
const storageKey = 'life.web.research.files.v1'
const byteLimit = 4_000_000
const mapFiles = ['map.json', 'map.mmd', 'map.html']
const stageWrites = new Map<string, Uint8Array>()
let operationQueue: Promise<unknown> = Promise.resolve()
type Files = Record<string, string>
const safeName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 240 &&
  value !== '.' &&
  value !== '..' &&
  !value.startsWith('.') &&
  !/[\/\\\0]/.test(value)

function loadFiles(): Files {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return {}
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'The browser Research file store is invalid. Export your local data before resetting it.',
    )
  return Object.fromEntries(
    Object.entries(value).filter(([, contents]) => typeof contents === 'string'),
  ) as Files
}
function saveFiles(files: Files) {
  localStorage.setItem(storageKey, JSON.stringify(files))
}
async function digest(value: string | undefined): Promise<string | null> {
  if (value === undefined) return null
  const bytes = new TextEncoder().encode(value)
  if (bytes.length > byteLimit) throw new Error('Research file exceeds 4 MB.')
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function goalPath(input: Record<string, unknown>): string {
  if (!safeName(input.directory)) throw new Error('Invalid goal directory.')
  if (!['goal.json', ...mapFiles].includes(String(input.file)))
    throw new Error('Invalid Research file.')
  return `${input.directory}/${input.file}`
}

/** The same file protocol used by native Research, backed by this browser only. No shell evaluation. */
export async function performWebResearchOperation<T>(
  scope: ResearchScope,
  input: Record<string, unknown>,
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request('life.web.research.files', () =>
      performOperation<T>(scope, input),
    )
  const result = operationQueue.then(() => performOperation<T>(scope, input))
  operationQueue = result.catch(() => {})
  return result
}

async function performOperation<T>(
  scope: ResearchScope,
  input: Record<string, unknown>,
): Promise<T> {
  if (scope.profileId !== WEB_PREVIEW_PROFILE_ID || scope.workspace !== WEB_PREVIEW_HOME)
    throw new Error('Browser Research cannot access a desktop or SSH machine.')
  const files = loadFiles()
  let result: unknown
  switch (input.op) {
    case 'init': {
      for (const [name, contents] of [
        ['README.md', input.readme],
        ['AGENTS.md', input.instructions],
        ['CLAUDE.md', input.instructions],
      ])
        if (!files[String(name)] && typeof contents === 'string') files[String(name)] = contents
      for (const [name, contents] of [
        ['.life-method.md', input.methodGuide],
        ['.life-method-schema.json', input.methodSchema],
      ]) {
        if (contents === undefined) continue
        if (typeof contents !== 'string' || new TextEncoder().encode(contents).length > 200000)
          throw new Error('Invalid Research instruction or schema.')
        files[String(name)] = contents
      }
      saveFiles(files)
      result = { ok: true }
      break
    }
    case 'scan': {
      const directories = Object.keys(files)
        .filter((path) => /^[^/]+\/goal\.json$/.test(path))
        .map((path) => path.split('/')[0])
        .sort()
      result = {
        entries: await Promise.all(
          directories.map(async (directory) => ({
            directory,
            revision: await digest(files[`${directory}/goal.json`]),
            maps: await Promise.all(
              mapFiles.map(async (file) => ({
                file,
                revision: await digest(files[`${directory}/${file}`]),
              })),
            ),
          })),
        ),
      }
      break
    }
    case 'read': {
      const path = goalPath(input)
      const revision = await digest(files[path])
      if (input.expected !== undefined && revision !== input.expected)
        throw new Error('RESEARCH_CHANGED')
      const bytes = new TextEncoder().encode(files[path] || '')
      const offset = Number(input.offset)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
        throw new Error('Invalid read offset.')
      const part = bytes.subarray(offset, offset + 32768)
      result = {
        revision,
        data: btoa(String.fromCharCode(...part)),
        done: offset + part.length >= bytes.length,
      }
      break
    }
    case 'stage': {
      if (
        typeof input.stage !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(input.stage) ||
        typeof input.data !== 'string'
      )
        throw new Error('Invalid staged write.')
      const bytes = Uint8Array.from(atob(input.data), (character) => character.charCodeAt(0))
      const offset = Number(input.offset)
      const previous = stageWrites.get(input.stage)
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        bytes.length > 32768 ||
        offset + bytes.length > byteLimit ||
        (offset === 0 ? Boolean(previous) : previous?.length !== offset)
      )
        throw new Error('Invalid write chunk.')
      const next = new Uint8Array(offset + bytes.length)
      if (previous) next.set(previous)
      next.set(bytes, offset)
      stageWrites.set(input.stage, next)
      result = { ok: true }
      break
    }
    case 'discard':
      stageWrites.delete(String(input.stage))
      result = { ok: true }
      break
    case 'commit': {
      if (!safeName(input.directory)) throw new Error('Invalid goal directory.')
      const staged = stageWrites.get(String(input.stage))
      if (!staged) throw new Error('Staged write is missing.')
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(staged)
      const goal = JSON.parse(contents)
      if (
        !goal ||
        typeof goal.id !== 'string' ||
        typeof goal.title !== 'string' ||
        !Array.isArray(goal.problems)
      )
        throw new Error('Invalid goal.json.')
      const path = `${input.directory}/goal.json`
      if ((await digest(files[path])) !== input.expected) throw new Error('RESEARCH_CHANGED')
      files[path] = contents
      saveFiles(files)
      stageWrites.delete(String(input.stage))
      result = { revision: await digest(contents) }
      break
    }
    case 'context': {
      if (!safeName(input.directory)) throw new Error('Invalid goal directory.')
      const goal = JSON.parse(files[`${input.directory}/goal.json`] || 'null')
      if (!goal || typeof goal.id !== 'string' || !Array.isArray(goal.problems))
        throw new Error('The Research goal is missing.')
      const problem =
        input.problemId === undefined
          ? undefined
          : goal.problems.find((item: { id: unknown }) => item.id === input.problemId)
      if (input.problemId !== undefined && !problem)
        throw new Error('The selected Research problem no longer exists.')
      if (problem && !safeName(input.problemDirectory))
        throw new Error('Invalid problem directory.')
      const directory = `${input.directory}${problem ? `/problems/${input.problemDirectory}` : ''}`
      const relative = problem ? '../../' : ''
      const context = {
        format: 'life-research-context',
        version: 1,
        conversation: problem ? 'problem' : 'goal',
        goalId: goal.id,
        ...(input.invocationId
          ? {
              invocationId: input.invocationId,
              executionId: input.invocationId,
              invocationFile: `.life-invocations/${input.invocationId}.json`,
            }
          : {}),
        ...(input.operation ? { operation: input.operation } : {}),
        methodGuideFile: relative + '../.life-method.md',
        methodSchemaFile: relative + '../.life-method-schema.json',
        ...(problem ? { problemId: problem.id } : {}),
        goalDirectory: problem ? '../..' : '.',
        goalFile: relative + 'goal.json',
        readmeFile: relative + '../README.md',
        lockFile: relative + '../.life.lock',
        mapFiles: {
          json: relative + 'map.json',
          mermaid: relative + 'map.mmd',
          html: relative + 'map.html',
        },
      }
      const encoded = JSON.stringify(context, null, 2) + '\n'
      if (new TextEncoder().encode(encoded).length > 65536)
        throw new Error('The Research conversation context is too large.')
      if (input.invocationId) {
        if (typeof input.invocationId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.invocationId))
          throw new Error('Invalid Research invocation identity.')
        const snapshot = `${directory}/.life-invocations/${input.invocationId}.json`
        if (files[snapshot] && files[snapshot] !== encoded)
          throw new Error('Research invocation metadata is immutable.')
        files[snapshot] = encoded
      }
      const contextFile = `${directory}/.life-context.json`
      if (files[contextFile]) {
        const existing = JSON.parse(files[contextFile])
        if (
          existing.format !== context.format ||
          existing.goalId !== context.goalId ||
          existing.problemId !== context.problemId
        )
          throw new Error('The Research conversation directory already belongs to another context.')
      }
      files[contextFile] = encoded
      for (const name of ['AGENTS.md', 'CLAUDE.md'])
        if (!files[`${directory}/${name}`] && typeof input.instructions === 'string')
          files[`${directory}/${name}`] = input.instructions
      saveFiles(files)
      result = { directory: `${scope.root}/${directory}`, context }
      break
    }
    default:
      throw new Error('Unsupported browser Research operation.')
  }
  return result as T
}

export function exportWebResearchFiles(): Files {
  return loadFiles()
}

/** Only public example content, never copied from a user's extension backup or machine. */
export function initializeWebResearchExample() {
  if (localStorage.getItem(storageKey)) return
  const now = Date.now()
  saveFiles({
    'example-research/goal.json':
      JSON.stringify(
        {
          id: 'example-research',
          title: 'Example: Reliable research workflow',
          goal: 'Break a goal into fundamental requirements, test assumptions against evidence, and combine compatible solutions. This is editable example data stored only in this browser.',
          method: createWebResearchExampleMethod(now),
          problems: [
            {
              id: 'example-boundaries',
              title: 'What is absolutely required?',
              description:
                'Separate measurable requirements from assumptions. Record the evidence needed to validate each requirement.',
              notes: '',
              status: 'open',
              updatedAt: now,
            },
            {
              id: 'example-interference',
              title: 'Which solutions reinforce one another?',
              description:
                'Compare candidate approaches against the same requirements. Record constructive effects, tradeoffs, and experiments before choosing a synthesis.',
              notes: '',
              status: 'open',
              updatedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
        null,
        2,
      ) + '\n',
  })
}
