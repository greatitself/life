// Transparent observations only: original inputs, outputs and Promises are retained unchanged.
function installMain({ ipcMain }, options) {
  const fs = process.getBuiltinModule('node:fs/promises')
  const { Worker } = process.getBuiltinModule('node:worker_threads')
  const probe = { phase: 'idle', ipc: [], workers: [], journal: [], timers: {} }
  const observe = (promise, success, failure) => {
    if (promise?.then) promise.then(success, failure)
    else success(promise)
    return promise
  }
  if (options?.observeJournal === true) {
    const open = fs.open
    fs.open = function (...args) {
      const pending = Reflect.apply(open, this, args)
      return observe(
        pending,
        (file) => {
          const path = String(args[0])
          if (!/\/native-recovery\/[a-f0-9]{64}\.jsonl$/.test(path)) return
          const entry = { path, phase: probe.phase, writes: [], syncs: [] }
          probe.journal.push(entry)
          const write = file.write
          file.write = function (...writeArgs) {
            const record = { phase: probe.phase, startedAt: performance.now(), args: writeArgs }
            entry.writes.push(record)
            const result = Reflect.apply(write, this, writeArgs)
            return observe(
              result,
              (value) => {
                record.bytesWritten = value.bytesWritten
                record.endedAt = performance.now()
              },
              (error) => {
                record.error = String(error)
                record.endedAt = performance.now()
              },
            )
          }
          const sync = file.sync
          file.sync = function (...syncArgs) {
            const record = { phase: probe.phase, startedAt: performance.now() }
            entry.syncs.push(record)
            const result = Reflect.apply(sync, this, syncArgs)
            return observe(
              result,
              () => {
                record.success = true
                record.endedAt = performance.now()
              },
              (error) => {
                record.error = String(error)
                record.endedAt = performance.now()
              },
            )
          }
        },
        () => {},
      )
    }
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message, ...args) {
      probe.workers.push({
        direction: 'request',
        threadId: this.threadId,
        phase: probe.phase,
        at: performance.now(),
        message,
      })
      return Reflect.apply(post, this, [message, ...args])
    }
    const emit = Worker.prototype.emit
    Worker.prototype.emit = function (name, message, ...args) {
      if (name === 'message')
        probe.workers.push({
          direction: 'response',
          threadId: this.threadId,
          phase: probe.phase,
          at: performance.now(),
          message,
        })
      return Reflect.apply(emit, this, [name, message, ...args])
    }
  }
  for (const channel of ['conversations:save', 'conversations:checkpoint']) {
    const handler = ipcMain._invokeHandlers.get(channel)
    if (!handler) throw new Error('Missing actual native history handler: ' + channel)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (...args) => {
      const record = { channel, phase: probe.phase, at: performance.now(), args }
      probe.ipc.push(record)
      try {
        const pending = handler(...args)
        record.returnedAt = performance.now()
        return observe(
          pending,
          (result) => {
            record.result = result
            record.ackAt = performance.now()
          },
          (error) => {
            record.error = String(error)
            record.ackAt = performance.now()
          },
        )
      } catch (error) {
        record.error = String(error)
        record.ackAt = performance.now()
        throw error
      }
    })
  }
  globalThis.__nativeRegistryPerformanceMain = probe
}
function startMain(_, phase) {
  const p = globalThis.__nativeRegistryPerformanceMain
  p.phase = phase
  const record = { start: performance.now(), ticks: 0, maxLagMs: 0 }
  let previous = record.start
  record.timer = setInterval(() => {
    const now = performance.now()
    record.maxLagMs = Math.max(record.maxLagMs, Math.max(0, now - previous - 4))
    record.ticks++
    previous = now
  }, 4)
  p.timers[phase] = record
}
function stopMain() {
  const p = globalThis.__nativeRegistryPerformanceMain
  const timer = p.timers[p.phase]
  clearInterval(timer.timer)
  timer.end = performance.now()
  p.phase = 'idle'
}
function readMain() {
  const p = globalThis.__nativeRegistryPerformanceMain
  const crypto = process.getBuiltinModule('node:crypto')
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
  const output = { timers: {}, ipc: [], worker: [], journal: [] }
  for (const [phase, { timer, ...record }] of Object.entries(p.timers))
    output.timers[phase] = record
  for (const item of p.ipc) {
    const input = item.args[1]
    const checkpoint = item.channel.endsWith('checkpoint')
    const admissions = checkpoint ? input?.projectionAdmissions : item.args[3]
    output.ipc.push({
      channel: item.channel,
      phase: item.phase,
      at: item.at,
      synchronousHandlerMs: item.returnedAt - item.at,
      apiAckMs: item.ackAt - item.at,
      savedAt: checkpoint ? input.savedAt : item.args[2],
      inputBytes: Buffer.byteLength(JSON.stringify(input)),
      projectionAdmissions: Array.isArray(admissions) ? admissions.length : 0,
      appends: checkpoint
        ? input.upserts?.flatMap((row) =>
            (row.messages.fields || []).flatMap((field) =>
              Object.entries(field.append || {}).map(([key, value]) => ({
                id: field.id,
                key,
                baseLength: value.baseLength,
                characters: value.value.length,
                sha256: digest(Buffer.from(value.value)),
              })),
            ),
          )
        : [],
      result: item.result,
      error: item.error,
    })
  }
  for (const item of p.workers) {
    const m = item.message
    if (item.direction === 'request' && m?.command)
      output.worker.push({
        phase: item.phase,
        at: item.at,
        threadId: item.threadId,
        direction: item.direction,
        id: m.id,
        command: m.command.type,
      })
    if (item.direction === 'response' && m?.type === 'recoveryPrepare')
      output.worker.push({
        phase: item.phase,
        at: item.at,
        threadId: item.threadId,
        direction: item.direction,
        type: m.type,
        admissionId: m.admissionId,
        hash: m.proof.hash,
        savedAt: m.proof.savedAt,
        snapshotId: m.proof.receipt.snapshotId,
        projectionAdmissions: Array.isArray(m.projectionAdmissions)
          ? m.projectionAdmissions.length
          : 0,
        owners: m.proof.receipt.owners,
      })
    if (
      item.direction === 'response' &&
      m?.id !== undefined &&
      m.result &&
      !(m.result instanceof ArrayBuffer)
    )
      output.worker.push({
        phase: item.phase,
        at: item.at,
        threadId: item.threadId,
        direction: item.direction,
        id: m.id,
        savedAt: m.result.savedAt,
        nativeRecovery: m.result.nativeRecovery,
        nativeRecoveryHash: m.result.nativeRecoveryHash,
        error: m.error,
      })
  }
  for (const entry of p.journal) {
    const writes = entry.writes.filter((write) => !write.error && write.bytesWritten > 0)
    if (!writes.length) continue
    const pieces = writes.map((write) => {
      const buffer = write.args[0]
      if (!Buffer.isBuffer(buffer)) throw new Error('Unexpected native journal write signature')
      return buffer.subarray(write.args[1] || 0, (write.args[1] || 0) + write.bytesWritten)
    })
    const bytes = Buffer.concat(pieces)
    const batches = bytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const records = batches.flatMap((batch) => batch.records)
    const raw = records.filter(
      (record) => record.kind === 'output' && record.frame.type === 'stdout',
    )
    output.journal.push({
      path: entry.path,
      phase: entry.phase,
      bytes: bytes.length,
      firstWriteAt: writes[0].startedAt,
      lastWriteAt: writes.at(-1).endedAt,
      syncs: entry.syncs,
      batchHashes: batches.map((batch) => batch.hash),
      rawStdoutBytes: raw.reduce(
        (n, record) => n + Buffer.from(record.frame.data, 'base64').length,
        0,
      ),
      records: records.filter((record) => ['history-prepare', 'history-ack'].includes(record.kind)),
      rawOutputCursors: raw.map((record) => record.frame.cursor),
      recordKinds: records.reduce((counts, record) => {
        counts[record.kind] = (counts[record.kind] || 0) + 1
        return counts
      }, {}),
    })
  }
  return output
}
function installRenderer() {
  const p = { characters: 0, textEvents: 0, phases: [], current: undefined }
  window.__nativeRegistryPerformanceRenderer = p
  p.submitFlush = () => {
    const record = p.current
    if (!record || record.flushStartedAt !== undefined) return
    record.outputObservedAt = p.lastTextAt
    record.flushStartedAt = performance.now()
    const pending = window.__lifeFlushConversationHistory()
    record.rendererSubmissionMs = performance.now() - record.flushStartedAt
    p.flush = pending.then(
      () => {
        record.flushAckAt = performance.now()
      },
      (error) => {
        record.flushError = String(error)
        record.flushAckAt = performance.now()
        throw error
      },
    )
  }
  p.unsubscribe = window.relay.onAgent((event) => {
    if (event.type === 'text' && event.itemId === p.itemId && event.status !== 'replace') {
      p.characters += event.text.length
      p.textEvents++
      p.lastTextAt = performance.now()
      // The App listener has queued this exact delta. Start the real flush now
      // so its automatic timer cannot make the measured submission a no-op.
      if (p.current && p.characters >= p.current.targetCharacters) p.submitFlush()
    }
  })
}
function startRenderer({ phase, itemId, targetCharacters }) {
  const p = window.__nativeRegistryPerformanceRenderer
  p.itemId = itemId
  const record = {
    phase,
    start: performance.now(),
    beforeCharacters: p.characters,
    targetCharacters,
    ticks: 0,
    maxLagMs: 0,
  }
  let previous = record.start
  record.timer = setInterval(() => {
    const now = performance.now()
    record.maxLagMs = Math.max(record.maxLagMs, Math.max(0, now - previous - 4))
    record.ticks++
    previous = now
  }, 4)
  p.phases.push(record)
  p.current = record
  p.flush = undefined
}
function submitFlush() {
  window.__nativeRegistryPerformanceRenderer.submitFlush()
}
async function finishRenderer() {
  const p = window.__nativeRegistryPerformanceRenderer
  if (!p.flush?.then) throw new Error('The native target delta never started its real App flush')
  await p.flush
  await new Promise((done) => setTimeout(done, 12))
  const record = p.current
  clearInterval(record.timer)
  const { timer, ...result } = record
  result.characters = p.characters - record.beforeCharacters
  result.rendererFlushAckMs = record.flushAckAt - record.flushStartedAt
  result.releaseToRendererObservedMs = record.outputObservedAt - record.start
  p.current = undefined
  return result
}
module.exports = {
  installMain,
  startMain,
  stopMain,
  readMain,
  installRenderer,
  startRenderer,
  submitFlush,
  finishRenderer,
}
