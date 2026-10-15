import { describe, expect, it, vi } from 'vitest'
import {
  STUDIO_DRAFT_FORMAT_ERROR,
  STUDIO_DRAFT_READ_ERROR,
  STUDIO_DRAFT_WRITE_ERROR,
  StudioDraftStore,
  studioDraftRecovery,
} from '../src/renderer/studio-drafts'

const exact = ' \r\nDraft Ω 😀 \ud800 \udfff\tKeep every space  '

describe('owned Studio drafts', () => {
  it('restores a successfully stored draft beyond the submission limit verbatim', () => {
    const text = exact + 'x'.repeat(1_000_001) + exact
    const write = vi.fn()
    const store = new StudioDraftStore(() => JSON.stringify({ selected: text }), write)
    expect(store.get('selected')).toBe(text)
    expect(store.dirty).toBe(false)
    expect(store.flush()).toEqual({ saved: true, error: '' })
    expect(write).not.toHaveBeenCalled()
    store.update('selected', text + '\nEdited without truncating.  ')
    expect(store.flush().saved).toBe(true)
    expect(JSON.parse(write.mock.calls[0][0]).selected).toBe(
      text + '\nEdited without truncating.  ',
    )
  })

  it('retains every unrelated unknown or opaque JSON entry while editing a known draft', () => {
    const original = JSON.parse(
      '{"selected":"before","future":{"payload":[null,17,"Ω"]},"__proto__":{"polluted":true},"constructor":{"retained":true},"prototype":[false],"toJSON":{"future":true},"bad\\u0000key":"opaque text","number":17,"null":null,"boolean":false}',
    )
    const write = vi.fn()
    const store = new StudioDraftStore(() => JSON.stringify(original), write)
    store.update('selected', exact)
    expect(store.flush().saved).toBe(true)
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ ...original, selected: exact })
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
    expect(store.get('bad\u0000key')).toBe('')
    expect(store.get('number')).toBe('')
    expect(store.get('toString')).toBe('')
  })

  it.each(['__proto__', 'constructor', 'prototype', 'toString', 'Ω space', 'a'.repeat(200)])(
    'saves and restores the exact draft under %s without inherited values',
    (id) => {
      const write = vi.fn()
      const store = new StudioDraftStore(() => '{}', write)
      expect(store.get(id)).toBe('')
      store.update(id, exact)
      expect(store.flush().saved).toBe(true)
      const encoded = write.mock.calls[0][0]
      expect(Object.hasOwn(JSON.parse(encoded), id)).toBe(true)
      const restored = new StudioDraftStore(() => encoded, vi.fn())
      expect(restored.get(id)).toBe(exact)
    },
  )

  it.each(['', 'bad\u0000key', 'a'.repeat(201)])(
    'rejects edits for invalid session ID %s',
    (id) => {
      const write = vi.fn()
      const store = new StudioDraftStore(() => '{}', write)
      expect(store.update(id, exact)).toBe(false)
      expect(store.dirty).toBe(false)
      store.flush()
      expect(write).not.toHaveBeenCalled()
    },
  )

  it.each(['', '{malformed', '[]', 'null', '17', '"text"'])(
    'protects unreadable or nonobject stored bytes %s while retaining current edits',
    (raw) => {
      const write = vi.fn()
      const store = new StudioDraftStore(() => raw, write)
      expect(store.readError).toBe(STUDIO_DRAFT_READ_ERROR)
      store.update('selected', exact)
      expect(store.get('selected')).toBe(exact)
      expect(store.flush()).toEqual({ saved: false, error: STUDIO_DRAFT_READ_ERROR })
      expect(store.dirty).toBe(true)
      expect(write).not.toHaveBeenCalled()
    },
  )

  it('protects a read failure without guessing that existing storage is empty', () => {
    const write = vi.fn()
    const store = new StudioDraftStore(() => {
      throw new Error('Storage is unavailable')
    }, write)
    store.update('selected', exact)
    expect(store.get('selected')).toBe(exact)
    expect(store.flush().error).toBe(STUDIO_DRAFT_READ_ERROR)
    expect(write).not.toHaveBeenCalled()
  })

  it('starts a missing draft map without a write until the user edits', () => {
    const write = vi.fn()
    const store = new StudioDraftStore(() => null, write)
    expect(store.readError).toBe('')
    store.flush()
    expect(write).not.toHaveBeenCalled()
    store.update('selected', exact)
    expect(store.flush().saved).toBe(true)
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ selected: exact })
  })

  it('retains a dirty quota-failed draft and acknowledges only a successful retry', () => {
    let fail = true
    const write = vi.fn((_encoded: string) => {
      if (fail) throw new Error('Quota exceeded')
    })
    const store = new StudioDraftStore(() => '{"selected":"before"}', write)
    store.update('selected', exact)
    expect(store.flush()).toEqual({ saved: false, error: STUDIO_DRAFT_WRITE_ERROR })
    expect(store.dirty).toBe(true)
    expect(store.get('selected')).toBe(exact)
    fail = false
    expect(store.flush()).toEqual({ saved: true, error: '' })
    expect(store.dirty).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[0][0]).toBe(write.mock.calls[1][0])
    store.flush()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not acknowledge a new edit made during a successful write', () => {
    let editDuringWrite = true
    const store: StudioDraftStore = new StudioDraftStore(
      () => '{}',
      () => {
        if (editDuringWrite) store.update('selected', 'newer')
      },
    )
    store.update('selected', 'older')
    expect(store.flush().saved).toBe(true)
    expect(store.dirty).toBe(true)
    expect(store.get('selected')).toBe('newer')
    editDuringWrite = false
    expect(store.flush().saved).toBe(true)
    expect(store.dirty).toBe(false)
  })

  it('protects a nonstring entry at the selected ID while other drafts can still save', () => {
    const opaque = { future: ['unrecognized draft', 17] }
    const write = vi.fn()
    const store = new StudioDraftStore(
      () => JSON.stringify({ selected: opaque, other: 'old' }),
      write,
    )
    store.update('selected', exact)
    expect(store.get('selected')).toBe(exact)
    expect(store.flush()).toEqual({ saved: false, error: STUDIO_DRAFT_FORMAT_ERROR })
    expect(write).not.toHaveBeenCalled()
    store.update('other', 'updated')
    expect(store.flush()).toEqual({ saved: false, error: STUDIO_DRAFT_FORMAT_ERROR })
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ selected: opaque, other: 'updated' })
    expect(store.dirty).toBe(true)
    store.flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(
      studioDraftRecovery({ id: 'selected' }, 'selected', store.get('selected')).draft.text,
    ).toBe(exact)
  })
})

