import type { Message } from './state'

// Only constructors and exact source projections below can create registrations.
// Nodes retain suffixes, never earlier message objects or accumulated text.
interface AppendNode {
  parent?: AppendNode
  suffix: string
  length: number
}
interface AppendProof {
  node: AppendNode
  id: string
  text: string
}
interface AppendReceipt {
  node: AppendNode
  message: WeakRef<object>
}
const proofs = new WeakMap<object, AppendProof>()
const sources = new WeakMap<object, WeakRef<object>>()
const mutated = new WeakSet<object>()
const receipts = new WeakMap<object, AppendReceipt>()
const mutationOwners = new WeakMap<object, WeakRef<object>>()
const mutationEpochs = new WeakMap<object, number>()
const mutationWatchers = new WeakMap<object, Set<WeakRef<object>>>()
const watcherReferences = new WeakMap<object, WeakRef<object>>()
let mutationEpoch = 0
const maximumNodes = 512
// UTF-16 uses at most two bytes per unit; bound additional suffix content to 2 MiB.
const maximumSuffixUnits = 1024 * 1024

function ownString(value: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined
}

function validProof(value: object): AppendProof | undefined {
  if (mutated.has(value)) {
    proofs.delete(value)
    const raw = sources.get(value)?.deref()
    const text = ownString(value, 'text')
    const id = ownString(value, 'id')
    if (
      !raw ||
      raw === value ||
      text === undefined ||
      id === undefined ||
      !exactSource(raw, text, id)
    )
      noteMutation(value)
    return undefined
  }
  const proof = proofs.get(value)
  if (!proof) return undefined
  if (ownString(value, 'id') === proof.id && Object.is(ownString(value, 'text'), proof.text))
    return proof
  mutated.add(value)
  proofs.delete(value)
  noteMutation(value)
  return undefined
}

function noteMutation(value: object): void {
  mutationEpoch++
  const owner = mutationOwners.get(value)?.deref()
  if (owner) {
    mutationEpochs.set(owner, (mutationEpochs.get(owner) ?? 0) + 1)
    watchMutation(owner, value)
  }
}

function watchMutation(owner: object, value: object): void {
  let watchers = mutationWatchers.get(owner)
  if (!watchers) {
    watchers = new Set()
    mutationWatchers.set(owner, watchers)
  }
  let reference = watcherReferences.get(value)
  if (!reference) {
    reference = new WeakRef(value)
    watcherReferences.set(value, reference)
  }
  watchers.add(reference)
}

function exactSource(raw: object, text: string, id: string): boolean {
  return ownString(raw, 'id') === id && Object.is(ownString(raw, 'text'), text)
}

function rootWithinBounds(node: AppendNode): AppendNode | undefined {
  let root = node
  let count = 0
  while (root.parent) {
    if (++count > maximumNodes) return undefined
    root = root.parent
  }
  return node.length - root.length <= maximumSuffixUnits ? root : undefined
}

/** Construct the string here so callers cannot register a post-hoc prefix hint. */
export function appendConversationMessageText(
  previous: Message | undefined,
  fields: Omit<Message, 'text'>,
  suffix: string,
): Message {
  const prior = previous?.text || ''
  const text = prior + suffix
  const message: Message = { ...fields, text }
  if (typeof suffix !== 'string' || typeof prior !== 'string' || typeof text !== 'string')
    return message
  const id = ownString(message, 'id')
  if (id === undefined) return message
  let parent: AppendNode | undefined
  if (
    previous &&
    ownString(previous, 'id') === id &&
    Object.is(ownString(previous, 'text'), prior) &&
    !mutated.has(previous)
  ) {
    const known = validProof(previous)
    if (!mutated.has(previous)) {
      parent = known?.node ?? { suffix: '', length: prior.length }
      const proof = known ?? { node: parent, id, text: prior }
      if (!known) proofs.set(previous, proof)
      const raw = sources.get(previous)?.deref()
      if (raw && !mutated.has(raw) && exactSource(raw, prior, id)) proofs.set(raw, proof)
    }
  }
  let node: AppendNode =
    parent && !suffix.length
      ? parent
      : { parent, suffix: parent ? suffix : '', length: text.length }
  if (!rootWithinBounds(node)) node = { suffix: '', length: text.length }
  proofs.set(message, { node, id, text })
  return message
}

/** Capture only an exact restoration pairing; a foreign rebind loses prior eligibility. */
export function bindConversationMessageAppendSource(view: object, raw: object): void {
  const text = ownString(view, 'text')
  const id = ownString(view, 'id')
  if (text === undefined || id === undefined || !exactSource(raw, text, id)) {
    // A pending write can acknowledge after this captured endpoint was mutated.
    // Record the newer edit before its owner acknowledges the earlier projection.
    validProof(view)
    return
  }
  // Quarantine remains permanent. An exact accepted body has already reported
  // its edit and must not fabricate a newer mutation at acknowledgement.
  if (!mutated.has(view)) validProof(view)
  const previous = sources.get(view)?.deref()
  if (previous && previous !== raw) {
    proofs.delete(view)
  }
  sources.set(view, new WeakRef(raw))
}

/** The private exact occurrence pairing survives edits to the normalized body. */
export function getConversationMessageAppendSource(value: object): object | undefined {
  return sources.get(value)?.deref()
}

