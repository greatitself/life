import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHistory } from '../src/main/agent-history'
import type { SSHExecOptions } from '../src/main/ssh'
import type { ConnectionState } from '../src/shared/types'

const roots: string[] = []
const processes = new Set<ChildProcessWithoutNullStreams>()
const histories: AgentHistory[] = []
afterEach(async () => {
  for (const history of histories.splice(0)) history.cancelAll()
  for (const process of processes) process.kill('SIGKILL')
  processes.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface Execution {
  command: string
  input?: string
  output: string
}

function run(command: string, options: SSHExecOptions, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      env,
      signal: options.signal,
      stdio: 'pipe',
    })
    processes.add(child)
    const output: Buffer[] = [],
      errors: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('History parity helper exceeded its deadline'))
    }, options.timeoutMs ?? 20_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > (options.maxOutputBytes ?? 4_000_000)) {
        child.kill('SIGKILL')
        reject(new Error('History parity helper exceeded its output limit'))
      } else output.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      processes.delete(child)
      if (code === 0) resolve(Buffer.concat(output).toString('utf8'))
      else reject(new Error(Buffer.concat(errors).toString('utf8') || `Helper exited ${code}`))
    })
    child.stdin.end(options.input)
  })
}

async function fixture(contents: string) {
  const root = await mkdtemp(join(tmpdir(), 'life-local-history-parity-'))
  roots.push(root)
  const config = join(root, "Claude config ' café 🧪")
  const project = join(config, 'projects', 'project')
  await mkdir(project, { recursive: true })
  const filename = join(project, 'session.jsonl')
  await writeFile(filename, contents)
  function connection(transport: 'local' | 'ssh') {
    const executions: Execution[] = []
    const env = {
      ...process.env,
      PATH: transport === 'local' ? join(root, 'empty-path') : process.env.PATH,
      CLAUDE_CONFIG_DIR: config,
    }
    const state: ConnectionState = {
      status: 'connected',
      home: root,
      profile: {
        transport,
        id: 'same-private-host',
        name: transport,
        host: 'localhost',
        port: 22,
        username: 'fixture',
        auth: 'agent',
        privateKeyPath: '',
        workspace: root,
      },
    }
    const exec = vi.fn(async (command: string, options: SSHExecOptions = {}) => {
      const output = await run(command, options, env)
      executions.push({ command, input: options.input, output })
      return output
    })
    const channel = vi.fn(async () => {
      throw new Error('History parity tests do not authorize provider execution')
    })
    const history = new AgentHistory(Object.assign(new EventEmitter(), { state, exec, channel }))
    histories.push(history)
    return { history, executions, channel }
  }
  return { root, filename, local: connection('local'), remote: connection('ssh') }
}

function summaryParts(executions: Execution[], local: boolean): Buffer[] {
  const execution = executions.find(({ command, input }) =>
    local ? Boolean(input && 'indexedSize' in JSON.parse(input)) : command.startsWith('[ -f '),
  )
  expect(execution, 'the actual summary command must have completed').toBeDefined()
  const segments = execution!.output.split('\0')
  expect(segments).toHaveLength(3)
  return segments.map((segment) => Buffer.from(segment.replace(/\s/g, ''), 'base64'))
}

const prompt = '  /life exact original\r\n研究 🧪\t ${literal} `quoted`  '
const user =
  JSON.stringify({
    type: 'user',
    uuid: 'original-user',
    sessionId: 'session',
    cwd: '/work/café 🧪',
    timestamp: '2026-10-09T12:00:00.000Z',
    message: { role: 'user', content: prompt },
  }) + '\n'
const response =
  JSON.stringify({
    type: 'assistant',
    uuid: 'original-assistant',
    timestamp: '2026-10-09T12:00:01.000Z',
    message: {
      role: 'assistant',
      model: 'claude-fixture-model',
      content: [{ type: 'text', text: 'Exact reply 🧪\r\n' }],
    },
  }) + '\n'
const title = (name: string, type = 'ai-title') =>
  JSON.stringify({ type, [type === 'custom-title' ? 'customTitle' : 'aiTitle']: name })
const giant = (size: number) =>
  JSON.stringify({ type: 'irrelevant', padding: 'x'.repeat(size) }) + '\n'
