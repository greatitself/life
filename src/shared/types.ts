export type Provider = 'codex' | 'claude'
export type PermissionMode = 'review' | 'edit' | 'plan'
export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'agent' | 'key' | 'password'
  privateKeyPath: string
  workspace: string
}
export interface ConnectInput extends ConnectionProfile {
  password?: string
  passphrase?: string
}
export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected'
  profile?: ConnectionProfile
  workspace?: string
  codex?: string
  claude?: string
  error?: string
}
export interface StartInput {
  sessionId: string
  provider: Provider
  remoteId?: string
  prompt: string
  model?: string
  mode: PermissionMode
}
export interface FileEntry {
  name: string
  path: string
  directory: boolean
  size: number
}
export interface GitState {
  branch: string
  diff: string
  status: string
}
export interface AgentEvent {
  sessionId: string
  type:
    | 'text'
    | 'tool'
    | 'tool-output'
    | 'approval'
    | 'question'
    | 'complete'
    | 'error'
    | 'session'
    | 'status'
  text?: string
  itemId?: string
  title?: string
  requestId?: string
  remoteId?: string
  questions?: AgentQuestion[]
  status?: string
}
export interface AgentQuestion {
  id: string
  header?: string
  question: string
  options?: { label: string; description?: string }[]
}
export interface HostKeyRequest {
  id: string
  host: string
  fingerprint: string
}
export interface ModelOption {
  id: string
  name: string
}
export interface RelayAPI {
  profiles: {
    list(): Promise<ConnectionProfile[]>
    save(profile: ConnectionProfile): Promise<void>
    remove(id: string): Promise<void>
  }
  connection: {
    connect(input: ConnectInput): Promise<ConnectionState>
    disconnect(): Promise<void>
    state(): Promise<ConnectionState>
    trust(id: string, accepted: boolean): Promise<void>
  }
  agent: {
    start(input: StartInput): Promise<void>
    stop(sessionId: string): Promise<void>
    respond(
      sessionId: string,
      requestId: string,
      accepted: boolean,
      answers?: Record<string, string[]>,
    ): Promise<void>
    models(provider: Provider): Promise<ModelOption[]>
  }
  files: {
    list(path?: string): Promise<FileEntry[]>
    read(path: string): Promise<string>
    git(): Promise<GitState>
  }
  terminal: {
    open(): Promise<void>
    write(data: string): void
    resize(cols: number, rows: number): void
    close(): Promise<void>
  }
  chooseKey(): Promise<string | null>
  window: { minimize(): void; maximize(): void; close(): void }
  onConnection(callback: (state: ConnectionState) => void): () => void
  onAgent(callback: (event: AgentEvent) => void): () => void
  onHostKey(callback: (request: HostKeyRequest) => void): () => void
  onTerminal(callback: (data: string) => void): () => void
}
