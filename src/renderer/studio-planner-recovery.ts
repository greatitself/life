import { z } from 'zod'
import { configPatchSchema, parseLifeConfigPatch } from '../shared/customization'
import { extensionSchema, parseExtensionManifest } from '../shared/extensions'
import {
  lifeSourcePatchSchema,
  lifeSourcePathSchema,
  lifeSourceReadSchema,
  parseLifeSourcePatch,
  type LifeSourceContext,
  type LifeSourceSnapshot,
} from '../shared/source-code'
import type { NativeRecoveryOwnerState, Provider } from '../shared/types'
import { startSchema } from '../shared/validation'

export const STUDIO_PLANNER_RECOVERY_FORMAT = 'life-studio-planner-recovery' as const
const maximumBytes = 32_000_000
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/)
const revision = natural
const cacheProofIdentifier = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\x00-\x1f\x7f]+$/)
const preparedCacheSchema = z
  .object({
    snapshotId: cacheProofIdentifier,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    throughEventRevision: natural,
    transportId: identifier,
    snapshotToken: cacheProofIdentifier,
    ownerGeneration: natural,
  })
  .strict()
const repairSchema = z
  .object({ attempt: z.number().int().min(1).max(2), diagnostics: z.string().max(40_000) })
  .strict()

const summarySchema = z
  .object({
    id: identifier,
    name: z.string().max(120),
    description: z.string().max(2000),
    version: z.string().max(200),
    enabled: z.boolean(),
    builtIn: z.literal(true).optional(),
    deleted: z.literal(true).optional(),
    originalId: identifier.optional(),
    features: z.array(z.string().max(200)).max(100).optional(),
    effect: z.string().max(2000).optional(),
    incorporated: z.literal(true).optional(),
    files: z.array(lifeSourcePathSchema).max(100),
    dependencies: z.record(z.string(), z.string().max(200)),
    createdAt: z.string().max(200),
    updatedAt: z.string().max(200),
    error: z.string().optional(),
  })
  .strict()
const snapshotSchema = z
  .object({
    extensions: z.array(summarySchema).max(200),
    revision,
    builtInRevision: revision.optional(),
    builtInError: z.string().optional(),
    enabled: z.boolean(),
    active: z
      .object({ revision, js: z.string().max(4096), css: z.string().max(4096).optional() })
      .strict()
      .optional(),
    canRollback: z.boolean(),
    path: z.string().max(4096),
    error: z.string().optional(),
    recovered: z.boolean(),
    summary: z.string().max(2000).optional(),
    baseChanged: z.boolean().optional(),
  })
  .strict()
const sourceFilesSchema = z
  .array(z.object({ path: lifeSourcePathSchema, content: z.string() }).strict())
  .max(30)
const contextSchema = z
  .object({
    extensions: z.array(summarySchema).max(200),
    revision,
    paths: z
      .array(lifeSourcePathSchema)
      .max(20_000)
      .refine((paths) => new Set(paths).size === paths.length),
    files: sourceFilesSchema,
    dependencies: z.record(z.string(), z.string().max(200)),
    snapshot: snapshotSchema,
    baselineFiles: sourceFilesSchema.optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.revision !== source.snapshot.revision)
      context.addIssue({ code: 'custom', message: 'Source context revisions do not match.' })
    const paths = new Set(source.paths)
    if ([...source.files, ...(source.baselineFiles || [])].some((file) => !paths.has(file.path)))
      context.addIssue({
        code: 'custom',
        message: 'Source files must belong to their saved index.',
      })
  })
const inputSchema = startSchema.strict().superRefine((input, context) => {
  if (input.mode !== 'plan' || input.scope !== 'life-customization')
    context.addIssue({ code: 'custom', message: 'Recovered planners belong only to Life Studio.' })
  if (input.clientRecovery !== undefined)
    context.addIssue({
      code: 'custom',
      message: 'Planner ownership belongs outside the saved native input.',
    })
})
const nativeReceiptSchema = z
  .object({ actionId: identifier, transportId: identifier, ownerGeneration: natural })
  .strict()
