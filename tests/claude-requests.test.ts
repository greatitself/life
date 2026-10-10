import { describe, expect, it } from 'vitest'
import { claudeElicitationQuestions, claudeElicitationResponse } from '../src/main/claude-requests'

const form = {
  subtype: 'elicitation',
  mcp_server_name: 'test-server',
  message: 'Review the requested configuration.',
  title: 'Configure the test service',
  display_name: 'Test service',
  description: 'Configuration for this request only.',
  requested_schema: {
    type: 'object',
    properties: {
      label: { type: 'string', title: 'Label', minLength: 2, default: 'never submit this' },
      ratio: { type: 'number', minimum: 0, maximum: 1 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      enabled: { type: 'boolean' },
      choice: {
        type: 'string',
        oneOf: [
          { const: 'alpha', title: 'Alpha display' },
          { const: 'beta', title: 'Beta display' },
        ],
      },
      selections: {
        type: 'array',
        items: { type: 'string', enum: ['one', 'two'] },
        minItems: 1,
        maxItems: 2,
      },
      private_note: { type: 'string', isSecret: true },
      optional: { type: 'string', default: 'also never submit this' },
    },
    required: ['label', 'ratio', 'count', 'enabled', 'choice', 'selections'],
  },
}

const answers = {
  label: ['Test'],
  ratio: ['0.25'],
  count: ['3'],
  enabled: ['false'],
  choice: ['alpha'],
  selections: ['one', 'two'],
}

describe('Claude native MCP elicitation requests', () => {
  it('adapts native snake_case schemas and defaults omitted mode to form without applying defaults', () => {
    const original = structuredClone(form)
    const questions = claudeElicitationQuestions(form)
    expect(questions.map((question) => question.id)).toEqual([
      'label',
      'ratio',
      'count',
      'enabled',
      'choice',
      'selections',
      'private_note',
      'optional',
    ])
    expect(questions.find((question) => question.id === 'ratio')).toMatchObject({
      inputType: 'number',
      required: true,
    })
    expect(questions.find((question) => question.id === 'count')).toMatchObject({
      inputType: 'integer',
    })
    expect(questions.find((question) => question.id === 'enabled')).toMatchObject({
      inputType: 'boolean',
      options: [
        { label: 'Yes', value: 'true' },
        { label: 'No', value: 'false' },
      ],
      isOther: false,
    })
    expect(questions.find((question) => question.id === 'choice')).toMatchObject({
      options: [
        { label: 'Alpha display', value: 'alpha' },
        { label: 'Beta display', value: 'beta' },
      ],
      isOther: false,
    })
    expect(questions.find((question) => question.id === 'selections')).toMatchObject({
      multiple: true,
      allowEmpty: false,
    })
    expect(questions.find((question) => question.id === 'private_note')).toMatchObject({
      isSecret: true,
      required: false,
    })
    expect(questions.find((question) => question.id === 'optional')).toMatchObject({
      required: false,
    })
    expect(JSON.stringify(questions)).not.toContain('never submit this')
    expect(form).toEqual(original)
  })

  it('returns an exact typed MCP form response containing only explicit requested answers', () => {
    const original = structuredClone(answers)
    expect(claudeElicitationResponse(form, true, answers)).toEqual({
      action: 'accept',
      content: {
        label: 'Test',
        ratio: 0.25,
        count: 3,
        enabled: false,
        choice: 'alpha',
        selections: ['one', 'two'],
      },
    })
    expect(answers).toEqual(original)
    expect(claudeElicitationResponse({ ...form, mode: 'form' }, true, answers)).toEqual(
      claudeElicitationResponse(form, true, answers),
    )
  })

  it.each([
    [{ label: ['A'] }, /length/],
    [{ ratio: ['2'] }, /number limits/],
    [{ count: ['1.5'] }, /number limits/],
    [{ count: ['NaN'] }, /valid number/],
    [{ count: ['9007199254740992'] }, /number limits/],
    [{ enabled: ['yes'] }, /Yes or No/],
    [{ choice: ['Alpha display'] }, /offered answers/],
    [{ selections: [] }, /selection limits/],
    [{ selections: ['one', 'one'] }, /selection limits/],
    [{ selections: ['unknown'] }, /offered answers/],
    [{ label: [] }, /Answer Label/],
    [{ unrequested: ['value'] }, /did not request/],
  ])('rejects invalid forms before responding: %j', (override, error) => {
    expect(() => claudeElicitationResponse(form, true, { ...answers, ...override })).toThrow(error)
  })

  it('rejects malformed and unsupported schemas without inventing a form', () => {
    for (const request of [
      { requested_schema: null },
      { requestedSchema: form.requested_schema },
      { requested_schema: { type: 'array', items: { type: 'string' } } },
      {
        requested_schema: {
          type: 'object',
          properties: { nested: { type: 'object', properties: {} } },
        },
      },
    ]) {
      expect(() => claudeElicitationQuestions(request)).toThrow(/cannot display/)
      expect(() => claudeElicitationResponse(request, true, {})).toThrow(/cannot display/)
    }
  })

  it('confirms native URL consent without submitting form answers or null metadata', () => {
    const urlRequest = {
      subtype: 'elicitation',
      mcp_server_name: 'test-server',
      mode: 'url',
      message: 'Open the service to complete this interaction.',
      url: 'https://service.example.test/consent',
      elicitation_id: 'consent-request',
    }
    expect(claudeElicitationQuestions(urlRequest)).toEqual([])
    expect(
      claudeElicitationResponse(urlRequest, true, { unrequested: ['never send this'] }),
    ).toEqual({ action: 'accept' })
  })

  it('declines without parsing forms or disclosing entered values, even for unsupported requests', () => {
    for (const request of [form, { mode: 'url' }, { mode: 'unsupported' }, {}]) {
      expect(
        claudeElicitationResponse(request, false, { private_note: ['do not disclose'] }),
      ).toEqual({
        action: 'decline',
      })
    }
  })

  it.each(['unsupported', 'openai/form', '', null])(
    'rejects unsupported native modes on acceptance: %j',
    (mode) => {
      expect(() => claudeElicitationQuestions({ ...form, mode })).toThrow(/elicitation mode/)
      expect(() => claudeElicitationResponse({ ...form, mode }, true, answers)).toThrow(
        /elicitation mode/,
      )
      expect(claudeElicitationResponse({ ...form, mode }, false, answers)).toEqual({
        action: 'decline',
      })
    },
  )
})
