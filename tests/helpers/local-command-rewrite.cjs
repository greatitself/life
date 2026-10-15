// Fixture-only shell adapter. Preserve provider commands, native runtime and
// auth environment; redirect only Life's encoded private broker directory.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { appendFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

let command = process.argv[2] || ''
command = command.replaceAll('$HOME', '$RELAY_TEST_HOME')
if (process.argv[3] === '-lc' && command.includes('export ELECTRON_RUN_AS_NODE=1; exec ')) {
  const encoded = command.match(/'([a-zA-Z0-9+/=]+)'\s*$/)
  assert.ok(encoded, 'Fixture broker invocation must end in one encoded configuration argument')
  const configuration = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8'))
  assert.match(configuration.id, /^[a-zA-Z0-9_-]{1,80}$/)
  assert.equal(typeof configuration.command, 'string')
  const root = join(process.env.RELAY_TEST_HOME, '.life/agent-sessions', configuration.id)
  assert.ok(
    configuration.root === root ||
      configuration.root === join(homedir(), '.life/agent-sessions', configuration.id),
    'Fixture may redirect only the canonical broker root for this native session',
  )
  const redirected = { ...configuration, root }
  assert.equal(redirected.command, configuration.command)
  appendFileSync(
    join(process.env.RELAY_TEST_HOME, 'broker-configs.jsonl'),
    JSON.stringify({
      id: configuration.id,
      originalRoot: configuration.root,
      root,
      commandSha256: createHash('sha256').update(configuration.command).digest('hex'),
      runtimeUnchanged:
        JSON.stringify(configuration.localRuntime) === JSON.stringify(redirected.localRuntime),
    }) + '\n',
  )
  const replacement = Buffer.from(JSON.stringify(redirected)).toString('base64')
  command = command.slice(0, encoded.index) + `'${replacement}'`
}
process.stdout.write(command)