const timestamp = z.number().finite().nonnegative()
const userMessageSchema = z
  .object({
    id: identifier,
    role: z.literal('user'),
    text: z.string(),
    turn: natural,
    createdAt: timestamp,
  })
  .strict()
const terminalSchema = z
  .object({
    stage: z.enum(['complete', 'interrupted', 'failed']),
    error: z.string().optional(),
    discarded: z.literal(true).optional(),
    finishedAt: natural.optional(),
    errorMessageId: z
      .string()
      .min(1)
      .max(1000)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .optional(),
  })
  .strict()
  .superRefine((terminal, context) => {
    if (terminal.errorMessageId !== undefined && terminal.error === undefined)
      context.addIssue({
        code: 'custom',
        message: 'A terminal error message ID requires its exact error.',
      })
  })
const metadataSchema = z.custom<Record<string, unknown>>(
  (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)),
  'Native session seed metadata must be a plain JSON object',
)
const sessionSeedSchema = z
  .object({
    id: identifier,
    createdAt: timestamp,
    updatedAt: timestamp,
    thread: z
      .object({
        id: identifier,
        profileId: identifier,
        provider: z.enum(['codex', 'claude']),
        title: z.string(),
        model: z.string().max(200),
        mode: z.literal('plan'),
        purpose: z.literal('customization'),
        updatedAt: timestamp,
        turn: natural,
        messages: z.array(z.never()).max(0),
        busy: z.literal(false),
        pending: z.array(z.never()).max(0),
        remoteId: identifier.optional(),
        workspace: z
          .string()
          .min(1)
          .max(4096)
          .refine((path) => path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path))
          .optional(),
        workspaceUnknown: z.literal(true).optional(),
        reasoningEffort: z.string().max(200).optional(),
        serviceTier: z.string().max(200).optional(),
        /** Preserved archival fields are never spread into active native routing or controls. */
        metadata: metadataSchema.optional(),
      })
      .strict(),
  })
  .strict()
const actionState = {
  id: identifier,
  iteration: z.number().int().min(0).max(9),
  status: z.enum(['intended', 'started', 'succeeded', 'failed']),
  error: z.string().optional(),
}
const actionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...actionState,
        kind: z.literal('read-source'),
        intent: z
          .object({
            purpose: z.enum(['initial', 'source-read', 'repair-index', 'repair-files']),
            read: lifeSourceReadSchema.optional(),
          })
          .strict(),
        receipt: z
          .object({ native: nativeReceiptSchema, source: contextSchema })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionState,
        kind: z.literal('start-provider'),
        intent: z.object({ input: inputSchema }).strict(),
        receipt: z
          .object({ native: nativeReceiptSchema, remoteId: identifier.optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionState,
        kind: z.literal('apply-settings'),
        intent: z.object({ patch: configPatchSchema.strict() }).strict(),
        receipt: z.object({ native: nativeReceiptSchema }).strict().optional(),
      })
      .strict(),
    z
      .object({
        ...actionState,
        kind: z.literal('apply-extension'),
        intent: z.object({ manifest: extensionSchema }).strict(),
        receipt: z.object({ native: nativeReceiptSchema }).strict().optional(),
      })
      .strict(),
    z
      .object({
        ...actionState,
        kind: z.literal('apply-source'),
        intent: z.object({ patch: lifeSourcePatchSchema }).strict(),
        receipt: z
          .object({ native: nativeReceiptSchema, snapshot: snapshotSchema })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionState,
        kind: z.literal('reload-source'),
        intent: z.object({ appliedActionId: identifier, revision }).strict(),
        receipt: z.object({ native: nativeReceiptSchema }).strict().optional(),
      })
      .strict(),
  ])
  .superRefine((action, context) => {
    if ((action.status === 'succeeded') !== Boolean(action.receipt))
      context.addIssue({
        code: 'custom',
        message: 'Only completed actions have successful receipts.',
      })
    if ((action.status === 'failed') !== (typeof action.error === 'string'))
      context.addIssue({ code: 'custom', message: 'Only failed actions have failure receipts.' })
    if (
      action.receipt &&
      'native' in action.receipt &&
      action.receipt.native.actionId !== action.id
    )
      context.addIssue({ code: 'custom', message: 'Native receipts must name their exact action.' })
    if (action.kind === 'apply-source' && action.status === 'succeeded' && action.receipt) {
      const snapshot = action.receipt.snapshot
      if (
        !snapshot.enabled ||
        snapshot.error !== undefined ||
        !snapshot.active ||
        snapshot.active.revision !== snapshot.revision ||
        snapshot.revision <= action.intent.patch.baseRevision
      )
        context.addIssue({
          code: 'custom',
          message: 'A successful source receipt must own its activated committed generation.',
        })
    }
    if (action.kind === 'read-source') {
      const needsPaths = ['source-read', 'repair-files'].includes(action.intent.purpose)
      if (needsPaths !== Boolean(action.intent.read))
        context.addIssue({
          code: 'custom',
          message: 'Source read intent must preserve selected paths.',
        })
    }
  })