function paddingBytes(size: number): string {
  const empty = giant(0)
  if (size < Buffer.byteLength(empty)) throw new Error('Insufficient fixture padding')
  return giant(size - Buffer.byteLength(empty))
}
const opening = user + response
const middlePrefix = opening + giant(180_000)
const ending = giant(180_000)
const splitOffset = 262_144 - 3
const chunkPrefix = opening + paddingBytes(splitOffset - 1 - Buffer.byteLength(opening))

const cases = [
  {
    name: 'a native title between head and tail windows',
    contents: middlePrefix + title('Middle provider title') + '\n' + ending,
    expected: 'Middle provider title',
  },
  {
    name: 'a type token split over the fixed 64 KB byte boundary',
    contents: chunkPrefix + title('Chunk boundary provider title') + '\n' + ending,
    expected: 'Chunk boundary provider title',
  },
  {
    name: 'a final title at EOF without a newline',
    contents: middlePrefix + title('Provider EOF title'),
    expected: 'Provider EOF title',
  },
  {
    name: 'CRLF title records and original Unicode messages',
    contents:
      opening.replace(/\n/g, '\r\n') +
      giant(180_000) +
      title('CRLF provider title') +
      '\r\n' +
      ending,
    expected: 'CRLF provider title',
  },
  {
    name: 'a giant irrelevant line before a recoverable native title',
    contents: opening + giant(2_500_000) + title('After giant irrelevant line') + '\n' + ending,
    expected: 'After giant irrelevant line',
  },
  {
    name: 'more than 128 KB of matching title records retains the latest complete title',
    contents:
      middlePrefix +
      Array.from({ length: 4000 }, (_, i) => title(`Earlier title ${i}`)).join('\n') +
      '\n' +
      title('Latest original custom title', 'custom-title') +
      '\n' +
      ending,
    expected: 'Latest original custom title',
  },
  {
    name: 'a huge matching line drops old titles before a later complete title',
    contents:
      middlePrefix +
      title('Before oversized matching line') +
      '\n' +
      '{"type"' +
      ' '.repeat(2_500_000) +
      ':"ai-title","aiTitle":"Oversized line title"}\n' +
      title('After oversized matching line') +
      '\n' +
      ending,
    expected: 'After oversized matching line',
  },
  {
    name: 'non-ASCII whitespace does not match the C-locale title selector',
    contents:
      middlePrefix +
      title('Correct ASCII title') +
      '\n' +
      '{"type"\u00a0:"ai-title","aiTitle":"Invalid whitespace title"}\n' +
      ending,
    expected: 'Correct ASCII title',
  },
]

describe.skipIf(process.platform === 'win32')('Local and SSH Claude history byte parity', () => {
  it.each(cases)(
    '$name',
    async ({ contents, expected }) => {
      const { filename, local, remote } = await fixture(contents)
      const before = createHash('sha256')
        .update(await readFile(filename))
        .digest('hex')
      const remoteList = await remote.history.list({ provider: 'claude' })
      const localList = await local.history.list({ provider: 'claude' })
      expect(localList).toEqual(remoteList)
      expect(localList.warnings).toEqual([])
      expect(localList.sessions).toHaveLength(1)
      expect(localList.sessions[0]).toMatchObject({
        id: 'claude:session',
        remoteId: 'session',
        title: expected,
        workspace: '/work/café 🧪',
        model: 'claude-fixture-model',
      })
      expect(summaryParts(local.executions, true)).toEqual(summaryParts(remote.executions, false))

      const localPage = await local.history.read({ id: 'claude:session', limit: 2 })
      const remotePage = await remote.history.read({ id: 'claude:session', limit: 2 })
      expect(localPage).toEqual(remotePage)
      expect(localPage.messages.map((message) => message.text)).toEqual([
        prompt,
        'Exact reply 🧪\r\n',
      ])
      expect(local.channel).not.toHaveBeenCalled()
      expect(remote.channel).not.toHaveBeenCalled()
      expect(
        createHash('sha256')
          .update(await readFile(filename))
          .digest('hex'),
      ).toBe(before)
      expect(
        local.executions
          .slice(1)
          .every(({ command }) => command.startsWith('ELECTRON_RUN_AS_NODE=1 exec ')),
      ).toBe(true)
    },
    30_000,
  )
})
