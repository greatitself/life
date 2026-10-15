import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRemoteAgentBrokerCommand } from '../src/main/remote-agent-broker'
import { remoteCommand } from '../src/main/ssh'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'life-local-broker-rewrite-test-'))
  roots.push(root)
  const environment = { ...process.env, RELAY_TEST_HOME: root }
  const rewrite = (command: string, mode = '-lc') =>
    execFileSync(process.execPath, ['tests/helpers/local-command-rewrite.cjs', command, mode], {
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  return { root, rewrite }
}

describe('private local native fixture broker isolation', () => {
  it('rewrites only the decoded broker root and preserves every other native configuration field', async () => {
    const { root, rewrite } = await setup()
    const configuration = {
      id: 'fixture-session',
      root: join(homedir(), '.life/agent-sessions/fixture-session'),
      command: 'cd "/project café 🧪" && exec codex app-server --listen stdio://',
      cursor: 17,
      launch: false,
    }
    const original = buildRemoteAgentBrokerCommand(configuration, {
      executable: process.execPath,
      inheritedRunAsNode: 'preserve-original-value',
    })
    const changed = rewrite(original)
    const encoded = changed.match(/'([a-zA-Z0-9+/=]+)'\s*$/)![1]
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual({
      ...configuration,
      root: join(root, '.life/agent-sessions/fixture-session'),
      localRuntime: { inheritedRunAsNode: 'preserve-original-value' },
    })
    expect(changed.slice(0, changed.lastIndexOf("'", changed.length - 2))).toBe(
      original.slice(0, original.lastIndexOf("'", original.length - 2)),
    )
    const audit = JSON.parse((await readFile(join(root, 'broker-configs.jsonl'), 'utf8')).trim())
    expect(audit).toMatchObject({
      id: configuration.id,
      root: join(root, '.life/agent-sessions/fixture-session'),
      runtimeUnchanged: true,
    })
    expect(existsSync(join(root, '.life'))).toBe(false)
  })

  it('leaves outer shell quoting intact until the inner login shell receives the native command', async () => {
    const { rewrite } = await setup()
    const native = buildRemoteAgentBrokerCommand(
      {
        id: 'quoted-session',
        root: join(homedir(), '.life/agent-sessions/quoted-session'),
        command: "exec codex app-server --listen stdio:// --fixture='quoted'",
      },
      { executable: process.execPath },
    )
    const outer = remoteCommand(native)
    expect(rewrite(outer, '-c')).toBe(outer.replaceAll('$HOME', '$RELAY_TEST_HOME'))
  })

  it('refuses an unrecognized broker root rather than writing outside the fixture', async () => {
    const { root, rewrite } = await setup()
    const command = buildRemoteAgentBrokerCommand(
      {
        id: 'wrong-root',
        root: '/unrelated/private/path',
        command: 'exec codex app-server --listen stdio://',
      },
      { executable: process.execPath },
    )
    expect(() => rewrite(command)).toThrow()
    expect(existsSync(join(root, 'broker-configs.jsonl'))).toBe(false)
    expect(existsSync(join(root, '.life'))).toBe(false)
  })
})
