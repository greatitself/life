import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConnectionProfile } from '../shared/types'
import { profileSchema } from '../shared/validation'

interface Data {
  profiles: ConnectionProfile[]
  knownHosts: Record<string, string>
}
export class Store {
  private data: Data = { profiles: [], knownHosts: {} }
  private writes = Promise.resolve()
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
    this.data.profiles = [...this.data.profiles.filter((p) => p.id !== clean.id), clean]
    return this.flush()
  }
  remove(id: string) {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id)
    return this.flush()
  }
  hostKey(host: string) {
    return Object.hasOwn(this.data.knownHosts, host) ? this.data.knownHosts[host] : undefined
  }
  trust(host: string, fingerprint: string) {
    this.data.knownHosts[host] = fingerprint
    return this.flush()
  }
  private flush() {
    const contents = JSON.stringify(this.data, null, 2)
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        const path = join(this.directory, 'connections.json')
        await writeFile(path + '.tmp', contents, { mode: 0o600 })
        await rename(path + '.tmp', path)
      })
    this.writes = write
    return write
  }
}