const plannerSchema = z
  .object({
    format: z.literal(STUDIO_PLANNER_RECOVERY_FORMAT),
    formatVersion: z.literal(1),
    sessionId: identifier,
    profileId: identifier,
    provider: z.enum(['codex', 'claude']),
    request: z
      .string()
      .min(1)
      .max(1_000_000)
      .refine((request) => Boolean(request.trim())),
    input: inputSchema,
    userMessage: userMessageSchema.optional(),
    sessionSeed: sessionSeedSchema.optional(),
    source: contextSchema.optional(),
    nativeIteration: z.number().int().min(0).max(9),
    reads: z.number().int().min(0).max(6),
    repairs: z.number().int().min(0).max(2),
    parts: z
      .array(z.object({ itemId: identifier, text: z.string() }).strict())
      .max(10_000)
      .refine((parts) => new Set(parts.map((part) => part.itemId)).size === parts.length),
    finishing: z.boolean(),
    autoApply: z.boolean(),
    phase: z.enum([
      'preparing',
      'planning',
      'completing',
      'reading',
      'repairing',
      'review',
      'applying',
      'reloading',
      'finished',
    ]),
    terminal: terminalSchema.optional(),
    continuation: z
      .object({ sourceRead: lifeSourceReadSchema.optional(), repair: repairSchema.optional() })
      .strict()
      .optional(),
    /** Exactly the native output already included in the ordered partial response parts. */
    applied: z
      .object({ transportId: identifier, throughEventRevision: natural })
      .strict()
      .optional(),
    /** Native scope reconciliation owns admission; the exact prepared cache tuple is never rewritten. */
    preparedCache: preparedCacheSchema.optional(),
    action: actionSchema.optional(),
  })
  .strict()
  .superRefine((planner, context) => {
    const sameInput = (input: z.infer<typeof inputSchema>) =>
      input.sessionId === planner.sessionId &&
      input.provider === planner.provider &&
      input.prompt === planner.request
    if (!sameInput(planner.input))
      context.addIssue({
        code: 'custom',
        message: 'Planner identity and exact native request differ.',
      })
    if (
      planner.userMessage &&
      (planner.userMessage.text !== planner.request ||
        planner.input.localTurn === undefined ||
        planner.userMessage.turn !== planner.input.localTurn)
    )
      context.addIssue({
        code: 'custom',
        message: 'Recovered user message must retain its exact request and local turn.',
      })
    if (planner.terminal && planner.phase !== 'finished')
      context.addIssue({
        code: 'custom',
        message: 'Only a finished planner owns a terminal outcome.',
      })
    if (planner.sessionSeed) {
      const seed = planner.sessionSeed
      const thread = seed.thread
      if (
        !planner.userMessage ||
        seed.id !== planner.sessionId ||
        thread.id !== planner.sessionId ||
        thread.profileId !== planner.profileId ||
        thread.provider !== planner.provider ||
        thread.turn > planner.userMessage.turn ||
        (thread.remoteId !== undefined && thread.remoteId !== planner.input.remoteId) ||
        (thread.workspace !== undefined &&
          planner.input.workspace !== undefined &&
          thread.workspace !== planner.input.workspace)
      )
        context.addIssue({
          code: 'custom',
          message: 'Native session seed must retain its exact Studio owner and original user turn.',
        })
    }
    if (planner.action?.kind === 'start-provider') {
      const action = planner.action
      const { remoteId: sentRemoteId, ...sentInput } = action.intent.input
      const { remoteId: currentRemoteId, ...currentInput } = planner.input
      const admittedNewIdentity =
        sentRemoteId === undefined &&
        action.status === 'succeeded' &&
        action.receipt?.remoteId === currentRemoteId
      if (
        !sameInput(action.intent.input) ||
        JSON.stringify(sentInput) !== JSON.stringify(currentInput) ||
        (sentRemoteId !== currentRemoteId && !admittedNewIdentity) ||
        (sentRemoteId !== undefined &&
          action.receipt?.remoteId !== undefined &&
          action.receipt.remoteId !== sentRemoteId)
      )
        context.addIssue({
          code: 'custom',
          message: 'Continuation must retain its exact native input and owner.',
        })
    }
    if (planner.action && planner.action.iteration !== planner.nativeIteration)
      context.addIssue({
        code: 'custom',
        message: 'Actions must belong to the current native iteration.',
      })
    if (planner.continuation?.repair && planner.continuation.repair.attempt !== planner.repairs)
      context.addIssue({
        code: 'custom',
        message: 'Repair intent must retain its admitted attempt.',
      })
    if (planner.continuation?.sourceRead && planner.reads === 0)
      context.addIssue({
        code: 'custom',
        message: 'A source continuation requires an admitted read.',
      })
    if (planner.continuation?.repair && planner.continuation.sourceRead)
      context.addIssue({
        code: 'custom',
        message: 'Each native iteration has one continuation context.',
      })
    if (planner.nativeIteration > planner.reads + planner.repairs + 1)
      context.addIssue({
        code: 'custom',
        message: 'Native iteration exceeds authorized continuation bounds.',
      })
    if (planner.action?.kind === 'apply-source') parseLifeSourcePatch(planner.action.intent.patch)
    if (planner.action?.kind === 'apply-extension')
      parseExtensionManifest(planner.action.intent.manifest)
    if (planner.action?.kind === 'apply-settings') parseLifeConfigPatch(planner.action.intent.patch)
  })

