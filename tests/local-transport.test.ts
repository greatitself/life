import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, fstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClientChannel } from 'ssh2'
import { LocalClient, localShell, type LocalTransportOptions } from '../src/main/local-transport'
import { shellQuote } from '../src/shared/validation'

let directory: string
const clients = new Set<LocalClient>()
const cleanupPids = new Set<number>()
let sequence = 0

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-local-transport-'))
})

afterEach(async () => {
  await Promise.all(
    [...clients].map(
      (client) =>
        new Promise<void>((resolve) => {
          client.once('close', resolve)
          client.end()
        }),
    ),
  )
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  cleanupPids.clear()
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function client(options: LocalTransportOptions = {}) {
  const value = new LocalClient({ shell: '/bin/sh', ...options })
  clients.add(value)
  value.once('close', () => clients.delete(value))
  return value
}

function open(value: LocalClient, command: string, pty?: { cols: number; rows: number }) {
  return new Promise<ClientChannel>((resolve, reject) => {
    value.exec(command, pty ? { pty } : {}, (error, channel) => {
      if (error) reject(error)
      else if (channel) resolve(channel)
      else reject(new Error('Missing local channel'))
    })
  })
}

function node(code: string) {
  return `exec ${shellQuote(process.execPath)} -e ${shellQuote(code)}`
}

function collect(channel: ClientChannel) {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const errors: Error[] = []
  const events: string[] = []
  channel.on('data', (bytes: Buffer) => {
    expect(Buffer.isBuffer(bytes)).toBe(true)
    stdout.push(bytes)
  })
  channel.stderr.on('data', (bytes: Buffer) => stderr.push(bytes))
  channel.on('error', (error: Error) => errors.push(error))
  channel.on('exit', () => events.push('exit'))
  const closed = new Promise<{ code: number | null; signal?: string }>((resolve) => {
    channel.once('close', (code: number | null, signal?: string) => {
      events.push('close')
      resolve({ code, signal })
    })
  })
  return {
    stdout,
    stderr,
    errors,
    events,
    closed,
    text: () => Buffer.concat(stdout).toString('utf8'),
  }
}

async function running(pid: number) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const state = await readFile(`/proc/${pid}/stat`, 'utf8')
      return !state.slice(state.lastIndexOf(')') + 2).startsWith('Z')
    }
    return true
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

const until = (predicate: () => unknown | Promise<unknown>) =>
  vi.waitFor(async () => expect(await predicate()).toBeTruthy(), {
    timeout: 5000,
    interval: 10,
  })

describe.skipIf(process.platform === 'win32')('native local transport', () => {
  it('adopts exec asynchronously and preserves stdin, stderr, exit status, and stream aliases', async () => {
    const value = client()
    let synchronous = true
    const opening = new Promise<ClientChannel>((resolve, reject) => {
      value.exec(
        node(
          `const parts=[];process.stdin.on('data',b=>parts.push(b));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(parts));process.stderr.write('actual stderr');process.exitCode=7})`,
        ),
        {},
        (error, channel) => {
          expect(synchronous).toBe(false)
          if (error) reject(error)
          else resolve(channel!)
        },
      )
    })
    synchronous = false
    const channel = await opening
    expect(channel.stdin).toBe(channel)
    expect(channel.stdout).toBe(channel)
    expect(channel.server).toBe(false)
    expect(channel.type).toBe('session')
    const result = collect(channel)
    const input = '  exact input 👋\r\n\n$HOME `literal`\n'
    channel.end(input)
    expect(await result.closed).toEqual({ code: 7, signal: undefined })
    expect(result.text()).toBe(input)
    expect(Buffer.concat(result.stderr).toString()).toBe('actual stderr')
    expect(result.events).toEqual(['exit', 'close'])
    expect(result.errors).toEqual([])
  })

  it('keeps raw UTF8 byte fragments exact on both pipe output lanes', async () => {
    const bytes = Buffer.from('α 👋 終')
    const channel = await open(
      client(),
      node(
        `const b=Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64');let i=0;const next=()=>{if(i===b.length){process.exitCode=0;return}process.stdout.write(b.subarray(i,i+1));process.stderr.write(b.subarray(i,i+1));i++;setTimeout(next,2)};next()`,
      ),
    )
    const result = collect(channel)
    await result.closed
    expect(Buffer.concat(result.stdout)).toEqual(bytes)
    expect(Buffer.concat(result.stderr)).toEqual(bytes)
    expect(result.errors).toEqual([])
  })

  it('preserves large valid pipe input and explicit undefined-encoding write callbacks', async () => {
    const bytes = Buffer.from('漢\u0000👋'.repeat(600000))
    expect(bytes.length).toBeGreaterThan(4_000_000)
    const channel = await open(
      client(),
      node(
        "const hash=require('node:crypto').createHash('sha256');process.stdin.on('data',b=>hash.update(b));process.stdin.on('end',()=>process.stdout.write(hash.digest('hex')))",
      ),
    )
    const result = collect(channel)
    let acknowledged = false
    const writeWithDefaultEncoding = channel.write.bind(channel) as (
      chunk: Buffer,
      encoding: undefined,
      callback: (error?: Error | null) => void,
    ) => boolean
    await new Promise<void>((resolve, reject) =>
      writeWithDefaultEncoding(bytes, undefined, (error) => {
        acknowledged = true
        error ? reject(error) : resolve()
      }),
    )
    channel.end()
    await result.closed
    const { createHash } = await import('node:crypto')
    expect(result.text()).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(acknowledged).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('retains buffered stderr and defers natural close until the consumer drains it', async () => {
    const channel = await open(client(), 'printf stdout; printf stderr >&2; exit 0')
    const output: Buffer[] = []
    channel.on('data', (bytes: Buffer) => output.push(bytes))
    let didClose = false
    const closing = new Promise<number>((resolve) =>
      channel.once('close', (code: number) => {
        didClose = true
        resolve(code)
      }),
    )
    await delay(50)
    expect(didClose).toBe(false)
    const stderr: Buffer[] = []
    channel.stderr.on('data', (bytes: Buffer) => stderr.push(bytes))
    const code = await closing
    expect(code).toBe(0)
    expect(Buffer.concat(output).toString()).toBe('stdout')
    expect(Buffer.concat(stderr).toString()).toBe('stderr')
  })

  it('bounds both unread pipe lanes and later drains every admitted byte', async () => {
    const size = 2 * 1024 * 1024
    const channel = await open(
      client(),
      node(
        `process.stdout.write(Buffer.alloc(${size},'o'));process.stderr.write(Buffer.alloc(${size},'e'))`,
      ),
    )
    await until(() => channel.readableLength >= 65536 && channel.stderr.readableLength >= 65536)
    await delay(60)
    expect(channel.readableLength).toBeLessThanOrEqual(131072)
    expect(channel.stderr.readableLength).toBeLessThanOrEqual(131072)
    const result = collect(channel)
    expect((await result.closed).code).toBe(0)
    expect(Buffer.concat(result.stdout).equals(Buffer.alloc(size, 'o'))).toBe(true)
    expect(Buffer.concat(result.stderr).equals(Buffer.alloc(size, 'e'))).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('preserves exact supplied environment values, absence, and shell without changing process.env', async () => {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      RELAY_TEST_HOME: directory,
      SHELL: '/does/not/exist',
      LOCAL_SENTINEL: 'exact 👋 $literal',
      LOCAL_ABSENT: undefined,
      life_local_fd_directory: 'preserved directory 👋\n$literal',
      life_local_fd_path: '',
      life_local_fd_number: 'preserved number `literal`',
    }
    const inheritedHome = process.env.HOME
    const inheritedCodex = process.env.CODEX_HOME
    const value = client({ env })
    const command = node(
      `process.stdout.write(JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME,shell:process.env.SHELL,sentinel:process.env.LOCAL_SENTINEL,absent:Object.hasOwn(process.env,'LOCAL_ABSENT'),privateDirectory:process.env.life_local_fd_directory,privatePath:process.env.life_local_fd_path,privateNumber:process.env.life_local_fd_number}))`,
    )
    for (const pty of [undefined, { cols: 80, rows: 24 }]) {
      const result = collect(await open(value, command, pty))
      await result.closed
      expect(JSON.parse(result.text())).toEqual({
        home: env.HOME,
        codex: env.CODEX_HOME,
        shell: '/bin/sh',
        sentinel: env.LOCAL_SENTINEL,
        absent: false,
        privateDirectory: env.life_local_fd_directory,
        privatePath: env.life_local_fd_path,
        privateNumber: env.life_local_fd_number,
      })
    }
    expect(env.SHELL).toBe('/does/not/exist')
    expect(process.env.HOME).toBe(inheritedHome)
    expect(process.env.CODEX_HOME).toBe(inheritedCodex)
  })

  it('runs the selected Bash startup environment once for each local launch path', async () => {
    const startup = join(directory, `startup-${++sequence}.sh`)
    const log = join(directory, `startup-${sequence}.log`)
    await writeFile(startup, 'printf "started\\n" >> "$LOCAL_STARTUP_LOG"\n')
    const value = client({
      shell: '/bin/bash',
      env: { ...process.env, BASH_ENV: startup, LOCAL_STARTUP_LOG: log },
    })
    for (const pty of [undefined, { cols: 80, rows: 24 }]) {
      const result = collect(await open(value, node('process.stdout.write("started")'), pty))
      expect((await result.closed).code).toBe(0)
      expect(result.text()).toBe('started')
      expect(result.errors).toEqual([])
    }
    expect(await readFile(log, 'utf8')).toBe('started\nstarted\n')
  })

  it.skipIf(process.platform !== 'linux')(
    'closes inherited non-CLOEXEC native descriptors before both local launch paths',
    async () => {
      const load = createRequire(__filename)
      const utilities = load('node-pty/lib/utils') as {
        loadNativeModule(name: string): {
          module: { open(cols: number, rows: number): { master: number; slave: number } }
        }
      }
      const descriptors = utilities.loadNativeModule('pty').module.open(80, 24)
      try {
        // Native openpty does not mark the descriptor CLOEXEC. This makes the
        // baseline actually reproduce inheritance, rather than mocking an FD.
        const info = await readFile(`/proc/self/fdinfo/${descriptors.slave}`, 'utf8')
        const flags = Number.parseInt(info.match(/^flags:\s+([0-7]+)$/m)![1], 8)
        expect(flags & 0o2000000).toBe(0)
        expect(descriptors.slave).toBeGreaterThan(9)
        const stat = fstatSync(descriptors.slave)
        const identity = { dev: stat.dev, ino: stat.ino, rdev: stat.rdev }
        const code = `const fs=require('node:fs');const expected=${JSON.stringify(identity)};const inherited=fs.readdirSync('/proc/self/fd').some(name=>{if(!/^[0-9]+$/.test(name)||Number(name)<3)return false;try{const stat=fs.fstatSync(Number(name));return stat.dev===expected.dev&&stat.ino===expected.ino&&stat.rdev===expected.rdev}catch{return false}});process.stdout.write(JSON.stringify({inherited}))`
        const native = load('node-pty') as typeof import('node-pty')
        const baseline = native.spawn('/bin/sh', ['-c', node(code)], {
          cols: 80,
          rows: 24,
          encoding: null,
          env: { ...process.env },
        })
        const baselineOutput: Buffer[] = []
        baseline.onData((value) =>
          baselineOutput.push(Buffer.isBuffer(value) ? value : Buffer.from(value)),
        )
        const baselineCode = await new Promise<number>((resolve) =>
          baseline.onExit(({ exitCode }) => resolve(exitCode)),
        )
        expect(baselineCode).toBe(0)
        expect(JSON.parse(Buffer.concat(baselineOutput).toString())).toEqual({ inherited: true })
        const value = client()
        for (const pty of [undefined, { cols: 80, rows: 24 }]) {
          const result = collect(await open(value, node(code), pty))
          expect((await result.closed).code).toBe(0)
          expect(JSON.parse(result.text())).toEqual({ inherited: false })
          expect(result.errors).toEqual([])
          // Closing the child copy must never release the parent's descriptor.
          expect(fstatSync(descriptors.slave).ino).toBe(stat.ino)
        }
      } finally {
        closeSync(descriptors.master)
        closeSync(descriptors.slave)
      }
    },
  )

  it('rejects invalid explicit shells and safely falls back from an invalid inherited shell', async () => {
    expect(() => new LocalClient({ shell: 'relative-shell' })).toThrow('absolute path')
    expect(localShell({ env: { SHELL: '/missing-life-local-shell' } })).toBe('/bin/sh')
    const shell = join(directory, 'configured shell')
    await writeFile(shell, '#!/bin/sh\nexec /bin/sh "$@"\n')
    await chmod(shell, 0o700)
    expect(localShell({ shell })).toBe(shell)
    const result = collect(await open(client({ shell }), 'printf "$SHELL"'))
    await result.closed
    expect(result.text()).toBe(shell)
  })

  it('discards late pipe and file acknowledgements after client teardown', async () => {
    const value = client()
    const opening = open(value, node('setInterval(()=>{},1000)'))
    const files = new Promise<void>((resolve, reject) =>
      value.sftp((error, files) => (error ? reject(error) : resolve(files as unknown as void))),
    )
    const rejectedExec = expect(opening).rejects.toThrow('disconnected')
    const rejectedFiles = expect(files).rejects.toThrow('disconnected')
    value.end()
    await rejectedExec
    await rejectedFiles
    await expect(open(value, 'printf never')).rejects.toThrow('disconnected')
  })

  it('ends owned native file streams and rejects subsequent file operations', async () => {
    const value = client()
    const files = await new Promise<NonNullable<Parameters<Parameters<LocalClient['sftp']>[0]>[1]>>(
      (resolve, reject) => value.sftp((error, files) => (error ? reject(error) : resolve(files!))),
    )
    const file = join(directory, `stream-${++sequence}`)
    await writeFile(file, Buffer.alloc(1024 * 1024, 'x'))
    const stream = files.createReadStream(file)
    const closed = new Promise<void>((resolve) => stream.once('close', resolve))
    value.end()
    await closed
    expect(stream.destroyed).toBe(true)
    await expect(
      new Promise((resolve, reject) =>
        files.stat(file, (error, stat) => (error ? reject(error) : resolve(stat))),
      ),
    ).rejects.toThrow('closed')
  })

  it('terminates same-group descendants that ignore TERM before acknowledging close', async () => {
    const file = join(directory, `group-${++sequence}.json`)
    const childCode = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"
    const code = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,c.pid])));setInterval(()=>{},1000)`
    const channel = await open(client(), node(code))
    const result = collect(channel)
    await until(() => existsSync(file))
    const pids: number[] = JSON.parse(await readFile(file, 'utf8'))
    pids.forEach((pid) => cleanupPids.add(pid))
    const start = Date.now()
    channel.close()
    await result.closed
    expect(Date.now() - start).toBeGreaterThanOrEqual(200)
    await until(async () => (await Promise.all(pids.map(running))).every((active) => !active))
  })

  it('does not terminate a detached durable process after its launch command naturally completes', async () => {
    const childCode = 'setInterval(()=>{},1000)'
    const channel = await open(
      client(),
      node(
        `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(String(c.pid))`,
      ),
    )
    const result = collect(channel)
    await result.closed
    const pid = Number(result.text())
    cleanupPids.add(pid)
    expect(await running(pid)).toBe(true)
    channel.close()
    await delay(350)
    expect(await running(pid)).toBe(true)
  })

  it('reports actual POSIX signal exits and validates signal names', async () => {
    for (const pty of [undefined, { cols: 80, rows: 24 }]) {
      const channel = await open(
        client(),
        node("process.stdout.write('ready');setInterval(()=>{},1000)"),
        pty,
      )
      const result = collect(channel)
      await until(() => result.text().includes('ready'))
      expect(() => channel.signal('NOT_A_SIGNAL')).toThrow('Unknown process signal')
      channel.signal('TERM')
      expect(await result.closed).toEqual({ code: null, signal: 'TERM' })
      expect(result.events).toEqual(['exit', 'close'])
    }
  })

  it('opens a genuine terminal and applies input and kernel window changes', async () => {
    const channel = await open(
      client(),
      'stty -echo; test -t 0 && test -t 1 && printf "READY "; stty size; IFS= read -r line; printf "INPUT:%s " "$line"; stty size; exit 9',
      { cols: 91, rows: 23 },
    )
    const result = collect(channel)
    await until(() => result.text().includes('READY 23 91'))
    channel.setWindow(47, 132, 0, 0)
    channel.write('exact 👋 payload\n')
    expect((await result.closed).code).toBe(9)
    expect(result.text()).toContain('INPUT:exact 👋 payload 47 132')
    expect(result.stderr).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('preserves split UTF8 binary input/output on a raw native terminal', async () => {
    const bytes = Buffer.from('é 👋 終')
    const code = `process.stdin.setRawMode(true);let size=0;process.stdout.write('READY');process.stdin.on('data',b=>{size+=b.length;process.stdout.write(b);if(size>=${bytes.length}){process.stdin.pause();process.exitCode=0;process.stdin.destroy()}})`
    const channel = await open(client(), `stty raw -echo; ${node(code)}`, {
      cols: 80,
      rows: 24,
    })
    const result = collect(channel)
    await until(() => result.text() === 'READY')
    for (const byte of bytes) channel.write(Buffer.from([byte]))
    expect((await result.closed).code).toBe(0)
    expect(Buffer.concat(result.stdout)).toEqual(Buffer.concat([Buffer.from('READY'), bytes]))
    expect(result.errors).toEqual([])
  })

  it('keeps canonical Unicode erase enabled while delivering raw bytes', async () => {
    const code =
      "process.stdout.write('READY');process.stdin.once('data',b=>{process.stdout.write('HEX:'+b.toString('hex'));process.stdin.destroy()})"
    const channel = await open(client(), `stty -echo; ${node(code)}`, {
      cols: 80,
      rows: 24,
    })
    const result = collect(channel)
    await until(() => result.text() === 'READY')
    channel.write(Buffer.from('é\u007f\n'))
    await result.closed
    expect(result.text()).toBe('READYHEX:0a')
  })

  it('retains the complete terminal tail after a consumer pause longer than node-pty exit timeout', async () => {
    const size = 72 * 1024
    const channel = await open(
      client(),
      `stty raw -echo; ${node(`process.stdout.write(Buffer.alloc(${size},'x'))`)}`,
      { cols: 80, rows: 24 },
    )
    await until(() => channel.readableLength >= 65536)
    await delay(700)
    expect(channel.readableLength).toBeLessThanOrEqual(131072)
    const result = collect(channel)
    expect((await result.closed).code).toBe(0)
    expect(Buffer.concat(result.stdout).length).toBe(size)
    expect(Buffer.concat(result.stdout).equals(Buffer.alloc(size, 'x'))).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('bounds terminal output and eventually drains a large producer without truncation', async () => {
    const size = 2 * 1024 * 1024
    const value = client()
    for (let attempt = 0; attempt < 6; attempt++) {
      const flushed = join(directory, `output-flushed-${++sequence}`)
      const code = `process.stdout.write(Buffer.alloc(${size},'x'),error=>{if(error)process.exitCode=31;else require('node:fs').writeFileSync(${JSON.stringify(flushed)},String(${size}))})`
      const channel = await open(value, `stty raw -echo; ${node(code)}`, {
        cols: 80,
        rows: 24,
      })
      await until(() => channel.readableLength >= 65536)
      await delay(60)
      expect(channel.readableLength).toBeLessThanOrEqual(131072)
      const result = collect(channel)
      expect((await result.closed).code).toBe(0)
      expect(await readFile(flushed, 'utf8')).toBe(String(size))
      expect(Buffer.concat(result.stdout).length).toBe(size)
      expect(Buffer.concat(result.stdout).equals(Buffer.alloc(size, 'x'))).toBe(true)
      expect(result.errors).toEqual([])
    }
  })

  it('keeps terminal writes pending while the native peer is not reading', async () => {
    const channel = await open(
      client(),
      `stty raw -echo; ${node("process.stdout.write('READY');setInterval(()=>{},1000)")}`,
      { cols: 80, rows: 24 },
    )
    const result = collect(channel)
    await until(() => result.text() === 'READY')
    let completed = false
    let writeError: Error | null | undefined
    expect(
      channel.write(Buffer.alloc(65536), (error) => {
        completed = true
        writeError = error
      }),
    ).toBe(false)
    await delay(100)
    expect(completed).toBe(false)
    expect(channel.writableLength).toBe(65536)
    channel.close()
    await result.closed
    expect(completed).toBe(true)
    expect(writeError?.message).toContain('closed')
  })

  it('rejects excessive queued terminal pastes with visible error and owned teardown', async () => {
    const channel = await open(
      client(),
      `stty raw -echo; ${node("process.stdout.write('READY');setInterval(()=>{},1000)")}`,
      { cols: 80, rows: 24 },
    )
    const result = collect(channel)
    await until(() => result.text() === 'READY')
    for (let index = 0; index < 64 && !channel.destroyed; index++)
      channel.write(Buffer.alloc(65536))
    expect(channel.writableLength).toBeLessThanOrEqual(4_000_000)
    await result.closed
    expect(result.errors.some((error) => error.message.includes('exceeds 4 MB'))).toBe(true)
  })

  it('applies the terminal queue bound to final input behind a blocked write', async () => {
    const channel = await open(
      client(),
      `stty raw -echo; ${node("process.stdout.write('READY');setInterval(()=>{},1000)")}`,
      { cols: 80, rows: 24 },
    )
    const result = collect(channel)
    await until(() => result.text() === 'READY')
    channel.write(Buffer.alloc(65536))
    channel.end(Buffer.alloc(8 * 1024 * 1024))
    expect(channel.writableLength).toBeLessThanOrEqual(4_000_000)
    await result.closed
    expect(result.errors.some((error) => error.message.includes('exceeds 4 MB'))).toBe(true)
  })

  it('cancels blocked native writes before a new terminal can reuse its descriptor', async () => {
    const value = client()
    const blocked = await open(
      value,
      `stty raw -echo; ${node("process.stdout.write('READY');setInterval(()=>{},1000)")}`,
      { cols: 80, rows: 24 },
    )
    const first = collect(blocked)
    await until(() => first.text() === 'READY')
    let acknowledged = false
    blocked.write(Buffer.alloc(65536, 'A'), () => {
      acknowledged = true
    })
    await delay(30)
    expect(acknowledged).toBe(false)
    blocked.close()
    await first.closed
    expect(acknowledged).toBe(true)
    const code =
      "process.stdin.setRawMode(true);process.stdout.write('READY');process.stdin.on('data',b=>{process.stdout.write(b);process.stdin.destroy()})"
    const next = await open(value, `stty raw -echo; ${node(code)}`, {
      cols: 80,
      rows: 24,
    })
    const second = collect(next)
    await until(() => second.text() === 'READY')
    await delay(30)
    next.write('NEW_PTY_SENTINEL')
    expect((await second.closed).code).toBe(0)
    expect(second.text()).toBe('READYNEW_PTY_SENTINEL')
    expect(second.errors).toEqual([])
  })

  it('terminates an owned live process that has already closed every terminal descriptor', async () => {
    const file = join(directory, `closed-descriptors-${++sequence}`)
    const code = `require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeSync(1,'READY');setTimeout(()=>{for(const fd of [0,1,2])require('node:fs').closeSync(fd)},30);setInterval(()=>{},1000)`
    const channel = await open(client(), node(code), { cols: 80, rows: 24 })
    const result = collect(channel)
    const ended = new Promise<void>((resolve) => channel.once('end', resolve))
    await ended
    const pid = Number(await readFile(file, 'utf8'))
    cleanupPids.add(pid)
    expect(await running(pid)).toBe(true)
    expect(result.text()).toBe('READY')
    channel.close()
    await result.closed
    await until(async () => !(await running(pid)))
  })

  it.skipIf(!existsSync('/bin/bash'))(
    'closes interactive job-control foreground groups before client close',
    async () => {
      const file = join(directory, `job-${++sequence}.json`)
      const channel = await open(client(), 'exec /bin/bash --noprofile --norc -i', {
        cols: 100,
        rows: 24,
      })
      const result = collect(channel)
      const child = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000)`
      channel.write(`${shellQuote(process.execPath)} -e ${shellQuote(child)}\n`)
      await until(() => existsSync(file))
      const pid = Number(await readFile(file, 'utf8'))
      cleanupPids.add(pid)
      expect(await running(pid)).toBe(true)
      channel.close()
      await result.closed
      await until(async () => !(await running(pid)))
    },
  )

  it('rejects invalid terminal sizes before creating a process', async () => {
    const value = client()
    await expect(open(value, 'printf never', { cols: 0, rows: 24 })).rejects.toThrow(
      'positive integers',
    )
    const channel = await open(value, 'sleep 1', { cols: 80, rows: 24 })
    const result = collect(channel)
    expect(() => channel.setWindow(NaN, 20, 0, 0)).toThrow('positive integers')
    channel.close()
    await result.closed
  })
})
