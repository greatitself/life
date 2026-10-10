import type { Message } from './state'
import { isSubagentActivity } from './thread-activity'

export type ActivityRow =
  | { kind: 'message' | 'context'; message: Message }
  | { kind: 'tools' | 'agents'; messages: Message[] }

/** Keep settled batch props intact while another item in the same turn streams. */
export function createActivityRowsProjector(): (messages: Message[]) => ActivityRow[] {
  let previous = new Map<string, ActivityRow>()
  return (messages) => {
    const rows: ActivityRow[] = []
    let batch: Extract<ActivityRow, { messages: Message[] }> | undefined
    for (const message of messages) {
      if (
        message.role !== 'tool' ||
        /context.?compact|compaction/i.test(message.title || '') ||
        message.kind === 'status'
      ) {
        batch = undefined
        rows.push({ kind: message.role === 'tool' ? 'context' : 'message', message })
        continue
      }
      const kind = isSubagentActivity(message) ? 'agents' : 'tools'
      if (!batch || batch.kind !== kind) {
        batch = { kind, messages: [] }
        rows.push(batch)
      }
      batch.messages.push(message)
    }
    const projected = rows.map((row) => {
      const id = 'messages' in row ? row.messages[0].id : row.message.id
      const retained = previous.get(id)
      return retained &&
        retained.kind === row.kind &&
        ('messages' in retained && 'messages' in row
          ? retained.messages.length === row.messages.length &&
            retained.messages.every((message, index) => message === row.messages[index])
          : 'message' in retained && 'message' in row && retained.message === row.message)
        ? retained
        : row
    })
    previous = new Map(
      projected.map((row) => ['messages' in row ? row.messages[0].id : row.message.id, row]),
    )
    return projected
  }
}
