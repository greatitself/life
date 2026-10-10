import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceCodeStore } from '../src/main/source-code'

const reads = vi.hoisted(() => ({
  tracked: new Set<string>(),
  pending: new Map<string, () => void>(),
  completed: [] as string[],
  active: 0,
  peak: 0,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...native,
    async readFile(
      path: Parameters<typeof native.readFile>[0],
      options?: Parameters<typeof native.readFile>[1],
    ) {
      const key = String(path)
      if (!reads.tracked.has(key)) return native.readFile(path, options)
      reads.peak = Math.max(reads.peak, ++reads.active)
      try {
        const content = await native.readFile(path, options)
        await new Promise<void>((resolve) => reads.pending.set(key, resolve))
        return content
      } finally {
        reads.pending.delete(key)
        reads.active--
        reads.completed.push(key)
      }
    },
  }
})

let directory: string | undefined
let store: SourceCodeStore | undefined
afterEach(async () => {
  for (const release of reads.pending.values()) release()
  reads.tracked.clear()
  await store?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  store = undefined
  reads.pending.clear()
  reads.completed = []
  reads.active = reads.peak = 0
})

it('retains an existing customization fingerprint and content hashes despite out-of-order baseline reads', async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-baseline-reads-'))
  const source = join(directory, 'source')
  const saved = join(directory, 'saved')
  const files = {
    'src/shared/z.ts': 'export const last = "last"\n',
    'src/renderer/main.tsx': '// installed renderer\r\n',
    'src/shared/c.ts': '// shared C\n',
    'src/renderer/b.ts': '// renderer B\n',
    'src/shared/b.ts': '// shared B\n',
    'src/renderer/styles.css': 'body { color: #123456; }\n',
    'src/shared/a.ts': '// shared A\n',
    'src/renderer/a.ts': '// renderer A with Unicode: λ\n',
  }
  const packageContent = '{"name":"saved-baseline","dependencies":{}}\n'
  const paths = Object.keys(files).sort()
  const fingerprint = createHash('sha256').update('package.json').update(packageContent)
  const hashes: Record<string, string> = {}
  for (const path of paths) {
    const content = files[path as keyof typeof files]
    await mkdir(dirname(join(source, path)), { recursive: true })
    await writeFile(join(source, path), content)
    fingerprint.update(path).update(content)
    hashes[path] = createHash('sha256').update(content).digest('hex')
    reads.tracked.add(join(source, path))
  }
  await writeFile(join(source, 'package.json'), packageContent)
  await mkdir(join(source, 'src/main'), { recursive: true })
  await writeFile(
    join(source, 'src/main/native.ts'),
    '// Native code does not enter the renderer fingerprint',
  )
  await mkdir(join(saved, 'revisions/1/dist'), { recursive: true })
  await writeFile(join(saved, 'revisions/1/dist/entry.js'), '// Previously compiled customization')
  await writeFile(
    join(saved, 'revisions/1/metadata.json'),
    JSON.stringify({
      summary: 'Existing customization',
      dependencies: {},
      baseFingerprint: fingerprint.digest('hex'),
      baseHashes: hashes,
      extensions: [],
    }),
  )
  await writeFile(
    join(saved, 'state.json'),
    JSON.stringify({
      format: 1,
      revision: 1,
      current: 1,
      history: [null],
      enabled: true,
    }),
  )
  store = new SourceCodeStore({
    sourceDir: source,
    nodeModulesDir: join(directory, 'node_modules'),
    directory: saved,
  })
  const initialized = store.init()
  for (let offset = 0; offset < paths.length; offset += 4) {
    const batch = paths.slice(offset, offset + 4)
    await vi.waitFor(() => {
      expect(reads.pending.size).toBe(batch.length)
      for (const path of batch) expect(reads.pending.has(join(source, path))).toBe(true)
    })
    for (const path of [...batch].reverse()) reads.pending.get(join(source, path))!()
  }
  const snapshot = await initialized
  expect(reads.peak).toBe(4)
  expect(reads.completed.slice(0, 4)).toEqual(
    paths
      .slice(0, 4)
      .reverse()
      .map((path) => join(source, path)),
  )
  expect(snapshot).toMatchObject({ enabled: true, revision: 1, active: { revision: 1 } })
  expect(snapshot.baseChanged).toBeUndefined()
  expect(snapshot.error).toBeUndefined()
  expect((store as unknown as { baselineHashes: Record<string, string> }).baselineHashes).toEqual(
    hashes,
  )
})
