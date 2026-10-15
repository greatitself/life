const { types, TextDecoder } = require('node:util')

// These are observation limits, not application limits. A rejected snapshot must
// only fail the observer; it must never replace a native result or rejection.
const LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, depth: 1024, nodes: 1_000_000 })
const FORMAT = 'life-observer-portable-wire'
const VERSION = 1
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const typedArraySet = typedArrayPrototype.set

class PortableWireError extends Error {
  constructor(code, path) {
    super(`Portable observer snapshot rejected: ${code} at ${path}`)
    this.name = 'PortableWireError'
    this.code = code
    this.path = path
  }
}

function reject(code, path) {
  throw new PortableWireError(code, path)
}

function pathFor(path, key) {
  return `${path}[${JSON.stringify(key)}]`
}

function define(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function wireArray(values = []) {
  // JSON.stringify looks for inherited toJSON hooks even on arrays. Internal
  // wire containers mask that lookup without reading a hook on native data.
  Object.defineProperty(values, 'toJSON', { value: undefined })
  return values
}

function encoder() {
  const ancestors = new Set()
  let nodes = 0
  return function encode(value, path = '$', depth = 0) {
    if (depth > LIMITS.depth) reject('depth-limit', path)
    if (++nodes > LIMITS.nodes) reject('node-limit', path)
    if (value === undefined) return wireArray(['undefined'])
    if (value === null) return wireArray(['null'])
    switch (typeof value) {
      case 'boolean':
        return wireArray(['boolean', value])
      case 'string':
        return wireArray(['string', value])
      case 'number':
        if (!Number.isFinite(value)) reject('non-finite-number', path)
        return Object.is(value, -0) ? wireArray(['negative-zero']) : wireArray(['number', value])
      case 'bigint':
      case 'function':
      case 'symbol':
        reject(`unsupported-${typeof value}`, path)
      case 'object':
        break
      default:
        reject('unsupported-value', path)
    }
    if (types.isProxy(value)) reject('proxy', path)
    if (ancestors.has(value)) reject('cycle', path)
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      reject('unsupported-prototype', path)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key === 'symbol')) reject('symbol-key', path)
    ancestors.add(value)
    try {
      if (array) {
        const length = descriptors.length
        if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value))
          reject('array-length', path)
        if (keys.length !== length.value + 1) reject('sparse-or-extra-array-field', path)
        const entries = wireArray()
        for (let index = 0; index < length.value; index++) {
          const key = String(index)
          if (!Object.hasOwn(descriptors, key)) reject('sparse-array', pathFor(path, key))
          const descriptor = descriptors[key]
          if (!Object.hasOwn(descriptor, 'value')) reject('accessor', pathFor(path, key))
          if (!descriptor.enumerable) reject('non-enumerable-field', pathFor(path, key))
          entries.push(encode(descriptor.value, pathFor(path, key), depth + 1))
        }
        return wireArray(['array', entries])
      }
      const entries = wireArray()
      for (const key of keys) {
        const descriptor = descriptors[key]
        if (!Object.hasOwn(descriptor, 'value')) reject('accessor', pathFor(path, key))
        if (!descriptor.enumerable) reject('non-enumerable-field', pathFor(path, key))
        entries.push(wireArray([key, encode(descriptor.value, pathFor(path, key), depth + 1)]))
      }
      return wireArray(['object', prototype === null ? 'null' : 'plain', entries])
    } finally {
      ancestors.delete(value)
    }
  }
}

function serialize(value) {
  const envelope = Object.create(null)
  envelope.format = FORMAT
  envelope.version = VERSION
  envelope.value = encoder()(value)
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8')
  if (bytes.length > LIMITS.bytes) reject('byte-limit', '$')
  return bytes
}

function decoder() {
  let nodes = 0
  return function decode(node, path = '$', depth = 0) {
    if (depth > LIMITS.depth) reject('depth-limit', path)
    if (++nodes > LIMITS.nodes) reject('node-limit', path)
    if (!Array.isArray(node) || typeof node[0] !== 'string') reject('malformed-tag', path)
    const exactLength = (length) => {
      if (node.length !== length) reject('malformed-tag-length', path)
    }
    switch (node[0]) {
      case 'undefined':
        exactLength(1)
        return undefined
      case 'null':
        exactLength(1)
        return null
      case 'negative-zero':
        exactLength(1)
        return -0
      case 'boolean':
        exactLength(2)
        if (typeof node[1] !== 'boolean') reject('malformed-boolean', path)
        return node[1]
      case 'string':
        exactLength(2)
        if (typeof node[1] !== 'string') reject('malformed-string', path)
        return node[1]
      case 'number':
        exactLength(2)
        if (typeof node[1] !== 'number' || !Number.isFinite(node[1]) || Object.is(node[1], -0))
          reject('malformed-number', path)
        return node[1]
      case 'array': {
        exactLength(2)
        if (!Array.isArray(node[1])) reject('malformed-array', path)
        return node[1].map((entry, index) => decode(entry, pathFor(path, String(index)), depth + 1))
      }
      case 'object': {
        exactLength(3)
        if (node[1] !== 'plain' && node[1] !== 'null') reject('malformed-prototype', path)
        if (!Array.isArray(node[2])) reject('malformed-object-entries', path)
        const object = node[1] === 'null' ? Object.create(null) : {}
        const seen = new Set()
        for (const entry of node[2]) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
            reject('malformed-object-entry', path)
          if (seen.has(entry[0])) reject('duplicate-object-key', pathFor(path, entry[0]))
          seen.add(entry[0])
          define(object, entry[0], decode(entry[1], pathFor(path, entry[0]), depth + 1))
        }
        return object
      }
      default:
        reject('unknown-tag', path)
    }
  }
}

