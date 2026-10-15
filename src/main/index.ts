import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Store } from './store'
import { ConversationStore, type ConversationStoreOptions } from './conversation-store'
import {
  ConversationHistoryLifecycle,
  finishNativeShutdownEffect,
  type CapturedHistoryDocument,
} from './conversation-history-lifecycle'
import { runEffect } from './effect-runtime'
import { SSHConnection } from './ssh'
import { Agents } from './agents'
import {
  connectSchema,
  profileSchema,
  remoteDirectorySchema,
  startSchema,
  agentSettingsSchema,
  agentSteerSchema,
} from '../shared/validation'
import { z } from 'zod'
import { Effect, ManagedRuntime, Schema, Semaphore } from 'effect'
import { CustomizationStore } from './customization'
import { listSSHConfig, resolveSSHConfig } from './ssh-config'
import { UpdatesService } from './updater'
import { ExtensionStore } from './extensions'
import {
  extensionIdSchema,
  extensionMethodSchema,
  parseExtensionPayload,
} from '../shared/extensions'
import { extensionCoreArguments } from '../shared/extension-core'
import { buildExtensionDocument, extensionDocumentCSP } from '../shared/extension-document'
import { SourceCodeStore } from './source-code'
import { PackagedDependencies } from './packaged-dependencies'
import { executeConnectionCommandEffect } from './connection-execution'
import { ApplicationRuntime } from './application-runtime'
import { AgentHistory } from './agent-history'
import { builtinExtensionCatalog } from '../shared/builtin-extensions'
import { parseLifeSourcePatch, parseLifeSourceRead } from '../shared/source-code'
import { ExtensionSharing } from './extension-sharing'
import { canonicalPublicGistURL } from '../shared/extension-sharing'
import {
  RendererDocumentAdmission,
  RendererRecoveryBudget,
  RendererReloadFlights,
  isNativeMainDocumentNavigation,
  requestsRendererReload,
} from './renderer-recovery'
import { ResearchDocuments } from './research-documents'
import { isTrustedRendererSender } from './renderer-ipc'
import { ProviderUpdateController } from './provider-updates'
import { NativeRecoveryStore } from './native-recovery-store'
import type { NativeRecoveryStoreHandle } from './native-recovery-store'
import {
  NativeRecoveryActions,
  NativeRecoveryActionError,
  makeStudioRecoveryActionDrivers,
  nativeRecoveryActionRequestSchema,
} from './native-recovery-actions'
import type { NativeRecoveryActionsHandle } from './native-recovery-actions'
import {
  unavailableNativeRecoveryActions,
  unavailableNativeRecoveryStore,
} from './native-recovery-fallback'
import { NativeDocumentReadiness } from './native-document-readiness'
import {
  assessNativeRecoveryPlatformEffect,
  blockedNativeRecoveryPlatformPolicy,
} from './native-recovery-platform'

