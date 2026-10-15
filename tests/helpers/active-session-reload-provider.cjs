#!/usr/bin/env node
// Supplemental stand-in wrapper only. The matched provider stays byte-for-byte frozen.
// No credentials, network, upstream provider or inference are used.
const { basename, join } = require('node:path')
const { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync } = require('node:fs')
const { createHash } = require('node:crypto')

if (!process.env.RELAY_TEST_HOME || !process.env.RELAY_TEST_LOG)
  throw new Error('The supplemental wrapper requires its disposable SSH fixture paths')
const provider = basename(process.argv[1])
if (!['codex', 'claude'].includes(provider))
  throw new Error('Invoke the supplemental wrapper through a fixture-owned provider executable')

const nativePath = join(process.env.RELAY_TEST_HOME, 'active-session-reload-native.cjs')
const expectedNativeSha256 = 'bec9cf3b2649c9a79c25e28564957623c027366b0a78e7caa8c0322d6cfdc983'
const actualNativeSha256 = createHash('sha256').update(readFileSync(nativePath)).digest('hex')
if (actualNativeSha256 !== expectedNativeSha256)
  throw new Error('The supplemental wrapper did not receive the exact frozen native stand-in')

const controlRoot = join(process.env.RELAY_TEST_HOME, 'active-recovery-control')
const holdPath = join(controlRoot, 'hold-native-exit')
const releasePath = join(controlRoot, `release-native-exit-${process.pid}`)
const writerRoot = join(process.env.RELAY_TEST_HOME, 'active-recovery-provider', provider)
const record = (value) =>
  appendFileSync(
    process.env.RELAY_TEST_LOG,
    JSON.stringify({ provider, pid: process.pid, at: Date.now(), inference: false, ...value }) +
      '\n',
  )

function ownedThreadIds() {
  if (!existsSync(writerRoot)) return []
  return readdirSync(writerRoot)
    .filter((path) => path.endsWith('.writer'))
    .map((path) => JSON.parse(readFileSync(join(writerRoot, path), 'utf8')))
    .filter((owner) => owner.pid === process.pid)
    .map((owner) => owner.threadId)
    .sort()
}

const originalOn = process.on
let registeredTerm = false
let deferredTerm
let releaseTimer

// Capture the actual frozen stand-in's TERM callback without changing its parser,
// native messages, process identity, writer locks, stream lifetime or turn timers.
process.on = function (event, listener) {
  if (event !== 'SIGTERM') return originalOn.call(this, event, listener)
  if (registeredTerm) throw new Error('The frozen stand-in registered more than one TERM handler')
  registeredTerm = true
  return originalOn.call(this, event, function (...argumentsForSignal) {
    if (deferredTerm) {
      record({
        kind: 'slow-exit-signal-duplicate',
        signal: 'SIGTERM',
        ownedThreadIds: ownedThreadIds(),
      })
      return
    }
    const owned = ownedThreadIds()
    // Discovery-only invocations retain their ordinary teardown behavior even
    // while another real fixture turn owns the supplemental hold file.
    if (!existsSync(holdPath) || owned.length === 0) return listener.apply(this, argumentsForSignal)

    deferredTerm = { listener, receiver: this, argumentsForSignal, acceptedAt: Date.now() }
    record({
      kind: 'slow-exit-signal-accepted',
      signal: 'SIGTERM',
      ownedThreadIds: owned,
      releaseFile: basename(releasePath),
      nativeSha256: actualNativeSha256,
    })
    releaseTimer = setInterval(() => {
      if (!existsSync(releasePath)) return
      unlinkSync(releasePath)
      clearInterval(releaseTimer)
      releaseTimer = undefined
      const pending = deferredTerm
      record({
        kind: 'slow-exit-released',
        signal: 'SIGTERM',
        ownedThreadIds: ownedThreadIds(),
        heldMs: Date.now() - pending.acceptedAt,
      })
      // Keep deferredTerm set: any repeat TERM remains a duplicate while the
      // original native callback releases its actual locks and exits normally.
      pending.listener.apply(pending.receiver, pending.argumentsForSignal)
    }, 20)
  })
}

try {
  require(nativePath)
} finally {
  process.on = originalOn
}

if (!registeredTerm) throw new Error('The frozen stand-in did not register its TERM handler')
