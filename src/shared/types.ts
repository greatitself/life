import type { LifeConfigPatch, LifeConfigState } from './customization'
import type { LifeUpdatesAPI } from './updates'
import type { ProviderUpdatesAPI } from './provider-updates'
import type { ProviderUsageSnapshot } from './usage'
import type { LifeExtensionManifest, LifeExtensionsSnapshot } from './extensions'
import type { PortForwardingState } from './port-forwarding'
import type { SourceExtensionBundle } from './source-extensions'
import type { LifeStudioContext } from './life-studio'
import type { HostHistoryAPI } from './agent-history'
import type { ResearchDocumentsAPI } from './research-document'
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
export type PermissionMode =
  | 'review'
  | 'edit'
  | 'plan'
  | 'ask-for-approval'
  | 'read-only'
  | 'full-access'
  | 'auto-review'
  | 'auto'
  | 'dontAsk'
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
  /** Omitted on saved profiles from earlier releases, which use SSH. */
  transport?: 'ssh' | 'local'
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
  providerVersionsStatus?: 'checking' | 'ready' | 'failed'
  /** Advances when installed provider versions are successfully rediscovered. */
  providerVersionsRevision?: number
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
  /** The renderer turn owned by this native invocation; generations need not equal UI turns. */
  localTurn?: number
  provider: Provider
  remoteId?: string
  prompt: string
  model?: string
  reasoningEffort?: string
  serviceTier?: string
  providerOptions?: AgentProviderOptions
  mode: PermissionMode
  workspace?: string
  /** Dedicated Life Studio only; ordinary agent chats never receive app instructions. */
  scope?: 'life-customization' | 'research'
  studioContext?: LifeStudioContext
  attachments?: AgentAttachment[]
  /** Renderer planner continuation owned durably by the original native session. */
  clientRecovery?: unknown
  /** An answer to a privately recorded asynchronous native message question. */
  questionReply?: AgentQuestionReply
}
export interface AgentAttachment {
  remotePath: string
  name: string
  mimeType: string
}
export interface AgentSettingsInput {
  sessionId: string
  model?: string
  reasoningEffort?: string
  serviceTier?: string
  mode?: PermissionMode
}
export interface AgentConfigureResult {
  applied: 'live' | 'next-request'
  model?: string
  reasoningEffort?: string
  serviceTier?: string
  note?: string
  mode?: PermissionMode
}
export interface AgentSteerInput {
  sessionId: string
  prompt: string
  attachments?: AgentAttachment[]
  questionReply?: AgentQuestionReply
  /** Exact authored followup projection, retained with the native outbox input. */
  clientRecovery?: unknown
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
  scope?: 'project' | 'machine'
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
    | 'request-resolved'
    | 'account-usage'
    | 'complete'
    | 'error'
    | 'session'
    | 'status'
    | 'title'
    | 'settings'
    | 'reasoning'
    | 'plan'
    | 'subagent'
  text?: string
  itemId?: string
  title?: string
  requestId?: string
  remoteId?: string
  questions?: AgentQuestion[]
  /** Message questions continue independently and reply through native start/steer. */
  responseMode?: 'message'
  canDismiss?: boolean
  approvalChoices?: import('./approval-decisions').ApprovalChoice[]
  approvalChoicesUnsupported?: string
  status?: string
  phase?: 'commentary' | 'final_answer'
  input?: string
  agentId?: string
  agentName?: string
  parentItemId?: string
  provider?: Provider
  details?: unknown
  /** Identity issued by Life's durable native ledger, independent of provider payloads. */
  nativeRecovery?: {
    transportId: string
    revision: number
    eventId: string
    ownerGeneration?: number
    emittedAt?: number
    snapshotToken?: string
    localTurn?: number
    /** Ephemeral renderer delivery capability; never saved in conversation JSON. */
    deliveryToken?: string
    /** Current native control attestation on this delivery, independent of event history. */
    ownerStatus?: 'recovering' | 'unknown' | 'running' | 'idle'
  }
}
export interface NativeRecoverySupport {
  mode: 'durable' | 'unsupported-clean' | 'blocked'
  message?: string
}
export interface NativeRecoveryCursor {
  appliedRevision: number
  snapshotToken?: string
  ownerGeneration?: number
}
export interface NativeRecoveryConsumer {
  kind: 'main' | 'studio'
  sessionId: string
  profileId: string
  workspace?: string
  remoteId?: string
  applied?: Record<string, NativeRecoveryCursor>
  /** SHA256 of the actual privately admitted cache source. */
  cacheHash?: string
  projectionAdmissions?: readonly import('./conversations').ConversationProjectionAdmission[]
}
export interface NativeRecoveryOwnerState {
  sessionId: string
  transportId: string
  status: 'recovering' | 'unknown' | 'running' | 'idle'
  snapshotToken?: string
  ownerGeneration?: number
  throughEventRevision?: number
  /** Progress validated against this consumer's actual native/admitted-cache checkpoint. */
  acceptedAppliedRevision?: number
  acceptedAppliedCursor?: NativeRecoveryCursor
  acceptedProjectionAdmission?: import('./conversations').ConversationProjectionAdmission
  acceptedCacheHash?: string
  /** Current control ownership; historical projection admission is separate. */
  deliveryToken?: string
  message?: string
  /** Native-owned planner state; saved conversation metadata cannot grant this ownership. */
  clientRecovery?: unknown
  originalInput?: StartInput
  localTurn?: number
  remoteId?: string
  provider?: Provider
  pending?: AgentEvent[]
  /** Exact authored followups whose bound native message has a durable written receipt. */
  admittedFollowups?: unknown[]
  currentChildren?: AgentEvent[]
}
export interface NativeRecoveryHistoryReceipt {
  kind: 'studio'
  sessionId: string
  transportId: string
  snapshotToken: string
  snapshotId: string
  throughEventRevision: number
  durability: 'admitted-cache'
  fileHash?: string
}
export type NativeRecoveryActionKind =
  'source-read' | 'source-apply' | 'settings-apply' | 'extension-apply' | 'reload'
