import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ConversationHistorySnapshot } from '../shared/conversations'

interface PendingWrite {
  serialized: string
  resolve: (() => void)[]
  reject: ((error: unknown) => void)[]
}

function history(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error('Conversation history must be an array.')
  for (const thread of value) {
    if (
      !thread ||
      typeof thread !== 'object' ||
      typeof thread.id !== 'string' ||
      typeof thread.profileId !== 'string' ||
      !['codex', 'claude'].includes(thread.provider) ||
      !Array.isArray(thread.messages)
    )
      throw new Error('Conversation history contains an invalid thread.')
  }
}

/** Serializes atomic writes and replaces queued intermediate checkpoints with the newest one. */
export class ConversationStore {
  private readonly path: string
  private initialized?: Promise<void>
  private serialized: string | null = null
  private pending?: PendingWrite
  private draining?: Promise<void>

  constructor(private readonly directory: string) {
    this.path = join(directory, 'conversations.json')
  }

  async load(): Promise<ConversationHistorySnapshot | null> {
    await this.settled()
    await this.initialize()
    return this.serialized === null ? null : JSON.parse(this.serialized)
  }

  async save(threads: unknown[], savedAt = Date.now()): Promise<void> {
    history(threads)
    if (!Number.isSafeInteger(savedAt) || savedAt < 0)
      throw new Error('Conversation checkpoint has an invalid timestamp.')
    const serialized = JSON.stringify({ version: 1, savedAt, threads })
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024 * 1024)
      throw new Error(
        'Conversation history exceeds the 256 MB checkpoint limit. No history was removed.',
      )
    return new Promise<void>((resolve, reject) => {
      if (this.pending) {
        this.pending.serialized = serialized
        this.pending.resolve.push(resolve)
        this.pending.reject.push(reject)
      } else this.pending = { serialized, resolve: [resolve], reject: [reject] }
      this.startDrain()
    })
  }

  async settled(): Promise<void> {
    // Save callers receive failures. Recovery waits for completion without losing
    // its ability to recover after a disk error.
    while (this.draining) await this.draining
  }

  private initialize(): Promise<void> {
    return (this.initialized ||= (async () => {
      await mkdir(this.directory, { recursive: true })
      let serialized: string
      try {
        serialized = await readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const stored: unknown = JSON.parse(serialized)
      if (Array.isArray(stored)) {
        // Accept an earlier array-only snapshot without throwing away its fields.
        history(stored)
        this.serialized = JSON.stringify({ version: 1, savedAt: 0, threads: stored })
        return
      }
      const snapshot = stored as Partial<ConversationHistorySnapshot> | null
      if (
        !snapshot ||
        snapshot.version !== 1 ||
        !Number.isSafeInteger(snapshot.savedAt) ||
        (snapshot.savedAt as number) < 0
      )
        throw new Error('Conversation history could not be read. The original file was preserved.')
      history(snapshot.threads)
      this.serialized = serialized
    })())
  }

  private startDrain(): void {
    if (this.draining) return
    // Coalesce synchronous IPC bursts before starting disk work.
    this.draining = Promise.resolve()
      .then(async () => {
        while (this.pending) {
          const checkpoint = this.pending
          this.pending = undefined
          try {
            await this.initialize()
            await this.write(checkpoint.serialized)
            this.serialized = checkpoint.serialized
            checkpoint.resolve.forEach((resolve) => resolve())
          } catch (error) {
            checkpoint.reject.forEach((reject) => reject(error))
          }
        }
      })
      .finally(() => {
        this.draining = undefined
        if (this.pending) this.startDrain()
      })
  }

  private async write(serialized: string): Promise<void> {
    const temporary = this.path + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(serialized, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
