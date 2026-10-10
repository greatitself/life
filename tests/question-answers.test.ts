import { describe, expect, it } from 'vitest'
import type { AgentQuestion } from '../src/shared/types'
import {
  approvalRequestPresentation,
  prepareQuestionAnswers,
  questionChoiceSentinel,
} from '../src/renderer/question-answers'

describe('provider question answers', () => {
  it('requires native answers without choosing a provider default and omits untouched optional fields', () => {
    const questions: AgentQuestion[] = [
      { id: 'required', question: 'Your response?' },
      { id: 'optional', question: 'Extra notes?', required: false },
    ]
    expect(prepareQuestionAnswers(questions, {})).toEqual({
      answers: {},
      errors: { required: 'Please answer this question.' },
      valid: false,
    })
    expect(
      prepareQuestionAnswers(questions, {
        required: ['  Keep these exact bytes.\n'],
        optional: [''],
      }),
    ).toEqual({
      answers: { required: ['  Keep these exact bytes.\n'] },
      errors: {},
      valid: true,
    })
  })

  it('preserves intentional whitespace and requires explicit empty values when the schema permits them', () => {
    const questions: AgentQuestion[] = [
      { id: 'text', question: 'Text?', allowEmpty: true },
      {
        id: 'list',
        question: 'List?',
        multiple: true,
        allowEmpty: true,
        isOther: false,
        options: [{ label: 'Check' }],
      },
    ]
    expect(prepareQuestionAnswers(questions, {}).valid).toBe(false)
    expect(prepareQuestionAnswers(questions, { text: [''], list: [] })).toEqual({
      answers: { text: [''], list: [] },
      errors: {},
      valid: true,
    })
    expect(
      prepareQuestionAnswers([{ id: 'space', question: 'Exact text?' }], { space: ['  \n'] })
        .answers,
    ).toEqual({ space: ['  \n'] })
  })

  it('uses exact enum values including an empty string and rejects out-of-schema values', () => {
    const question: AgentQuestion = {
      id: 'region',
      question: 'Region?',
      isOther: false,
      options: [
        { label: 'Europe', value: 'eu-west-1' },
        { label: 'No region', value: '' },
      ],
    }
    expect(prepareQuestionAnswers([question], { region: ['eu-west-1'] }).answers).toEqual({
      region: ['eu-west-1'],
    })
    expect(prepareQuestionAnswers([question], { region: [''] }).valid).toBe(true)
    expect(prepareQuestionAnswers([question], { region: ['Europe'] }).valid).toBe(false)
    expect(prepareQuestionAnswers([question], {}).valid).toBe(false)
  })

  it('supports multiple selections and a custom response while enforcing single-select requests', () => {
    const question: AgentQuestion = {
      id: 'checks',
      question: 'Checks?',
      multiple: true,
      options: [{ label: 'Types' }, { label: 'Build' }],
    }
    const answer = { checks: ['Types', 'Build', '  Also test reconnection.\n'] }
    expect(prepareQuestionAnswers([question], answer)).toEqual({
      answers: answer,
      errors: {},
      valid: true,
    })
    expect(prepareQuestionAnswers([{ ...question, multiple: false }], answer).valid).toBe(false)
    expect(prepareQuestionAnswers([{ ...question, isOther: false }], answer).valid).toBe(false)
  })

  it.each([
    ['number', '0', true],
    ['number', '-3.25e2', true],
    ['number', 'Infinity', false],
    ['number', '0x10', false],
    ['number', '1e999', false],
    ['number', '12 cats', false],
    ['integer', '0', true],
    ['integer', '-8', true],
    ['integer', '1e3', true],
    ['integer', '3.25', false],
    ['integer', '9007199254740993', false],
    ['boolean', 'true', true],
    ['boolean', 'false', true],
    ['boolean', 'Yes', false],
  ] as const)('validates %s input %j without changing its value', (inputType, value, valid) => {
    const result = prepareQuestionAnswers([{ id: 'typed', question: 'Value?', inputType }], {
      typed: [value],
    })
    expect(result.valid).toBe(valid)
    if (valid) expect(result.answers).toEqual({ typed: [value] })
  })

  it('avoids collision between renderer placeholders and provider option values', () => {
    const question: AgentQuestion = {
      id: 'sentinels',
      question: 'Choice?',
      options: [
        { label: 'Native', value: '__life_empty__' },
        { label: 'Other native', value: '__life_other__' },
      ],
    }
    expect(questionChoiceSentinel(question, 'empty')).toBe('__life_empty___')
    expect(questionChoiceSentinel(question, 'other')).toBe('__life_other___')
  })
})

describe('approval request presentation', () => {
  it('retains native Claude permission reasons and descriptions without terminal formatting controls', () => {
    const presentation = approvalRequestPresentation({
      sessionId: 's',
      type: 'approval',
      details: {
        decision_reason: '\x1b[33mWrite access is required for the report.\x1b[0m',
        description: '\x1b]8;;https://example.com\x07Save report.md\x1b]8;;\x07',
        blocked_path: '/workspace/report.md',
      },
    })
    expect(presentation.fields).toEqual([
      { label: 'Reason', text: 'Write access is required for the report.' },
      { label: 'Details', text: 'Save report.md' },
      { label: 'File access', text: '/workspace/report.md' },
    ])
  })
  it('presents the actual command, cwd, reason and turn permissions with readable labels', () => {
    const presentation = approvalRequestPresentation({
      sessionId: 'session',
      type: 'approval',
      details: {
        method: 'item/permissions/requestApproval',
        params: {
          reason: 'Compile the project',
          cwd: '/workspace/life',
          command: 'npm run build',
          permissions: {
            fileSystem: { read: ['/source'], write: ['/output'] },
            network: { enabled: true },
          },
        },
      },
    })
    expect(presentation.permissionsRequest).toBe(true)
    expect(presentation.fields).toEqual([
      { label: 'Reason', text: 'Compile the project' },
      { label: 'Working directory', text: '/workspace/life' },
      { label: 'Command', text: 'npm run build' },
      {
        label: 'Requested permissions',
        text: 'File System: Read: /source\nWrite: /output\nNetwork: Enabled: true',
      },
    ])
  })

  it('only opens HTTP or HTTPS provider URLs and never credentials or script schemes', () => {
    const request = (url: string) =>
      approvalRequestPresentation({
        sessionId: 's',
        type: 'approval',
        details: { method: 'url', url },
      })
    expect(request('https://provider.example/authorize?request=1').url).toBe(
      'https://provider.example/authorize?request=1',
    )
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:password@provider.example',
      'invalid',
    ]) {
      expect(request(url).urlRequest).toBe(true)
      expect(request(url).url).toBeUndefined()
      expect(request(url).rawURL).toBe(url)
    }
  })

  it('extracts Claude tool input without requiring provider JSON in the primary text', () => {
    const presentation = approvalRequestPresentation({
      sessionId: 's',
      type: 'approval',
      details: {
        tool_name: 'Write',
        input: { file_path: '/workspace/result.md' },
        decisionReason: 'This writes the report',
      },
    })
    expect(presentation.fields).toEqual([
      { label: 'Reason', text: 'This writes the report' },
      { label: 'File access', text: '/workspace/result.md' },
    ])
  })
})
