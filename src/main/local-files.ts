import * as fs from 'node:fs'
import { posix } from 'node:path'
import type { FileEntryWithStats, Stats } from 'ssh2'

type FileCallback<T> = (error: Error | null | undefined, value?: T) => void

class LocalFileStats implements Stats {
  readonly mode: number
  readonly uid: number
  readonly gid: number
  readonly size: number
  readonly atime: number
  readonly mtime: number

  constructor(value: fs.Stats) {
    this.mode = value.mode
    this.uid = value.uid
    this.gid = value.gid
    this.size = value.size
    // The shared file access boundary uses SFTP's seconds, not Node's Dates.
    this.atime = Math.floor(value.atimeMs / 1000)
    this.mtime = Math.floor(value.mtimeMs / 1000)
  }

  isDirectory() {
    return (this.mode & fs.constants.S_IFMT) === fs.constants.S_IFDIR
  }
  isFile() {
    return (this.mode & fs.constants.S_IFMT) === fs.constants.S_IFREG
  }
  isBlockDevice() {
    return (this.mode & fs.constants.S_IFMT) === fs.constants.S_IFBLK
  }
  isCharacterDevice() {
    return (this.mode & fs.constants.S_IFMT) === fs.constants.S_IFCHR
  }
  isSymbolicLink() {
    return (this.mode & fs.constants.S_IFMT) === fs.constants.S_IFLNK
  }
  isFIFO() {
    return (this.mode & fs.constants.S_IFMT) === fs.constants.S_IFIFO
  }
  isSocket() {
    return (this.mode & fs.constants.S_IFMT) === fs.constants.S_IFSOCK
  }
}

function closedError() {
  return Object.assign(new Error('Local file access is closed'), {
    code: 'ERR_LOCAL_FILES_CLOSED',
  })
}

/** Node's callback boundary for the file operations shared with SSH connections. */
export class LocalFiles {
  private closed = false
  private readonly pending = new Set<() => void>()
  private readonly streams = new Set<fs.ReadStream>()

  private request<T>(callback: FileCallback<T>, start: (done: FileCallback<T>) => void) {
    if (this.closed) {
      queueMicrotask(() => callback(closedError()))
      return
    }
    let settled = false
    const cancel = () => done(closedError())
    const done: FileCallback<T> = (error, value) => {
      if (settled) return
      settled = true
      this.pending.delete(cancel)
      if (this.closed) callback(closedError())
      else if (error) callback(error)
      else callback(error, value)
    }
    this.pending.add(cancel)
    try {
      start(done)
    } catch (error) {
      // Invalid paths can throw synchronously; keep the callback contract async.
      queueMicrotask(() => done(error instanceof Error ? error : new Error(String(error))))
    }
  }

  realpath(path: string, callback: FileCallback<string>): void {
    this.request(callback, (done) => fs.realpath(path, done))
  }

  stat(path: string, callback: FileCallback<Stats>): void {
    this.request(callback, (done) => {
      fs.stat(path, (error, value) => done(error, error ? undefined : new LocalFileStats(value)))
    })
  }

  readdir(path: string, callback: FileCallback<FileEntryWithStats[]>): void {
    this.request(callback, (done) => {
      fs.readdir(path, (error, names) => {
        if (this.closed) return done(closedError())
        if (error) return done(error)
        if (names.length === 0) return done(null, [])
        const entries = new Array<FileEntryWithStats>(names.length)
        let next = 0
        let completed = 0
        let failed = false
        const readNext = () => {
          if (failed || this.closed || next === names.length) return
          const index = next++
          const filename = names[index]
          // Directory entries retain their symlink identity, just like SFTP.
          fs.lstat(posix.join(path, filename), (error, value) => {
            if (failed || this.closed) return
            if (error) {
              failed = true
              done(error)
              return
            }
            entries[index] = { filename, longname: filename, attrs: new LocalFileStats(value) }
            if (++completed === names.length) done(null, entries)
            else readNext()
          })
        }
        // Bound native work for very large directories rather than opening one
        // filesystem request per entry simultaneously.
        for (let index = 0; index < Math.min(names.length, 32); index++) readNext()
      })
    })
  }

  createReadStream(path: string): fs.ReadStream {
    if (this.closed) throw closedError()
    const stream = fs.createReadStream(path)
    this.streams.add(stream)
    stream.once('close', () => this.streams.delete(stream))
    return stream
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    for (const cancel of this.pending) queueMicrotask(cancel)
    for (const stream of this.streams) stream.destroy()
  }
}