/** This belongs to the native owner registry, never to archival Studio history. */
type ParsedStudioPlannerAction = z.infer<typeof actionSchema>
type NativeActionReceipt = z.infer<typeof nativeReceiptSchema>
/** Native context contracts permit readonly feature arrays; validation always detaches their data. */
export type StudioPlannerAction =
  | (Omit<Extract<ParsedStudioPlannerAction, { kind: 'read-source' }>, 'receipt'> & {
      receipt?: { native: NativeActionReceipt; source: LifeSourceContext }
    })
  | (Omit<Extract<ParsedStudioPlannerAction, { kind: 'apply-source' }>, 'receipt'> & {
      receipt?: { native: NativeActionReceipt; snapshot: LifeSourceSnapshot }
    })
  | Exclude<ParsedStudioPlannerAction, { kind: 'read-source' | 'apply-source' }>
export type StudioPlannerRecovery = Omit<z.infer<typeof plannerSchema>, 'source' | 'action'> & {
  source?: LifeSourceContext
  action?: StudioPlannerAction
}
export interface StudioPlannerBinding {
  sessionId: string
  profileId: string
  provider: Provider
}
export interface BoundStudioPlannerRecovery {
  planner: StudioPlannerRecovery
  owner: Omit<NativeRecoveryOwnerState, 'clientRecovery'>
}
const recoveredOwners = new WeakSet<BoundStudioPlannerRecovery>()

function freezeJson(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeJson(child)
  Object.freeze(value)
}

