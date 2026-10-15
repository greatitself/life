export const conversationStringChunkSize = 64 * 1024
export interface ConversationStringPlan {
  path: string[]
  parts: number
  length: number
}

/** Compare parsed JSON with a restoration projection without serializing transcript text. */
export function samePersistedConversationValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        samePersistedConversationValue(value ?? null, right[index] ?? null),
      )
    )
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const previous = left as Record<string, unknown>
  const next = right as Record<string, unknown>
  let leftCount = 0
  for (const key of Object.keys(previous)) {
    if (previous[key] === undefined) continue
    leftCount++
    if (!Object.hasOwn(next, key) || !samePersistedConversationValue(previous[key], next[key]))
      return false
  }
  let rightCount = 0
  for (const key of Object.keys(next)) if (next[key] !== undefined) rightCount++
  return leftCount === rightCount
}

/** Keep large scalar strings out of an otherwise small structured-clone batch. */
export function prepareConversationValue<T>(value: T) {
  const strings: { path: string[]; value: string }[] = []
  const visit = (node: unknown, path: string[]): unknown => {
    if (typeof node === 'string' && node.length > conversationStringChunkSize) {
      strings.push({ path: [...path], value: node })
      return ''
    }
    if (!node || typeof node !== 'object') return node
    let replacement: Record<string, unknown> | unknown[] | undefined
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key]
      if (
        !(typeof child === 'string' && child.length > conversationStringChunkSize) &&
        (!child || typeof child !== 'object')
      )
        continue
      path.push(key)
      const next = visit(child, path)
      path.pop()
      if (next === child) continue
      replacement ??= Array.isArray(node) ? [...node] : { ...node }
      Object.defineProperty(replacement, key, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return replacement ?? node
  }
  const prepared = visit(value, []) as T
  return {
    value: prepared,
    strings,
    plans: strings.map(({ path, value }) => ({
      path,
      parts: Math.ceil(value.length / conversationStringChunkSize),
      length: value.length,
    })),
  }
}

export function conversationStringSlot(root: unknown, path: string[]) {
  if (!path.length) throw new Error('History decoder returned an invalid string path.')
  let parent = root
  for (const key of path.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key))
      throw new Error('History decoder returned an unknown string path.')
    parent = (parent as Record<string, unknown>)[key]
  }
  const key = path[path.length - 1]
  if (
    !parent ||
    typeof parent !== 'object' ||
    !Object.hasOwn(parent, key) ||
    (parent as Record<string, unknown>)[key] !== ''
  )
    throw new Error('History decoder returned an invalid string destination.')
  return { parent: parent as Record<string, unknown>, key }
}