app.setName('Life')
protocol.registerSchemesAsPrivileged([
  { scheme: 'life-extension', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'life-code',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

let window: BrowserWindow | null = null
let ssh: SSHConnection
let customization: CustomizationStore
let updates: UpdatesService
let providerUpdates: ProviderUpdateController | undefined
let extensions: ExtensionStore
let sourceCode: SourceCodeStore
let hostHistory: AgentHistory | undefined
let conversations: ConversationStore | undefined
let applicationRuntime: ApplicationRuntime | undefined
let nativeRecoveryRuntime: ManagedRuntime.ManagedRuntime<NativeRecoveryStore, unknown> | undefined
let nativeActionRuntime: ManagedRuntime.ManagedRuntime<NativeRecoveryActions, unknown> | undefined
let flushNativeRecovery = async (): Promise<void> => {}
let settleRendererOperations = async (): Promise<void> => {}
let detachNativeRecovery = async (): Promise<void> => {}
let finalizeRendererSuspension = () => {}
let rendererHandoffAdmitted = async (): Promise<boolean> => false
let rendererWorkPending = () => true
let providerRetirementPending = () => false
let rendererHandoff: { documentId: string; promise: Promise<void> } | undefined
let suspendedRendererDocument: string | undefined
let sourceStartupTimer: ReturnType<typeof setTimeout> | undefined
let sourceReloadTimer: ReturnType<typeof setTimeout> | undefined
let quitting = false
let recovering = false
let cancelRendererSessions = () => {}
let releaseIdleProviders = async (): Promise<void> => {}
let releaseProvidersOnQuit = async (): Promise<void> => {}
let reloadRendererWhenIdle = (): Promise<void> => Promise.resolve()
const rendererRecoveryBudget = new RendererRecoveryBudget()
const nativeDocuments = new NativeDocumentReadiness()
const recoveryMutationChannels = new Set([
  'agent:reserve-recovery-owner',
  'agent:update-recovery-owner',
  'agent:acknowledge-recovery-history',
  'agent:prepare-recovery-cache',
  'agent:perform-recovery-action',
])
const rendererAdmissions = new WeakMap<BrowserWindow, RendererDocumentAdmission>()
const historyLifecycle = new ConversationHistoryLifecycle()
const extensionRecoveryStartups = new WeakSet<BrowserWindow>()
const researchDocuments = new ResearchDocuments()
const assertRendererAdmission = (channel: string) => {
  const admission = window ? rendererAdmissions.get(window) : undefined
  if (!admission) throw new Error('Life window is unavailable.')
  if (historyLifecycle.failure && recoveryMutationChannels.has(channel))
    throw historyLifecycle.failure
  historyLifecycle.admit(admission, channel)
}
const permitsRendererAdmission = (channel: string) => {
  try {
    assertRendererAdmission(channel)
    return true
  } catch {
    return false
  }
}
function captureHistoryDocument(owner: BrowserWindow | null): CapturedHistoryDocument | undefined {
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return
  const admission = rendererAdmissions.get(owner)
  if (!admission) return
  const frame = owner.webContents.mainFrame
  const documentId = nativeDocuments.capture().documentId
  const ownsNativeDocument = () => {
    try {
      return nativeDocuments.capture().documentId === documentId
    } catch {
      return false
    }
  }
  return historyLifecycle.capture(
    admission,
    () =>
      owner === window &&
      !owner.isDestroyed() &&
      !owner.webContents.isDestroyed() &&
      owner.webContents.mainFrame === frame &&
      rendererAdmissions.get(owner) === admission &&
      ownsNativeDocument(),
  )
}
const reportShutdownFailure = (error: unknown) => {
  console.error('[Life] Native shutdown could not confirm completion:', error)
}
async function cancelRendererWork(
  owner = window,
  waitForIdleProviders = false,
  ownsDocument?: () => boolean,
  retirementPending?: () => boolean,
): Promise<void> {
  historyLifecycle.assertHealthy()
  const document = captureHistoryDocument(owner)
  const current = () =>
    (!ownsDocument || ownsDocument()) && (!document || document.ownsDocument()) && !quitting
  if (!current()) throw new Error('The interface handoff belongs to an earlier Life document.')
  if (owner) rendererAdmissions.get(owner)?.suspend()
  researchDocuments.clear()
  const requests = ssh?.cancelRendererRequests()
  // Claim the old document's drain before any await. A manual native navigation
  // can commit a new UUID while its history and provider observations are pending.
  const history = flushConversationHistory(owner, document)
  cancelRendererSessions()
  hostHistory?.cancelAll()
  const retireIdle = !rendererWorkPending() && providerRetirementPending()
  const retirement = retireIdle
    ? releaseIdleProviders().then(
        () => ({ success: true as const }),
        (error: unknown) => ({ success: false as const, error }),
      )
    : undefined
  await runEffect(
    historyLifecycle.handoffEffect(
      undefined,
      undefined,
      Effect.tryPromise({
        try: async () => {
          await requests
          await history
          document?.admission.sealHistoryWrites(document.revision)
          await runEffect(historyLifecycle.settledEffect(conversations, document))
          const retired = await retirement
          // A joined idle release may cover an older target snapshot. Recollect
          // only while this document still owns the retirement request.
          if (retired?.success && waitForIdleProviders)
            while (retirementPending?.()) {
              if (!current()) break
              await releaseIdleProviders()
            }
          await settleRendererOperations()
          await flushNativeRecovery()
          finalizeRendererSuspension()
          if (retired && !retired.success) throw retired.error
          if (!(await rendererHandoffAdmitted()))
            throw new Error('Native ownership remains uncertain. The new interface stays paused.')
        },
        catch: (error) => error,
      }),
    ),
  )
}
function beginRendererHandoff(
  owner = window,
  waitForIdleProviders = false,
  ownsDocument?: () => boolean,
  retirementPending?: () => boolean,
): Promise<void> {
  if (rendererHandoff) return rendererHandoff.promise
  historyLifecycle.assertHealthy()
  const documentId = nativeDocuments.capture().documentId
  if (suspendedRendererDocument === documentId) return Promise.resolve()
  const handoff = { documentId, promise: Promise.resolve() }
  rendererHandoff = handoff
  handoff.promise = cancelRendererWork(owner, waitForIdleProviders, ownsDocument, retirementPending)
    .then(() => {
      suspendedRendererDocument = documentId
    })
    .finally(() => {
      if (rendererHandoff === handoff) rendererHandoff = undefined
    })
  return handoff.promise
}
async function flushConversationHistory(
  owner: BrowserWindow | null,
  document = captureHistoryDocument(owner),
): Promise<void> {
  if (!owner || owner.isDestroyed()) return
  const contents = owner.webContents
  if (
    contents.isDestroyed() ||
    contents.isCrashed() ||
    contents.isLoadingMainFrame() ||
    !document?.ownsDocument()
  )
    return
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    // A frozen customized renderer cannot block native recovery indefinitely.
    await Promise.race([
      contents.executeJavaScript(
        'typeof window.__lifeFlushConversationHistory === "function" ? window.__lifeFlushConversationHistory(true) : undefined',
      ),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 3_000)
      }),
    ])
  } catch {
    // The bounded periodic checkpoint remains available after renderer death.
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
  }
}
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
})
async function recoverExtensions() {
  historyLifecycle.assertHealthy()
  if (quitting || recovering || !extensions) return
  recovering = true
  const owner = window
  const document = captureHistoryDocument(owner)
  try {
    if (owner && !owner.isDestroyed()) {
      const mainFrame = owner.webContents.mainFrame
      const frameProcesses = new Set<number>()
      for (const frame of mainFrame.framesInSubtree) {
        try {
          if (
            frame !== mainFrame &&
            frame.url.startsWith('life-extension:') &&
            frame.osProcessId > 0 &&
            frame.osProcessId !== process.pid
          )
            frameProcesses.add(frame.osProcessId)
        } catch {
          /* A frame can disappear during emergency recovery. */
        }
      }
      // Cross-process iframe loops survive a parent renderer crash. Terminate only
      // the renderer processes belonging to this window's extension frames.
      for (const pid of frameProcesses) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
    }
    await beginRendererHandoff(owner)
    if (quitting || (owner && !document?.ownsDocument())) return
    ssh?.disconnect()
    clearTimeout(sourceStartupTimer)
    await sourceCode?.disable()
    if (quitting || (owner && !document?.ownsDocument())) return
    await Promise.all(
      extensions
        .list()
        .filter((extension) => extension.enabled)
        .map((extension) => extensions.enable(extension.id, false)),
    )
    // Main-process recovery remains usable even when generated UI is stuck in a CPU loop.
    if (!quitting && owner && !owner.isDestroyed() && document?.ownsDocument()) {
      createWindow(owner, true)
      owner.destroy()
    }
  } finally {
    recovering = false
  }
}
async function restartInterface(owner: BrowserWindow, sourceFailure?: string) {
  historyLifecycle.assertHealthy()
  if (owner !== window || owner.isDestroyed() || recovering || quitting) return
  recovering = true
  const document = captureHistoryDocument(owner)
  try {
    clearTimeout(sourceStartupTimer)
    // A replacement receives only native replay admitted against its saved
    // history, while the provider and selected project retain their ownership.
    await beginRendererHandoff(owner)
    if (!document?.ownsDocument()) return
    if (sourceFailure && sourceCode?.get().enabled) await sourceCode.disable(sourceFailure)
    if (owner !== window || owner.isDestroyed() || quitting || !document?.ownsDocument()) return
    createWindow(owner)
    owner.destroy()
  } finally {
    recovering = false
  }
}
const send = (channel: string, data: unknown) => {
  if (!window || window.isDestroyed()) return false
  const contents = window.webContents
  if (contents.isDestroyed() || contents.isCrashed()) return false
  contents.send(channel, data)
  return true
}
function assertStartupActive(): void {
  if (quitting) throw new Error('Life is shutting down.')
}
async function init() {
  assertStartupActive()
  const store = new Store(app.getPath('userData'))
  await store.init()
  assertStartupActive()
  let recoveryPolicy = await runEffect(
    assessNativeRecoveryPlatformEffect({
      userData: app.getPath('userData'),
      exclusiveRuntime: ownsInstance,
    }),
  )
  assertStartupActive()
  let recoveryAgents: Agents | undefined
  customization = new CustomizationStore(app.getPath('userData'), (state) => {
    nativeTheme.themeSource = state.config.theme
    ssh?.forwarding.setEnabled(state.config.autoPortForward)
    window?.setBackgroundColor(state.config.theme === 'dark' ? '#161616' : '#ffffff')
    send('customization:state', state)
  })
  await customization.init()
  assertStartupActive()
  updates = new UpdatesService((state) => send('updates:state', state))
  await updates.init()
  assertStartupActive()
  const recoveryDirectory = join(app.getPath('userData'), 'native-recovery')
  let recoveryStore: NativeRecoveryStoreHandle | undefined
  if (recoveryPolicy.mode === 'durable') {
    nativeRecoveryRuntime = ManagedRuntime.make(
      NativeRecoveryStore.layer({ directory: recoveryDirectory, exclusiveRuntime: ownsInstance }),
    )
    try {
      recoveryStore = await nativeRecoveryRuntime.runPromise(NativeRecoveryStore)
    } catch (cause) {
      recoveryPolicy = blockedNativeRecoveryPlatformPolicy(app.getPath('userData'), cause)
      recoveryStore = unavailableNativeRecoveryStore(recoveryDirectory, cause)
    }
    assertStartupActive()
  } else if (recoveryPolicy.mode === 'blocked') {
    recoveryStore = unavailableNativeRecoveryStore(recoveryDirectory, recoveryPolicy.error)
  }
  const historyOptions: ConversationStoreOptions = {
    persistenceMode: recoveryPolicy.sourcePersistenceMode,
  }
  if (recoveryPolicy.mode === 'durable') {
    historyOptions.authorizeRecoveryReceipt = (candidate, admissions) =>
      recoveryAgents?.authorizeRecoveryReceiptEffect(candidate, admissions) ?? Effect.succeed(null)
    historyOptions.onCommitted = (ack) =>
      Effect.tryPromise({
        try: () => recoveryAgents?.acknowledgeCommittedHistory(ack) ?? Promise.resolve(),
        catch: (cause) => cause,
      })
  }
  conversations = new ConversationStore(app.getPath('userData'), historyOptions)
  ssh = new SSHConnection(store, {}, recoveryStore, recoveryPolicy)
  ssh.forwarding.setEnabled(customization.get().config.autoPortForward)
  const agents = new Agents(
    ssh,
    (event) => send('agent:event', event),
    recoveryStore,
    recoveryPolicy,
  )
  recoveryAgents = agents
  let nativeHistoryReconciled = false
  const nativeHistoryAdmission = Semaphore.makeUnsafe(1)
  const admitNativeHistory = Effect.fn('Life.admitNativeHistory')(() =>
    nativeHistoryAdmission.withPermits(1)(
      Effect.gen(function* () {
        if (nativeHistoryReconciled) return
        const proof = yield* conversations!.loadRecoveryReceiptEffect()
        if (proof) yield* agents.acknowledgeRecoveredHistoryProofEffect(proof)
        nativeHistoryReconciled = true
      }).pipe(
        // History/export stays available when private recovery evidence fails.
        // The native service retains uncertain ownership instead of advancing it.
        Effect.catch(() => Effect.void),
      ),
    ),
  )
  const attestLoadedHistory = Effect.fn('Life.attestLoadedHistory')(function* (input: unknown) {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
    )(input)
    const proof = yield* conversations!.loadRecoveryReceiptEffect()
    if (!proof || proof.hash !== request.hash) return []
    return yield* agents.admitLoadedHistoryProofEffect(proof)
  })
  providerUpdates = new ProviderUpdateController(
    () => ssh.state,
    (state) => send('provider-updates:state', state),
    {
      cachePath: join(app.getPath('userData'), 'provider-updates-cache.json'),
      refreshInstalled: () => ssh.refreshProviderVersions(),
    },
  )
  hostHistory = new AgentHistory(ssh)
  cancelRendererSessions = () => agents.suspendRendererConsumers()
  flushNativeRecovery = () => agents.flushRecovery()
  settleRendererOperations = () => agents.settleRendererHandoff()
  detachNativeRecovery = () => agents.detachForShutdown()
  finalizeRendererSuspension = () => agents.finalizeRendererSuspension()
  rendererHandoffAdmitted = () => agents.rendererHandoffAdmitted()
  rendererWorkPending = () => agents.hasPendingRendererWork()
  providerRetirementPending = () => agents.hasProviderRetirementTargets()
  releaseIdleProviders = async () => {
    const releases = await Promise.all([
      agents.releaseIdleProviders(),
      agents.releaseIdleClaudeProviders(),
    ])
    if (releases.some((results) => results.some((released) => !released)))
      throw new Error(
        'An idle provider has not confirmed its exit. The current interface is paused; use Restart Interface to recover.',
      )
    // Native exit can enqueue its final owner/history receipts. Join those
    // accepted operations before checking whether the old document still owns work.
    await agents.settleRendererHandoff()
    if (agents.hasPendingRendererWork(true))
      throw new Error('Native work still owns this interface. Use Restart Interface to recover.')
  }
  releaseProvidersOnQuit = async () => {
    const releases = await Promise.allSettled([
      agents.releaseIdleProviders(),
      agents.releaseIdleClaudeProviders(),
    ])
    for (const result of releases) {
      if (result.status === 'rejected') reportShutdownFailure(result.reason)
      else if (result.value.some((released) => !released))
        reportShutdownFailure(new Error('An idle native provider did not confirm its exit.'))
    }
  }
  const extensionSharing = new ExtensionSharing()
  ssh.on('state', (state) => {
    send('connection:state', state)
    providerUpdates?.connectionChanged()
  })
  ssh.on('host-key', (request) => send('connection:host-key', request))
  ssh.on('terminal', (data) => send('terminal:data', data))
  ssh.on('forwarding-state', (state) => send('forwarding:state', state))
  const operations = new ApplicationRuntime(assertRendererAdmission)
  applicationRuntime = operations
  let localApplies = 0
  const applyLocal = async <T>(operation: () => Promise<T>): Promise<T> => {
    localApplies++
    try {
      return await operation()
    } finally {
      localApplies--
    }
  }
  const handle = (name: string, fn: (...args: unknown[]) => unknown) => {
    operations.register(name, fn)
    ipcMain.handle(name, async (event, ...args: unknown[]) => {
      if (!isTrustedRendererSender(window, event)) throw new Error('Untrusted IPC sender')
      const incomingDocumentId = nativeDocuments.capture().documentId
      const handoff = rendererHandoff
      // A new document can load before the preceding document's accepted
      // history/owner work has drained. Hold its requests behind that receipt.
      if (handoff && incomingDocumentId !== handoff.documentId) {
        await handoff.promise
        if (
          !isTrustedRendererSender(window, event) ||
          nativeDocuments.capture().documentId !== incomingDocumentId
        )
          throw new Error('The request belongs to an earlier Life document.')
      }
      assertRendererAdmission(name)
      return operations.invoke(name, args, {
        beforeDispatch: () => {
          if (!isTrustedRendererSender(window, event)) throw new Error('Untrusted IPC sender')
          if (nativeDocuments.capture().documentId !== incomingDocumentId)
            throw new Error('The request belongs to an earlier Life document.')
          if (name === 'conversations:save' || name === 'conversations:checkpoint')
            assertRendererAdmission(name)
        },
      })
    })
  }
  const invokeCore = async (method: string, payload: unknown) => {
    const documentId = nativeDocuments.capture().documentId
    const beforeDispatch = () => {
      if (nativeDocuments.capture().documentId !== documentId)
        throw new Error('The extension request belongs to an earlier Life document.')
    }
    const args = extensionCoreArguments(method, parseExtensionPayload(payload))
    if (method === 'window.minimize') {
      window?.minimize()
      return null
    }
    if (method === 'window.maximize') {
      window?.isMaximized() ? window.unmaximize() : window?.maximize()
      return null
    }
    if (method === 'window.close') {
      window?.close()
      return null
    }
    if (method === 'terminal.write') {
      assertRendererAdmission('terminal:write')
      ssh.writeTerminal(z.string().max(100000).parse(args[0]))
      return null
    }
    if (method === 'terminal.resize') {
      assertRendererAdmission('terminal:resize')
      ssh.resizeTerminal(
        z.number().int().min(1).max(999).parse(args[0]),
        z.number().int().min(1).max(999).parse(args[1]),
      )
      return null
    }
    const channel =
      method === 'app.chooseKey'
        ? 'choose-key'
        : method === 'connection.selectWorkspace'
          ? 'connection:select-workspace'
          : method === 'connection.listDirectories'
            ? 'connection:list-directories'
            : method.startsWith('sshConfig.')
              ? method.replace('sshConfig.', 'ssh-config:')
              : method.startsWith('sourceCode.')
                ? (
                    {
                      'sourceCode.getContext': 'source-code:context',
                      'sourceCode.openFolder': 'source-code:open-folder',
                      'sourceCode.setExtensionEnabled': 'source-code:set-extension-enabled',
                      'sourceCode.removeExtension': 'source-code:remove-extension',
                      'sourceCode.exportExtension': 'source-code:export-extension',
                      'sourceCode.importExtension': 'source-code:import-extension',
                      'sourceCode.updateExtension': 'source-code:update-extension',
                    } as Record<string, string>
                  )[method] || method.replace('sourceCode.', 'source-code:')
                : method.replace('.', ':')
    if (!operations.has(channel)) throw new Error(`This Life method is unavailable: ${method}`)
    assertRendererAdmission(channel)
    const value = await operations.invoke(channel, args, { beforeDispatch })
    // Built-in snapshots may include optional undefined fields; worker RPC is strict JSON.
    return JSON.parse(JSON.stringify(value === undefined ? null : value))
  }
  extensions = new ExtensionStore(
    join(app.getPath('userData'), 'extensions'),
    (state) => send('extensions:state', state),
    (_id, method, args) => invokeCore(method, args),
    (id, event, data) => send('extensions:event', { id, type: 'event', event, data }),
  )
  const packagedDependencies = app.isPackaged
    ? new PackagedDependencies({
        sourceDirectory: join(app.getAppPath(), 'node_modules'),
        manifestPath: join(process.resourcesPath, 'life-dependencies.json'),
        cacheDirectory: join(app.getPath('userData'), 'source-code', 'compiler-cache'),
      })
    : undefined
  sourceCode = new SourceCodeStore({
    builtinExtensions: builtinExtensionCatalog,
    sourceDir: app.isPackaged ? join(process.resourcesPath, 'life-source') : app.getAppPath(),
    nodeModulesDir: join(app.getAppPath(), 'node_modules'),
    prepareNodeModules: packagedDependencies
      ? (signal) => packagedDependencies.ensure(signal)
      : undefined,
    directory: join(app.getPath('userData'), 'source-code'),
    persistenceMode: recoveryPolicy.sourcePersistenceMode,
    recoveryPlatform: recoveryPolicy,
    onUpdate: (state) => send('source-code:state', state),
  })
  await sourceCode.init()
  assertStartupActive()
  type PendingReload = {
    acknowledgement: Promise<void>
    cancel(): void
    allowActive(): void
  }
  const sourceReloads = new RendererReloadFlights<BrowserWindow | null, PendingReload>()
  const reloadSource = (waitForIdleSessions = false) => {
    if (historyLifecycle.failure) return Promise.reject(historyLifecycle.failure)
    const owner = window
    const document = captureHistoryDocument(owner)
    const requestedRevision = owner ? rendererAdmissions.get(owner)?.documentRevision : undefined
    const requestedDocumentId = nativeDocuments.capture().documentId
    const existing = sourceReloads.get(owner, requestedRevision, requestedDocumentId)
    if (existing) {
      if (!waitForIdleSessions) existing.allowActive()
      return existing.acknowledgement
    }
    let deferActive = waitForIdleSessions
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let acknowledge = () => {}
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    const clearTimer = () => {
      clearTimeout(timer)
      if (sourceReloadTimer === timer) sourceReloadTimer = undefined
      timer = undefined
    }
    const finish = () => {
      cancelled = true
      clearTimer()
      sourceReloads.clear(pending)
      acknowledge()
    }
    const pending: PendingReload = {
      acknowledgement,
      cancel: finish,
      allowActive: () => {
        deferActive = false
      },
    }
    sourceReloads.replace(owner, requestedRevision, pending, requestedDocumentId)?.cancel()
    const ownsDocument = () =>
      Boolean(
        !cancelled &&
        owner &&
        owner === window &&
        !owner.isDestroyed() &&
        !quitting &&
        document?.ownsDocument() &&
        rendererAdmissions.get(owner)?.documentRevision === requestedRevision &&
        nativeDocuments.capture().documentId === requestedDocumentId,
      )
    const schedule = (work: () => void, delay: number) => {
      clearTimer()
      const scheduled = setTimeout(() => {
        if (timer !== scheduled) return
        if (sourceReloadTimer === scheduled) sourceReloadTimer = undefined
        timer = undefined
        work()
      }, delay)
      timer = scheduled
      sourceReloadTimer = scheduled
    }
    const reloadRequestedAt = Date.now()
    let reportedHandoffBlock = false
    const canHandoff = async () => {
      const reportBlocked = !reportedHandoffBlock && Date.now() - reloadRequestedAt >= 2000
      if (reportBlocked) reportedHandoffBlock = true
      if (localApplies) {
        if (reportBlocked)
          console.error('[Life] Source reload is waiting for local changes:', { localApplies })
        return false
      }
      try {
        await agents.settleRendererHandoff()
        // Automatic development navigation retains the current React owner while
        // its native turn is active. Explicit reloads use the durable handoff.
        if (deferActive && agents.hasRunningSessions()) return false
        if (await agents.rendererHandoffAdmitted(reportBlocked)) return true
      } catch (error) {
        if (reportBlocked) console.error('[Life] Source reload ownership check failed:', error)
        return false
      }
      return (
        !agents.hasPendingRendererWork() &&
        (!agents.hasUntrackedRunningSessions() || agents.hasProviderRetirementTargets())
      )
    }
    const reloadWhenIdle = async () => {
      if (!owner || !ownsDocument() || historyLifecycle.failure) return finish()
      const admitted = await canHandoff()
      if (!ownsDocument() || historyLifecycle.failure) return finish()
      if (!admitted) {
        schedule(() => void reloadWhenIdle(), 200)
        return
      }
      // Keep the flight until the final native/history barrier has completed.
      acknowledge()
      schedule(() => {
        void (async () => {
          if (!ownsDocument()) return finish()
          const admitted = await canHandoff()
          if (!ownsDocument() || historyLifecycle.failure) return finish()
          if (!admitted) {
            schedule(() => void reloadWhenIdle(), 200)
            return
          }
          await beginRendererHandoff(
            owner,
            true,
            ownsDocument,
            () => agents.hasPendingRendererWork() || agents.hasProviderRetirementTargets(),
          )
          if (!ownsDocument() || historyLifecycle.failure) return
          // Accepted start/control work can enter while history is flushing.
          // Recheck its real durable ownership after every asynchronous barrier.
          if (
            (deferActive && agents.hasRunningSessions()) ||
            !(await agents.rendererHandoffAdmitted())
          ) {
            if (ownsDocument()) schedule(() => void reloadWhenIdle(), 200)
            return
          }
          if (!ownsDocument() || historyLifecycle.failure) return
          owner.webContents.reload()
        })()
          .catch((error) => {
            if (!quitting && ownsDocument()) {
              console.error('[Life] Source reload failed:', error)
              dialog.showErrorBox('Life reload failed', String(error))
            }
          })
          .finally(() => {
            if (timer === undefined) finish()
          })
      }, 100)
    }
    schedule(() => void reloadWhenIdle(), 100)
    return acknowledgement
  }
  reloadRendererWhenIdle = () => reloadSource(true)
  const actionDirectory = join(app.getPath('userData'), 'native-recovery-actions')
  let recoveryActions: NativeRecoveryActionsHandle = unavailableNativeRecoveryActions(
    actionDirectory,
    recoveryPolicy.error ?? new Error('Native recovery actions are unavailable on this platform.'),
  )
  if (recoveryPolicy.mode === 'durable') {
    nativeActionRuntime = ManagedRuntime.make(
      NativeRecoveryActions.layer({
        directory: actionDirectory,
        exclusiveRuntime: ownsInstance,
        drivers: makeStudioRecoveryActionDrivers({
          sourceCode,
          customization,
          extensions,
          captureReloadDocument: () => nativeDocuments.capture(),
          reload: async (request, prepared, signal) => {
            const revision = z.number().int().min(0).parse(request.intent.revision)
            if (!nativeDocuments.matches(prepared.originalDocumentId, revision)) {
              await reloadSource()
              await nativeDocuments.wait(prepared.originalDocumentId, revision, signal)
            }
          },
          reconcileReload: async (request, prepared) =>
            nativeDocuments.matches(
              prepared.originalDocumentId,
              z.number().int().min(0).parse(request.intent.revision),
            ),
        }),
      }),
    )
    try {
      recoveryActions = await nativeActionRuntime.runPromise(NativeRecoveryActions)
    } catch (cause) {
      recoveryActions = unavailableNativeRecoveryActions(actionDirectory, cause)
    }
    assertStartupActive()
  }
  const performRecoveryAction = Effect.fn('Life.performRecoveryAction')(function* (input: unknown) {
    yield* recoveryPolicy.assertNativeRecoveryEffect('perform-recovery-action').pipe(
      Effect.mapError(
        (cause) =>
          new NativeRecoveryActionError({
            operation: 'platform',
            path: actionDirectory,
            reason: 'unsupported',
            message: 'Native recovery actions are unavailable in this platform mode.',
            cause,
          }),
      ),
    )
    const request = yield* Schema.decodeUnknownEffect(nativeRecoveryActionRequestSchema)(
      input,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new NativeRecoveryActionError({
            operation: 'validate',
            path: actionDirectory,
            reason: 'invalid',
            message: 'Select an owned Studio action to continue.',
            cause,
          }),
      ),
    )
    const authorization = yield* Effect.tryPromise({
      try: () => agents.assertRecoveryActionOwner(request),
      catch: (cause) =>
        new NativeRecoveryActionError({
          operation: 'authorize',
          path: actionDirectory,
          reason: 'ownership',
          message: 'This Studio action no longer belongs to the active native owner.',
          cause,
        }),
    })
    return yield* authorization === 'reconcile-only'
      ? recoveryActions.reconcileOnly(request)
      : recoveryActions.perform(request)
  })
  const sourceFailure = async (revision: number, reason: string) => {
    if (!sourceCode.get().enabled || sourceCode.get().active?.revision !== revision) return
    const owner = window
    if (owner && !owner.isDestroyed()) await restartInterface(owner, reason)
  }
  handle('source-code:get', () => sourceCode.get())
  handle('source-code:context', (request) =>
    sourceCode.getContext(request === undefined ? undefined : parseLifeSourceRead(request)),
  )
  handle('source-code:apply', (patch) =>
    applyLocal(() => sourceCode.apply(parseLifeSourcePatch(patch))),
  )
  handle('source-code:set-extension-enabled', (id, enabled) =>
    applyLocal(() =>
      sourceCode.setExtensionEnabled(extensionIdSchema.parse(id), z.boolean().parse(enabled)),
    ),
  )
  handle('source-code:remove-extension', (id) =>
    applyLocal(() => sourceCode.removeExtension(extensionIdSchema.parse(id))),
  )
  handle('source-code:export-extension', (id) =>
    sourceCode.exportExtension(extensionIdSchema.parse(id)),
  )
  handle('source-code:import-extension', (bundle) =>
    applyLocal(() => sourceCode.importExtension(bundle)),
  )
  handle('source-code:update-extension', (bundle) =>
    applyLocal(() => sourceCode.updateExtension(bundle)),
  )
  handle('source-code:rollback', () => applyLocal(() => sourceCode.rollback()))
  handle('source-code:disable', () => sourceCode.disable())
  handle('source-code:reload', () => reloadSource())
  handle('source-code:ready', (value) => {
    const revision = z.number().int().min(0).parse(value)
    if (sourceCode.get().active?.revision === revision) {
      clearTimeout(sourceStartupTimer)
      if (window) nativeDocuments.ready(window, revision)
    }
  })
  handle('source-code:error', (value, reason) =>
    sourceFailure(z.number().int().min(0).parse(value), z.string().max(10000).parse(reason)),
  )
  handle('source-code:open-folder', async () => {
    const error = await shell.openPath(sourceCode.get().path)
    if (error) throw new Error(error)
  })
  handle('extension-sharing:publish', (input) => extensionSharing.publish(input))
  handle('extension-sharing:inspect-public', (link) =>
    extensionSharing.inspectPublic(z.string().max(2048).parse(link)),
  )
  handle('extension-sharing:open-public', async (link) => {
    await shell.openExternal(canonicalPublicGistURL(z.string().max(2048).parse(link)))
  })
  handle('extensions:get', () => extensions.get())
  handle('extensions:apply', (manifest) => applyLocal(() => extensions.apply(manifest)))
  handle('extensions:enable', (id, enabled) =>
    extensions.enable(extensionIdSchema.parse(id), z.boolean().parse(enabled)),
  )
  handle('extensions:remove', (id) => extensions.remove(extensionIdSchema.parse(id)))
  handle('extensions:rollback', (id) => extensions.rollback(extensionIdSchema.parse(id)))
  handle('extensions:call', (id, method, args) =>
    extensions.call(
      extensionIdSchema.parse(id),
      extensionMethodSchema.parse(method),
      parseExtensionPayload(args),
    ),
  )
  handle('extensions:invoke', (method, args) =>
    invokeCore(extensionMethodSchema.parse(method), args),
  )
  handle('extensions:open-folder', async () => {
    const error = await shell.openPath(extensions.path)
    if (error) throw new Error(error)
  })
  handle('extensions:recover', () => {
    void recoverExtensions().catch((error) => {
      if (!quitting) dialog.showErrorBox('Life recovery failed', String(error))
    })
  })
  handle('profiles:list', () => store.list())
  handle('conversations:load', () =>
    admitNativeHistory().pipe(Effect.andThen(conversations!.loadEffect())),
  )
  handle('conversations:loadEncoded', () =>
    admitNativeHistory().pipe(Effect.andThen(conversations!.loadEncodedEffect())),
  )
  handle('conversations:save', (threads, savedAt, projectionAdmissions) =>
    conversations!.saveEffect(
      z.array(z.unknown()).parse(threads),
      savedAt === undefined ? undefined : z.number().int().min(0).parse(savedAt),
      projectionAdmissions,
    ),
  )
  handle('conversations:checkpoint', (input) => conversations!.saveCheckpointEffect(input))
  handle('app:info', () => ({
    name: 'Life',
    version: app.getVersion(),
    platform: process.platform,
    dataDirectory: app.getPath('userData'),
  }))
  handle('app:openExternal', async (url) => {
    const destination = z.url().max(4096).parse(url)
    if (!['https:', 'http:'].includes(new URL(destination).protocol))
      throw new Error('Use an HTTP or HTTPS link')
    await shell.openExternal(destination)
  })
  handle('window:configure', (value) => {
    const options = z
      .object({
        title: z.string().max(200).optional(),
        width: z.number().int().min(760).max(8000).optional(),
        height: z.number().int().min(580).max(8000).optional(),
        alwaysOnTop: z.boolean().optional(),
        fullscreen: z.boolean().optional(),
        opacity: z.number().min(0.2).max(1).optional(),
      })
      .strict()
      .parse(value)
    if (!window) throw new Error('Life window is unavailable')
    if (options.title !== undefined) window.setTitle(options.title)
    if (options.width !== undefined || options.height !== undefined) {
      const [width, height] = window.getSize()
      window.setSize(options.width ?? width, options.height ?? height)
    }
    if (options.alwaysOnTop !== undefined) window.setAlwaysOnTop(options.alwaysOnTop)
    if (options.fullscreen !== undefined) window.setFullScreen(options.fullscreen)
    if (options.opacity !== undefined) window.setOpacity(options.opacity)
    return null
  })
  handle('updates:get', () => updates.getState())
  handle('updates:check', () => updates.check())
  handle('updates:download', () => updates.download())
  handle('updates:auto-download', (enabled) => updates.setAutoDownload(z.boolean().parse(enabled)))
  handle('updates:install', () => {
    if (agents.hasPendingRendererWork())
      throw new Error('Finish or stop active agents before restarting Life to install the update.')
    updates.install()
  })
  handle('customization:get', () => customization.get())
  handle('customization:apply', (patch) => customization.apply(patch))
  handle('customization:undo', () => customization.undo())
  handle('customization:reset', () => customization.reset())
  handle('customization:reload', () => customization.reload())
  handle('ssh-config:list', (path) => listSSHConfig(z.string().max(4096).optional().parse(path)))
  handle('ssh-config:resolve', (alias, path) =>
    resolveSSHConfig(z.string().max(255).parse(alias), z.string().max(4096).optional().parse(path)),
  )
  handle('window:state', () => window?.isMaximized() || false)
  handle('window:initial-recovery', () =>
    Boolean(window && extensionRecoveryStartups.delete(window)),
  )
  handle('window:restart', () => {
    const owner = window
    if (!owner || owner.isDestroyed() || quitting) throw new Error('Life window is unavailable')
    if (recovering) throw new Error('Life is already restarting its interface')
    return restartInterface(owner)
  })
  handle('profiles:save', (p) => store.saveEffect(profileSchema.parse(p)))
  handle('profiles:remove', (id) => store.removeEffect(z.string().parse(id)))
  handle('connection:connect', (input) => {
    const parsed = connectSchema.parse(input)
    ssh.validateConnectInput(parsed)
    const owner = window
    const admission = owner ? rendererAdmissions.get(owner) : undefined
    const documentRevision = admission?.documentRevision
    const documentId = nativeDocuments.capture().documentId
    const ownsDocument = () =>
      Boolean(
        owner &&
        owner === window &&
        !owner.isDestroyed() &&
        rendererAdmissions.get(owner) === admission &&
        admission?.documentRevision === documentRevision &&
        nativeDocuments.capture().documentId === documentId &&
        !historyLifecycle.failure &&
        admission?.allows('connection:connect'),
      )
    const ownsEnvironment = ssh.captureEnvironmentOwnership()
    const ownsRequest = () => ownsEnvironment() && ownsDocument()
    return agents.withEnvironmentChangeEffect(
      Effect.gen(function* () {
        const state = yield* Effect.tryPromise({
          try: () => {
            if (!ownsRequest()) throw new Error('The selected environment changed.')
            return ssh.connect(parsed)
          },
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        const ownsConnectedEnvironment = ssh.captureEnvironmentOwnership()
        const current = () =>
          ownsDocument() &&
          ownsConnectedEnvironment() &&
          ssh.state.status === 'connected' &&
          ssh.state.profile?.id === state.profile?.id
        if (!current()) return yield* Effect.fail(new Error('The selected environment changed.'))
        yield* store.selectionEffect(state.profile!.id, current)
        if (!current()) return yield* Effect.fail(new Error('The selected environment changed.'))
        return ssh.state
      }),
      ownsRequest,
    )
  })
  handle('connection:select-workspace', (path) =>
    ssh.selectWorkspace(remoteDirectorySchema.parse(path)),
  )
  handle('connection:list-directories', (path) =>
    ssh.listDirectories(remoteDirectorySchema.optional().parse(path)),
  )
  handle('connection:disconnect', () => {
    const owner = window
    const admission = owner ? rendererAdmissions.get(owner) : undefined
    const documentRevision = admission?.documentRevision
    const documentId = nativeDocuments.capture().documentId
    const ownsEnvironment = ssh.captureEnvironmentOwnership()
    const ownsRequest = () =>
      Boolean(
        ownsEnvironment() &&
        owner &&
        owner === window &&
        !owner.isDestroyed() &&
        rendererAdmissions.get(owner) === admission &&
        admission?.documentRevision === documentRevision &&
        nativeDocuments.capture().documentId === documentId &&
        !historyLifecycle.failure &&
        admission?.allows('connection:disconnect'),
      )
    return agents.withEnvironmentChangeEffect(
      Effect.try({
        try: () => {
          if (!ownsRequest()) throw new Error('The selected environment changed.')
          ssh.disconnect()
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
      ownsRequest,
    )
  })
  handle('connection:state', () => ssh.state)
  handle('connection:execute', (input) => executeConnectionCommandEffect(ssh, input))
  handle('forwarding:get', () => ssh.forwarding.getState())
  handle('connection:trust', (id, accepted) =>
    ssh.trust(z.string().parse(id), z.boolean().parse(accepted)),
  )
  handle('agent:start', (input) => agents.start(startSchema.parse(input)))
  handle('agent:recovery-support', () => {
    if (recoveryPolicy.mode !== 'unsupported-clean') return recoveryPolicy.status
    const document = captureHistoryDocument(window)
    return agents
      .resumeOrdinaryRendererEffect(() => Boolean(document?.ownsDocument() && !quitting))
      .pipe(Effect.as(recoveryPolicy.status))
  })
  handle('agent:reserve-recovery-owner', (input) => agents.reserveRecoveryOwner(input))
  handle('agent:attest-loaded-history', (input) => attestLoadedHistory(input))
  handle('agent:prepare-recovery-cache', (input) => agents.prepareRecoveryCacheEffect(input))
  handle('agent:attest-recovery-cache', (input) => agents.attestRecoveryCacheEffect(input))
  handle('agent:recover', (input) =>
    admitNativeHistory().pipe(
      Effect.andThen(
        Effect.tryPromise({ try: () => agents.recover(input), catch: (cause) => cause }),
      ),
    ),
  )
  handle('agent:update-recovery-owner', (input) => agents.updateRecoveryOwner(input))
  handle('agent:acknowledge-recovery-history', (input) => agents.acknowledgeRecoveryHistory(input))
  handle('agent:perform-recovery-action', (input) => performRecoveryAction(input))
  handle('agent-history:list', (input) => hostHistory!.list(input))
  handle('agent-history:read', (input) => hostHistory!.read(input))
  handle('agent-history:cancel', (id) => hostHistory!.cancel(z.string().min(1).max(100).parse(id)))
  handle('agent:configure', (input) => agents.configure(agentSettingsSchema.parse(input)))
  handle('agent:steer', (input) => agents.steer(agentSteerSchema.parse(input)))
  handle('agent:stop', (id) => agents.stop(z.string().parse(id)))
  handle('agent:dispose', (id) => agents.dispose(z.string().parse(id)))
  handle('agent:respond', (id, requestId, accepted, answers, decisionId) =>
    agents.respond(
      z.string().parse(id),
      z.string().parse(requestId),
      z.boolean().parse(accepted),
      z.record(z.string(), z.array(z.string())).optional().parse(answers),
      z.string().min(1).max(128).optional().parse(decisionId),
    ),
  )
  handle('agent:models', (provider) => agents.models(z.enum(['codex', 'claude']).parse(provider)))
  handle('agent:usage', (provider) => agents.usage(z.enum(['codex', 'claude']).parse(provider)))
  handle('provider-updates:get', () => providerUpdates!.getState())
  handle('provider-updates:check', async () => {
    const expected = ssh.state
    if (expected.status === 'connected') {
      try {
        await ssh.refreshProviderVersions()
      } catch (error) {
        providerUpdates!.markInstalledCheckFailed(error, expected)
        throw error
      }
    }
    return providerUpdates!.check(true)
  })
  handle('files:list', (path) => ssh.list(z.string().optional().parse(path)))
  handle('files:read', (path) => ssh.read(z.string().parse(path)))
  handle('files:git', () => ssh.git())
  handle('terminal:open', () => ssh.openTerminal())
  handle('terminal:close', () => ssh.closeTerminal())
  handle('choose-key', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose an SSH private key',
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handle('research-documents:register', (html) => researchDocuments.register(html))
  handle('research-documents:revoke', (id) => researchDocuments.revoke(id))
  ipcMain.on('terminal:write', (e, data: unknown) => {
    if (
      window &&
      e.sender === window.webContents &&
      e.senderFrame === window.webContents.mainFrame &&
      permitsRendererAdmission('terminal:write') &&
      typeof data === 'string' &&
      data.length <= 100000
    )
      ssh.writeTerminal(data)
  })
  ipcMain.on('terminal:resize', (e, cols: unknown, rows: unknown) => {
    if (
      e.sender === window?.webContents &&
      e.senderFrame === window?.webContents.mainFrame &&
      window &&
      permitsRendererAdmission('terminal:resize') &&
      typeof cols === 'number' &&
      typeof rows === 'number' &&
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      cols < 1000 &&
      rows > 0 &&
      rows < 1000
    )
      ssh.resizeTerminal(cols, rows)
  })
  ipcMain.on('window:action', (e, action) => {
    if (!isTrustedRendererSender(window, e)) return
    if (action === 'minimize') window?.minimize()
    if (action === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize()
    if (action === 'close') window?.close()
  })
  await extensions.init()
  assertStartupActive()
  protocol.handle('life-code', async (request) => {
    try {
      const path = sourceCode.assetPath(request.url)
      if (!path) return new Response('Source build asset unavailable', { status: 404 })
      const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
      const type =
        (
          {
            '.js': 'text/javascript',
            '.mjs': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
          } as Record<string, string>
        )[extension] || 'application/octet-stream'
      return new Response(await readFile(path), {
        headers: {
          'Content-Type': type,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      })
    } catch {
      return new Response('Source build asset unavailable', { status: 404 })
    }
  })
  protocol.handle('life-extension', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname === 'research') return researchDocuments.respond(request)
      if (url.hostname !== 'runtime' || !url.pathname.startsWith('/view/'))
        return new Response('Not found', { status: 404 })
      const id = extensionIdSchema.parse(decodeURIComponent(url.pathname.slice('/view/'.length)))
      const manifest = extensions
        .list()
        .find((extension) => extension.id === id && extension.enabled)
      if (!manifest) return new Response('Extension disabled or missing', { status: 404 })
      const theme = z.enum(['dark', 'light']).parse(url.searchParams.get('theme'))
      const token = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{8,100}$/)
        .parse(url.searchParams.get('token'))
      return new Response(buildExtensionDocument(manifest, theme, token), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': extensionDocumentCSP(token),
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Invalid extension request', { status: 400 })
    }
  })
  const initialProfile = store.selectedProfile()
  if (initialProfile.transport === 'local') {
    const startup = ssh.connect(initialProfile)
    createWindow()
    void startup.catch((cause) => {
      if (quitting) return
      // Failed admission precedes connection publication. A newer environment
      // selection always keeps its own state and error.
      if (ssh.state.status === 'disconnected' && !ssh.state.profile) {
        ssh.state = {
          status: 'disconnected',
          profile: initialProfile,
          error: cause instanceof Error ? cause.message : String(cause),
        }
        send('connection:state', ssh.state)
      }
      console.error('Local environment startup failed:', cause)
    })
  } else {
    // Retain an explicit SSH selection without storing or replaying its credentials.
    ssh.state = { status: 'disconnected', profile: initialProfile }
    createWindow()
  }
  updates.start()
}
function createWindow(previous?: BrowserWindow, extensionRecovery = false) {
  assertStartupActive()
  historyLifecycle.assertCanCreateDocument()
  const previousAlive = previous && !previous.isDestroyed() ? previous : undefined
  const previousBounds =
    previousAlive && (previousAlive.isMaximized() || previousAlive.isFullScreen())
      ? previousAlive.getNormalBounds()
      : previousAlive?.getBounds()
  const wasMaximized = previousAlive?.isMaximized() || false
  const wasFullscreen = previousAlive?.isFullScreen() || false
  const wasMinimized = previousAlive?.isMinimized() || false
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    ...previousBounds,
    minWidth: 760,
    minHeight: 580,
    show: false,
    backgroundColor: customization.get().config.theme === 'dark' ? '#161616' : '#ffffff',
    title: previousAlive?.getTitle() || 'Life',
    alwaysOnTop: previousAlive?.isAlwaysOnTop() || false,
    opacity: previousAlive?.getOpacity() ?? 1,
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'build/icon.png'),
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 12 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const owner = window
  let closeReady = false
  let closePending = false
  owner.on('close', (event) => {
    if (closeReady || quitting) return
    event.preventDefault()
    if (closePending || owner !== window || owner.isDestroyed()) return
    closePending = true
    const document = captureHistoryDocument(owner)
    rendererAdmissions.get(owner)?.suspend()
    void runEffect(
      finishNativeShutdownEffect(
        [
          historyLifecycle.handoffEffect(
            undefined,
            undefined,
            Effect.tryPromise({
              try: async () => {
                await flushConversationHistory(owner, document)
                document?.admission.sealHistoryWrites(document.revision)
                cancelRendererSessions()
                await runEffect(historyLifecycle.settledEffect(conversations, document))
                await flushNativeRecovery()
                finalizeRendererSuspension()
              },
              catch: (error) => error,
            }),
          ),
          Effect.tryPromise({ try: () => releaseProvidersOnQuit(), catch: (error) => error }),
          Effect.tryPromise({ try: () => detachNativeRecovery(), catch: (error) => error }),
        ],
        (error) => {
          reportShutdownFailure(error)
          if (historyLifecycle.failure && !quitting)
            dialog.showErrorBox(
              'Life history could not be confirmed',
              historyLifecycle.failure.message,
            )
        },
      ),
    ).finally(() => {
      closeReady = true
      if (!owner.isDestroyed()) owner.close()
    })
  })
  if (extensionRecovery) extensionRecoveryStartups.add(owner)
  const admission = new RendererDocumentAdmission()
  rendererAdmissions.set(owner, admission)
  nativeDocuments.commit(owner)
  let recoveryPrompt:
    { controller: AbortController; cause: 'unresponsive' | 'crash' | 'load' } | undefined
  const reportRecoveryFailure = (error: unknown) => {
    console.error('[Life] Renderer handoff failed:', error)
    if (!quitting) dialog.showErrorBox('Life recovery failed', String(error))
  }
  const promptRecovery = (cause: 'unresponsive' | 'crash' | 'load', detail: string) => {
    if (owner !== window || owner.isDestroyed() || recovering || quitting || recoveryPrompt) return
    const canRecoverExtensions =
      sourceCode?.get().enabled || extensions?.list().some((extension) => extension.enabled)
    const actions = [
      ...(cause === 'unresponsive' ? ['Wait'] : []),
      'Restart interface',
      ...(canRecoverExtensions ? ['Recover extensions'] : []),
      'Close Life',
    ]
    const pending = { controller: new AbortController(), cause }
    recoveryPrompt = pending
    // This dialog is native and runs in the main process, so a stopped renderer
    // cannot leave recovery controls inaccessible behind a black window.
    if (!owner.isVisible()) owner.show()
    void dialog
      .showMessageBox(owner, {
        type: 'warning',
        title: cause === 'unresponsive' ? 'Life is not responding' : 'Life interface stopped',
        message:
          cause === 'unresponsive'
            ? 'Life’s interface is taking too long to respond.'
            : 'Life could not keep its interface running.',
        detail:
          `${detail}\n\nYour saved projects, conversations and installed extensions are preserved. ` +
          'Verified agent work continues while Life restores its interface and keeps your machine connected.' +
          (canRecoverExtensions
            ? '\nRecover extensions disables customizations and disconnects the machine.'
            : ''),
        buttons: actions,
        defaultId: 0,
        cancelId: cause === 'unresponsive' ? 0 : actions.length - 1,
        noLink: true,
        signal: pending.controller.signal,
      })
      .then(async ({ response }) => {
        if (
          pending.controller.signal.aborted ||
          owner !== window ||
          owner.isDestroyed() ||
          quitting
        )
          return
        const action = actions[response]
        if (action === 'Restart interface') await restartInterface(owner)
        else if (action === 'Recover extensions') await recoverExtensions()
        else if (action === 'Close Life') app.quit()
      })
      .catch(reportRecoveryFailure)
      .finally(() => {
        if (recoveryPrompt === pending) recoveryPrompt = undefined
      })
  }
  const startSourceWatchdog = () => {
    clearTimeout(sourceStartupTimer)
    const state = sourceCode?.get()
    if (!state?.enabled || !state.active) return
    const revision = state.active.revision
    sourceStartupTimer = setTimeout(() => {
      if (
        owner !== window ||
        owner.isDestroyed() ||
        !sourceCode.get().enabled ||
        sourceCode.get().active?.revision !== revision
      )
        return
      void restartInterface(
        owner,
        'The customized interface did not finish starting. Life restored its built-in interface.',
      ).catch(reportRecoveryFailure)
    }, 25000)
    sourceStartupTimer.unref()
  }
  owner.webContents.on('did-start-navigation', (navigation) => {
    // Window close already owns the history handoff and native exit barrier.
    // A programmatic reload must not start a competing handoff during shutdown.
    if (owner !== window || quitting || closePending) return
    const currentURL = owner.webContents.getURL()
    // Renderer attempts reach will-navigate after this event. They must not
    // retire work before that attempt is blocked or deferred through the idle path.
    if (!isNativeMainDocumentNavigation(navigation)) return
    if (currentURL && navigation.url !== currentURL) return
    if (currentURL) void beginRendererHandoff(owner).catch(reportRecoveryFailure)
    startSourceWatchdog()
  })
  owner.webContents.on('did-frame-navigate', (_event, _url, _code, _status, mainFrame) => {
    if (!mainFrame || owner !== window || owner.isDestroyed() || quitting) return
    nativeDocuments.commit(owner)
    const documentId = nativeDocuments.capture().documentId
    const admit = () => {
      if (
        owner === window &&
        !owner.isDestroyed() &&
        !quitting &&
        !recovering &&
        !closePending &&
        !historyLifecycle.failure &&
        nativeDocuments.capture().documentId === documentId
      )
        historyLifecycle.commitDocument(admission)
    }
    const handoff = rendererHandoff
    if (handoff) void handoff.promise.then(admit).catch(reportRecoveryFailure)
    else admit()
  })
  owner.webContents.on('render-process-gone', (_event, details) => {
    if (owner !== window || owner.isDestroyed() || recovering || quitting) return
    recoveryPrompt?.controller.abort()
    recoveryPrompt = undefined
    const failure = `The renderer stopped (${details.reason}, exit code ${details.exitCode}).`
    console.error(`[Life] ${failure}`)
    if (rendererRecoveryBudget.allowAutomaticRecovery())
      void restartInterface(
        owner,
        'The customized interface stopped unexpectedly. Life restored its built-in interface.',
      ).catch(reportRecoveryFailure)
    else
      promptRecovery('crash', `${failure}\nAutomatic restart was paused after repeated failures.`)
  })
  owner.on('unresponsive', () => {
    promptRecovery('unresponsive', 'Wait for the current operation, or restart the interface.')
  })
  owner.on('responsive', () => {
    if (recoveryPrompt?.cause === 'unresponsive') recoveryPrompt.controller.abort()
  })
  owner.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3)
      promptRecovery('load', `The interface could not load (${description}, error ${code}).`)
  })
  window.once('ready-to-show', () => {
    if (wasMaximized) owner.maximize()
    if (wasFullscreen) owner.setFullScreen(true)
    owner.show()
    if (wasMinimized) owner.minimize()
  })
  window.on('maximize', () => send('window:state', true))
  window.on('unmaximize', () => send('window:state', false))
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (['https:', 'http:'].includes(new URL(url).protocol))
        void shell.openExternal(url).catch(() => {})
    } catch {
      /* Ignore invalid external URLs. */
    }
    return { action: 'deny' }
  })
  owner.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    if (owner !== window || owner.isDestroyed() || quitting || recovering) return
    if (requestsRendererReload(owner.webContents.getURL(), event.url))
      void reloadRendererWhenIdle().catch(reportRecoveryFailure)
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === 'l'
    ) {
      event.preventDefault()
      void recoverExtensions().catch((error) => {
        if (!quitting) dialog.showErrorBox('Life recovery failed', String(error))
      })
    }
  })
  const loaded = process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(process.env.ELECTRON_RENDERER_URL)
    : window.loadFile(join(__dirname, '../renderer/index.html'))
  void loaded.catch((error) => {
    if (!owner.isDestroyed())
      promptRecovery('load', `The interface could not load: ${String(error)}`)
  })
  window.on('closed', () => {
    nativeDocuments.invalidate(owner)
    recoveryPrompt?.controller.abort()
    if (window === owner) {
      researchDocuments.clear()
      ssh?.disconnect()
      window = null
    }
  })
}
if (ownsInstance)
  app
    .whenReady()
    .then(init)
    .catch((error) => {
      if (!quitting) dialog.showErrorBox('Life could not start', error.message)
      app.quit()
    })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (!window && !quitting) {
    try {
      createWindow()
    } catch (error) {
      dialog.showErrorBox('Life history could not be confirmed', String(error))
    }
  }
})
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  const owner = window
  const document = captureHistoryDocument(owner)
  if (owner) rendererAdmissions.get(owner)?.suspend()
  researchDocuments.clear()
  const rendererRequests = ssh?.cancelRendererRequests()
  customization?.close()
  updates?.dispose()
  providerUpdates?.dispose()
  clearTimeout(sourceStartupTimer)
  clearTimeout(sourceReloadTimer)
  const boundary = (operation: () => Promise<unknown> | undefined) =>
    Effect.tryPromise({ try: () => Promise.resolve(operation()), catch: (error) => error })
  void runEffect(
    finishNativeShutdownEffect(
      [
        historyLifecycle.handoffEffect(
          conversations,
          document,
          boundary(() => flushConversationHistory(owner, document)).pipe(
            Effect.tap(() =>
              Effect.sync(() => document?.admission.sealHistoryWrites(document.revision)),
            ),
            Effect.asVoid,
          ),
        ),
        Effect.sync(() => nativeDocuments.close()),
        Effect.sync(() => cancelRendererSessions()),
        boundary(() => applicationRuntime?.dispose()),
        boundary(() => flushNativeRecovery()),
        Effect.sync(() => finalizeRendererSuspension()),
        boundary(() => releaseProvidersOnQuit()),
        boundary(() => detachNativeRecovery()),
        ssh?.disconnectAndWaitEffect() ?? Effect.void,
        Effect.all(
          [
            boundary(() => rendererRequests),
            boundary(() => extensions?.close()),
            boundary(() => sourceCode?.close()),
            boundary(() => customization?.closeAndSettle()),
            historyLifecycle.closeEffect(conversations, document),
          ].map((resource) => finishNativeShutdownEffect([resource], reportShutdownFailure)),
          { concurrency: 'unbounded' },
        ),
        boundary(() => nativeActionRuntime?.dispose()),
        boundary(() => nativeRecoveryRuntime?.dispose()),
      ],
      reportShutdownFailure,
    ),
  ).finally(() => app.quit())
})