/** Copy descriptors before validation; executable properties must never be evaluated. */
function copyJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
  path: string[] = [],
  archival = false,
): unknown {
  if (++budget.nodes > 200_000 || depth > 40)
    throw new Error('Studio planner recovery is too deeply nested or too large.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object')
    throw new Error('Studio planner recovery requires JSON data.')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null)
    throw new Error('Studio planner recovery requires plain objects.')
  if (ancestors.has(value)) throw new Error('Studio planner recovery cannot contain cycles.')
  ancestors.add(value)
  const result: unknown[] | Record<string, unknown> = array ? [] : {}
  let entries = 0
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      (!archival && ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key))
    )
      throw new Error('Studio planner recovery contains an unsupported property.')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (descriptor.get || descriptor.set)
      throw new Error('Studio planner recovery cannot contain getters or setters.')
    if (array) {
      if (key === 'length') continue
      if (!/^(?:0|[1-9][0-9]*)$/.test(key))
        throw new Error('Studio planner arrays cannot contain named properties.')
      entries++
      ;(result as unknown[])[Number(key)] = copyJson(
        descriptor.value,
        ancestors,
        depth + 1,
        budget,
        [...path, key],
        archival,
      )
    } else if (descriptor.value !== undefined) {
      const isMetadata =
        key === 'metadata' &&
        ((path.length === 2 && path[0] === 'sessionSeed' && path[1] === 'thread') ||
          (path.length === 3 &&
            path[0] === 'clientRecovery' &&
            path[1] === 'sessionSeed' &&
            path[2] === 'thread'))
      Object.defineProperty(result, key, {
        value: copyJson(
          descriptor.value,
          ancestors,
          depth + 1,
          budget,
          [...path, key],
          archival || isMetadata,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }
  if (array && entries !== value.length)
    throw new Error('Studio planner arrays cannot contain holes.')
  ancestors.delete(value)
  return result
}

/** No migration may rewrite the prompt, change its owner, or admit extra continuation work. */
export function parseStudioPlannerRecovery(value: unknown): StudioPlannerRecovery {
  const copied = copyJson(value)
  if (bytes(JSON.stringify(copied)) > maximumBytes)
    throw new Error('Studio planner recovery must be smaller than 32 MB; no context was truncated.')
  const parsed = plannerSchema.parse(copied)
  const original = copied as {
    input: { workspace?: unknown }
    action?: { kind: string; intent: { input?: { workspace?: unknown } } }
  }
  if (
    parsed.input.workspace !== original.input.workspace ||
    (parsed.action?.kind === 'start-provider' &&
      parsed.action.intent.input.workspace !== original.action?.intent.input?.workspace)
  )
    throw new Error(
      'Saved native workspace must remain exact; recovery cannot normalize ownership.',
    )
  return parsed
}

export function encodeStudioPlannerRecovery(planner: StudioPlannerRecovery): string {
  return JSON.stringify(parseStudioPlannerRecovery(planner))
}

export function readStudioPlannerRecovery(
  serialized: string | null | undefined,
): StudioPlannerRecovery | undefined {
  if (!serialized || serialized.length > maximumBytes || bytes(serialized) > maximumBytes) return
  try {
    return parseStudioPlannerRecovery(JSON.parse(serialized))
  } catch {
    return
  }
}

/** Call only with an owner returned by agent.recover(), after native ownership reconciliation. */
export function restoreStudioPlannerRecovery(
  owner: NativeRecoveryOwnerState,
  binding: StudioPlannerBinding,
): BoundStudioPlannerRecovery | undefined {
  try {
    const copied = copyJson(owner) as NativeRecoveryOwnerState
    if (
      copied.sessionId !== binding.sessionId ||
      !identifier.safeParse(copied.transportId).success ||
      !natural.safeParse(copied.ownerGeneration).success ||
      !['recovering', 'unknown', 'running', 'idle'].includes(copied.status)
    )
      return
    const planner = parseStudioPlannerRecovery(copied.clientRecovery)
    if (
      planner.sessionId !== binding.sessionId ||
      planner.profileId !== binding.profileId ||
      planner.provider !== binding.provider ||
      (planner.applied && planner.applied.transportId !== copied.transportId) ||
      (planner.applied &&
        (!natural.safeParse(copied.throughEventRevision).success ||
          planner.applied.throughEventRevision > copied.throughEventRevision!))
    )
      return
    const native =
      planner.action?.receipt && 'native' in planner.action.receipt
        ? planner.action.receipt.native
        : undefined
    if (
      native &&
      (native.transportId !== copied.transportId ||
        native.ownerGeneration !== copied.ownerGeneration)
    )
      return
    const { clientRecovery: _clientRecovery, ...state } = copied
    const result = { planner, owner: state }
    freezeJson(result)
    recoveredOwners.add(result)
    return result
  } catch {
    return
  }
}

export type StudioPlannerRecoveryStep =
  | 'wait-owner'
  | 'await-output'
  | 'finish-response'
  | 'continue-action'
  | 'use-receipt'
  | 'reconcile-action'
  | 'review'
  | 'finished'

/** The caller reconciles native actions/outbox before performing any mutating continuation. */
export function getStudioPlannerRecoveryStep(
  bound: BoundStudioPlannerRecovery,
): StudioPlannerRecoveryStep {
  if (!recoveredOwners.has(bound)) return 'wait-owner'
  const { planner, owner } = bound
  if (owner.status === 'recovering' || owner.status === 'unknown') return 'wait-owner'
  if (planner.action && ['intended', 'started'].includes(planner.action.status)) {
    // A lost IPC receipt is never permission to repeat a provider start, apply, or reload.
    if (
      planner.phase === 'finished' ||
      planner.action.status === 'started' ||
      planner.action.kind !== 'read-source'
    )
      return 'reconcile-action'
    return 'continue-action'
  }
  if (planner.phase === 'finished') return planner.terminal ? 'finished' : 'reconcile-action'
  if (planner.action) return 'use-receipt'
  if (planner.phase === 'planning')
    return owner.status === 'running' ? 'await-output' : 'reconcile-action'
  if (planner.phase === 'completing') return 'finish-response'
  if (planner.phase === 'review') return 'review'
  return 'reconcile-action'
}

/** Write this transition through the native registry before issuing its action. */
export function startStudioPlannerAction(
  planner: StudioPlannerRecovery,
  actionId: string,
): StudioPlannerRecovery {
  const current = parseStudioPlannerRecovery(planner)
  if (current.action?.id !== actionId || current.action.status !== 'intended')
    throw new Error('Only the exact intended Studio action may start.')
  return parseStudioPlannerRecovery({
    ...current,
    action: { ...current.action, status: 'started' },
  })
}

/** A duplicate receipt is harmless; conflicting completion or another action is refused. */
export function settleStudioPlannerAction(
  planner: StudioPlannerRecovery,
  actionId: string,
  result: { receipt: NonNullable<StudioPlannerAction['receipt']> } | { error: string },
): StudioPlannerRecovery {
  const current = parseStudioPlannerRecovery(planner)
  const completion = copyJson(result) as typeof result
  if (
    !completion ||
    typeof completion !== 'object' ||
    Array.isArray(completion) ||
    Object.keys(completion).length !== 1 ||
    (!Object.hasOwn(completion, 'receipt') &&
      !(
        Object.hasOwn(completion, 'error') &&
        typeof (completion as { error?: unknown }).error === 'string'
      ))
  )
    throw new Error('Studio action completion must contain one exact receipt or error.')
  if (current.action?.id !== actionId) throw new Error('Studio receipt belongs to another action.')
  const settled = parseStudioPlannerRecovery({
    ...current,
    action: {
      ...current.action,
      status: 'receipt' in completion ? 'succeeded' : 'failed',
      receipt: 'receipt' in completion ? completion.receipt : undefined,
      error: 'error' in completion ? completion.error : undefined,
    },
  })
  if (current.action.status === 'succeeded' || current.action.status === 'failed') {
    if (JSON.stringify(settled.action) !== JSON.stringify(current.action))
      throw new Error('Studio action already has a different durable receipt.')
    return planner
  }
  if (current.action.status !== 'started') throw new Error('Studio action was not started.')
  return settled
}

export interface StudioPlannerNativeActionResult {
  status: 'intended' | 'started' | 'succeeded' | 'failed' | 'unknown'
  native: { actionId: string; transportId: string; ownerGeneration: number }
  receipt?: NonNullable<StudioPlannerAction['receipt']>
  error?: string
}
const nativeResultSchema = z
  .object({
    status: z.enum(['intended', 'started', 'succeeded', 'failed', 'unknown']),
    native: nativeReceiptSchema,
    receipt: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.status === 'succeeded') !== (result.receipt !== undefined))
      context.addIssue({ code: 'custom', message: 'Only native success has an action receipt.' })
    if (result.status === 'failed' && typeof result.error !== 'string')
      context.addIssue({
        code: 'custom',
        message: 'Native action failure requires its durable error.',
      })
    if (result.error !== undefined && result.status !== 'failed' && result.status !== 'unknown')
      context.addIssue({
        code: 'custom',
        message: 'An unsettled native action has no failure receipt.',
      })
  })

