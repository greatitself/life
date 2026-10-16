import type { AgentQuestion } from './types'

/** A message reply preserves the provider's question titles and every answer byte. */
export function formatAsyncQuestionReply(
  questions: readonly AgentQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
): string {
  return questions
    .map(
      (question) =>
        `Question: ${question.question}\nAnswer: ${(answers[question.id] || []).join('\n')}`,
    )
    .join('\n\n')
}
