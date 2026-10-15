import type { AgentQuestion } from '../shared/types'
import type { ApprovalChoice } from '../shared/approval-decisions'
import { Option, Schema } from 'effect'

type Wire = Record<string, unknown>
const object = (value: unknown): Wire =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : {}
const string = (value: unknown) => (typeof value === 'string' ? value : '')

const simpleApprovalDecision = Schema.Literals(['accept', 'acceptForSession', 'decline', 'cancel'])
const commandApprovalDecision = Schema.Union([
  simpleApprovalDecision,
  Schema.Struct({
    acceptWithExecpolicyAmendment: Schema.Struct({
      execpolicy_amendment: Schema.Array(Schema.String),
    }),
  }),
  Schema.Struct({
    applyNetworkPolicyAmendment: Schema.Struct({
      network_policy_amendment: Schema.Struct({
        host: Schema.NonEmptyString,
        action: Schema.Literals(['allow', 'deny']),
      }),
    }),
  }),
])
type NativeApprovalDecision = typeof commandApprovalDecision.Type
const decodeCommandApprovalDecision = Schema.decodeUnknownOption(commandApprovalDecision, {
  onExcessProperty: 'error',
})
const decodeFileApprovalDecision = Schema.decodeUnknownOption(simpleApprovalDecision)
const decodeOfferedDecisions = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

function nativeApprovalMethod(method: string) {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  )
}

function decodeApprovalDecision(method: string, value: unknown) {
  return method === 'item/fileChange/requestApproval'
    ? decodeFileApprovalDecision(value)
    : decodeCommandApprovalDecision(value)
}

function approvalChoice(
  method: string,
  params: Wire,
  decision: NativeApprovalDecision,
  index: number,
): ApprovalChoice {
  const id = `codex-approval:${index}`
  if (decision === 'accept')
    return {
      id,
      label: 'Allow once',
      description: params.grantRoot
        ? `Allows these file changes and write access to ${string(params.grantRoot)} for the remainder of this session.`
        : 'Allows this requested action.',
      outcome: 'approved',
    }
  if (decision === 'acceptForSession')
    return {
      id,
      label: 'Allow for this session',
      description:
        method === 'item/fileChange/requestApproval'
          ? 'Allows these changes and future changes to the same files without prompting in this session.'
          : 'Allows this action and future prompts in the same session approval cache without prompting.',
      outcome: 'approved',
    }
  if (decision === 'decline')
    return {
      id,
      label: 'Decline',
      description: 'Declines this action. The agent can continue the turn.',
      outcome: 'declined',
    }
  if (decision === 'cancel')
    return {
      id,
      label: 'Cancel this turn',
      description: 'Declines this action and immediately interrupts the current turn.',
      outcome: 'cancelled',
    }
  if ('acceptWithExecpolicyAmendment' in decision) {
    const prefix = decision.acceptWithExecpolicyAmendment.execpolicy_amendment
    return {
      id,
      label: 'Allow and save command rule',
      description: `Allows this action and saves a persistent rule for future commands matching this prefix: ${JSON.stringify(prefix)}${prefix.length ? '' : ' (matches every command)'}.`,
      outcome: 'approved',
    }
  }
  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment
  return {
    id,
    label: `${amendment.action === 'allow' ? 'Always allow' : 'Always deny'} ${amendment.host}`,
    description: `Saves a persistent network ${amendment.action} rule for ${amendment.host}, including future requests.`,
    outcome: amendment.action === 'allow' ? 'approved' : 'declined',
  }
}

/** Only project validated native choices; an explicit list never gets fallback grants. */
export function codexApprovalChoices(
  method: string,
  params: Wire,
): {
  approvalChoices?: ApprovalChoice[]
  approvalChoicesUnsupported?: string
} {
  if (!nativeApprovalMethod(method) || params.availableDecisions == null) return {}
  const offered = decodeOfferedDecisions(params.availableDecisions)
  if (Option.isNone(offered))
    return {
      approvalChoices: [],
      approvalChoicesUnsupported:
        'Codex supplied an invalid approval choice list. Use the provider client or stop this turn.',
    }
  const approvalChoices: ApprovalChoice[] = []
  let unsupported = 0
  for (const [index, value] of offered.value.entries()) {
    const decision = decodeApprovalDecision(method, value)
    if (Option.isSome(decision))
      approvalChoices.push(approvalChoice(method, params, decision.value, index))
    else unsupported++
  }
  return {
    approvalChoices,
    ...(unsupported || !offered.value.length
      ? {
          approvalChoicesUnsupported: unsupported
            ? `Codex offered ${unsupported} unsupported approval ${unsupported === 1 ? 'choice' : 'choices'}. Use the provider client for those choices.`
            : 'Codex did not offer a response for this request. Use the provider client or stop this turn.',
        }
      : {}),
  }
}