/** An authoritative action lookup can bridge a crash between admission and the renderer ACK. */
export function acceptStudioPlannerActionResult(
  bound: BoundStudioPlannerRecovery,
  value: StudioPlannerNativeActionResult,
): StudioPlannerRecovery {
  if (!recoveredOwners.has(bound))
    throw new Error('Native Studio planner ownership is not admitted.')
  const result = nativeResultSchema.parse(copyJson(value))
  const current = parseStudioPlannerRecovery(bound.planner)
  const action = current.action
  if (
    !action ||
    result.native.actionId !== action.id ||
    result.native.transportId !== bound.owner.transportId ||
    result.native.ownerGeneration !== bound.owner.ownerGeneration
  )
    throw new Error('Native Studio action result belongs to another owner or action.')
  if (result.status === 'intended') return current
  if (result.status === 'started' || result.status === 'unknown') {
    // Unknown admission is retained as started, so even an intended renderer record cannot rerun it.
    return action.status === 'intended' ? startStudioPlannerAction(current, action.id) : current
  }
  const admitted =
    action.status === 'intended' ? startStudioPlannerAction(current, action.id) : current
  if (result.status === 'failed')
    return settleStudioPlannerAction(admitted, action.id, { error: result.error! })
  const receipt = copyJson(result.receipt) as NonNullable<StudioPlannerAction['receipt']>
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('native' in receipt) ||
    receipt.native.actionId !== result.native.actionId ||
    receipt.native.transportId !== result.native.transportId ||
    receipt.native.ownerGeneration !== result.native.ownerGeneration
  )
    throw new Error('Native Studio receipt does not match its authoritative result.')
  return settleStudioPlannerAction(admitted, action.id, { receipt })
}