/** Forward only privately owned data through this exact lossless projection. */
export function projectConversationMessageAppendSource(
  before: object,
  rawBefore: object,
  after: object,
  rawAfter: object,
): void {
  const beforeProof = validProof(before)
  const rawProof = validProof(rawBefore)
  const ownsBefore =
    before === rawBefore ||
    sources.get(before)?.deref() === rawBefore ||
    (beforeProof !== undefined && rawProof?.node === beforeProof.node)
  const afterProofValue = validProof(after)
  const afterText = ownString(after, 'text')
  const afterId = ownString(after, 'id')
  if (
    mutated.has(after) &&
    afterText !== undefined &&
    afterId !== undefined &&
    exactSource(rawAfter, afterText, afterId)
  ) {
    mutated.add(rawAfter)
    proofs.delete(rawAfter)
  }
  if (!beforeProof || !ownsBefore || !exactSource(rawBefore, beforeProof.text, beforeProof.id))
    return
  if (!mutated.has(rawBefore)) proofs.set(rawBefore, beforeProof)
  let afterProof = afterProofValue
  // Immutable metadata edits can retain an existing owned string operation.
  if (
    !afterProof &&
    beforeProof &&
    ownsBefore &&
    !mutated.has(after) &&
    ownString(after, 'id') === beforeProof.id &&
    Object.is(ownString(after, 'text'), beforeProof.text)
  ) {
    afterProof = beforeProof
    proofs.set(after, afterProof)
  }
  if (!afterProof || !exactSource(rawAfter, afterProof.text, afterProof.id)) return
  if (!mutated.has(rawAfter)) proofs.set(rawAfter, afterProof)
  sources.set(after, new WeakRef(rawAfter))
}

/** Lengths bound work; actual ancestor identity proves the exact operation sequence. */
export function getConversationMessageAppend(
  before: object,
  after: object,
): { baseLength: number; value: string } | undefined {
  const previous = validProof(before)
  const next = validProof(after)
  if (!previous || !next || previous.id !== next.id || next.text.length <= previous.text.length)
    return undefined
  const suffixes: string[] = []
  let node: AppendNode | undefined = next.node
  let count = 0
  let units = 0
  while (node && node !== previous.node) {
    if (++count > maximumNodes || (units += node.suffix.length) > maximumSuffixUnits)
      return undefined
    suffixes.push(node.suffix)
    node = node.parent
  }
  if (!node || !units) return undefined
  return { baseLength: previous.text.length, value: suffixes.reverse().join('') }
}

/** Mutated proof endpoints require a complete field set, preserving the actual new value. */
export function conversationMessageAppendWasMutated(value: object): boolean {
  validProof(value)
  return mutated.has(value)
}

/** Reject known executable fields without rereading unrelated settled data. */
export function assertConversationMessageAppendMutationData(value: object): void {
  if (!mutated.has(value)) return
  for (const key of ['id', 'text']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && !('value' in descriptor))
      throw new Error('Cannot save a conversation message with an accessor field.')
  }
}

/** Quarantine persists, but an exact accepted source need not invalidate its cache. */
export function conversationMessageAppendHasPendingMutation(value: object): boolean {
  validProof(value)
  if (!mutated.has(value)) return false
  const raw = sources.get(value)?.deref()
  const text = ownString(value, 'text')
  const id = ownString(value, 'id')
  return (
    !raw || raw === value || text === undefined || id === undefined || !exactSource(raw, text, id)
  )
}

/** Keep only weak ownership; an older endpoint can still report a mutation. */
export function observeConversationMessageAppendSource(owner: object, message: object): void {
  if (!proofs.has(message) && !mutated.has(message)) return
  const previous = mutationOwners.get(message)?.deref()
  mutationOwners.set(message, new WeakRef(owner))
  if (previous !== owner && mutated.has(message)) noteMutation(message)
}

export function conversationMessageAppendSourceMutationEpoch(owner: object): number {
  const watchers = mutationWatchers.get(owner)
  if (watchers)
    for (const reference of watchers) {
      const value = reference.deref()
      if (!value) {
        watchers.delete(reference)
        continue
      }
      const raw = sources.get(value)?.deref()
      const text = ownString(value, 'text')
      const id = ownString(value, 'id')
      if (
        !raw ||
        raw === value ||
        text === undefined ||
        id === undefined ||
        !exactSource(raw, text, id)
      ) {
        mutationEpoch++
        mutationEpochs.set(owner, (mutationEpochs.get(owner) ?? 0) + 1)
      }
    }
  return mutationEpochs.get(owner) ?? 0
}

export function conversationMessageAppendMutationEpoch(): number {
  return mutationEpoch
}

export function createConversationMessageAppendAcknowledgement(
  message: object,
): object | undefined {
  const proof = validProof(message)
  if (!proof) return undefined
  const receipt = {}
  receipts.set(receipt, { node: proof.node, message: new WeakRef(message) })
  return receipt
}

/** Call only after the exact submitted native write acknowledges; stale/forged receipts miss. */
export function acknowledgeConversationMessageAppends(values: readonly object[]): void {
  for (const value of values) {
    const receipt = receipts.get(value)
    receipts.delete(value)
    const message = receipt?.message.deref()
    if (!receipt || !message || validProof(message)?.node !== receipt.node) continue
    receipt.node.parent = undefined
    receipt.node.suffix = ''
  }
}

export function discardConversationMessageAppendAcknowledgements(values: readonly object[]): void {
  for (const value of values) receipts.delete(value)
}
