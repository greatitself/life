import type { Thread } from '../state'
import { threadProjectName } from '../sidebar-ordering'
import { useProjectColor } from './ProjectColors'
import './thread-experience.css'

export function ThreadBadge({ thread }: { thread: Thread }) {
  const color = useProjectColor(thread)
  const letters = threadProjectName(thread).match(/[\p{L}\p{N}]/gu) || ['?']
  const initials =
    `${letters[0]}${letters.length > 1 ? letters[letters.length - 1] : ''}`.toLocaleUpperCase()
  return (
    <span className="thread-project-badge" aria-hidden="true" style={{ backgroundColor: color }}>
      <span className="thread-project-initials">{initials}</span>
    </span>
  )
}
