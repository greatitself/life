import { promptResearchMethodGuide } from '../shared/research-method-protocol'
import {
  legacyResearchConversationInstructions,
  legacyResearchInstructions,
  promptResearchConversationInstructions,
  promptResearchInstructions,
  researchConversationInstructions,
  researchInstructions,
} from './research-storage'

export function researchWorkspaceGuidance() {
  return {
    instructions: promptResearchInstructions,
    previousInstructions: [
      legacyResearchInstructions,
      researchInstructions,
      promptResearchInstructions,
    ],
    methodGuide: promptResearchMethodGuide,
  }
}

export function researchInvocationGuidance() {
  return {
    instructions: promptResearchConversationInstructions,
    previousInstructions: [
      legacyResearchConversationInstructions,
      legacyResearchInstructions,
      researchInstructions,
      researchConversationInstructions,
      promptResearchInstructions,
      promptResearchConversationInstructions,
    ],
  }
}
