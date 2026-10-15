import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileEntryWithStats, Stats } from 'ssh2'
import { LocalFiles } from '../src/main/local-files'

type Callback<T> = (error: Error | null | undefined, value?: T) => void
function call<T>(start: (callback: Callback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    start((error, value) => {
      if (error) reject(error)
      else resolve(value as T)
    })
  })
}

describe('local files', () => {
  let directory: string
  let files: LocalFiles
  let exactName: string
  let filePath: string

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'life-local-files-'))
    files = new LocalFiles()
    exactName = 'notes 空白 $literal `text` ;.txt'
    filePath = join(directory, exactName)
    await fs.writeFile(filePath, 'first\r\nsecond\n🙂')
  })
  afterEach(async () => {
    files.end()
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('resolves a native symlink and preserves exact physical names', async () => {
    const link = join(directory, 'linked file')
    await fs.symlink(exactName, link)
    expect(await call<string>((done) => files.realpath(link, done))).toBe(filePath)
    expect(await call<string>((done) => files.realpath(filePath, done))).toBe(filePath)
  })

  it('returns actual size, mode, ownership, and epoch-second file times', async () => {
    await fs.chmod(filePath, 0o640)
    await fs.utimes(filePath, 1_700_000_000.125, 1_700_000_004.875)
    const native = await fs.stat(filePath)
    const actual = await call<Stats>((done) => files.stat(filePath, done))
    expect(actual).toMatchObject({
      size: native.size,
      mode: native.mode,
      uid: native.uid,
      gid: native.gid,
      atime: Math.floor(native.atimeMs / 1000),
      mtime: Math.floor(native.mtimeMs / 1000),
    })
    expect(actual.isFile()).toBe(true)
    expect(actual.isDirectory()).toBe(false)
    expect(actual.isSymbolicLink()).toBe(false)
    expect(actual.isBlockDevice()).toBe(false)
    expect(actual.isCharacterDevice()).toBe(false)
    expect(actual.isFIFO()).toBe(false)
    expect(actual.isSocket()).toBe(false)
  })

  it('follows a directory symlink for stat but preserves the link in readdir', async () => {
    await fs.mkdir(join(directory, 'real directory'))
    await fs.symlink('real directory', join(directory, 'directory link'))
    await fs.symlink('missing target', join(directory, 'dangling link'))
    const linked = await call<Stats>((done) => files.stat(join(directory, 'directory link'), done))
    expect(linked.isDirectory()).toBe(true)
    expect(linked.isSymbolicLink()).toBe(false)
    const entries = await call<FileEntryWithStats[]>((done) => files.readdir(directory, done))
    expect(entries.map((entry) => entry.filename).sort()).toEqual(
      [exactName, 'real directory', 'directory link', 'dangling link'].sort(),
    )
    expect(entries.find((entry) => entry.filename === exactName)?.attrs.size).toBe(
      Buffer.byteLength('first\r\nsecond\n🙂'),
    )
    expect(entries.find((entry) => entry.filename === 'real directory')?.attrs.isDirectory()).toBe(
      true,
    )
    for (const name of ['directory link', 'dangling link']) {
      const entry = entries.find((entry) => entry.filename === name)!
      expect(entry.attrs.isSymbolicLink()).toBe(true)
      expect(entry.attrs.isDirectory()).toBe(false)
      expect(entry.attrs.size).toBe((await fs.lstat(join(directory, name))).size)
      expect(entry.longname).toBe(name)
    }
  })

  it('lists every entry in a directory larger than the native concurrency bound', async () => {
    await Promise.all(
      Array.from({ length: 79 }, (_, index) =>
        fs.writeFile(join(directory, `file-${index}`), `${index}`),
      ),
    )
    const entries = await call<FileEntryWithStats[]>((done) => files.readdir(directory, done))
    expect(entries).toHaveLength(80)
    expect(new Set(entries.map((entry) => entry.filename)).size).toBe(80)
    expect(entries.find((entry) => entry.filename === 'file-78')?.attrs.size).toBe(2)
  })

  it('returns an empty directory without inventing dot entries', async () => {
    const empty = join(directory, 'empty')
    await fs.mkdir(empty)
    expect(await call<FileEntryWithStats[]>((done) => files.readdir(empty, done))).toEqual([])
  })

  it('preserves native missing-path errors for each callback operation', async () => {
    const missing = join(directory, 'missing')
    for (const start of [
      (done: Callback<unknown>) => files.realpath(missing, done),
      (done: Callback<unknown>) => files.stat(missing, done),
      (done: Callback<unknown>) => files.readdir(missing, done),
    ]) {
      await expect(call(start)).rejects.toMatchObject({ code: 'ENOENT', path: missing })
    }
  })

  it('settles invalid-path exceptions through the asynchronous callback boundary', async () => {
    let synchronous = true
    const result = new Promise<Error | null | undefined>((resolve) => {
      files.stat('invalid\0path', (error) => {
        expect(synchronous).toBe(false)
        resolve(error)
      })
    })
    synchronous = false
    expect(await result).toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('reads exact binary and UTF-8 bytes through a native owned stream', async () => {
    const contents = Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from('\r\n🙂字\n')])
    await fs.writeFile(filePath, contents)
    const stream = files.createReadStream(filePath)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(contents)
    expect(stream.closed).toBe(true)
    files.end()
    expect(stream.destroyed).toBe(true)
  })

  it('propagates the native read-stream error without a false successful end', async () => {
    const stream = files.createReadStream(join(directory, 'missing'))
    let ended = false
    stream.on('end', () => (ended = true))
    const [error] = await once(stream, 'error')
    expect(error).toMatchObject({ code: 'ENOENT' })
    expect(ended).toBe(false)
  })

  it('destroys an outstanding paused stream and closes its native descriptor', async () => {
    await fs.writeFile(filePath, Buffer.alloc(512_000, 42))
    const stream = files.createReadStream(filePath)
    await once(stream, 'open')
    let ended = false
    stream.on('end', () => (ended = true))
    const closed = once(stream, 'close')
    files.end()
    expect(stream.destroyed).toBe(true)
    await closed
    expect(stream.closed).toBe(true)
    expect(ended).toBe(false)
    files.end()
  })

  it('closes a stream even when teardown precedes the native open callback', async () => {
    const stream = files.createReadStream(filePath)
    const closed = once(stream, 'close')
    files.end()
    await closed
    expect(stream.closed).toBe(true)
    expect(stream.destroyed).toBe(true)
  })

  it('rejects all pending successes exactly once when their owner ends', async () => {
    const outcomes: Array<{ error: Error | null | undefined; value?: unknown }> = []
    const settled = Promise.all(
      [
        (done: Callback<unknown>) => files.realpath(filePath, done),
        (done: Callback<unknown>) => files.stat(filePath, done),
        (done: Callback<unknown>) => files.readdir(directory, done),
      ].map(
        (start) =>
          new Promise<void>((resolve) => {
            start((error, value) => {
              outcomes.push({ error, value })
              resolve()
            })
          }),
      ),
    )
    files.end()
    await settled
    // Allow native completion callbacks to arrive after cancellation.
    await fs.readdir(directory)
    await fs.stat(filePath)
    expect(outcomes).toHaveLength(3)
    for (const outcome of outcomes) {
      expect(outcome.error).toMatchObject({ code: 'ERR_LOCAL_FILES_CLOSED' })
      expect(outcome.value).toBeUndefined()
    }
  })

  it('fails future callbacks asynchronously and does not acquire a future stream', async () => {
    files.end()
    let synchronous = true
    const results = [
      (done: Callback<unknown>) => files.realpath(filePath, done),
      (done: Callback<unknown>) => files.stat(filePath, done),
      (done: Callback<unknown>) => files.readdir(directory, done),
    ].map(
      (start) =>
        new Promise<Error | null | undefined>((resolve) => {
          start((error, value) => {
            expect(synchronous).toBe(false)
            expect(value).toBeUndefined()
            resolve(error)
          })
        }),
    )
    synchronous = false
    for (const result of await Promise.all(results)) {
      expect(result).toMatchObject({ code: 'ERR_LOCAL_FILES_CLOSED' })
    }
    expect(() => files.createReadStream(filePath)).toThrow('Local file access is closed')
  })
})
