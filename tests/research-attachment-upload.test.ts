import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { ConnectionExecutionInput, ConnectionState } from '../src/shared/types'
import {
  attachmentPrompt,
  uploadAttachmentFiles,
  type AttachmentUploadContext,
  type DraftAttachment,
} from '../src/renderer/attachments'
import { ensureAttachmentUploads } from '../src/renderer/draft-upload'

const transport = vi.hoisted(() => ({
  state: vi.fn<() => Promise<ConnectionState>>(),
  execute: vi.fn<(input: ConnectionExecutionInput) => Promise<string>>(),
  listeners: new Set<(state: ConnectionState) => void>(),
  onConnection: vi.fn((listener: (state: ConnectionState) => void) => {
    transport.listeners.add(listener)
    return () => transport.listeners.delete(listener)
  }),
}))

vi.mock('../src/renderer/api', () => ({
  api: {
    connection: { state: transport.state, execute: transport.execute },
    onConnection: transport.onConnection,
  },
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

// Draft jobs' persistence is independent of the upload transport being tested.
// Keep the actual upload implementation and avoid introducing a synthetic
// IndexedDB implementation into remote-file correctness tests.
vi.mock('../src/renderer/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/attachments')>()),
  saveAttachmentFiles: vi.fn(async () => undefined),
}))

// Read the real Blob bytes just as a browser FileReader does. Remote commands
// below also run unchanged in a real child shell, so multipart correctness is
// checked at both sides of the production upload boundary.
class BlobFileReader {
  result: string | null = null
  error: Error | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(
      (bytes) => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
        this.onload?.()
      },
      (error) => {
        this.error = error
        this.onerror?.()
      },
    )
  }
}

let directory: string
let goal: string
let project: string
let expected: ConnectionState
let current: ConnectionState
let sequence: number
let remoteTemporaryDirectories: Set<string>

function updateConnection(patch: Partial<ConnectionState>) {
  current = { ...current, ...patch }
  for (const listener of transport.listeners) listener(current)
}

function executeShell(input: ConnectionExecutionInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', input.command], { cwd: input.workspace })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (data: Buffer) => stdout.push(data))
    child.stderr.on('data', (data: Buffer) => stderr.push(data))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        const output = Buffer.concat(stdout).toString('utf8')
        const temporaryDirectory = output
          .split(/\r?\n/)
          .find((line) =>
            /^LIFE_ATTACHMENT_DIR=\/tmp\/life-thread-attachments\.[a-zA-Z0-9]+$/.test(line),
          )
          ?.slice('LIFE_ATTACHMENT_DIR='.length)
        if (temporaryDirectory) remoteTemporaryDirectories.add(temporaryDirectory)
        resolve(output)
      } else reject(new Error(Buffer.concat(stderr).toString('utf8') || `Exit ${code}`))
    })
    child.stdin.end()
  })
}

function attachment(name: string, bytes: string | Buffer, mime = 'application/octet-stream') {
  const file = new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], name, {
    type: mime,
  })
  return {
    id: `upload-${++sequence}`,
    name,
    mime,
    size: file.size,
    file,
  } satisfies DraftAttachment
}

function researchContext(): AttachmentUploadContext {
  return { scope: 'machine', workspace: goal }
}

async function upload(
  items: DraftAttachment[],
  context: AttachmentUploadContext | undefined = researchContext(),
  controller = new AbortController(),
) {
  const progress = vi.fn<(value: number) => void>()
  const result = await uploadAttachmentFiles(items, expected, controller.signal, progress, context)
  return { result, progress }
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('FileReader', BlobFileReader)
  transport.listeners.clear()
  sequence = 0
  remoteTemporaryDirectories = new Set()
  // Shell-sensitive names verify that the selected cwd never becomes command
  // syntax. Research folders are below the connected host's home directory.
  directory = await mkdtemp(join(tmpdir(), "life-research-upload-'quoted'-"))
  goal = join(directory, '.life', 'research', 'experiment')
  project = join(directory, 'agents-project')
  await Promise.all([mkdir(goal, { recursive: true }), mkdir(project)])
  expected = {
    status: 'connected',
    home: directory,
    workspace: project,
    profile: {
      id: 'host-a',
      name: 'Research host',
      host: 'localhost',
      port: 22,
      username: 'researcher',
      auth: 'agent',
      privateKeyPath: '',
      workspace: project,
    },
  }
  current = structuredClone(expected)
  transport.state.mockImplementation(async () => structuredClone(current))
  transport.execute.mockImplementation(executeShell)
})

