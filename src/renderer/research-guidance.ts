import { researchOperationCatalog, type ResearchOperation } from '../shared/research-method'
import { promptResearchMethodGuide, researchMethodGuide } from '../shared/research-method-protocol'
import {
  legacyResearchConversationInstructions,
  legacyResearchInstructions,
  promptResearchConversationInstructions,
  promptResearchInstructions,
  researchConversationInstructions,
  researchInstructions,
} from './research-storage'

export function researchWorkspaceGuidance(web: boolean) {
  return {
    instructions: web ? promptResearchInstructions : researchInstructions,
    previousInstructions: [
      legacyResearchInstructions,
      researchInstructions,
      promptResearchInstructions,
    ],
    methodGuide: web ? promptResearchMethodGuide : researchMethodGuide,
  }
}

export function researchInvocationGuidance(web: boolean, operation?: ResearchOperation) {
  return {
    instructions: web ? promptResearchConversationInstructions : researchConversationInstructions,
    previousInstructions: [
      legacyResearchConversationInstructions,
      legacyResearchInstructions,
      researchInstructions,
      researchConversationInstructions,
      promptResearchInstructions,
      promptResearchConversationInstructions,
    ],
    ...(!web
      ? {
          operation:
            researchOperationCatalog.find((row) => row.id === operation) ||
            researchOperationCatalog[0],
        }
      : {}),
  }
}
