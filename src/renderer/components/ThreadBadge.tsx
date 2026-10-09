import type { Thread } from '../state'
import { threadProjectKey, threadProjectName } from '../sidebar-ordering'
import './thread-experience.css'

const colors = [
  '#3155a6',
  '#843fa0',
  '#246d60',
  '#90432c',
  '#755623',
  '#a13551',
  '#405d7b',
  '#5d4892',
]
export function ThreadBadge({ thread }: { thread: Thread }) {
  let hash = 2166136261
  for (const character of threadProjectKey(thread))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  const letters = threadProjectName(thread).match(/[\p{L}\p{N}]/gu) || ['?']
  const initials =
    `${letters[0]}${letters.length > 1 ? letters[letters.length - 1] : ''}`.toLocaleUpperCase()
  return (
    <span
      className="thread-project-badge"
      aria-hidden="true"
      style={{ backgroundColor: colors[(hash >>> 0) % colors.length] }}
    >
      <span className="thread-project-initials">{initials}</span>
    </span>
  )
}
