/** Safe presentation metadata; native permission payloads stay in the main process. */
export interface ApprovalChoice {
  id: string
  label: string
  description: string
  outcome: 'approved' | 'declined' | 'cancelled'
}
