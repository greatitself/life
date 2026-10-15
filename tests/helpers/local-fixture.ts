import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Real local processes and files, with deterministic native provider stand-ins. */
export class LocalFixture {
  root = ''
  workspace = ''
  shell = ''
  versionGate?: string
  async start(providerSource = join(process.cwd(), 'tests/fixtures/fake-provider.cjs')) {
    this.root = await mkdtemp(join(tmpdir(), 'life-local-test-'))
    this.workspace = join(this.root, "workspace's café 🧪")
    const bin = join(this.root, '.local/bin')
    this.shell = join(bin, 'fixture-shell')
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(join(this.workspace, 'src'), { recursive: true }),
      mkdir(join(this.workspace, 'node_modules'), { recursive: true }),
    ])
    const provider = (await readFile(providerSource, 'utf8')).replace(
      '#!/usr/bin/env node\n',
      '#!/usr/bin/env node\n' +
        'if (process.argv.includes("--version") && process.env.RELAY_TEST_VERSION_GATE) {\n' +
        '  const fixtureFs = require("node:fs");\n' +
        '  fixtureFs.writeFileSync(process.env.RELAY_TEST_VERSION_GATE + ".started", String(process.pid));\n' +
        '  const fixtureWait = new Int32Array(new SharedArrayBuffer(4));\n' +
        '  while (!fixtureFs.existsSync(process.env.RELAY_TEST_VERSION_GATE)) Atomics.wait(fixtureWait, 0, 0, 20);\n' +
        '}\n',
    )
    await Promise.all(
      ['codex', 'claude'].map((name) => writeFile(join(bin, name), provider, { mode: 0o755 })),
    )
    // HOME and CODEX_HOME in the environment remain untouched. Only Life's
    // literal shell paths are redirected to the fixture-owned broker directory.
    await writeFile(
      this.shell,
      '#!/bin/bash\nif [[ "$1" == "-lc" || "$1" == "-c" ]]; then\n  task_command="$("$RELAY_TEST_NODE" "$RELAY_TEST_HOME/rewrite-command.cjs" "$2" "$1")" || exit $?\n  exec /bin/bash --noprofile --norc -c "$task_command"\nfi\nif [[ "$1" == "-s" ]]; then\n  exec /bin/bash --noprofile --norc -s\nfi\nexec /bin/bash --noprofile --rcfile "$RELAY_TEST_HOME/interactive.bashrc" -i\n',
      { mode: 0o755 },
    )
    await Promise.all([
      writeFile(join(this.workspace, 'README.md'), '# Local fixture café 🧪\n'),
      writeFile(join(this.workspace, 'src/index.ts'), 'export const answer = 42\n'),
      writeFile(join(this.workspace, 'binary.dat'), Buffer.from([0, 1, 2])),
      writeFile(join(this.workspace, 'large.txt'), 'x'.repeat(1_000_001)),
      writeFile(join(this.root, 'outside.txt'), 'Private outside workspace'),
      symlink(join(this.root, 'outside.txt'), join(this.workspace, 'escape-link')),
      writeFile(join(this.root, 'provider-messages.jsonl'), ''),
      writeFile(join(this.root, 'broker-configs.jsonl'), ''),
      writeFile(
        join(this.root, 'rewrite-command.cjs'),
        await readFile(join(process.cwd(), 'tests/helpers/local-command-rewrite.cjs'), 'utf8'),
      ),
      writeFile(join(this.root, 'interactive.bashrc'), "PS1='LIFE_LOCAL_SHELL_READY> '\n"),
      writeFile(
        join(this.workspace, '.gitignore'),
        'node_modules/\nbinary.dat\nlarge.txt\nescape-link\n',
      ),
    ])
    this.git('init', '--quiet')
    this.git('add', 'README.md', 'src/index.ts', '.gitignore')
    this.git(
      '-c',
      'user.name=Life local fixture',
      '-c',
      'user.email=life-fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Create local native fixture',
    )
    return this
  }
  get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SHELL: this.shell,
      PATH: `${join(this.root, '.local/bin')}:${process.env.PATH || ''}`,
      RELAY_TEST_HOME: this.root,
      RELAY_TEST_LOG: join(this.root, 'provider-messages.jsonl'),
      RELAY_TEST_NODE: process.execPath,
      ...(this.versionGate ? { RELAY_TEST_VERSION_GATE: this.versionGate } : {}),
      PS1: 'LIFE_LOCAL_SHELL_READY> ',
      LC_ALL: 'C.UTF-8',
    }
  }
  get options() {
    return {
      local: {
        shell: this.shell,
        env: this.env,
        brokerDirectory: join(this.root, '.life/agent-sessions'),
      },
    }
  }
  git(...args: string[]) {
    const result = spawnSync('git', args, { cwd: this.workspace, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  async log(): Promise<Array<Record<string, any>>> {
    return (await readFile(join(this.root, 'provider-messages.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  async close() {
    // Kill only brokers recorded beneath this fixture-owned temporary root.
    // A provider broker can intentionally survive the client that created it.
    const sessions = join(this.root, '.life/agent-sessions')
    try {
      for (const name of readdirSync(sessions)) {
        try {
          const state = JSON.parse(readFileSync(join(sessions, name, 'state.json'), 'utf8'))
          if (Number.isSafeInteger(state.pid) && state.pid > 1)
            try {
              process.kill(-state.pid, 'SIGKILL')
            } catch {}
          if (Number.isSafeInteger(state.brokerPid) && state.brokerPid > 1)
            try {
              process.kill(state.brokerPid, 'SIGTERM')
            } catch {}
        } catch {}
      }
    } catch {}
    if (this.root)
      await rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
