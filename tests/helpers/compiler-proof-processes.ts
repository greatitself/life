import childProcess, { type ChildProcess } from 'node:child_process'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

/** The isolated runtime proof owns these children and deletes their executable cache. */
export function observeCompilerProcesses(
  cacheDirectory: string,
  processHost: Pick<typeof childProcess, 'spawn'> = childProcess,
) {
  const originalSpawn = processHost.spawn
  const services: { child: ChildProcess; closed: boolean; completion: Promise<void> }[] = []
  const observedSpawn: typeof childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn.apply(processHost, args)
    const command = args[0]
    const path = relative(resolve(cacheDirectory), resolve(command))
    if (
      path &&
      !isAbsolute(path) &&
      path !== '..' &&
      !path.startsWith(`..${sep}`) &&
      /^(?:esbuild|esbuild\.exe)$/i.test(basename(command))
    ) {
      const service = {
        child,
        closed: false,
        completion: Promise.resolve(),
      }
      service.completion = new Promise((done) => {
        child.once('close', () => {
          service.closed = true
          done()
        })
      })
      services.push(service)
    }
    return child
  }) as typeof childProcess.spawn
  processHost.spawn = observedSpawn
  return {
    get count() {
      return services.length
    },
    async stop(stopCompiler: () => Promise<void> | void): Promise<void> {
      try {
        // esbuild.stop() destroys its pipes and kills the service, but resolves
        // before Windows releases the executable. The child close event is the gate.
        await stopCompiler()
        for (const service of services) if (!service.closed) service.child.ref()
        await Promise.all(services.map((service) => service.completion))
      } finally {
        if (processHost.spawn === observedSpawn) processHost.spawn = originalSpawn
      }
    },
  }
}