/** Consume proven results without reconstructing or replaying their already completed action. */
export function advanceStudioPlannerActionReceipt(
  planner: StudioPlannerRecovery,
): StudioPlannerRecovery {
  const current = parseStudioPlannerRecovery(planner)
  const action = current.action
  if (!action || action.status === 'failed') return current
  if (action.status !== 'succeeded')
    throw new Error('Studio action has no successful durable receipt.')
  switch (action.kind) {
    case 'read-source':
      if (action.intent.purpose === 'repair-index') return current
      return parseStudioPlannerRecovery({
        ...current,
        source: action.receipt!.source,
        phase: 'preparing',
        finishing: true,
        continuation:
          action.intent.purpose === 'source-read'
            ? { sourceRead: action.intent.read }
            : current.continuation,
        // The next native start replaces this proven read atomically with its own outbox intent.
        // Keeping the receipt makes a crash before that admission resumable without rereading.
        action,
      })
    case 'start-provider':
      return parseStudioPlannerRecovery({
        ...current,
        input: {
          ...current.input,
          ...(action.receipt!.remoteId ? { remoteId: action.receipt!.remoteId } : {}),
        },
        phase: 'planning',
        finishing: false,
        action: undefined,
      })
    case 'apply-settings':
    case 'apply-extension':
    case 'reload-source':
      return parseStudioPlannerRecovery({
        ...current,
        phase: 'finished',
        finishing: true,
        terminal: { stage: 'complete' },
        action: undefined,
      })
    case 'apply-source':
      // Keep the exact snapshot and action ID until the native reload intent is durably recorded.
      return parseStudioPlannerRecovery({ ...current, phase: 'reloading', finishing: true })
  }
}