afterEach(async () => {
  expect(transport.listeners.size).toBe(0)
  vi.unstubAllGlobals()
  await Promise.all(
    [directory, ...remoteTemporaryDirectories].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

describe('Research attachments use their own machine-scoped workspace', () => {
  it('preserves every byte of concurrent multipart files, including empty files', async () => {
    const binary = Buffer.alloc(234_567)
    for (let index = 0; index < binary.length; index++) binary[index] = index % 251
    const text = Buffer.from("  研究 👋\r\n$() `literal` 'quoted'\n".repeat(3_000))
    const selected = [
      attachment('raw binary.bin', binary),
      attachment('notes-研究.md', text, 'text/markdown'),
      attachment('empty.txt', '', 'text/plain'),
    ]
    const { result, progress } = await upload(selected)
    const original = [binary, text, Buffer.alloc(0)]
    const directories = new Set<string>()
    for (const [index, item] of result.entries()) {
      expect(item).toMatchObject({
        id: selected[index].id,
        name: selected[index].name,
        mime: selected[index].mime,
        size: original[index].length,
      })
      const path = item.remotePath!
      directories.add(dirname(path))
      expect(relative(goal, path)).toMatch(/^\.life-attachments\.[^/]+\/[^/]+$/)
      const actual = await readFile(path)
      expect(createHash('sha256').update(actual).digest('hex')).toBe(
        createHash('sha256').update(original[index]).digest('hex'),
      )
    }
    expect(directories.size).toBe(1)
    expect(await readdir([...directories][0])).toHaveLength(selected.length)
    expect(await readdir(project)).toEqual([])
    expect(transport.execute.mock.calls.length).toBeGreaterThan(6)
    for (const [input] of transport.execute.mock.calls)
      expect(input).toMatchObject({ scope: 'machine', workspace: goal, timeoutMs: 30_000 })
    expect(progress.mock.calls.at(-1)).toEqual([100])
    const percentages = progress.mock.calls.map(([percent]) => percent)
    expect(percentages).toEqual([...percentages].sort((left, right) => left - right))
  })

  it('allocates a separate hidden folder for each upload instead of reusing prior files', async () => {
    const selected = attachment('notes.txt', 'independent upload', 'text/plain')
    const first = (await upload([selected])).result[0]
    const second = (await upload([selected])).result[0]
    expect(dirname(first.remotePath!)).not.toBe(dirname(second.remotePath!))
    expect(await readFile(first.remotePath!, 'utf8')).toBe('independent upload')
    expect(await readFile(second.remotePath!, 'utf8')).toBe('independent upload')
  })

  it('continues research uploads when the Agents panel selects a different project', async () => {
    let commands = 0
    transport.execute.mockImplementation(async (input) => {
      const output = await executeShell(input)
      if (++commands === 2) updateConnection({ workspace: join(directory, 'different-project') })
      return output
    })
    const selected = attachment('multipart.bin', Buffer.alloc(170_000, 0xab))
    const result = (await upload([selected])).result[0]
    expect(await readFile(result.remotePath!)).toEqual(Buffer.alloc(170_000, 0xab))
    expect(current.workspace).not.toBe(expected.workspace)
    for (const [input] of transport.execute.mock.calls) expect(input.workspace).toBe(goal)
  })

  it('works before a project is selected on the connected machine', async () => {
    expected = { ...expected, workspace: undefined }
    current = structuredClone(expected)
    const result = (await upload([attachment('notes.txt', 'research only')])).result[0]
    expect(await readFile(result.remotePath!, 'utf8')).toBe('research only')
    expect(transport.execute.mock.calls[0][0].scope).toBe('machine')
  })

  it('fences a Research path whose symlink target changes during the upload', async () => {
    const link = join(directory, 'research-link')
    const otherGoal = join(directory, '.life', 'research', 'other-experiment')
    await mkdir(otherGoal)
    await symlink(goal, link)
    let commands = 0
    transport.execute.mockImplementation(async (input) => {
      const output = await executeShell(input)
      if (++commands === 1) {
        await unlink(link)
        await symlink(otherGoal, link)
      }
      return output
    })
    await expect(
      upload([attachment('notes.txt', 'must stay in original directory')], {
        scope: 'machine',
        workspace: link,
      }),
    ).rejects.toThrow()
    expect(await readdir(otherGoal)).toEqual([])
  })

  it.each(['profile', 'home', 'disconnect'] as const)(
    'fences an in-flight research upload when the host %s changes',
    async (change) => {
      let commands = 0
      transport.execute.mockImplementation(async (input) => {
        const output = await executeShell(input)
        if (++commands === 1) {
          if (change === 'profile')
            updateConnection({ profile: { ...current.profile!, id: 'host-b' } })
          else if (change === 'home') updateConnection({ home: join(directory, 'different-home') })
          else updateConnection({ status: 'disconnected' })
        }
        return output
      })
      await expect(upload([attachment('notes.txt', 'must stay on host a')])).rejects.toThrow(
        /connection|machine|host|changed/i,
      )
      expect(transport.execute).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects a host change even when the original host reconnects before the command returns', async () => {
    transport.execute.mockImplementation(async (input) => {
      const output = await executeShell(input)
      updateConnection({ status: 'disconnected' })
      updateConnection({ status: 'connected' })
      return output
    })
    await expect(upload([attachment('notes.txt', 'original')])).rejects.toThrow(
      /connection|machine|host|changed/i,
    )
    expect(transport.execute).toHaveBeenCalledTimes(1)
  })

  it('rejects a different host before issuing the first remote command', async () => {
    current = { ...current, profile: { ...current.profile!, id: 'host-b' } }
    await expect(upload([attachment('notes.txt', 'original')])).rejects.toThrow(
      /connection|machine|host|changed/i,
    )
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('keeps normal project uploads bound to their selected project', async () => {
    transport.execute.mockImplementation(async (input) => {
      const output = await executeShell(input)
      updateConnection({ workspace: join(directory, 'different-project') })
      return output
    })
    await expect(
      upload([attachment('notes.txt', 'project attachment')], {
        scope: 'project',
        workspace: project,
      }),
    ).rejects.toThrow(/project|connection|changed/i)
    expect(transport.execute).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation before the first remote operation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      upload([attachment('notes.txt', 'original')], researchContext(), controller),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('does not finish or publish paths after cancellation during a multipart transfer', async () => {
    const controller = new AbortController()
    let commands = 0
    transport.execute.mockImplementation(async (input) => {
      const output = await executeShell(input)
      if (++commands === 2) controller.abort()
      return output
    })
    const progress = vi.fn<(value: number) => void>()
    await expect(
      uploadAttachmentFiles(
        [attachment('multipart.bin', Buffer.alloc(234_567, 0xaf))],
        expected,
        controller.signal,
        progress,
        researchContext(),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).not.toHaveBeenCalledWith(100)
  })

  it.each([
    {
      label: 'file count',
      files: () => Array.from({ length: 9 }, (_, index) => attachment(`${index}.txt`, '')),
      error: /8 files/i,
    },
    {
      label: 'per-file size',
      files: () => [attachment('large.bin', Buffer.alloc(10 * 1024 * 1024 + 1))],
      error: /10 MB/i,
    },
    {
      label: 'aggregate size',
      files: () =>
        [10, 10, 6].map((megabytes, index) =>
          attachment(`${index}.bin`, Buffer.alloc(megabytes * 1024 * 1024)),
        ),
      error: /25 MB/i,
    },
  ])('enforces the $label limit before any remote work', async ({ files, error }) => {
    await expect(upload(files())).rejects.toThrow(error)
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('rejects forged size metadata instead of silently dropping selected bytes', async () => {
    const selected = attachment('notes.txt', 'original bytes')
    await expect(upload([{ ...selected, size: 0 }])).rejects.toThrow(/size|invalid|match/i)
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('preserves the user prompt exactly even when attachments have remote paths', () => {
    const prompt = '  /life literal\r\n```${doNotInterpolate}```\n👋 café\t '
    expect(
      attachmentPrompt(prompt, [
        {
          id: 'selected-file',
          name: 'notes.md',
          mime: 'text/markdown',
          size: 4,
          remotePath: join(goal, 'notes.md'),
        },
      ]),
    ).toBe(prompt)
    expect(attachmentPrompt('', [])).toBe('')
  })
})

describe('Research attachment draft cache', () => {
  async function prepare(items: DraftAttachment[], context = researchContext()) {
    return ensureAttachmentUploads(
      items,
      expected,
      new AbortController().signal,
      () => undefined,
      context,
    )
  }

  it('reuses completed research uploads after an Agents project switch', async () => {
    const selected = attachment('draft.txt', 'only upload once', 'text/plain')
    const first = await prepare([selected])
    const uploadedCommands = transport.execute.mock.calls.length
    updateConnection({ workspace: join(directory, 'different-agents-project') })
    const second = await prepare([selected])
    expect(second).toEqual(first)
    expect(transport.execute.mock.calls.length).toBe(uploadedCommands + 1)
    expect(transport.execute.mock.calls.at(-1)![0]).toMatchObject({
      scope: 'machine',
      workspace: goal,
      timeoutMs: 15_000,
    })
    expect(await readFile(second[0].remotePath!, 'utf8')).toBe('only upload once')
  })

  it('reuploads a cached attachment whose remote file disappeared', async () => {
    const selected = attachment('draft.txt', 'retained local bytes', 'text/plain')
    const first = await prepare([selected])
    await rm(first[0].remotePath!)
    const second = await prepare([selected])
    expect(second[0].remotePath).not.toBe(first[0].remotePath)
    expect(await readFile(second[0].remotePath!, 'utf8')).toBe('retained local bytes')
  })

  it('reuploads for the new real directory when a Research symlink is retargeted', async () => {
    const selected = attachment('draft.txt', 'follow explicitly selected directory', 'text/plain')
    const link = join(directory, 'research-link')
    const otherGoal = join(directory, '.life', 'research', 'other-experiment')
    await mkdir(otherGoal)
    await symlink(goal, link)
    const context = { scope: 'machine' as const, workspace: link }
    const first = await prepare([selected], context)
    await unlink(link)
    await symlink(otherGoal, link)
    const second = await prepare([selected], context)
    expect(second[0].remotePath).not.toBe(first[0].remotePath)
    expect(relative(otherGoal, second[0].remotePath!)).toMatch(/^\.life-attachments\.[^/]+\/[^/]+$/)
    expect(await readFile(second[0].remotePath!, 'utf8')).toBe(
      'follow explicitly selected directory',
    )
  })

  it('does not reuse a Research file in another goal with the same attachment ID', async () => {
    const selected = attachment('draft.txt', 'same selection, independent goal', 'text/plain')
    const otherGoal = join(directory, '.life', 'research', 'other-experiment')
    await mkdir(otherGoal)
    const first = await prepare([selected])
    const second = await prepare([selected], { scope: 'machine', workspace: otherGoal })
    expect(second[0].remotePath).not.toBe(first[0].remotePath)
    expect(relative(otherGoal, second[0].remotePath!)).toMatch(/^\.life-attachments\.[^/]+\/[^/]+$/)
    expect(await readFile(first[0].remotePath!, 'utf8')).toBe('same selection, independent goal')
    expect(await readFile(second[0].remotePath!, 'utf8')).toBe('same selection, independent goal')
  })

  it('does not share a Research cache entry with a normal project upload', async () => {
    const selected = attachment('draft.txt', 'separate scope', 'text/plain')
    const first = await prepare([selected])
    const second = await prepare([selected], { scope: 'project', workspace: project })
    expect(second[0].remotePath).not.toBe(first[0].remotePath)
    expect(second[0].remotePath).toMatch(/^\/tmp\/life-thread-attachments\.[^/]+\/[^/]+$/)
    // The project's existing temporary transport intentionally stays separate.
    await rm(dirname(second[0].remotePath!), { recursive: true, force: true })
  })

  it('rejects a changed host before reading a completed cached path', async () => {
    const selected = attachment('draft.txt', 'host a only', 'text/plain')
    await prepare([selected])
    const uploadedCommands = transport.execute.mock.calls.length
    updateConnection({ profile: { ...current.profile!, id: 'host-b' } })
    await expect(prepare([selected])).rejects.toThrow(/machine|host|changed/i)
    expect(transport.execute.mock.calls.length).toBe(uploadedCommands)
  })

  it('does not resolve cached attachments after cancellation during readiness verification', async () => {
    const selected = attachment('draft.txt', 'original', 'text/plain')
    await prepare([selected])
    const controller = new AbortController()
    transport.execute.mockImplementation(async (input) => {
      const output = await executeShell(input)
      controller.abort()
      return output
    })
    await expect(
      ensureAttachmentUploads(
        [selected],
        expected,
        controller.signal,
        () => undefined,
        researchContext(),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects cached paths after a disconnect and reconnect during readiness verification', async () => {
    const selected = attachment('draft.txt', 'fenced cache', 'text/plain')
    await prepare([selected])
    transport.execute.mockImplementation(async (input) => {
      const output = await executeShell(input)
      updateConnection({ status: 'disconnected' })
      updateConnection({ status: 'connected' })
      return output
    })
    await expect(prepare([selected])).rejects.toThrow(/machine|host|connection|changed/i)
  })

  it('rejects a batch of nine files before starting individual cached jobs', async () => {
    const selected = Array.from({ length: 9 }, (_, index) => attachment(`${index}.txt`, ''))
    await expect(prepare(selected)).rejects.toThrow(/8 files/i)
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('rejects a batch above the combined limit before starting individual cached jobs', async () => {
    const selected = [10, 10, 6].map((megabytes, index) =>
      attachment(`${index}.bin`, Buffer.alloc(megabytes * 1024 * 1024)),
    )
    await expect(prepare(selected)).rejects.toThrow(/25 MB/i)
    expect(transport.execute).not.toHaveBeenCalled()
  })
})
