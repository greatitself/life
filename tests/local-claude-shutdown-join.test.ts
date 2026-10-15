import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Agents } from '../src/main/agents'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import type { DurableRemoteChannel } from '../src/main/durable-remote-channel'
import type { AgentEvent } from '../src/shared/types'
import { LocalFixture } from './helpers/local-fixture'

const resources: Array<{
  fixture: LocalFixture
  connection: SSHConnection
  agents: Agents
  gate: string
}> = []

afterEach(async () => {
  for (const { fixture, connection, agents, gate } of resources.splice(0)) {
    await writeFile(gate, 'Release this fixture-owned Claude process\n')
    await agents.releaseIdleClaudeProviders().catch(() => undefined)
    agents.close()
    connection.disconnect()
    await fixture.close()
  }
})

const until = (predicate: () => unknown | Promise<unknown>) =>
  vi.waitFor(async () => expect(await predicate()).toBeTruthy(), { timeout: 4000, interval: 10 })

async function processRunning(pid: number) {
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

async function setup() {
  const fixture = await new LocalFixture().start()
  const gate = join(fixture.root, 'release-claude-close')
  const started = join(fixture.root, 'claude-close-started')
  const cli = join(fixture.root, '.local/bin/claude')
  const original = await readFile(cli, 'utf8')
  await writeFile(
    cli,
    original.replace(
      'record({ argv, cwd: process.cwd() })',
      `if (!argv.includes('--version') && !metadataWorkspace) {
  const fs = require('node:fs')
  const path = require('node:path')
  let closing = false
  // Keep the CLI alive before TERM: broker stdin EOF may otherwise let Node
  // exit before its queued signal handler runs.
  const wait = setInterval(() => {
    if (!closing || !fs.existsSync(path.join(process.env.RELAY_TEST_HOME, 'release-claude-close'))) return
    clearInterval(wait)
    process.exit(0)
  }, 10)
  process.on('SIGTERM', () => {
    fs.writeFileSync(path.join(process.env.RELAY_TEST_HOME, 'claude-close-started'), String(process.pid))
    closing = true
  })
}
record({ argv, cwd: process.cwd() })`,
    ),
  )
  const store = new Store(join(fixture.root, 'settings'))
  await store.init()
  const connection = new SSHConnection(store, fixture.options)
  const channels: DurableRemoteChannel[] = []
  const opening = connection.durableChannel.bind(connection)
  vi.spyOn(connection, 'durableChannel').mockImplementation(async (...args) => {
    const channel = await opening(...args)
    channels.push(channel as unknown as DurableRemoteChannel)
    return channel
  })
  const events: AgentEvent[] = []
  const agents = new Agents(connection, (event) => events.push(event))
  resources.push({ fixture, connection, agents, gate })
  await connection.connect(store.localProfile())
  await connection.whenProviderVersionsReady()
  await connection.selectWorkspace(fixture.workspace)
  const sessionId = 'joined-local-claude'
  const prompt = '  Preserve this exact Claude prompt café 漢字 🧪\n'
  const remoteId = 'local-shutdown-native-id'
  // A saved native identity suppresses the independent optional title process,
  // so this gate observes only the shutdown of the conversation's own CLI.
  await agents.start({
    sessionId,
    provider: 'claude',
    prompt,
    mode: 'review',
    remoteId,
  })
  await until(() => events.some((event) => event.type === 'complete'))
  expect(
    (await fixture.log()).find((entry) => entry.message?.type === 'user')?.message.session_id,
  ).toBe(remoteId)
  expect(channels).toHaveLength(1)
  return { fixture, agents, events, gate, started, sessionId, prompt, remoteId, channels }
}

async function resumedRelease(value: Awaited<ReturnType<typeof setup>>) {
  const eventBaseline = value.events.length
  const logBaseline = (await value.fixture.log()).length
  const prompt = '  Resume the same native Claude session café 🧪\n'
  await value.agents.start({
    sessionId: value.sessionId,
    provider: 'claude',
    prompt,
    mode: 'review',
  })
  await until(() => value.events.slice(eventBaseline).some((event) => event.type === 'complete'))
  expect(await value.agents.releaseIdleClaudeProviders()).toEqual([true])
  expect(value.channels).toHaveLength(2)
  const log = await value.fixture.log()
  const resumed = log.slice(logBaseline).find((entry) => Array.isArray(entry.argv))!
  expect(resumed.argv).toContain(`--resume=${value.remoteId}`)
  expect(
    log
      .filter((entry) => entry.kind !== 'title-metadata' && entry.message?.type === 'user')
      .every((entry) => entry.message.session_id === value.remoteId),
  ).toBe(true)
  for (const exact of [value.prompt, prompt])
    expect(
      log.filter(
        (entry) =>
          entry.kind !== 'title-metadata' &&
          entry.message?.type === 'user' &&
          entry.message.message.content.some((block: any) => block.text === exact),
      ),
    ).toHaveLength(1)
  expect(
    log.some(
      (entry) =>
        entry.message?.type === 'control_request' && entry.message.request?.subtype === 'interrupt',
    ),
  ).toBe(false)
  expect(
    value.events
      .filter((event) => event.remoteId)
      .every((event) => event.remoteId === value.remoteId),
  ).toBe(true)
  expect(
    value.events.some(
      (event) =>
        event.type === 'error' || (event.type === 'complete' && event.status === 'interrupted'),
    ),
  ).toBe(false)
}

describe.skipIf(process.platform === 'win32')('overlapping idle local Claude shutdown', () => {
  it('joins window close and app quit until the actual native Claude exit acknowledgement', async () => {
    const value = await setup()
    let firstSettled = false
    const first = value.agents.releaseIdleClaudeProviders()
    void first.then(() => (firstSettled = true))
    await until(() => existsSync(value.started))
    const pid = Number(await readFile(value.started, 'utf8'))
    expect(await processRunning(pid)).toBe(true)
    let secondSettled = false
    const second = value.agents.releaseIdleClaudeProviders()
    void second.then(() => (secondSettled = true))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(await processRunning(pid)).toBe(true)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(second).toBe(first)
    await writeFile(value.gate, 'Acknowledge this native process exit\n')
    expect(await Promise.all([first, second])).toEqual([[true], [true]])
    await until(async () => !(await processRunning(pid)))
    await resumedRelease(value)
  }, 15000)

  it.each(['false', 'rejected'] as const)(
    'clears a %s release result so a later completed native session can be released',
    async (outcome) => {
      const value = await setup()
      const channel = value.channels[0]
      const closing = channel.closeAndWaitEffect.bind(channel)
      const error = new Error('Fixture native close acknowledgement failed')
      vi.spyOn(channel, 'closeAndWaitEffect').mockImplementation(() =>
        closing().pipe(
          Effect.flatMap(() => (outcome === 'false' ? Effect.succeed(false) : Effect.die(error))),
        ),
      )
      const first = value.agents.releaseIdleClaudeProviders()
      const observed = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await until(() => existsSync(value.started))
      const pid = Number(await readFile(value.started, 'utf8'))
      expect(await processRunning(pid)).toBe(true)
      const second = value.agents.releaseIdleClaudeProviders()
      // Attach a rejection handler before allowing the native process to exit.
      const joined = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      expect(second).toBe(first)
      await writeFile(value.gate, 'Acknowledge this native process exit\n')
      const results = await Promise.all([observed, joined])
      expect(results).toEqual(
        outcome === 'false' ? [{ value: [false] }, { value: [false] }] : [{ error }, { error }],
      )
      await until(async () => !(await processRunning(pid)))
      await resumedRelease(value)
    },
    15000,
  )
})