function selectedApprovalDecision(method: string, params: Wire, decisionId: string) {
  if (!nativeApprovalMethod(method) || params.availableDecisions == null)
    throw new Error('This request does not offer native approval choices.')
  const offered = decodeOfferedDecisions(params.availableDecisions)
  if (Option.isNone(offered)) throw new Error('Codex supplied an invalid approval choice list.')
  for (const [index, value] of offered.value.entries()) {
    if (`codex-approval:${index}` !== decisionId) continue
    const decision = decodeApprovalDecision(method, value)
    if (Option.isNone(decision))
      throw new Error('This native approval choice is unsupported or malformed.')
    return decision.value
  }
  throw new Error('Choose one of the native approval choices offered for this request.')
}

/** Stop may choose native cancellation, but never silently persist a deny policy. */
export function codexApprovalStopDecisionId(
  method: string,
  params: Wire,
): string | null | undefined {
  if (!nativeApprovalMethod(method) || params.availableDecisions == null) return undefined
  const offered = decodeOfferedDecisions(params.availableDecisions)
  if (Option.isNone(offered)) return null
  for (const decision of ['cancel', 'decline']) {
    const index = offered.value.indexOf(decision)
    if (index !== -1) return `codex-approval:${index}`
  }
  return null
}

export function codexApprovalResponseOutcome(result: Wire): ApprovalChoice['outcome'] | undefined {
  const decision = decodeCommandApprovalDecision(result.decision)
  return Option.isSome(decision) ? approvalChoice('', {}, decision.value, 0).outcome : undefined
}

type FormQuestion = AgentQuestion & {
  required: boolean
  inputType: 'text' | 'number' | 'integer' | 'boolean'
  multiple?: boolean
  isSecret?: boolean
  isOther?: boolean
  allowEmpty?: boolean
  options?: { label: string; value: string; description?: string }[]
}

function enumOptions(schema: Wire): { label: string; value: string }[] | undefined {
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.length || schema.enum.some((value) => typeof value !== 'string'))
      throw new Error('This form has an unsupported choice schema.')
    const labels = Array.isArray(schema.enumNames) ? schema.enumNames : []
    return schema.enum.map((value, index) => ({
      value: value as string,
      label: string(labels[index]) || (value as string),
    }))
  }
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined
  if (variants) {
    if (!variants.length) throw new Error('This form has an unsupported choice schema.')
    return variants.map((value) => {
      const option = object(value)
      if (typeof option.const !== 'string')
        throw new Error('This form has an unsupported choice schema.')
      return { value: option.const, label: string(option.title) || option.const }
    })
  }
  return undefined
}

function formSchema(params: Wire) {
  const schema = object(params.requestedSchema)
  if (
    schema.type !== 'object' ||
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  )
    throw new Error(
      'Life cannot display this MCP form schema. Decline it or use the provider client.',
    )
  const properties = object(schema.properties)
  if (schema.required != null && !Array.isArray(schema.required))
    throw new Error('This MCP form has invalid required fields.')
  const required = Array.isArray(schema.required) ? schema.required : []
  if (required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key)))
    throw new Error('This MCP form has invalid required fields.')
  return { properties, required: new Set(required as string[]) }
}

