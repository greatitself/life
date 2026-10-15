const fixtureSource = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { useCustomizationStudio } from './src/renderer/useCustomizationStudio';
  import { defaultLifeConfig } from './src/shared/customization';
  const profile = { id:'studio-machine', name:'Studio fixture', host:'fixture.invalid',
    port:22, username:'fixture', auth:'agent', privateKeyPath:'', workspace:'/srv/selected-project' };
  const snapshot = window.studioNativeFixture.source.snapshot;
  function Fixture() {
    const [connection, setConnection] = useState({status:'connected',home:'/home/fixture',profile,
      workspace:'/srv/selected-project',lastWorkspace:'/srv/selected-project'});
    const [request, setRequest] = useState('');
    const studio = useCustomizationStudio({
      connection, config:defaultLifeConfig,
      extensions:{extensions:[],errors:{},revision:0,path:'',canRollback:[],recovered:false},
      source:snapshot, applySettings:async patch => {
        window.studioNativeFixture.state.localSettings.push(JSON.parse(JSON.stringify(patch)));
        window.studioNativeFixture.save();
      },
    });
    window.studio = studio;
    window.fixtureConnection = status => setConnection({status,home:'/home/fixture',profile,
      workspace:'/srv/selected-project',lastWorkspace:'/srv/selected-project'});
    return <main>
      <style>{'body{font:15px system-ui;margin:24px}textarea{display:block;width:680px;height:100px}button{margin:8px}output{display:block;max-width:1000px}pre{max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word}'}</style>
      <h1>Production Studio recovery hook</h1>
      <output aria-label="Studio stage">{studio.active?.stage}</output>
      <output aria-label="Studio feedback">{studio.feedback}</output>
      <form onSubmit={event => {event.preventDefault(); void studio.submit(request)}}>
        <label>Customization request<textarea aria-label="Customization request"
          value={request} onChange={event => setRequest(event.target.value)} /></label>
        <button type="submit">Send customization</button>
      </form>
      <button type="button" onClick={() => studio.newSession()}>New customization</button>
      <button type="button" onClick={() => void studio.stop()}>Stop customization</button>
      <button type="button" onClick={() => void studio.discardProposal()}>Discard proposal</button>
      <pre aria-label="Studio messages">{JSON.stringify(studio.active?.thread.messages.map(message => ({
        id:message.id,role:message.role,status:message.status,finishStatus:message.finishStatus,
        text:message.role === 'user' ? 'Exact user request: ' + message.text.length + ' UTF-16 units' : message.text,
      })))}</pre>
    </main>;
  }
  createRoot(document.getElementById('root')).render(<Fixture />);
