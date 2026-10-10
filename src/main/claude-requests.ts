import type { AgentQuestion } from '../shared/types'
import { codexElicitationQuestions, codexRequestResponse } from './codex-requests'

type Wire = Record<string, unknown>
type ElicitationContent = Record<string, string | number | boolean | string[]>
export type ClaudeElicitationResult = {
  action: 'accept' | 'decline'
  content?: ElicitationContent
}

function elicitationParams(request: Wire): Wire {
  // Native Claude stream-json uses snake_case; omitted mode means a form.
  const mode = request.mode === undefined ? 'form' : request.mode
  if (mode !== 'form' && mode !== 'url')
    throw new Error('Life cannot accept this Claude MCP elicitation mode.')
  return { mode, requestedSchema: request.requested_schema }
}

/** Use the same primitive form validation for both providers' native MCP requests. */
export function claudeElicitationQuestions(request: Wire): AgentQuestion[] {
  const params = elicitationParams(request)
  return params.mode === 'url' ? [] : codexElicitationQuestions(params)
}

/** MCP ElicitResult omits content on decline and URL consent, without null metadata. */
export function claudeElicitationResponse(
  request: Wire,
  accepted: boolean,
  answers: Record<string, string[]> = {},
): ClaudeElicitationResult {
  if (!accepted) return { action: 'decline' }
  const params = elicitationParams(request)
  const result = codexRequestResponse('mcpServer/elicitation/request', params, true, answers)
  return params.mode === 'url'
    ? { action: 'accept' }
    : { action: 'accept', content: result.content as ElicitationContent }
}
