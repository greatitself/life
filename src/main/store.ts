import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConnectionProfile } from '../shared/types'
import { profileSchema } from '../shared/validation'

interface Data {
  profiles: ConnectionProfile[]
  knownHosts: Record<string, string>
}
export class Store {
  private data: Data = { profiles: [], knownHosts: {} }
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true })
    try {
      const raw = JSON.parse(await readFile(join(this.directory, 'connections.json'), 'utf8'))
      this.data.profiles = (raw.profiles ?? []).flatMap((p: unknown) => {
        const parsed = profileSchema.safeParse(p)
        return parsed.success ? [parsed.data] : []
      })
      if (raw.knownHosts && typeof raw.knownHosts === 'object' && !Array.isArray(raw.knownHosts))
        this.data.knownHosts = Object.fromEntries(
          Object.entries(raw.knownHosts).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  list() {
    return this.data.profiles
  }
  save(profile: ConnectionProfile) {
    const clean = profileSchema.parse(profile)
    return this.queue(async () => {
      await this.commit({
        ...this.data,
        profiles: [...this.data.profiles.filter((p) => p.id !== clean.id), clean],
      })
    })
  }
  /** Publish a selected project only while the renderer that requested it still owns it. */
  saveIfCurrent(profile: ConnectionProfile, current: () => boolean, onCommit: () => void) {
    const clean = profileSchema.parse(profile)
    return this.queue(async () => {
      if (!current()) return false
      const previous = this.data
      const next = {
        ...previous,
        profiles: [...previous.profiles.filter((p) => p.id !== clean.id), clean],
      }
      const path = join(this.directory, 'connections.json')
      const temporary = path + '.tmp'
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      if (!current()) {
        await rm(temporary, { force: true })
        return false
      }
      await rename(temporary, path)
      if (!current()) {
        // Cancellation can arrive while the atomic rename is in flight. Restore
        // the last committed snapshot before releasing the serialized write lock.
        await this.write(previous)
        return false
      }
      this.data = next
      onCommit()
      return true
    })
  }
  remove(id: string) {
    return this.queue(async () => {
      await this.commit({
        ...this.data,
        profiles: this.data.profiles.filter((p) => p.id !== id),
      })
    })
  }
  hostKey(host: string) {
    return Object.hasOwn(this.data.knownHosts, host) ? this.data.knownHosts[host] : undefined
  }
  trust(host: string, fingerprint: string) {
    return this.queue(async () => {
      await this.commit({
        ...this.data,
        knownHosts: { ...this.data.knownHosts, [host]: fingerprint },
      })
    })
  }
  async settled() {
    // Original mutation callers receive write failures; recovery only needs a
    // completion barrier and must remain available after an earlier failed save.
    await this.writes.catch(() => {})
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const write = this.writes.catch(() => {}).then(operation)
    this.writes = write
    return write
  }
  private async commit(next: Data) {
    await this.write(next)
    this.data = next
  }
  private async write(data: Data) {
    const path = join(this.directory, 'connections.json')
    await writeFile(path + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(path + '.tmp', path)
  }
}
