const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { deserialize } = require('./portable-wire.cjs')

const hash = (value) => createHash('sha256').update(value).digest('hex')
function readTape(path, pid, appPath) {
  const bytes = readFileSync(path)
  assert.ok(bytes.length && bytes.at(-1) === 10, 'The observer tape contains complete records')
  let sequence = 0
  let previousHash = null
  const records = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const { hash: recordHash, ...payload } = JSON.parse(line)
      assert.equal(payload.format, 'life-native-recovery-observer')
      assert.equal(payload.version, 2)
      assert.equal(payload.sequence, ++sequence)
      assert.equal(payload.previousHash, previousHash)
      assert.equal(payload.nativePID, pid)
      assert.equal(hash(JSON.stringify(payload)), recordHash)
      const serialized = Buffer.from(payload.serializedBase64, 'base64')
      assert.equal(hash(serialized), payload.serializedSha256)
      previousHash = recordHash
      return { ...payload, hash: recordHash, value: deserialize(serialized) }
    })
  assert.equal(records[0].kind, 'observer-installed-before-main')
  assert.equal(records[0].value.expectedAppPath, appPath)
  const ready = records.filter((entry) => entry.kind === 'application-at-main-registration')
  assert.equal(ready.length, 1)
  assert.equal(ready[0].value.appPath, appPath)
  assert.equal(ready[0].value.name, 'Life')
  assert.deepEqual(ready[0].value.observerFailures, [])
  for (const entry of records.filter((value) => value.kind === 'observer-status'))
    assert.deepEqual(entry.value.failures, [])
  return { path, sha256: hash(bytes), bytes: bytes.length, records }
}

function readJournal(path) {
  const bytes = readFileSync(path)
  assert.ok(bytes.length && bytes.at(-1) === 10)
  let previousHash = null
  let index = 0
  let revision = 0
  const records = []
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const { hash: recordHash, ...payload } = JSON.parse(line)
    assert.equal(payload.format, 'life-native-recovery')
    assert.equal(payload.version, 1)
    assert.equal(payload.index, ++index)
    assert.equal(payload.previousHash, previousHash)
    assert.equal(hash(JSON.stringify(payload)), recordHash)
    previousHash = recordHash
    for (const record of payload.records) {
      assert.equal(record.revision, ++revision)
      records.push(record)
    }
  }
  return { path, sha256: hash(bytes), bytes: bytes.length, records }
}

function canonicalEvent(event) {
  const { nativeRecovery, ...content } = event
  return content
}

function bindPermission(harness, thread, event) {
  assert.equal(event.sessionId, thread.id)
  const native = event.nativeRecovery
  assert.ok(native?.transportId && native.snapshotToken)
  assert.ok(Number.isSafeInteger(native.ownerGeneration) && native.ownerGeneration >= 0)
  assert.ok(Number.isSafeInteger(native.revision) && native.revision > 0)
  assert.equal(native.localTurn, thread.turn)
  const journal = readJournal(
    join(harness.launches.at(-1).userData, 'native-recovery', hash(native.transportId) + '.jsonl'),
  )
  let transport
  for (const record of journal.records) {
    if (record.kind === 'create') transport = structuredClone(record.transport)
    if (record.kind === 'transport') Object.assign(transport, record.patch)
  }
  assert.equal(transport.id, native.transportId)
  assert.equal(transport.provider, thread.provider)
  assert.equal(transport.machine.profileId, thread.profileId)
  const owner = transport.owners.find((value) => value.sessionId === thread.id)
  assert.ok(owner)
  assert.equal(owner.kind, 'root')
  assert.equal(owner.generation ?? 0, native.ownerGeneration)
  assert.equal(owner.snapshotToken, native.snapshotToken)
  assert.equal(owner.workspace, thread.workspace)
  assert.equal(owner.nativeThreadId ?? owner.nativeSessionId, thread.remoteId)
  const stored = journal.records.find(
    (record) =>
      record.kind === 'event' &&
      record.event.revision === native.revision &&
      record.event.event.sessionId === thread.id &&
      record.event.event.requestId === event.requestId,
  )
  assert.ok(stored, 'The original actionable identity is in its exact native ledger')
  assert.equal(stored.event.eventId, native.eventId)
  assert.deepEqual(canonicalEvent(stored.event.event), canonicalEvent(event))
  const requested = harness
    .log()
    .filter((entry) => entry.kind === 'permission-requested' && entry.threadId === thread.remoteId)
  assert.equal(requested.length, 1)
  const envelope = requested[0].request
  const nativeRequestId = thread.provider === 'claude' ? envelope.request_id : envelope.id
  if (stored.event.nativeRequestId !== undefined)
    assert.equal(stored.event.nativeRequestId, nativeRequestId)
  if (thread.provider === 'claude') assert.equal(event.requestId, nativeRequestId)
  assert.deepEqual(
    event.details,
    thread.provider === 'claude'
      ? envelope.request
      : { method: envelope.method, ...envelope.params },
  )
  const stdout = Buffer.concat(
    journal.records
      .filter((record) => record.kind === 'output' && record.frame.type === 'stdout')
      .map((record) => Buffer.from(record.frame.data, 'base64')),
  )
  const raw = stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .find((line) => {
      const value = JSON.parse(line)
      return thread.provider === 'claude'
        ? value.type === 'control_request' && value.request_id === nativeRequestId
        : value.method === envelope.method && value.id === nativeRequestId
    })
  assert.ok(raw, 'The original native permission envelope remains byte-preserved')
  assert.deepEqual(JSON.parse(raw), envelope)
  return {
    event: structuredClone(event),
    thread: structuredClone(thread),
    originalNativeRequestId: nativeRequestId,
    originalNativeEnvelope: envelope,
    originalNativeLineBase64: Buffer.from(raw + '\n').toString('base64'),
    originalNativeLineSha256: hash(Buffer.from(raw + '\n')),
    originalJournal: { path: journal.path, sha256: journal.sha256 },
  }
}

