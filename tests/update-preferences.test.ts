import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdatePreferences } from '../src/main/update-preferences'

const directories: string[] = []
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'life-update-preferences-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('native update download preference', () => {
  it('prepares updates by default in a new installation', async () => {
    expect(await new UpdatePreferences(join(await directory(), 'updates.json')).init()).toBe(true)
  })

  it('preserves opt-out across native cold starts', async () => {
    const path = join(await directory(), 'updates.json')
    const preferences = new UpdatePreferences(path)
    await preferences.init()
    await preferences.set(false)
    expect(await new UpdatePreferences(path).init()).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, autoDownload: false })
    await preferences.set(true)
    expect(await new UpdatePreferences(path).init()).toBe(true)
  })

  it.each([
    '{',
    'null',
    '{"version":1,"autoDownload":"true"}',
    '{"version":2,"autoDownload":true}',
  ])('does not enable downloads from invalid preferences: %s', async (contents) => {
    const path = join(await directory(), 'updates.json')
    await writeFile(path, contents)
    expect(await new UpdatePreferences(path).init()).toBe(false)
  })

  it('commits concurrent changes in request order', async () => {
    const path = join(await directory(), 'nested', 'updates.json')
    const preferences = new UpdatePreferences(path)
    await preferences.init()
    await Promise.all([preferences.set(false), preferences.set(true), preferences.set(false)])
    expect(await new UpdatePreferences(path).init()).toBe(false)
  })

  it('reports failed saves and permits a subsequent successful retry', async () => {
    const directoryPath = await directory()
    const parent = join(directoryPath, 'settings')
    await writeFile(parent, 'file blocks directory')
    const path = join(parent, 'updates.json')
    const preferences = new UpdatePreferences(path)
    await expect(preferences.set(false)).rejects.toThrow()
    await rm(parent)
    await mkdir(parent)
    expect(await preferences.set(false)).toBe(false)
    expect(await new UpdatePreferences(path).init()).toBe(false)
  })
})