/** Display supported MCP primitive forms without applying server-supplied defaults. */
export function codexElicitationQuestions(params: Wire): AgentQuestion[] {
  const { properties, required } = formSchema(params)
  return Object.entries(properties).map(([id, value]): FormQuestion => {
    const schema = object(value)
    const type = string(schema.type)
    if (!['string', 'number', 'integer', 'boolean', 'array'].includes(type))
      throw new Error(`Life cannot display the MCP form field ${id}.`)
    const options = type === 'array' ? enumOptions(object(schema.items)) : enumOptions(schema)
    if (
      type === 'array' &&
      (!options ||
        (object(schema.items).type !== undefined && object(schema.items).type !== 'string'))
    )
      throw new Error(`Life cannot display the MCP form field ${id}.`)
    return {
      id,
      header: string(schema.title) || id,
      question: string(schema.description) || string(schema.title) || id,
      required: required.has(id),
      inputType:
        type === 'string' || type === 'array' ? 'text' : (type as FormQuestion['inputType']),
      ...(type === 'array' ? { multiple: true } : {}),
      ...(type === 'array'
        ? { allowEmpty: !(typeof schema.minItems === 'number' && schema.minItems > 0) }
        : type === 'string'
          ? { allowEmpty: acceptsEmptyString(schema) }
          : {}),
      ...(schema.format === 'password' || schema.isSecret === true ? { isSecret: true } : {}),
      ...(type === 'boolean'
        ? {
            options: [
              { label: 'Yes', value: 'true' },
              { label: 'No', value: 'false' },
            ],
            isOther: false,
          }
        : options
          ? { options, isOther: false }
          : {}),
    }
  })
}

function acceptsEmptyString(schema: Wire) {
  try {
    validateString('', schema, 'This field')
    return true
  } catch {
    return false
  }
}

function validDate(value: string) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!parts) return false
  const [year, month, day] = parts.slice(1).map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function validDateTime(value: string) {
  const parts =
    /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    )
  return Boolean(
    parts &&
    validDate(parts[1]) &&
    Number(parts[2]) < 24 &&
    Number(parts[3]) < 60 &&
    Number(parts[4]) <= 60 &&
    (!parts[5] || (Number(parts[6]) < 24 && Number(parts[7]) < 60)),
  )
}

function validateString(value: string, schema: Wire, name: string) {
  if (
    (typeof schema.minLength === 'number' && [...value].length < schema.minLength) ||
    (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength)
  )
    throw new Error(`${name} does not meet the requested length limits.`)
  const options = enumOptions(schema)
  if (options && !options.some((option) => option.value === value))
    throw new Error(`Choose one of the offered answers for ${name}.`)
  if (typeof schema.pattern === 'string') {
    let pattern: RegExp
    try {
      pattern = new RegExp(schema.pattern, 'u')
    } catch {
      throw new Error(`${name} has an invalid validation pattern.`)
    }
    if (!pattern.test(value)) throw new Error(`${name} does not match the requested format.`)
  }
  if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new Error(`Enter a valid email address for ${name}.`)
  if (schema.format === 'uri') {
    try {
      new URL(value)
    } catch {
      throw new Error(`Enter a valid URI for ${name}.`)
    }
  }
  if (schema.format === 'date' && !validDate(value))
    throw new Error(`Enter a date in YYYY-MM-DD format for ${name}.`)
  if (schema.format === 'date-time' && !validDateTime(value))
    throw new Error(`Enter a date and time for ${name}.`)
}

function elicitationContent(params: Wire, answers: Record<string, string[]>): Wire {
  // Check that every field can be represented before accepting any values.
  codexElicitationQuestions(params)
  const { properties, required } = formSchema(params)
  for (const key of Object.keys(answers))
    if (!Object.hasOwn(properties, key)) throw new Error(`The MCP form did not request ${key}.`)
  const entries: [string, unknown][] = []
  for (const [id, property] of Object.entries(properties)) {
    const schema = object(property)
    const values = Object.hasOwn(answers, id) ? answers[id] : undefined
    const name = string(schema.title) || id
    if (
      values === undefined ||
      (Array.isArray(values) && !values.length && schema.type !== 'array')
    ) {
      if (required.has(id)) throw new Error(`Answer ${name} before submitting.`)
      continue
    }
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
      throw new Error(`Invalid answer for ${name}.`)
    if (schema.type === 'array') {
      if (
        (typeof schema.minItems === 'number' && values.length < schema.minItems) ||
        (typeof schema.maxItems === 'number' && values.length > schema.maxItems) ||
        new Set(values).size !== values.length
      )
        throw new Error(`${name} does not meet the requested selection limits.`)
      values.forEach((value) => validateString(value, object(schema.items), name))
      entries.push([id, [...values]])
      continue
    }
    if (values.length !== 1) throw new Error(`Select one answer for ${name}.`)
    const value = values[0]
    if (!required.has(id) && value === '' && schema.type !== 'string') continue
    if (schema.type === 'boolean') {
      if (value !== 'true' && value !== 'false') throw new Error(`Choose Yes or No for ${name}.`)
      entries.push([id, value === 'true'])
    } else if (schema.type === 'number' || schema.type === 'integer') {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))
        throw new Error(`Enter a valid number for ${name}.`)
      const number = Number(value)
      if (
        !Number.isFinite(number) ||
        (schema.type === 'integer' && !Number.isSafeInteger(number)) ||
        (typeof schema.minimum === 'number' && number < schema.minimum) ||
        (typeof schema.maximum === 'number' && number > schema.maximum)
      )
        throw new Error(`${name} does not meet the requested number limits.`)
      entries.push([id, number])
    } else {
      validateString(value, schema, name)
      entries.push([id, value])
    }
  }
  return Object.fromEntries(entries)
}

