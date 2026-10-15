const escapedCharacters = /["\\\u0000-\u001f\ud800-\udfff]/g

function stringCharacterSize(value: string): number {
  let size = value.length + 2
  escapedCharacters.lastIndex = 0
  for (let match; (match = escapedCharacters.exec(value));) {
    const character = value.charCodeAt(match.index)
    if (character >= 0xd800 && character <= 0xdbff) {
      const next = value.charCodeAt(match.index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // JSON retains a complete surrogate pair as its two UTF-16 code units.
        escapedCharacters.lastIndex++
        continue
      }
      size += 5
    } else if (character >= 0xdc00 && character <= 0xdfff) {
      size += 5
    } else if (
      character < 0x20 &&
      character !== 8 &&
      character !== 9 &&
      character !== 10 &&
      character !== 12 &&
      character !== 13
    ) {
      size += 5
    } else size++
  }
  return size
}

/** Size plain JSON data without allocating another copy of conversation text. */
export function jsonCharacterSize(value: unknown): number {
  if (value === null) return 4
  switch (typeof value) {
    case 'string':
      return stringCharacterSize(value)
    case 'boolean':
      return value ? 4 : 5
    case 'number':
      return Number.isFinite(value) ? String(value).length : 4
    case 'object': {
      if (Array.isArray(value)) {
        let size = 2
        for (let index = 0; index < value.length; index++)
          size +=
            (index ? 1 : 0) + (value[index] === undefined ? 4 : jsonCharacterSize(value[index]))
        return size
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Conversation JSON sizing requires plain data.')
      let size = 2
      let count = 0
      for (const key of Object.keys(value)) {
        const child = (value as Record<string, unknown>)[key]
        if (child === undefined) continue
        size += (count++ ? 1 : 0) + stringCharacterSize(key) + 1 + jsonCharacterSize(child)
      }
      return size
    }
    default:
      throw new TypeError('Conversation JSON sizing requires plain data.')
  }
}
