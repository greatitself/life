import type { ConnectionProfile, ConnectionState, RelayAPI } from '../shared/types'
import type { Thread } from './state'

type ThreadTarget = Pick<Thread, 'id' | 'profileId' | 'workspace' | 'workspaceUnknown' | 'remoteId'>
type ConnectionClient = Pick<RelayAPI['connection'], 'state' | 'connect' | 'selectWorkspace'>

export type ThreadContextResult =
  | { kind: 'ready'; connection: ConnectionState }
  | { kind: 'credentials'; profileId: string }
  | { kind: 'project'; profileId: string; path?: string; error?: string }
  | { kind: 'unavailable'; error: string }
  | { kind: 'superseded' }

function targetKey(thread: ThreadTarget): string {
  return JSON.stringify([
    thread.id,
    thread.profileId,
    thread.workspace || '',
    Boolean(thread.remoteId),
    Boolean(thread.workspaceUnknown),
  ])
}

/** Life has one selected SSH workspace. Restore it in order when users switch threads. */
export class ThreadContextController {
  private generation = 0
  private tail: Promise<unknown> = Promise.resolve()
  private pendingCount = 0
  private pending?: { key: string; generation: number; promise: Promise<ThreadContextResult> }

  cancel(): void {
    this.generation++
    this.pending = undefined
  }

  get busy(): boolean {
    return this.pendingCount > 0
  }

  /** Explicit picker selections wait until an older SSH selection has released its lock. */
  async settled(): Promise<void> {
    for (;;) {
      const tail = this.tail
      await tail.catch(() => {})
      if (tail === this.tail) return
    }
  }

  restore(
    thread: ThreadTarget,
    profiles: ConnectionProfile[],
    client: ConnectionClient,
  ): Promise<ThreadContextResult> {
    const key = targetKey(thread)
    if (this.pending?.key === key) return this.pending.promise
    const generation = ++this.generation
    const current = () => generation === this.generation
    const run = async (): Promise<ThreadContextResult> => {
      if (!current()) return { kind: 'superseded' }
      if (thread.profileId === 'life-local')
        return { kind: 'ready', connection: await client.state() }
      // An unresolved historical conversation must never be resumed in another folder.
      if ((thread.remoteId && !thread.workspace) || thread.workspaceUnknown)
        return {
          kind: 'unavailable',
          error:
            'This older thread’s project could not be resolved. Start a new thread in the selected project.',
        }
      let state: ConnectionState
      try {
        state = await client.state()
      } catch (error) {
        return current()
          ? { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) }
          : { kind: 'superseded' }
      }
      if (!current()) return { kind: 'superseded' }
      if (state.status !== 'connected' || state.profile?.id !== thread.profileId) {
        const profile = profiles.find((item) => item.id === thread.profileId)
        if (!profile)
          return {
            kind: 'unavailable',
            error:
              'This thread’s saved machine is unavailable. Add its connection again to continue.',
          }
        if (state.status === 'connecting' || profile.auth === 'password')
          return { kind: 'credentials', profileId: profile.id }
        try {
          state = await client.connect(profile)
        } catch {
          return current() ? { kind: 'credentials', profileId: profile.id } : { kind: 'superseded' }
        }
        if (!current()) return { kind: 'superseded' }
      }
      if (state.status !== 'connected' || state.profile?.id !== thread.profileId)
        return { kind: 'credentials', profileId: thread.profileId }
      if (!thread.workspace)
        return state.workspace
          ? { kind: 'ready', connection: state }
          : { kind: 'project', profileId: thread.profileId }
      if (state.workspace !== thread.workspace) {
        try {
          state = await client.selectWorkspace(thread.workspace)
        } catch (error) {
          return current()
            ? {
                kind: 'project',
                profileId: thread.profileId,
                path: thread.workspace,
                error: error instanceof Error ? error.message : String(error),
              }
            : { kind: 'superseded' }
        }
        if (!current()) return { kind: 'superseded' }
      }
      if (
        state.status !== 'connected' ||
        state.profile?.id !== thread.profileId ||
        state.workspace !== thread.workspace
      )
        return {
          kind: 'project',
          profileId: thread.profileId,
          path: thread.workspace,
          error:
            'The machine or project changed while this thread was opening. Try selecting the thread again.',
        }
      return { kind: 'ready', connection: state }
    }
    // A slow project selection cannot race a second selection, or switch the UI
    // back to an older thread after its promise resolves.
    this.pendingCount++
    const promise = this.tail.then(run, run).finally(() => {
      this.pendingCount--
    })
    this.tail = promise
    this.pending = { key, generation, promise }
    void promise
      .finally(() => {
        if (this.pending?.generation === generation) this.pending = undefined
      })
      .catch(() => {})
    return promise
  }
}