function recoverPending(tape, original, currentThread) {
  assert.equal(currentThread.id, original.thread.id)
  assert.equal(currentThread.profileId, original.thread.profileId)
  assert.equal(currentThread.workspace, original.thread.workspace)
  assert.equal(currentThread.remoteId, original.thread.remoteId)
  const requests = new Map()
  let latestRelevantCall
  let found
  for (const record of tape.records) {
    if (record.kind === 'recover-request') {
      requests.set(record.value.callId, record)
      if (
        record.value.args[0]?.consumers?.some((value) => value.sessionId === original.thread.id)
      ) {
        latestRelevantCall = record.value.callId
        found = undefined
      }
    }
    if (record.kind !== 'recover-fulfilled') continue
    const request = requests.get(record.value.callId)
    assert.ok(request, 'A recovery result belongs to an observed genuine request')
    assert.deepEqual(record.value.sender, request.value.sender)
    const input = request.value.args[0]
    const consumer = input?.consumers?.find((value) => value.sessionId === original.thread.id)
    if (!consumer) continue
    if (record.value.callId !== latestRelevantCall) continue
    assert.equal(consumer.kind, 'main')
    assert.equal(consumer.profileId, original.thread.profileId)
    assert.equal(consumer.workspace, original.thread.workspace)
    assert.equal(consumer.remoteId, original.thread.remoteId)
    const owners = record.value.result.owners.filter(
      (value) => value.sessionId === original.thread.id,
    )
    assert.equal(owners.length, 1)
    const owner = owners[0]
    if (!owner.pending?.some((value) => value.requestId === original.event.requestId)) continue
    const native = original.event.nativeRecovery
    assert.equal(owner.status, 'running')
    assert.equal(owner.transportId, native.transportId)
    assert.equal(owner.provider, original.thread.provider)
    assert.equal(owner.remoteId, original.thread.remoteId)
    assert.equal(owner.snapshotToken, native.snapshotToken)
    assert.equal(owner.ownerGeneration, native.ownerGeneration)
    assert.equal(owner.localTurn, original.thread.turn)
    assert.equal(owner.originalInput.sessionId, original.thread.id)
    assert.equal(owner.originalInput.provider, original.thread.provider)
    assert.equal(owner.originalInput.workspace, original.thread.workspace)
    const prompt = original.thread.messages.find((value) => value.role === 'user').text
    assert.equal(owner.originalInput.prompt, prompt)
    assert.ok(owner.deliveryToken)
    const pending = owner.pending.filter((value) => value.requestId === original.event.requestId)
    assert.equal(pending.length, 1)
    assert.deepEqual(canonicalEvent(pending[0]), canonicalEvent(original.event))
    for (const field of [
      'transportId',
      'eventId',
      'revision',
      'snapshotToken',
      'ownerGeneration',
      'localTurn',
      'emittedAt',
    ])
      assert.equal(pending[0].nativeRecovery?.[field], native[field], field)
    found = { request, response: record, owner, pending: pending[0] }
  }
  assert.ok(found, 'Current Main returned the original pending control for this exact native owner')
  return found
}

module.exports = { hash, readTape, readJournal, bindPermission, recoverPending }
