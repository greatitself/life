import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { BuiltinExtensionDefinition } from '../shared/builtin-extensions'
import type { SourceExtensionSummary } from '../shared/source-extensions'

const choiceSchema = z.object({ enabled: z.boolean(), deleted: z.boolean() }).strict()
const savedSchema = z
  .object({
    format: z.literal(1),
    revision: z.number().int().nonnegative(),
    choices: z.record(z.string().min(1).max(160), choiceSchema),
  })
  .strict()
  .refine((value) => Object.keys(value.choices).length <= 300, 'Too many built-in feature choices')
type SavedChoices = z.infer<typeof savedSchema>

/** Feature removal never deletes project files, conversations, or the installed rescue interface. */
export class BuiltinExtensionStore {
  private state: SavedChoices = { format: 1, revision: 0, choices: {} }
  private operations: Promise<unknown> = Promise.resolve()
  error?: string

  constructor(
    private directory: string,
    private catalog: readonly BuiltinExtensionDefinition[],
  ) {
    if (new Set(catalog.map((extension) => extension.id)).size !== catalog.length)
      throw new Error('The built-in extension catalog contains duplicate IDs.')
  }

  private get path() {
    return join(this.directory, 'built-in-extensions.json')
  }

  get revision() {
    return this.state.revision
  }

  has(id: string) {
    return this.catalog.some((extension) => extension.id === id)
  }

  async init() {
    if (!this.catalog.length) return
    try {
      this.state = savedSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Do not overwrite unrecognized choices. Keep optional features off until
        // the user repairs the file or deliberately changes a feature choice.
        this.error =
          'Saved built-in extension choices could not be read. Optional features are paused; your saved file is preserved.'
        this.state.choices = Object.fromEntries(
          this.catalog.map((extension) => [extension.id, { enabled: false, deleted: false }]),
        )
      }
    }
  }

  list(): SourceExtensionSummary[] {
    return this.catalog.map((extension) => {
      const choice = this.state.choices[extension.id]
      return {
        id: extension.id,
        originalId: extension.originalId,
        name: extension.name,
        description: extension.description,
        version: extension.version,
        createdAt: extension.createdAt,
        updatedAt: extension.updatedAt,
        enabled: !choice || (choice.enabled && !choice.deleted),
        builtIn: true,
        ...(choice?.deleted ? { deleted: true as const } : {}),
        files: [...extension.files],
        dependencies: {},
        features: [...extension.features],
        effect: extension.effect,
      }
    })
  }

  setEnabled(id: string, enabled: boolean) {
    return this.change(id, { enabled, deleted: false })
  }

  remove(id: string) {
    return this.change(id, { enabled: false, deleted: true })
  }

  private change(id: string, choice: z.infer<typeof choiceSchema>) {
    if (!this.has(id)) return Promise.reject(new Error(`Built-in extension does not exist: ${id}`))
    const operation = this.operations.then(async () => {
      const previous = this.state.choices[id] || { enabled: true, deleted: false }
      if (previous.enabled === choice.enabled && previous.deleted === choice.deleted && !this.error)
        return
      await mkdir(this.directory, { recursive: true })
      // Record a private recovery copy before deletion or replacing unreadable choices.
      // It contains feature choices only, never project data or provider credentials.
      if (choice.deleted || this.error) {
        let originalFile: string | undefined
        try {
          originalFile = await readFile(this.path, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await this.atomicWrite(
          join(this.directory, 'built-in-extension-recovery.json'),
          JSON.stringify({
            format: 1,
            savedAt: new Date().toISOString(),
            extensionId: id,
            choices: this.state,
            ...(originalFile === undefined ? {} : { originalFile }),
          }),
        )
      }
      const next = savedSchema.parse({
        ...this.state,
        revision: this.state.revision + 1,
        choices: { ...this.state.choices, [id]: choice },
      })
      await this.atomicWrite(this.path, JSON.stringify(next))
      this.state = next
      this.error = undefined
    })
    this.operations = operation.catch(() => {})
    return operation
  }

  private async atomicWrite(path: string, content: string) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
