#!/usr/bin/env node
// Supplemental read-only artifact verification; it does not alter the matched fixture.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFile, lstat } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const digest = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
const privateJSON = async (path) => {
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${path} is a regular artifact file`)
  const bytes = await readFile(path)
  return { path, bytesSha256: digest(bytes), value: JSON.parse(bytes.toString('utf8')) }
}

async function main() {
  const directory = resolve(process.argv[2] || '')
  assert.ok(process.argv[2], 'Pass the completed candidate fixture artifact directory')
  const proof = JSON.parse(await readFile(join(directory, 'proof.json'), 'utf8'))
  assert.equal(proof.baseline, false)
  assert.equal(proof.failure, undefined)
  const verified = []
  for (const completed of proof.cases) {
    const result = JSON.parse(await readFile(join(directory, completed.name + '.json'), 'utf8'))
    const actionReceipts = result.actionReceipts || result.receipts
    if (
      !result.sourceAfter?.path ||
      !actionReceipts?.some(
        (record) => record.kind === 'source-apply' && record.status === 'succeeded',
      )
    )
      continue
    const state = await privateJSON(join(result.sourceAfter.path, 'state.json'))
    const actions = actionReceipts.filter(
      (record) => record.kind === 'source-apply' && record.status === 'succeeded',
    )
    const userData = result.launches.at(-1).userData
    for (const action of actions) {
      const ledger = await privateJSON(
        join(userData, 'native-recovery-actions', digest(action.actionId) + '.json'),
      )
      const { record, checksum } = ledger.value
      assert.equal(checksum, digest(canonical(record)))
      assert.equal(record.intentHash, digest(canonical(record.request.intent)))
      assert.equal(record.request.actionId, action.actionId)
      assert.equal(record.request.transportId, action.transportId)
      assert.equal(record.request.ownerGeneration, action.ownerGeneration)
      assert.equal(record.request.kind, 'source-apply')
      assert.equal(record.status, 'succeeded')
      assert.deepEqual(record.receipt.native, action.native)
      const markers = state.value.recoveryActions.filter(
        (marker) => marker.actionId === action.actionId,
      )
      assert.equal(markers.length, 1)
      const marker = markers[0]
      assert.equal(marker.intentHash, record.intentHash)
      let snapshot = marker.snapshot
      let immutable
      if (!snapshot) {
        immutable = await privateJSON(
          join(
            result.sourceAfter.path,
            'revisions',
            String(marker.revision),
            'recovery-action.json',
          ),
        )
        const { checksum: snapshotChecksum, ...payload } = immutable.value
        assert.equal(immutable.value.format, 'life-source-recovery-action')
        assert.equal(immutable.value.version, 1)
        assert.equal(snapshotChecksum, digest(JSON.stringify(payload)))
        assert.equal(marker.snapshotHash, snapshotChecksum)
        for (const key of ['actionId', 'intentHash', 'payloadHash', 'revision'])
          assert.equal(payload[key], marker[key])
        snapshot = payload.snapshot
        assert.equal(snapshot.revision, marker.revision)
      }
      assert.deepEqual(snapshot, record.receipt.snapshot)
      assert.equal(snapshot.active.revision, snapshot.revision)
      if (result.outcome === 'verified-source-commit-reconciled-with-crash-safety-fallback') {
        assert.equal(result.sourceAfter.enabled, false)
        assert.equal(result.sourceAfter.active, undefined)
        assert.equal(result.sourceAfter.recovered, true)
        assert.match(result.sourceAfter.error, /did not close cleanly/)
        assert.equal(state.value.enabled, false)
        assert.equal(state.value.current, result.committedRevision)
        assert.equal(snapshot.revision, result.committedRevision)
        assert.equal(
          digest(
            await readFile(
              join(
                result.sourceAfter.path,
                'revisions',
                String(result.committedRevision),
                'dist',
                'entry.js',
              ),
            ),
          ),
          result.compiledSha256,
        )
      } else assert.equal(snapshot.revision, result.sourceAfter.active.revision)
      assert.equal(snapshot.enabled, true)
      verified.push({
        name: completed.name,
        actionId: action.actionId,
        revision: snapshot.revision,
        ledgerSha256: ledger.bytesSha256,
        stateSha256: state.bytesSha256,
        ...(immutable
          ? {
              immutableSnapshotSha256: immutable.bytesSha256,
              snapshotChecksum: immutable.value.checksum,
            }
          : { legacyInlineSnapshot: true }),
      })
    }
  }
  assert.ok(
    verified.length,
    'The completed candidate proof includes at least one source-apply receipt',
  )
  process.stdout.write(
    JSON.stringify(
      {
        scope: 'read-only candidate source action linkage/checksum verification',
        verifierSha256: digest(await readFile(__filename)),
        candidateMainSha256: proof.mainSha256,
        verified,
      },
      null,
      2,
    ) + '\n',
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
