import type { AgentQuestion } from '../shared/types'

type Wire = Record<string, unknown>
const object = (value: unknown): Wire =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : {}
const string = (value: unknown) => (typeof value === 'string' ? value : '')

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
  if (schema.required !== undefined && !Array.isArray(schema.required))
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
): Wire {
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
  const decision = accepted ? 'accept' : 'decline'
  if (
    accepted &&
    Array.isArray(params.availableDecisions) &&
    !params.availableDecisions.includes(decision)
  )
    throw new Error(
      'This request does not offer approval for one action. Decline it or use the provider client.',
    )
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
    params.grantRoot ? `Requested write access: ${string(params.grantRoot)}` : '',
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
