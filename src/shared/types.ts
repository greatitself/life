import type { LifeConfigPatch, LifeConfigState } from './customization'
import type { LifeUpdatesAPI } from './updates'
import type { LifeExtensionManifest, LifeExtensionsSnapshot } from './extensions'
export type Provider = 'codex' | 'claude'
export type PermissionMode = 'review' | 'edit' | 'plan'
export interface SSHConfigSource {
  alias: string
  path: string
}
export interface SSHConfigHost {
  alias: string
  host: string
  port: number
  username: string
  identityFiles: string[]
  availableIdentityFiles: string[]
  identityAgent?: string
  proxyJump?: string
  proxyCommand?: string
  identitiesOnly: boolean
  options: Record<string, string[]>
  unsupportedOptions: string[]
}
export interface SSHConfigList {
  path: string
  hosts: SSHConfigHost[]
  error?: string
}
export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'agent' | 'key' | 'password'
  privateKeyPath: string
  workspace: string
  sshConfig?: SSHConfigSource
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
  platform: string
  updates: LifeUpdatesAPI
  extensions: {
    capabilities: readonly string[]
    get(): Promise<LifeExtensionsSnapshot>
    apply(manifest: LifeExtensionManifest): Promise<LifeExtensionsSnapshot>
    enable(id: string, enabled: boolean): Promise<LifeExtensionsSnapshot>
    remove(id: string): Promise<LifeExtensionsSnapshot>
    rollback(id: string): Promise<LifeExtensionsSnapshot>
    call(id: string, method: string, args: unknown): Promise<unknown>
    invoke(method: string, args: unknown): Promise<unknown>
    openFolder(): Promise<void>
    recover(): Promise<void>
    onState(callback: (state: LifeExtensionsSnapshot) => void): () => void
    onEvent(
      callback: (event: {
        id: string
        type: 'event' | 'error'
        event?: string
        data?: unknown
        error?: string
      }) => void,
    ): () => void
    onRecovery(callback: () => void): () => void
  }
  customization: {
    get(): Promise<LifeConfigState>
    apply(patch: LifeConfigPatch): Promise<LifeConfigState>
    undo(): Promise<LifeConfigState>
    reset(): Promise<LifeConfigState>
    reload(): Promise<LifeConfigState>
    onChange(callback: (state: LifeConfigState) => void): () => void
  }
  sshConfig: {
    list(configPath?: string): Promise<SSHConfigList>
    resolve(alias: string, configPath?: string): Promise<SSHConfigHost>
  }
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
    dispose(sessionId: string): Promise<void>
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
  window: {
    minimize(): void
    maximize(): void
    close(): void
    state(): Promise<boolean>
    onState(callback: (maximized: boolean) => void): () => void
  }
  onConnection(callback: (state: ConnectionState) => void): () => void
  onAgent(callback: (event: AgentEvent) => void): () => void
  onHostKey(callback: (request: HostKeyRequest) => void): () => void
  onTerminal(callback: (data: string) => void): () => void
}
