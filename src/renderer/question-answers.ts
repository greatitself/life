import type { AgentEvent, AgentQuestion } from '../shared/types'

export const questionOptionValue = (option: NonNullable<AgentQuestion['options']>[number]) =>
  option.value ?? option.label

/** Keep UI-only choices separate from every value the provider actually accepts. */
export function questionChoiceSentinel(question: AgentQuestion, name: 'empty' | 'other') {
  const values = new Set(question.options?.map(questionOptionValue))
  let sentinel = `__life_${name}__`
  while (values.has(sentinel)) sentinel += '_'
  return sentinel
}

export function questionAllowsOther(question: AgentQuestion) {
  return question.isOther !== false && (!question.inputType || question.inputType === 'text')
}

/** Validate without trimming, choosing defaults, or rewriting the user's response. */
export function prepareQuestionAnswers(
  questions: AgentQuestion[],
  draft: Record<string, string[]>,
) {
  const answers: Record<string, string[]> = {}
  const errors: Record<string, string> = {}
  for (const question of questions) {
    const choices = new Set(question.options?.map(questionOptionValue))
    const values = (draft[question.id] || []).filter(
      (value) =>
        choices.has(value) || value.length > 0 || (question.allowEmpty && !question.multiple),
    )
    if (!values.length) {
      if (question.allowEmpty && question.multiple && draft[question.id]?.length === 0) {
        answers[question.id] = []
        continue
      }
      if (question.required !== false) errors[question.id] = 'Please answer this question.'
      continue
    }
    if (!question.multiple && values.length > 1) {
      errors[question.id] = 'Choose one answer.'
      continue
    }
    if (
      choices.size &&
      !questionAllowsOther(question) &&
      values.some((value) => !choices.has(value))
    ) {
      errors[question.id] = 'Choose one of the offered answers.'
      continue
    }
    if (
      question.inputType === 'boolean' &&
      values.some((value) => !['true', 'false'].includes(value))
    ) {
      errors[question.id] = 'Choose Yes or No.'
      continue
    }
    if (question.inputType === 'number' || question.inputType === 'integer') {
      const valid = values.every((value) => {
        const trimmed = value.trim()
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return false
        const number = Number(trimmed)
        return (
          Number.isFinite(number) &&
          (question.inputType !== 'integer' || Number.isSafeInteger(number))
        )
      })
      if (!valid) {
        errors[question.id] =
          question.inputType === 'integer'
            ? 'Enter a whole number within the supported range.'
            : 'Enter a valid finite number.'
        continue
      }
    }
    answers[question.id] = values
  }
  return { answers, errors, valid: Object.keys(errors).length === 0 }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readableValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(readableValue).filter(Boolean).join('\n')
  return Object.entries(record(value))
    .map(([key, entry]) => `${readableLabel(key)}: ${readableValue(entry)}`)
    .join('\n')
}

function readableLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase())
}

function permissionText(value: unknown) {
  return readableValue(value).replace(
    /(?:\x1B\[|\u009B)[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-_]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
    '',
  )
}

/** Surface the actual requested operation and access rather than an unlabelled JSON payload. */
export function approvalRequestPresentation(event: AgentEvent) {
  const details = record(event.details)
  const request = { ...details, ...record(details.params) }
  const input = record(request.input)
  const value = (key: string) => request[key] ?? input[key]
  const fields: { label: string; text: string }[] = []
  const add = (label: string, entry: unknown) => {
    const text = readableValue(entry)
    if (text) fields.push({ label, text })
  }
  add(
    'Reason',
    permissionText(
      value('reason') ?? value('decisionReason') ?? value('decision_reason') ?? value('message'),
    ),
  )
  add('Details', permissionText(value('description')))
  add('Working directory', value('cwd') ?? value('workingDirectory'))
  add('Command', value('command'))
  add('Requested permissions', value('permissions'))
  add(
    'File access',
    value('grantRoot') ?? value('filePath') ?? value('file_path') ?? value('blocked_path'),
  )
  add('Network access', value('networkApprovalContext') ?? value('network'))
  add('Additional access', value('additionalPermissions') ?? value('additional_permissions'))
  const rawURL = typeof value('url') === 'string' ? String(value('url')) : undefined
  let url: string | undefined
  if (rawURL) {
    try {
      const parsed = new URL(rawURL)
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password)
        url = parsed.href
    } catch {
      // Invalid provider URLs stay visible as text and cannot launch an external application.
    }
  }
  const method = typeof request.method === 'string' ? request.method : ''
  const urlRequest = Boolean(rawURL) || method === 'url' || request.mode === 'url'
  const permissionsRequest = method.includes('permissions/requestApproval')
  const textIsJSON = Boolean(event.text && /^[\[{]/.test(event.text.trim()))
  return { fields, rawURL, url, urlRequest, permissionsRequest, textIsJSON }
}
