export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  version?: string
  progress?: UpdateProgress
  checkedAt?: string
  error?: string
  message?: string
}

export interface LifeUpdatesAPI {
  get(): Promise<UpdateState>
  check(): Promise<UpdateState>
  download(): Promise<UpdateState>
  install(): Promise<void>
  onState(callback: (state: UpdateState) => void): () => void
}

export const LIFE_RELEASES_URL = 'https://github.com/greatitself/life/releases/latest'
