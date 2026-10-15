// Loaded by stock Electron's explicit -r before the unmodified application.
const { appendFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
const { createHash } = require('node:crypto')
const { serialize, errorDTO } = require('./portable-wire.cjs')

function install(electron, configuration, append = appendFileSync) {
  let sequence = 0
  let previousHash = null
  let invocation = 0
  let applicationCaptured = false
  const failures = []
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  function observationFailed(error) {
    let message = 'Unprintable observer failure'
    try {
      message = String(error)
    } catch {}
    failures.push(message)
  }
  function capture(kind, value) {
    try {
      const bytes = serialize(value)
      const payload = {
        format: 'life-native-recovery-observer',
        version: 2,
        sequence: sequence + 1,
        previousHash,
        nativePID: process.pid,
        observedAt: Date.now(),
        kind,
        serializedBase64: bytes.toString('base64'),
        serializedSha256: hash(bytes),
      }
      const recordHash = hash(JSON.stringify(payload))
      append(configuration.tape, JSON.stringify({ ...payload, hash: recordHash }) + '\n', {
        mode: 0o600,
      })
      sequence++
      previousHash = recordHash
    } catch (error) {
      // Observation cannot change a production result, rejection or cancellation.
      observationFailed(error)
    }
  }
  function provenance(event) {
    try {
      return {
        contentsId: event.sender?.id,
        frameProcessId: event.senderFrame?.processId,
        frameRoutingId: event.senderFrame?.routingId,
        url: event.senderFrame?.url,
      }
    } catch (error) {
      observationFailed(error)
      return { observerError: 'Sender provenance could not be observed' }
    }
  }
  function observe(kind, value) {
    try {
      capture(kind, value())
    } catch (error) {
      observationFailed(error)
    }
  }
  const originalHandle = electron.ipcMain.handle
  electron.ipcMain.handle = function (channel, listener) {
    if (!applicationCaptured && channel === 'agent:start' && typeof listener === 'function') {
      applicationCaptured = true
      observe('application-at-main-registration', () => ({
        appPath: electron.app.getAppPath(),
        name: electron.app.getName(),
        version: electron.app.getVersion(),
        userData: electron.app.getPath('userData'),
        observerFailures: failures,
      }))
    }
    if (channel !== 'agent:recover' || typeof listener !== 'function')
      return Reflect.apply(originalHandle, this, arguments)
    capture('recover-handler-registration', { channel })
    return Reflect.apply(originalHandle, this, [
      channel,
      function (event, ...args) {
        const callId = ++invocation
        const sender = provenance(event)
        capture('recover-request', { callId, sender, args })
        let result
        try {
          result = Reflect.apply(listener, this, [event, ...args])
        } catch (error) {
          observe('recover-rejected', () => ({ callId, sender, error: errorDTO(error) }))
          throw error
        }
        if (result instanceof Promise) {
          try {
            Promise.prototype.then.call(
              result,
              (value) => capture('recover-fulfilled', { callId, sender, result: value }),
              (error) =>
                observe('recover-rejected', () => ({ callId, sender, error: errorDTO(error) })),
            )
          } catch (error) {
            observationFailed(error)
          }
        } else capture('recover-fulfilled', { callId, sender, result })
        return result
      },
    ])
  }
  electron.app.on('web-contents-created', (_event, contents) => {
    const originalSend = contents.send
    contents.send = function (channel, ...args) {
      let result
      try {
        result = Reflect.apply(originalSend, this, [channel, ...args])
      } catch (error) {
        if (channel === 'agent:event')
          observe('agent-event-send-rejected', () => ({
            contentsId: contents.id,
            args,
            error: errorDTO(error),
          }))
        throw error
      }
      if (channel === 'agent:event')
        observe('agent-event-sent', () => ({ contentsId: contents.id, args }))
      return result
    }
  })
  electron.app.once('ready', () => capture('electron-ready-observed', {}))
  electron.app.on('will-quit', () => capture('observer-status', { failures }))
  capture('observer-installed-before-main', {
    expectedAppPath: configuration.appPath,
    explicitElectronPreload: true,
  })
  return { failures, capture }
}

module.exports = { install }
if (process.type === 'browser') {
  const tape = process.env.LIFE_TEST_MAIN_OBSERVER_TAPE
  const appPath = process.env.LIFE_TEST_APP_PATH
  if (!tape || !appPath) throw new Error('The private observer requires its own tape and app path')
  mkdirSync(dirname(tape), { recursive: true, mode: 0o700 })
  globalThis.__lifeMainObserver = install(require('electron'), { tape, appPath })
}