/** Each response stays within the particular server request's advertised scope. */
export function codexRequestResponse(
  method: string,
  params: Wire,
  accepted: boolean,
  answers: Record<string, string[]> = {},
  decisionId?: string,
): Wire {
  if (decisionId !== undefined)
    return { decision: selectedApprovalDecision(method, params, decisionId) }
  if (method === 'item/permissions/requestApproval') {
    const requested = object(params.permissions)
    return {
      permissions: accepted
        ? Object.fromEntries(
            ['network', 'fileSystem']
              .filter((key) => requested[key] != null)
              .map((key) => [key, requested[key]]),
          )
        : {},
      scope: 'turn',
    }
  }
  if (method === 'mcpServer/elicitation/request') {
    if (!accepted) return { action: 'decline', content: null, _meta: null }
    if (params.mode === 'url') return { action: 'accept', content: null, _meta: null }
    if (!['form', 'openai/form', 'openaiForm'].includes(string(params.mode)))
      throw new Error('Life cannot accept this MCP elicitation mode.')
    return { action: 'accept', content: elicitationContent(params, answers), _meta: null }
  }
  if (method === 'item/tool/requestUserInput')
    return {
      answers: Object.fromEntries(
        Object.entries(accepted ? answers : {}).map(([key, value]) => [key, { answers: value }]),
      ),
    }
  if (!nativeApprovalMethod(method))
    throw new Error('Life does not support this native approval request.')
  const decision = accepted ? 'accept' : 'decline'
  if (params.availableDecisions != null) {
    const offered = decodeOfferedDecisions(params.availableDecisions)
    if (Option.isNone(offered)) throw new Error('Codex supplied an invalid approval choice list.')
    if (!offered.value.includes(decision))
      throw new Error(
        accepted
          ? 'This request does not offer approval for one action. Choose an offered native response.'
          : 'This request does not offer decline. Choose an offered native response.',
      )
  }
  return { decision }
}

export function codexApprovalPresentation(method: string, params: Wire) {
  const network = object(params.networkApprovalContext)
  const permissionRequest = method === 'item/permissions/requestApproval'
  const title = permissionRequest
    ? 'Allow requested access for this turn?'
    : network.host
      ? `Allow network access to ${string(network.host)}?`
      : method.includes('fileChange')
        ? 'Allow file changes?'
        : params.kind === 'writeStdin'
          ? 'Allow input to this command?'
          : 'Allow this command?'
  const text = [
    string(params.command),
    string(params.reason),
    params.cwd ? `Working directory: ${string(params.cwd)}` : '',
    params.grantRoot
      ? `Requested write access for the remainder of this session: ${string(params.grantRoot)}`
      : '',
    network.host
      ? `Network destination: ${string(network.protocol)}://${string(network.host)}`
      : '',
    params.permissions
      ? `Requested permissions:\n${JSON.stringify(params.permissions, null, 2)}`
      : '',
    params.additionalPermissions
      ? `Additional permissions:\n${JSON.stringify(params.additionalPermissions, null, 2)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { title, text: text || 'Codex needs permission to continue.' }
}
