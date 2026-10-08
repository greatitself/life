import type { LifeConfigPatch, LifeConfigState } from './customization'
import type { LifeUpdatesAPI } from './updates'
import type { LifeExtensionManifest, LifeExtensionsSnapshot } from './extensions'
import type { PortForwardingState } from './port-forwarding'
import type { SourceExtensionBundle } from './source-extensions'
import type {
  LifePublishedExtension,
  LifePublicExtensionPreview,
  LifePublishExtensionInput,
} from './extension-sharing'
import type {
  LifeSourceContext,
  LifeSourcePatch,
  LifeSourceRead,
  LifeSourceSnapshot,
} from './source-code'
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
export interface ConnectInput extends Omit<ConnectionProfile, 'workspace'> {
  workspace?: string
  password?: string
  passphrase?: string
}
export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected'
  profile?: ConnectionProfile
  home?: string
  lastWorkspace?: string
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
  reasoningEffort?: string
  serviceTier?: string
  providerOptions?: AgentProviderOptions
  mode: PermissionMode
  workspace?: string
}
export interface AgentProviderOptions {
  /** Additional Codex thread/start or thread/resume parameters. */
  thread?: Record<string, unknown>
  /** Additional Codex turn/start parameters. */
  turn?: Record<string, unknown>
  /** Additional session-scoped Claude Code settings. */
  settings?: Record<string, unknown>
  /** Additional Claude Code command-line arguments, quoted individually. */
  args?: string[]
}
export interface RemoteDirectoryList {
  path: string
  parent?: string
  entries: { name: string; path: string }[]
}
export interface ConnectionExecutionInput {
  command: string
  workspace?: string
  timeoutMs?: number
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
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[]
  defaultReasoningEffort?: string
  serviceTiers?: { id: string; name: string; description?: string }[]
  defaultServiceTier?: string
  isDefault?: boolean
}
export interface RelayAPI {
  platform: string
  forwarding: {
    get(): Promise<PortForwardingState>
    onState(callback: (state: PortForwardingState) => void): () => void
  }
  updates: LifeUpdatesAPI
  sourceCode: {
    get(): Promise<LifeSourceSnapshot>
    getContext(request?: LifeSourceRead): Promise<LifeSourceContext>
    apply(patch: LifeSourcePatch): Promise<LifeSourceSnapshot>
    setExtensionEnabled(id: string, enabled: boolean): Promise<LifeSourceSnapshot>
    removeExtension(id: string): Promise<LifeSourceSnapshot>
    exportExtension(id: string): Promise<SourceExtensionBundle>
    importExtension(bundle: SourceExtensionBundle): Promise<LifeSourceSnapshot>
    updateExtension(bundle: SourceExtensionBundle): Promise<LifeSourceSnapshot>
    rollback(): Promise<LifeSourceSnapshot>
    disable(): Promise<LifeSourceSnapshot>
    reload(): Promise<void>
    openFolder(): Promise<void>
    ready(revision: number): Promise<void>
    reportError(revision: number, message: string): Promise<void>
    onState(callback: (state: LifeSourceSnapshot) => void): () => void
  }
  extensionSharing: {
    publish(input: LifePublishExtensionInput): Promise<LifePublishedExtension>
    inspectPublic(link: string): Promise<LifePublicExtensionPreview>
    openPublic(link: string): Promise<void>
  }
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
    execute(input: ConnectionExecutionInput): Promise<string>
    selectWorkspace(path: string): Promise<ConnectionState>
    listDirectories(path?: string): Promise<RemoteDirectoryList>
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