describe('Studio submission draft ownership', () => {
  it('clears an accepted request only while its selected draft is unchanged', () => {
    const store = new StudioDraftStore(() => '{"selected":"A","other":"other"}', vi.fn())
    const submitted = store.capture('selected')
    store.update('other', 'edited another conversation')
    expect(store.clearIfCurrent(submitted)).toBe(true)
    expect(store.get('selected')).toBe('')
    expect(store.get('other')).toBe('edited another conversation')
  })

  it.each(['B', 'A'])(
    'preserves edits during submission even when the final draft is %s',
    (final) => {
      const store = new StudioDraftStore(() => '{"selected":"A"}', vi.fn())
      const submitted = store.capture('selected')
      store.update('selected', 'B')
      store.update('selected', final)
      expect(store.clearIfCurrent(submitted)).toBe(false)
      expect(store.get('selected')).toBe(final)
    },
  )

  it('does not clear a replacement store with coincidentally identical draft content', () => {
    const original = new StudioDraftStore(() => '{"selected":"A"}', vi.fn())
    const replacement = new StudioDraftStore(() => '{"selected":"A"}', vi.fn())
    expect(replacement.clearIfCurrent(original.capture('selected'))).toBe(false)
    expect(replacement.get('selected')).toBe('A')
  })

  it('exports the current draft separately without replacing an unknown conversation field', () => {
    const conversation = { id: 'selected', draft: { future: exact }, opaque: [null, 17] }
    const original = JSON.stringify(conversation)
    const recovery = studioDraftRecovery(conversation, 'selected', exact)
    expect(JSON.parse(JSON.stringify(recovery))).toEqual({
      version: 1,
      conversation,
      draft: { sessionId: 'selected', text: exact },
    })
    expect(JSON.stringify(conversation)).toBe(original)
  })
})
