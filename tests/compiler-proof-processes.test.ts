import childProcess, { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { observeCompilerProcesses } from './helpers/compiler-proof-processes'

class CompilerChild extends EventEmitter {
  ref = vi.fn(() => this)
  kill = vi.fn(() => true)
  exitCode: number | null = null
}

function createHost() {
  const children: CompilerChild[] = []
  const spawn = vi.fn(function (this: unknown, ..._args: unknown[]) {
    const child = new CompilerChild()
    children.push(child)
    return child as unknown as ChildProcess
  })
  const host: Pick<typeof childProcess, 'spawn'> = {
    spawn: spawn as unknown as typeof childProcess.spawn,
  }
  return { host, spawn, children }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const cacheDirectory = resolve('compiler-proof-cache')
const executable = join(cacheDirectory, 'node_modules', '@esbuild', 'platform', 'bin', 'esbuild')

describe('isolated compiler proof process cleanup', () => {
  it('waits for the actual close event after library stop has resolved', async () => {
    const { host, spawn, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    host.spawn(executable, ['--service=0.25.12'])
    const child = children[0]
    const stopCompiler = vi.fn(() => Promise.resolve())
    let finished = false
    const cleanup = observer.stop(stopCompiler).then(() => {
      finished = true
    })

    await flushMicrotasks()
    expect(stopCompiler).toHaveBeenCalledExactlyOnceWith()
    expect(child.ref).toHaveBeenCalledOnce()
    expect(finished).toBe(false)

    child.exitCode = 0
    child.emit('exit', 0, null)
    await flushMicrotasks()
    expect(finished).toBe(false)

    child.emit('close', 0, null)
    await cleanup
    expect(finished).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
    expect(host.spawn).toBe(spawn)
  })

  it('allows library stop to finish before referencing remaining workers', async () => {
    const { host, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    host.spawn(executable)
    const libraryStop = deferred()
    const stopCompiler = vi.fn(() => libraryStop.promise)
    const cleanup = observer.stop(stopCompiler)

    await flushMicrotasks()
    expect(stopCompiler).toHaveBeenCalledOnce()
    expect(children[0].ref).not.toHaveBeenCalled()

    libraryStop.resolve()
    await flushMicrotasks()
    expect(children[0].ref).toHaveBeenCalledOnce()
    children[0].emit('close', 0, null)
    await cleanup
  })

  it('does not observe, wait for, reference, or kill unrelated processes', async () => {
    const { host, spawn, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    const ignoredCommands = [
      join(resolve('elsewhere'), 'esbuild'),
      join(`${cacheDirectory}-other`, 'esbuild.exe'),
      join(cacheDirectory, 'node'),
      join(cacheDirectory, 'esbuild-helper'),
      join(cacheDirectory, 'esbuild.js'),
    ]
    for (const command of ignoredCommands) host.spawn(command)

    expect(observer.count).toBe(0)
    await observer.stop(() => {})

    expect(host.spawn).toBe(spawn)
    for (const child of children) {
      expect(child.listenerCount('close')).toBe(0)
      expect(child.ref).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
    }
  })

  it('captures both native executable names within the cache', async () => {
    const { host, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    host.spawn(executable)
    host.spawn(join(cacheDirectory, 'windows', 'esbuild.exe'))
    host.spawn(join(cacheDirectory, 'windows', 'ESBUILD.EXE'))

    expect(observer.count).toBe(3)
    expect(children.map((child) => child.listenerCount('close'))).toEqual([1, 1, 1])
    const cleanup = observer.stop(() => {})
    await flushMicrotasks()
    for (const child of children) child.emit('close', 0, null)
    await cleanup
  })

  it('captures closure before cleanup starts and does not reference closed workers', async () => {
    const { host, spawn, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    host.spawn(executable)
    children[0].emit('close', 0, null)

    await observer.stop(() => {})

    expect(observer.count).toBe(1)
    expect(children[0].ref).not.toHaveBeenCalled()
    expect(host.spawn).toBe(spawn)
  })

  it('handles a close event emitted synchronously by library stop', async () => {
    const { host, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    host.spawn(executable)

    await observer.stop(() => {
      children[0].emit('close', 0, null)
    })

    expect(children[0].ref).not.toHaveBeenCalled()
  })

  it('waits until every captured worker closes while ignoring other children', async () => {
    const { host, spawn, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    host.spawn(executable)
    host.spawn(join(cacheDirectory, 'another', 'esbuild.exe'))
    host.spawn(join(cacheDirectory, 'npm'))
    let finished = false
    const cleanup = observer
      .stop(() => {})
      .then(() => {
        finished = true
      })

    await flushMicrotasks()
    expect(observer.count).toBe(2)
    expect(children[0].ref).toHaveBeenCalledOnce()
    expect(children[1].ref).toHaveBeenCalledOnce()
    expect(children[2].ref).not.toHaveBeenCalled()

    children[0].emit('close', 0, null)
    await flushMicrotasks()
    expect(finished).toBe(false)

    children[1].emit('close', 0, null)
    await cleanup
    expect(finished).toBe(true)
    expect(host.spawn).toBe(spawn)
    expect(children[2].listenerCount('close')).toBe(0)
    expect(children.every((child) => child.kill.mock.calls.length === 0)).toBe(true)
  })

  it('forwards the original spawn receiver, arguments, and return value', async () => {
    const { host, spawn, children } = createHost()
    const originalSpawn = host.spawn
    const observer = observeCompilerProcesses(cacheDirectory, host)
    const args = ['--service=0.25.12']
    const options = { windowsHide: true, stdio: 'pipe' as const }
    const child = host.spawn(executable, args, options)

    expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, args, options)
    expect(spawn.mock.contexts[0]).toBe(host)
    expect(child).toBe(children[0])
    expect(host.spawn).not.toBe(originalSpawn)

    children[0].emit('close', 0, null)
    await observer.stop(() => {})
    expect(host.spawn).toBe(originalSpawn)
  })

  it('restores spawn when library stop throws synchronously', async () => {
    const { host, spawn } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    const failure = new Error('Compiler stop failed')

    await expect(
      observer.stop(() => {
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(host.spawn).toBe(spawn)
  })

  it('restores spawn and preserves asynchronous library stop failures', async () => {
    const { host, spawn, children } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    host.spawn(executable)
    const failure = new Error('Compiler service could not stop')

    await expect(observer.stop(() => Promise.reject(failure))).rejects.toBe(failure)

    expect(host.spawn).toBe(spawn)
    expect(children[0].ref).not.toHaveBeenCalled()
    expect(children[0].kill).not.toHaveBeenCalled()
    children[0].emit('close', 0, null)
  })

  it('preserves a spawn replacement installed after observation starts', async () => {
    const { host } = createHost()
    const observer = observeCompilerProcesses(cacheDirectory, host)
    const replacement = vi.fn() as unknown as typeof childProcess.spawn
    host.spawn = replacement

    await observer.stop(() => {})

    expect(host.spawn).toBe(replacement)
  })
})
