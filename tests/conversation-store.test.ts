import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../src/main/conversation-store'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let directory: string

function thread(text = 'Exact transcript\n  preserved  \n') {
  return {
    id: 'thread',
    profileId: 'machine',
    provider: 'codex',
    messages: [{ id: 'message', role: 'assistant', text, turn: 1 }],
    customFutureField: { retained: true },
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(async () => {
  vi.mocked(fs.rename).mockImplementation(original.rename)
  directory = await fs.mkdtemp(join(tmpdir(), 'life-conversation-store-'))
  vi.clearAllMocks()
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

describe('durable conversation checkpoints', () => {
  it('distinguishes a missing store from an intentional empty history', async () => {
    const store = new ConversationStore(directory)
    await expect(store.load()).resolves.toBeNull()
    await store.save([], 100)
    await expect(new ConversationStore(directory).load()).resolves.toEqual({
      version: 1,
      savedAt: 100,
      threads: [],
    })
  })

  it('retains exact content and optional fields across a restart with private file permissions', async () => {
    const store = new ConversationStore(directory)
    const threads = [thread()]
    await store.save(threads, 200)
    threads[0].messages[0].text = 'mutated after request'
    const reloaded = await new ConversationStore(directory).load()
    expect(reloaded).toEqual({ version: 1, savedAt: 200, threads: [thread()] })
    reloaded!.threads.length = 0
    expect((await store.load())?.threads).toEqual([thread()])
    if (process.platform !== 'win32')
      expect((await fs.stat(join(directory, 'conversations.json'))).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(directory)).toEqual(['conversations.json'])
  })

  it('coalesces a hundred queued streaming snapshots while retaining ordering at the active commit', async () => {
    const store = new ConversationStore(directory)
    const started = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      return original.rename(...args)
    })
    const first = store.save([thread('first')], 1)
    await started.promise
    const queued = Array.from({ length: 100 }, (_, index) =>
      store.save([thread(`snapshot-${index}`)], index + 2),
    )
    let settled = false
    const barrier = store.settled().then(() => (settled = true))
    const loading = store.load()
    expect(settled).toBe(false)
    release.resolve()
    await Promise.all([first, ...queued, barrier])
    expect(fs.rename).toHaveBeenCalledTimes(2)
    expect((await loading)?.threads).toEqual([thread('snapshot-99')])
    expect((await new ConversationStore(directory).load())?.savedAt).toBe(101)
  })

  it('reports a failed atomic replacement, retains the committed snapshot and permits a later save', async () => {
    const store = new ConversationStore(directory)
    await store.save([thread('committed')], 100)
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.save([thread('failed')], 200)).rejects.toThrow('disk full')
    await expect(store.settled()).resolves.toBeUndefined()
    expect((await store.load())?.threads).toEqual([thread('committed')])
    expect((await new ConversationStore(directory).load())?.threads).toEqual([thread('committed')])
    expect(await fs.readdir(directory)).toEqual(['conversations.json'])
    await store.save([thread('recovered')], 300)
    expect((await new ConversationStore(directory).load())?.threads).toEqual([thread('recovered')])
  })

  it('preserves a corrupt original instead of replacing it with an empty renderer cache', async () => {
    const path = join(directory, 'conversations.json')
    await fs.writeFile(path, '{ original damaged history')
    const store = new ConversationStore(directory)
    await expect(store.load()).rejects.toThrow()
    await expect(store.save([], 100)).rejects.toThrow()
    expect(await fs.readFile(path, 'utf8')).toBe('{ original damaged history')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('accepts prior array-only snapshots and rejects invalid history without modifying the original', async () => {
    const path = join(directory, 'conversations.json')
    await fs.writeFile(path, JSON.stringify([thread()]))
    const store = new ConversationStore(directory)
    expect(await store.load()).toEqual({ version: 1, savedAt: 0, threads: [thread()] })
    await expect(store.save([{}], 100)).rejects.toThrow('invalid thread')
    await expect(store.save([], -1)).rejects.toThrow('invalid timestamp')
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual([thread()])
  })
})
