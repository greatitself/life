import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomizationStore } from '../src/main/customization'
import {
  parseLifeConfig,
  type LifeConfig,
  type LifeConfigSnapshot,
} from '../src/shared/customization'

const stores: CustomizationStore[] = []
const directories: string[] = []
const releases: Array<() => void> = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(stores.splice(0).map((store) => store.closeAndSettle()))
  vi.restoreAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { promise, release }
}

async function fixture(onUpdate: (snapshot: LifeConfigSnapshot) => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'life-customization-settlement-'))
  directories.push(directory)
  const store = new CustomizationStore(directory, onUpdate)
  stores.push(store)
  await store.init()
  return { store, directory }
}

function delayFirstWrite(store: CustomizationStore, rejection?: Error) {
  const entered = barrier()
  const resume = barrier()
  const boundary = store as unknown as { write(config: LifeConfig): Promise<void> }
  const write = boundary.write.bind(store)
  const proposals: LifeConfig[] = []
  vi.spyOn(boundary, 'write').mockImplementation(async (config) => {
    proposals.push(structuredClone(config))
    if (proposals.length === 1) {
      entered.release()
      await resume.promise
      if (rejection) throw rejection
    }
    await write(config)
  })
  return { entered: entered.promise, release: resume.release, proposals }
}

async function savedConfig(store: CustomizationStore) {
  return parseLifeConfig(JSON.parse(await readFile(store.path, 'utf8')))
}

async function reopenedConfig(directory: string) {
  const reopened = new CustomizationStore(directory)
  stores.push(reopened)
  return (await reopened.init()).config
}

describe('customization operation settlement', () => {
  it('closes admissions immediately and waits for every accepted queued write before reopening', async () => {
    const { store, directory } = await fixture()
    const writes = delayFirstWrite(store)
    const applied = Promise.all([
      store.apply({ theme: 'light' }),
      store.apply({ fontSize: 18 }),
      store.apply({ density: 'compact' }),
    ])
    let finished = false
    const closing = store.closeAndSettle().then(() => {
      finished = true
    })

    await writes.entered
    expect(finished).toBe(false)
    expect((await savedConfig(store)).theme).toBe('dark')
    for (const operation of [
      () => store.apply({ sidebarWidth: 300 }),
      () => store.undo(),
      () => store.reset(),
      () => store.reload(),
    ])
      await expect(operation()).rejects.toThrow('closed')

    writes.release()
    await closing
    await applied
    expect(writes.proposals).toHaveLength(3)
    const saved = await savedConfig(store)
    expect(saved).toMatchObject({ theme: 'light', fontSize: 18, density: 'compact' })
    expect(await reopenedConfig(directory)).toEqual(saved)
  })

  it('keeps synchronous close compatible and drains queued writes after an earlier write rejects', async () => {
    const { store, directory } = await fixture()
    const writes = delayFirstWrite(store, new Error('The first settings write failed'))
    const rejected = store.apply({ theme: 'light' }).then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => ({ error }),
    )
    const accepted = store.apply({ fontSize: 19 })
    await writes.entered
    expect(store.close()).toBeUndefined()
    let finished = false
    const settling = store.settled().then(() => {
      finished = true
    })
    expect(finished).toBe(false)
    await expect(store.apply({ theme: 'light' })).rejects.toThrow('closed')

    writes.release()
    await settling
    expect(await rejected).toMatchObject({ error: new Error('The first settings write failed') })
    await accepted
    const saved = await savedConfig(store)
    expect(saved).toMatchObject({ theme: 'dark', fontSize: 19 })
    expect(await reopenedConfig(directory)).toEqual(saved)
  })

  it('settles a rejected final observer callback after the real settings writes have committed', async () => {
    let rejectNotifications = false
    const notifications: Array<Pick<LifeConfig, 'theme' | 'fontSize'>> = []
    const { store, directory } = await fixture((snapshot) => {
      if (!rejectNotifications) return
      notifications.push({ theme: snapshot.config.theme, fontSize: snapshot.config.fontSize })
      throw new Error('The settings caller disappeared after commit')
    })
    rejectNotifications = true
    const writes = delayFirstWrite(store)
    const outcomes = Promise.all(
      [store.apply({ theme: 'light' }), store.apply({ fontSize: 18 })].map((operation) =>
        operation.then(
          (snapshot) => ({ snapshot }),
          (error: unknown) => ({ error }),
        ),
      ),
    )
    let finished = false
    const settling = store.settled().then(() => {
      finished = true
    })
    await writes.entered
    expect(finished).toBe(false)
    writes.release()
    await settling
    expect(await outcomes).toEqual([
      { error: new Error('The settings caller disappeared after commit') },
      { error: new Error('The settings caller disappeared after commit') },
    ])
    expect(notifications).toEqual([
      { theme: 'light', fontSize: 14 },
      { theme: 'light', fontSize: 18 },
    ])
    await store.closeAndSettle()
    const saved = await savedConfig(store)
    expect(saved).toMatchObject({ theme: 'light', fontSize: 18 })
    expect(await reopenedConfig(directory)).toEqual(saved)
  })
})
