import type { Provider } from './types'

/** Read-only records from the connected host's existing provider history. */
export interface HostHistorySession {
  id: string
  provider: Provider
  remoteId: string
  title: string
  workspace?: string
  model?: string
  reasoningEffort?: string
  createdAt: number
  updatedAt: number
  archived?: boolean
  parentRemoteId?: string
  agentName?: string
  source: string
  lifePurpose?: 'research' | 'customization' | 'metadata'
}

/** Only Life's reserved directories define a domain, never a project basename. */
export function hostHistoryWorkspacePurpose(
  workspace?: string,
  machineHome?: string,
): HostHistorySession['lifePurpose'] {
  if (!workspace?.startsWith('/') || /[\x00-\x1f]/.test(workspace)) return
  const normalize = (path: string) => {
    const parts: string[] = []
    for (const part of path.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return '/' + parts.join('/')
  }
  const path = normalize(workspace)
  const home = machineHome?.startsWith('/') ? normalize(machineHome).replace(/\/$/, '') : undefined
  for (const purpose of ['research', 'customization', 'metadata'] as const) {
    const marker = `/.life/${purpose}`
    if (home !== undefined) {
      const root = home + marker
      if (path === root || path.startsWith(root + '/')) return purpose
    } else if (path.endsWith(marker) || path.includes(marker + '/')) return purpose
  }
}

export interface HostHistoryMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  title?: string
  input?: string
  status?: string
  turn: number
  turnId?: string
  createdAt?: number
  finishedAt?: number
  kind?: 'reasoning' | 'plan' | 'subagent' | 'attachment' | 'event'
  phase?: 'commentary' | 'final_answer'
  agentId?: string
  parentAgentId?: string
}

export interface HostHistoryListInput {
  provider?: Provider | 'all'
  query?: string
  cursor?: string
  limit?: number
  refresh?: boolean
  requestId?: string
}

export interface HostHistoryList {
  sessions: HostHistorySession[]
  nextCursor?: string
  warnings: string[]
}

export interface HostHistoryReadInput {
  id: string
  cursor?: string
  limit?: number
  requestId?: string
}

export interface HostHistoryPage {
  session: HostHistorySession
  messages: HostHistoryMessage[]
  subagents: HostHistorySession[]
  nextCursor?: string
  /** The exact existing import cursor continued by this page, absent for a fresh preview. */
  continuationOf?: string
  warnings: string[]
}

export interface HostHistoryAPI {
  list(input?: HostHistoryListInput): Promise<HostHistoryList>
  read(input: HostHistoryReadInput): Promise<HostHistoryPage>
  cancel(requestId: string): Promise<void>
}
