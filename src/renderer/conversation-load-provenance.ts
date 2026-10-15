import type { ConversationHistorySnapshot } from '../shared/conversations'
import type { RelayAPI } from '../shared/types'
import type { Thread } from './state'

export interface NativeConversationLoad {
  readonly hash: string
  readonly rows: readonly Thread[]
}

interface LoadedSnapshot {
  origin: NativeConversationLoad
  threads: unknown[]
  fields: Map<PropertyKey, unknown>
}
interface LoadedRow {
  origin: Readonly<{ hash: string }>
  fields: Map<PropertyKey, unknown>
  recovery?: {
    value: NonNullable<Thread['nativeRecovery']>
    cursors: Map<string, { value: object; fields: Map<PropertyKey, unknown> }>
  }
}
const snapshots = new WeakMap<ConversationHistorySnapshot, LoadedSnapshot>()
const rows = new WeakMap<Thread, LoadedRow>()
const rowFields = [
  'id',
  'profileId',
  'provider',
  'workspace',
  'workspaceUnknown',
  'remoteId',
  'messages',
  'nativeRecovery',
] as const

function captureFields(value: object, keys: readonly PropertyKey[]): Map<PropertyKey, unknown> {
  return new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]))
}

function matchesFields(value: object, fields: Map<PropertyKey, unknown>): boolean {
  for (const [key, previous] of fields) {
    const current = Object.getOwnPropertyDescriptor(value, key)
    if (current?.get || current?.set || current?.value !== previous) return false
  }
  return true
}

/** Internal to the completed encoded native load; persisted metadata never calls this. */
function recordNativeConversationLoad(snapshot: ConversationHistorySnapshot, hash: string): void {
  const loadedRows = Object.freeze([...(snapshot.threads as Thread[])])
  snapshots.set(snapshot, {
    origin: Object.freeze({ hash, rows: loadedRows }),
    threads: snapshot.threads,
    fields: captureFields(snapshot, ['version', 'savedAt', 'threads']),
  })
  const origin = Object.freeze({ hash })
  for (const row of loadedRows) {
    const recovery = row.nativeRecovery
    rows.set(row, {
      origin,
      fields: captureFields(row, rowFields),
      ...(recovery
        ? {
            recovery: {
              value: recovery,
              cursors: new Map(
                Object.entries(recovery).map(([transportId, cursor]) => [
                  transportId,
                  { value: cursor, fields: captureFields(cursor, Reflect.ownKeys(cursor)) },
                ]),
              ),
            },
          }
        : {}),
    })
  }
}

export function getNativeConversationLoad(
  snapshot: ConversationHistorySnapshot,
): NativeConversationLoad | undefined {
  const loaded = snapshots.get(snapshot)
  if (
    !loaded ||
    !matchesFields(snapshot, loaded.fields) ||
    Object.getOwnPropertyDescriptor(loaded.threads, 'length')?.value !==
      loaded.origin.rows.length ||
    loaded.origin.rows.some((row, index) => {
      const current = Object.getOwnPropertyDescriptor(loaded.threads, String(index))
      return (
        current?.get ||
        current?.set ||
        current?.value !== row ||
        getNativeConversationRowLoad(row)?.hash !== loaded.origin.hash
      )
    })
  )
    return
  return loaded.origin
}

export function getNativeConversationRowLoad(row: Thread): Readonly<{ hash: string }> | undefined {
  const loaded = rows.get(row)
  if (!loaded || !matchesFields(row, loaded.fields)) return
  if (loaded.recovery) {
    const { value, cursors } = loaded.recovery
    const currentKeys = Object.keys(value)
    if (currentKeys.length !== cursors.size) return
    for (const [transportId, cursor] of cursors) {
      const current = Object.getOwnPropertyDescriptor(value, transportId)
      if (
        current?.get ||
        current?.set ||
        current?.value !== cursor.value ||
        Reflect.ownKeys(cursor.value).length !== cursor.fields.size ||
        !matchesFields(cursor.value, cursor.fields)
      )
        return
    }
  }
  return loaded.origin
}

/** Only this native API wrapper can attach the private origin of a completed load. */
export async function loadConversationHistory(
  api: NonNullable<RelayAPI['conversations']>,
  signal?: AbortSignal,
): Promise<ConversationHistorySnapshot | null> {
  signal?.throwIfAborted()
  if (!api.loadEncoded) {
    const snapshot = await api.load()
    signal?.throwIfAborted()
    return snapshot
  }
  const buffer = await api.loadEncoded()
  signal?.throwIfAborted()
  if (buffer === null) return null
  const { decodeConversationHistoryWithHash } = await import('./conversation-load')
  signal?.throwIfAborted()
  const decoded = await decodeConversationHistoryWithHash(buffer, undefined, signal)
  signal?.throwIfAborted()
  if (decoded.hash !== undefined) recordNativeConversationLoad(decoded.snapshot, decoded.hash)
  return decoded.snapshot
}
