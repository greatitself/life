import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Kept outside workspace customization so resetting Studio never changes update consent. */
export class UpdatePreferences {
  private automaticDownloads = true
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async init(): Promise<boolean> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'))
      // Invalid settings must never silently re-enable downloads that were disabled.
      this.automaticDownloads = saved?.version === 1 && saved.autoDownload === true
    } catch (error) {
      this.automaticDownloads = (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    return this.automaticDownloads
  }

  set(autoDownload: boolean): Promise<boolean> {
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        const temporary = this.path + '.tmp'
        await writeFile(temporary, JSON.stringify({ version: 1, autoDownload }) + '\n', {
          mode: 0o600,
        })
        await rename(temporary, this.path)
        this.automaticDownloads = autoDownload
        return autoDownload
      })
    this.writes = write
    return write
  }
}