export interface NativeRecoveryActionIdentity {
  actionId: string
  transportId: string
  ownerGeneration: number
}
export interface NativeRecoveryActionRequest extends NativeRecoveryActionIdentity {
  sessionId: string
  kind: NativeRecoveryActionKind
  intent: unknown
}
export interface NativeRecoveryActionResult {
  status: 'intended' | 'started' | 'succeeded' | 'failed' | 'unknown'
  native: NativeRecoveryActionIdentity
  receipt?: {
    native: NativeRecoveryActionIdentity
    source?: LifeSourceContext
    snapshot?: LifeSourceSnapshot
  }
  error?: string
}
export interface AgentQuestion {
  id: string
  header?: string
  question: string
  options?: { label: string; description?: string; value?: string }[]
  required?: boolean
  inputType?: 'text' | 'number' | 'integer' | 'boolean'
  isSecret?: boolean
  isOther?: boolean
  multiple?: boolean
  allowEmpty?: boolean
}
export interface AgentQuestionReply {
  requestId: string
  answers: Record<string, string[]>
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
  supportsAutoMode?: boolean
  inputModalities?: string[]
}
export interface RelayAPI {
  platform: string
  conversations?: {
    supportsMessageFields?: true
    supportsMessageAppends?: true
    load(): Promise<import('./conversations').ConversationHistorySnapshot | null>
    loadEncoded?(): Promise<ArrayBuffer | null>
    save(
      threads: unknown[],
      savedAt?: number,
      projectionAdmissions?: readonly import('./conversations').ConversationProjectionAdmission[],
    ): Promise<void>
    checkpoint?(
      input: import('./conversations').ConversationCheckpointInput,
    ): Promise<import('./conversations').ConversationCheckpointAck>
  }
  hostHistory?: HostHistoryAPI
  researchDocuments?: ResearchDocumentsAPI
  forwarding: {
    get(): Promise<PortForwardingState>
    onState(callback: (state: PortForwardingState) => void): () => void
  }
  updates: LifeUpdatesAPI
  providerUpdates?: ProviderUpdatesAPI
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
    steer(input: AgentSteerInput): Promise<void>
    configure(input: AgentSettingsInput): Promise<AgentConfigureResult>
    stop(sessionId: string): Promise<void>
    dispose(sessionId: string): Promise<void>
    respond(
      sessionId: string,
      requestId: string,
      accepted: boolean,
      answers?: Record<string, string[]>,
      decisionId?: string,
    ): Promise<void>
    models(provider: Provider): Promise<ModelOption[]>
    usage?(provider: Provider): Promise<ProviderUsageSnapshot>
    /** Host-owned support report; renderer input cannot select the persistence mode. */
    recoverySupport?(): Promise<NativeRecoverySupport>
    /** Register hydrated consumers before delivering durable replay to this renderer. */
    recover?(input: {
      consumers: NativeRecoveryConsumer[]
      membershipAdmissions?: readonly import('./conversations').ConversationProjectionAdmission[]
    }): Promise<{ owners: NativeRecoveryOwnerState[] }>
    acknowledgeRecoveryHistory?(receipt: NativeRecoveryHistoryReceipt): Promise<void>
    attestLoadedHistory?(input: {
      hash: string
    }): Promise<import('./conversations').ConversationProjectionAdmission[]>
    prepareRecoveryCache?(input: {
      snapshotId: string
      hash: string
      savedAt: number
      projectionAdmissions: readonly import('./conversations').ConversationProjectionAdmission[]
      membershipAdmissions?: readonly import('./conversations').ConversationProjectionAdmission[]
    }): Promise<void>
    attestRecoveryCache?(input: { hash: string }): Promise<{
      projectionAdmissions: readonly import('./conversations').ConversationProjectionAdmission[]
      membershipAdmissions?: readonly import('./conversations').ConversationProjectionAdmission[]
      savedAt?: number
    }>
    updateRecoveryOwner?(input: {
      sessionId: string
      clientRecovery: unknown
      transportId?: string
      ownerGeneration?: number
      projectionAdmissions?: readonly import('./conversations').ConversationProjectionAdmission[]
    }): Promise<void>
    performRecoveryAction?(input: NativeRecoveryActionRequest): Promise<NativeRecoveryActionResult>
    reserveRecoveryOwner?(input: {
      input: StartInput
      clientRecovery: unknown
    }): Promise<NativeRecoveryOwnerState>
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
    /** Consumes the native emergency-recovery intent once for this BrowserWindow. */
    initialRecovery?(): Promise<boolean>
    minimize(): void
    maximize(): void
    close(): void
    /** Stop renderer-owned work and reopen the interface without disconnecting SSH or disabling extensions. */
    restart(): Promise<void>
    state(): Promise<boolean>
    onState(callback: (maximized: boolean) => void): () => void
  }
  onConnection(callback: (state: ConnectionState) => void): () => void
  onAgent(callback: (event: AgentEvent) => void): () => void
  onHostKey(callback: (request: HostKeyRequest) => void): () => void
  onTerminal(callback: (data: string) => void): () => void
}