function deserialize(input) {
  if (types.isProxy(input) || (!Buffer.isBuffer(input) && !types.isUint8Array(input)))
    reject('unsupported-bytes', '$')
  // Copy branded byte storage through intrinsics. Buffer.from(arbitraryBuffer)
  // can consult user valueOf/length properties; byte input must not run hooks.
  const length = Reflect.apply(typedArrayByteLength, input, [])
  if (length > LIMITS.bytes) reject('byte-limit', '$')
  const bytes = Buffer.alloc(length)
  Reflect.apply(typedArraySet, bytes, [input])
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    reject('malformed-utf8', '$')
  }
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    reject('malformed-json', '$')
  }
  if (
    envelope === null ||
    Array.isArray(envelope) ||
    typeof envelope !== 'object' ||
    Object.keys(envelope).join(',') !== 'format,version,value' ||
    envelope.format !== FORMAT ||
    envelope.version !== VERSION
  )
    reject('malformed-envelope', '$')
  const value = decoder()(envelope.value)
  if (!serialize(value).equals(bytes)) reject('non-canonical-wire', '$')
  return value
}

// Errors are deliberately normalized into a DTO. Descriptor reads never invoke
// user getters, and rejected fields are reported explicitly instead of dropped.
// This function never returns a reference to the native error or its field data.
function errorDTO(error) {
  const ancestors = new Set()
  const fallback = (reason) => ({
    format: 'life-observer-error-dto',
    version: 1,
    thrownType: 'uninspectable',
    fields: Object.create(null),
    inheritedFields: [],
    unsupportedFields: [{ key: '[[Observation]]', reason }],
  })
  function snapshot(value, depth = 0) {
    const dto = {
      format: 'life-observer-error-dto',
      version: 1,
      thrownType: value === null ? 'null' : typeof value,
      fields: Object.create(null),
      inheritedFields: [],
      unsupportedFields: [],
    }
    const unsupported = (key, reason) => dto.unsupportedFields.push({ key, reason })
    function copy(key, fieldValue) {
      try {
        if (
          key === 'cause' &&
          fieldValue !== null &&
          typeof fieldValue === 'object' &&
          !types.isProxy(fieldValue) &&
          types.isNativeError(fieldValue)
        ) {
          if (ancestors.has(fieldValue) || depth >= LIMITS.depth) {
            unsupported(key, 'cycle-or-depth-limit')
            return
          }
          define(dto.fields, key, snapshot(fieldValue, depth + 1))
        } else define(dto.fields, key, deserialize(serialize(fieldValue)))
      } catch (failure) {
        unsupported(
          key,
          failure instanceof PortableWireError ? failure.code : 'uninspectable-field',
        )
      }
    }
    try {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        copy('value', value)
        return dto
      }
      if (types.isProxy(value)) {
        unsupported('[[Object]]', 'proxy')
        return dto
      }
      if (typeof value === 'function') {
        unsupported('[[Object]]', 'unsupported-function')
        return dto
      }
      if (ancestors.has(value)) {
        unsupported('[[Object]]', 'cycle')
        return dto
      }
      ancestors.add(value)
      try {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        for (const key of Reflect.ownKeys(descriptors)) {
          if (typeof key === 'symbol') {
            unsupported(String(key), 'symbol-key')
            continue
          }
          const descriptor = descriptors[key]
          if (!Object.hasOwn(descriptor, 'value')) {
            unsupported(key, 'accessor')
            continue
          }
          copy(key, descriptor.value)
        }
        const nativeError = types.isNativeError(value)
        const originalPrototype = Object.getPrototypeOf(value)
        if (
          !nativeError &&
          originalPrototype !== Object.prototype &&
          originalPrototype !== null &&
          !Array.isArray(value)
        )
          unsupported('[[Prototype]]', 'unsupported-prototype')
        if (nativeError) {
          for (const key of ['name', 'message']) {
            if (Object.hasOwn(descriptors, key)) continue
            let prototype = originalPrototype
            let count = 0
            while (prototype !== null) {
              if (types.isProxy(prototype) || count++ > LIMITS.depth) {
                unsupported(key, 'uninspectable-prototype')
                break
              }
              const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
              if (descriptor) {
                if (!Object.hasOwn(descriptor, 'value')) unsupported(key, 'accessor')
                else {
                  copy(key, descriptor.value)
                  dto.inheritedFields.push(key)
                }
                break
              }
              prototype = Object.getPrototypeOf(prototype)
            }
          }
        }
      } finally {
        ancestors.delete(value)
      }
    } catch {
      unsupported('[[Observation]]', 'uninspectable-error')
    }
    return dto
  }
  try {
    const dto = snapshot(error)
    // Many individually portable fields can collectively exceed observation
    // limits. Keep even that failure representable without exposing the error.
    serialize(dto)
    return dto
  } catch (failure) {
    return fallback(failure instanceof PortableWireError ? failure.code : 'uninspectable-error')
  }
}

module.exports = { serialize, deserialize, errorDTO, PortableWireError, LIMITS }
