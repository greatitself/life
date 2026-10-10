import type { PermissionMode, Provider } from './types'

// Legacy values remain readable for desktop conversations and source customization sessions.
export const permissionModes = [
  'review',
  'edit',
  'plan',
  'ask-for-approval',
  'read-only',
  'full-access',
  'auto-review',
  'auto',
  'dontAsk',
] as const

export function webPermissionMode(provider: Provider, mode: PermissionMode): PermissionMode {
  if (provider === 'codex') {
    if (mode === 'plan') return 'read-only'
    return ['ask-for-approval', 'read-only', 'full-access', 'auto-review'].includes(mode)
      ? mode
      : 'ask-for-approval'
  }
  return ['review', 'edit', 'full-access', 'auto', 'dontAsk'].includes(mode) ? mode : 'review'
}

export function codexPermissions(mode: PermissionMode, writableRoot: string) {
  if (mode === 'auto' || mode === 'dontAsk') throw new Error('Select a Codex permission mode.')
  const readonly = mode === 'plan' || mode === 'read-only'
  const full = mode === 'full-access'
  return {
    approvalPolicy: full ? 'never' : mode === 'review' ? 'untrusted' : 'on-request',
    approvalsReviewer: mode === 'auto-review' ? 'auto_review' : 'user',
    sandbox: full ? 'danger-full-access' : readonly ? 'read-only' : 'workspace-write',
    sandboxPolicy: full
      ? { type: 'dangerFullAccess' }
      : readonly
        ? { type: 'readOnly' }
        : { type: 'workspaceWrite', writableRoots: [writableRoot], networkAccess: false },
  }
}

export function claudePermissionMode(mode: PermissionMode) {
  if (mode === 'read-only' || mode === 'auto-review')
    throw new Error('Select a Claude Code permission mode.')
  if (mode === 'full-access') return 'bypassPermissions'
  if (mode === 'edit') return 'acceptEdits'
  if (mode === 'plan') return 'plan'
  return mode === 'auto' || mode === 'dontAsk' ? mode : 'default'
}