`

// This is a deterministic native bridge stand-in. It never starts an upstream provider.
// Its ledger survives a renderer reload independently of Studio's history storage.
function initializeNativeFixture() {
  const ledgerKey = 'fixture.life.studio.native-ledger'
  const historyKey = 'life.studio.sessions.v1'
  const pendingKey = 'life.studio.pending-source.v1'
  const originalSet = Storage.prototype.setItem
  const originalGet = Storage.prototype.getItem
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const saved = originalGet.call(sessionStorage, ledgerKey)
  const decode = (serialized) => {
    const encoded = JSON.parse(serialized)
    return JSON.parse(JSON.stringify(encoded.value), (_key, value) =>
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      Number.isSafeInteger(value.$fixtureText)
        ? encoded.texts[value.$fixtureText]
        : value,
    )
  }
  const state = saved
    ? decode(saved)
    : {
        owners: {},
        ownerSnapshots: [],
        starts: [],
        reservations: [],
        checkpoints: [],
        actions: [],
        acknowledgments: [],
        acknowledgmentAttempts: [],
        preparedClaims: [],
        preparedPromotions: [],
        cacheWrites: [],
        localSettings: [],
        stops: [],
        disposals: [],
        legacyContext: 0,
        legacyApply: 0,
        legacyReload: 0,
        legacyPendingWrites: 0,
        historyFailures: [],
        holdStarts: false,
        failHistory: false,
        failAfterApply: false,
        holdAcknowledgments: false,
        recoveries: [],
        recoveryReplay: [],
        replayedDuringRecovery: 0,
        generation: 10,
      }
  const persist = () => {
    // Repeated immutable planner snapshots contain the same exact large prompt.
    // Intern its text solely in this fixture's ledger serialization so a legitimate
    // one-million-unit prompt does not exhaust the mock's unrelated sessionStorage.
    const indexes = new Map()
    const texts = []
    const value = JSON.parse(
      JSON.stringify(state, (_key, entry) => {
        if (typeof entry !== 'string' || entry.length < 4000) return entry
        let index = indexes.get(entry)
        if (index === undefined) {
          index = texts.length
          indexes.set(entry, index)
          texts.push(entry)
        }
        return { $fixtureText: index }
      }),
    )
    originalSet.call(sessionStorage, ledgerKey, JSON.stringify({ texts, value }))
  }
  const listeners = new Set()
  const heldStarts = []
  const heldAcknowledgments = []
  const hashRow = async (row) => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(row)),
    )
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  const documentId = crypto.randomUUID()
  for (const snapshot of state.ownerSnapshots)
    snapshot.deliveryToken = 'fixture-delivery:' + documentId + ':' + snapshot.ownerGeneration
  for (const owner of Object.values(state.owners))
    owner.deliveryToken = 'fixture-delivery:' + documentId + ':' + owner.ownerGeneration
  const source = {
    revision: 7,
    paths: ['src/renderer/fixture-feature.tsx'],
    files: [
      { path: 'src/renderer/fixture-feature.tsx', content: 'export const feature = "before"\n' },
    ],
    dependencies: {},
    extensions: [],
    snapshot: {
      revision: 7,
      extensions: [],
      enabled: false,
      canRollback: false,
      recovered: false,
      path: '/private/fixture-source',
    },
  }
  Storage.prototype.setItem = function (key, value) {
    if (key === pendingKey) {
      state.legacyPendingWrites++
      persist()
    }
    if (key === historyKey && state.failHistory) {
      state.historyFailures.push({
        committedSourceApplies: state.actions.filter(
          (entry) => entry.request.kind === 'source-apply' && entry.result.status === 'succeeded',
        ).length,
      })
      persist()
      throw new DOMException('Fixture Studio history quota exhausted', 'QuotaExceededError')
    }
    const result = originalSet.call(this, key, value)
    if (key === historyKey) {
      state.cacheWrites.push({
        rows: JSON.parse(value)
          .filter((row) => row && typeof row === 'object')
          .map((row) => ({
            sessionId: row.id,
            nativeRecovery: clone(row.thread?.nativeRecovery || {}),
          })),
        preparedSnapshotIds: state.preparedClaims.map((claim) => claim.proof.snapshotId),
      })
      persist()
    }
    return result
  }
  const ownerFor = (input, planner, reservation) => {
    const transportId = reservation
      ? 'native-reservation:' + input.sessionId
      : 'native-transport:' + input.sessionId
    const previous = state.owners[input.sessionId]
    const sameTransport = previous?.transportId === transportId
    return {
      sessionId: input.sessionId,
      transportId,
      status: reservation ? 'idle' : 'running',
      snapshotToken: 'fixture-token:' + state.generation,
      deliveryToken: 'fixture-delivery:' + documentId + ':' + state.generation,
      ownerGeneration: state.generation,
      throughEventRevision: sameTransport ? previous.throughEventRevision : 0,
      acceptedAppliedRevision: sameTransport ? previous.acceptedAppliedRevision : 0,
      clientRecovery: clone(planner),
      originalInput: {
        ...clone(input),
        workspace: '/home/fixture/.life/customization/studio-' + input.sessionId,
      },
      localTurn: input.localTurn,
      provider: input.provider,
      remoteId: 'native-remote:' + input.sessionId,
      pending: [],
      currentChildren: [],
    }
  }
  window.relay = {
    onAgent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    agent: {
      models: async () => [],
      configure: async () => ({ applied: 'next-turn' }),
      recover: async (input) => {
        state.recoveries.push(clone(input))
        const replay = state.recoveryReplay.splice(0)
        state.replayedDuringRecovery += replay.length
        persist()
        // Native replay is delivered before recover() resolves its owner snapshot.
        // This exercises the hook's in-flight buffering, not just post-recovery delivery.
        for (const event of replay) for (const listener of listeners) listener(clone(event))
        return {
          owners: await Promise.all(
            Object.values(state.owners)
              .filter(
                (owner) =>
                  input.consumers.some((consumer) => consumer.sessionId === owner.sessionId) ||
                  owner.clientRecovery?.format === 'life-studio-planner-recovery',
              )
              .map(async (owner) => {
                const recovered = clone(owner)
                const consumer = input.consumers.find(
                  (candidate) => candidate.sessionId === owner.sessionId,
                )
                if (
                  consumer?.workspace !== undefined &&
                  consumer.workspace !== owner.originalInput.workspace
                )
                  throw new Error(
                    'Fixture rejected a Studio consumer outside its exact native staging workspace',
                  )
                const cursor = consumer?.applied?.[owner.transportId]
                const known =
                  cursor &&
                  state.ownerSnapshots.some(
                    (snapshot) =>
                      snapshot.sessionId === owner.sessionId &&
                      snapshot.transportId === owner.transportId &&
                      snapshot.snapshotToken === cursor.snapshotToken &&
                      snapshot.ownerGeneration === cursor.ownerGeneration,
                  )
                const acknowledged =
                  known &&
                  state.acknowledgments.find(
                    (receipt) =>
                      receipt.sessionId === owner.sessionId &&
                      receipt.transportId === owner.transportId &&
                      receipt.snapshotToken === cursor.snapshotToken &&
                      receipt.ownerGeneration === cursor.ownerGeneration &&
                      receipt.throughEventRevision <= owner.throughEventRevision &&
                      receipt.hash === consumer.cacheHash,
                  )
                let admitted = acknowledged
                if (!admitted && known && consumer.cacheHash) {
                  const claim = state.preparedClaims.find(
                    (entry) =>
                      entry.sessionId === owner.sessionId &&
                      entry.proof.hash === consumer.cacheHash &&
                      entry.proof.transportId === owner.transportId &&
                      entry.proof.snapshotToken === cursor.snapshotToken &&
                      entry.proof.ownerGeneration === cursor.ownerGeneration &&
                      entry.proof.throughEventRevision === cursor.appliedRevision &&
                      cursor.appliedRevision <= owner.throughEventRevision,
                  )
                  if (claim) {
                    admitted = {
                      sessionId: owner.sessionId,
                      transportId: owner.transportId,
                      snapshotToken: cursor.snapshotToken,
                      ownerGeneration: cursor.ownerGeneration,
                      snapshotId: claim.proof.snapshotId,
                      throughEventRevision: cursor.appliedRevision,
                      hash: claim.proof.hash,
                      durability: 'admitted-cache',
                    }
                    state.acknowledgments.push(clone(admitted))
                    state.preparedPromotions.push(clone(admitted))
                    owner.acceptedAppliedRevision = Math.max(
                      owner.acceptedAppliedRevision || 0,
                      cursor.appliedRevision,
                    )
                    persist()
                  }
                }
                recovered.acceptedAppliedRevision = admitted
                  ? Math.min(cursor.appliedRevision, admitted.throughEventRevision)
                  : 0
                recovered.acceptedAppliedCursor = known
                  ? {
                      appliedRevision: recovered.acceptedAppliedRevision,
                      snapshotToken: cursor.snapshotToken,
                      ownerGeneration: cursor.ownerGeneration,
                    }
                  : undefined
                const acceptedSnapshot =
                  recovered.acceptedAppliedCursor &&
                  state.ownerSnapshots.find(
                    (snapshot) =>
                      snapshot.sessionId === owner.sessionId &&
                      snapshot.transportId === owner.transportId &&
                      snapshot.snapshotToken === recovered.acceptedAppliedCursor.snapshotToken &&
                      snapshot.ownerGeneration === recovered.acceptedAppliedCursor.ownerGeneration,
                  )
                if (admitted && acceptedSnapshot) {
                  recovered.acceptedProjectionAdmission = {
                    sessionId: owner.sessionId,
                    transportId: owner.transportId,
                    ...recovered.acceptedAppliedCursor,
                    deliveryToken: acceptedSnapshot.deliveryToken,
                  }
                  recovered.acceptedCacheHash = consumer.cacheHash
                }
                return recovered
              }),
          ),
        }
      },
      reserveRecoveryOwner: async ({ input, clientRecovery }) => {
        state.generation++
        const owner = ownerFor(input, clientRecovery, true)
        state.reservations.push(clone(owner))
        state.ownerSnapshots.push({
          sessionId: owner.sessionId,
          transportId: owner.transportId,
          snapshotToken: owner.snapshotToken,
          ownerGeneration: owner.ownerGeneration,
          deliveryToken: owner.deliveryToken,
        })
        state.owners[input.sessionId] = owner
        persist()
        return clone(owner)
      },
      updateRecoveryOwner: async (input) => {
        const owner = state.owners[input.sessionId]
        if (
          !owner ||
          (input.transportId && owner.transportId !== input.transportId) ||
          (input.ownerGeneration !== undefined && owner.ownerGeneration !== input.ownerGeneration)
        )
          throw new Error('Fixture rejected a different native checkpoint owner')
        const prepared = input.clientRecovery.preparedCache
        if (
          prepared &&
          !state.preparedClaims.some(
            (entry) =>
              entry.sessionId === input.sessionId && entry.proof.snapshotId === prepared.snapshotId,
          )
        ) {
          const known = state.ownerSnapshots.some(
            (snapshot) =>
              snapshot.sessionId === input.sessionId &&
              snapshot.transportId === prepared.transportId &&
              snapshot.snapshotToken === prepared.snapshotToken &&
              snapshot.ownerGeneration === prepared.ownerGeneration,
          )
          const admission = input.projectionAdmissions?.find(
            (entry) =>
              entry.sessionId === input.sessionId &&
              entry.transportId === prepared.transportId &&
              entry.snapshotToken === prepared.snapshotToken &&
              entry.ownerGeneration === prepared.ownerGeneration &&
              entry.appliedRevision === prepared.throughEventRevision &&
              state.ownerSnapshots.some(
                (snapshot) =>
                  snapshot.sessionId === entry.sessionId &&
                  snapshot.transportId === entry.transportId &&
                  snapshot.snapshotToken === entry.snapshotToken &&
                  snapshot.ownerGeneration === entry.ownerGeneration &&
                  snapshot.deliveryToken === entry.deliveryToken,
              ),
          )
          if (
            !known ||
            !admission ||
            prepared.throughEventRevision > owner.throughEventRevision ||
            !/^[a-f0-9]{64}$/.test(prepared.hash)
          )
            throw new Error(
              'Fixture rejected prepared Studio cache claim: known=' +
                known +
                ', admission=' +
                Boolean(admission) +
                ', future=' +
                (prepared.throughEventRevision > owner.throughEventRevision),
            )
          state.preparedClaims.push({
            sessionId: input.sessionId,
            proof: clone(prepared),
            admission: clone(admission),
          })
        }
        if (prepared) {
          const original = state.preparedClaims.find(
            (entry) =>
              entry.sessionId === input.sessionId && entry.proof.snapshotId === prepared.snapshotId,
          )
          if (JSON.stringify(original?.proof) !== JSON.stringify(prepared))
            throw new Error('Fixture rejected a conflicting prepared Studio snapshot identity')
        }
        owner.clientRecovery = clone(input.clientRecovery)
        state.checkpoints.push({
          sessionId: input.sessionId,
          planner: clone(input.clientRecovery),
          projectionAdmissions: clone(input.projectionAdmissions || []),
        })
        persist()
      },
      start: async (input) => {
        state.starts.push(clone(input))
        persist()
        if (state.holdStarts) await new Promise((resolve) => heldStarts.push(resolve))
        state.generation++
        const owner = ownerFor(input, input.clientRecovery, false)
        state.ownerSnapshots.push({
          sessionId: owner.sessionId,
          transportId: owner.transportId,
          snapshotToken: owner.snapshotToken,
          ownerGeneration: owner.ownerGeneration,
          deliveryToken: owner.deliveryToken,
        })
        state.owners[input.sessionId] = owner
        persist()
      },
      performRecoveryAction: async (input) => {
        const owner = state.owners[input.sessionId]
        if (
          !owner ||
          owner.transportId !== input.transportId ||
          owner.ownerGeneration !== input.ownerGeneration
        )
          throw new Error('Fixture rejected a different native action owner')
        const previous = state.actions.find((entry) => entry.request.actionId === input.actionId)
        if (previous) return clone(previous.result)
        const native = {
          actionId: input.actionId,
          transportId: input.transportId,
          ownerGeneration: input.ownerGeneration,
        }
        const receipt = { native }
        if (input.kind === 'source-read') receipt.source = clone(source)
        if (input.kind === 'source-apply') {
          receipt.snapshot = {
            ...clone(source.snapshot),
            revision: input.intent.patch.baseRevision + 1,
            enabled: true,
            active: {
              revision: input.intent.patch.baseRevision + 1,
              js: 'life-source://fixture/compiled.js',
            },
          }
          if (state.failAfterApply) state.failHistory = true
        }
        const result = { status: 'succeeded', native, receipt }
        state.actions.push({ request: clone(input), result: clone(result) })
        persist()
        return clone(result)
      },
      acknowledgeRecoveryHistory: async (receipt) => {
        state.acknowledgmentAttempts.push(clone(receipt))
        persist()
        if (state.holdAcknowledgments)
          await new Promise((resolve) => heldAcknowledgments.push(resolve))
        const owner = state.owners[receipt.sessionId]
        const known = state.ownerSnapshots.some(
          (snapshot) =>
            snapshot.sessionId === receipt.sessionId &&
            snapshot.transportId === receipt.transportId &&
            snapshot.snapshotToken === receipt.snapshotToken,
        )
        const stored = JSON.parse(originalGet.call(localStorage, historyKey) || '[]')
        const cursor = stored.find((session) => session?.id === receipt.sessionId)?.thread
          ?.nativeRecovery?.[receipt.transportId]
        const row = stored.find((session) => session?.id === receipt.sessionId)
        const hash = row ? await hashRow(row) : undefined
        const prepare = state.preparedClaims.find(
          (claim) =>
            claim.sessionId === receipt.sessionId &&
            claim.proof.snapshotId === receipt.snapshotId &&
            claim.proof.hash === hash &&
            claim.proof.transportId === receipt.transportId &&
            claim.proof.snapshotToken === receipt.snapshotToken &&
            claim.proof.ownerGeneration === cursor?.ownerGeneration &&
            claim.proof.throughEventRevision === receipt.throughEventRevision,
        )
        if (
          !known ||
          !cursor ||
          !prepare ||
          receipt.fileHash !== hash ||
          cursor.snapshotToken !== receipt.snapshotToken ||
          cursor.appliedRevision !== receipt.throughEventRevision ||
          !Number.isSafeInteger(receipt.throughEventRevision) ||
          receipt.throughEventRevision > (owner?.throughEventRevision || 0)
        )
          throw new Error(
            'Fixture rejected an uncommitted or unknown native history acknowledgment',
          )
        state.acknowledgments.push({
          ...clone(receipt),
          hash,
          ownerGeneration: cursor.ownerGeneration,
        })
        if (owner?.transportId === receipt.transportId)
          owner.acceptedAppliedRevision = Math.max(
            owner.acceptedAppliedRevision || 0,
            receipt.throughEventRevision,
          )
        persist()
      },
      stop: async (id) => {
        state.stops.push(id)
        persist()
      },
      dispose: async (id) => {
        state.disposals.push(id)
        persist()
      },
      respond: async () => {},
    },
    extensions: { capabilities: [] },
    sourceCode: {
      getContext: async () => {
        state.legacyContext++
        persist()
        return clone(source)
      },
      apply: async () => {
        state.legacyApply++
        persist()
        return clone(source.snapshot)
      },
      reload: async () => {
        state.legacyReload++
        persist()
      },
    },
  }
  window.studioNativeFixture = {
    state,
    source,
    owner: (id = window.studio.active.id) => clone(state.owners[id]),
    save: persist,
    releaseStarts: () => {
      state.holdStarts = false
      persist()
      for (const resolve of heldStarts.splice(0)) resolve()
    },
    releaseAcknowledgments: () => {
      state.holdAcknowledgments = false
      persist()
      for (const resolve of heldAcknowledgments.splice(0)) resolve()
    },
    emit: (event, overrides = {}) => {
      const id = event.sessionId || window.studio.active.id
      const owner = state.owners[id]
      const nativeRecovery = {
        transportId: owner.transportId,
        ownerGeneration: owner.ownerGeneration,
        snapshotToken: owner.snapshotToken,
        deliveryToken: owner.deliveryToken,
        localTurn: owner.localTurn,
        revision: (owner.throughEventRevision || 0) + 1,
        eventId: 'fixture-event:' + ((owner.throughEventRevision || 0) + 1),
        emittedAt: 1_700_000_000_000 + ((owner.throughEventRevision || 0) + 1),
        ...overrides,
      }
      if (nativeRecovery.transportId === owner.transportId)
        owner.throughEventRevision = Math.max(
          owner.throughEventRevision || 0,
          nativeRecovery.revision,
        )
      if (!event.agentId && event.type === 'complete') owner.status = 'idle'
      persist()
      const delivered = { sessionId: id, ...event, nativeRecovery }
      for (const listener of listeners) listener(delivered)
      return clone(delivered)
    },
    replaceOwner: (owner) => {
      state.owners[owner.sessionId] = clone(owner)
      persist()
    },
    stored: () => JSON.parse(originalGet.call(localStorage, historyKey) || '[]'),
  }
  persist()
}

module.exports = { fixtureSource, initializeNativeFixture }
