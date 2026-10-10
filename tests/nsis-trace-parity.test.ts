import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { assertStockStatements, macroBody, verify } = require('../scripts/verify-nsis-trace.cjs')

describe('NSIS installer upstream fallback parity', () => {
  it('retains the resolved extraction and uninstall-result routines', () => {
    expect(() => verify()).not.toThrow()
  })

  it('allows trace calls while retaining stock executable statements', () => {
    const stock = 'CopyFiles /SILENT "source" "target"\nIfErrors 0 Done'
    const traced =
      '!insertmacro LifeInstallerTrace "payload-copy-start"\n' +
      stock +
      '\n!insertmacro LifeInstallerTrace "payload-copy-complete"'
    expect(() => assertStockStatements(traced, stock, 'fixture')).not.toThrow()
  })

  it('allows only the explicit complete stage and installed-payload gates for extraction', () => {
    const stock = 'CopyFiles /SILENT "source" "target"\nIfErrors 0 Done'
    const verified =
      '!insertmacro LifeRequireVerifiedStagedPayload "$PLUGINSDIR\\7z-out"\n' +
      stock +
      '\n!insertmacro LifeRequireVerifiedPayload "$INSTDIR"'
    expect(() => assertStockStatements(verified, stock, 'extraction', true)).not.toThrow()
    expect(() => assertStockStatements(verified, stock, 'uninstall')).toThrow('differs')
    expect(() =>
      assertStockStatements(verified.replace('$INSTDIR', '$OTHERDIR'), stock, 'extraction', true),
    ).toThrow('differs')
  })

  it.each([
    'CopyFiles /SILENT "source" "wrong-target"\nIfErrors 0 Done',
    'CopyFiles /SILENT "source" "target"',
    'CopyFiles /SILENT "source" "target"\nIfErrors 0 Done\nClearErrors',
  ])('rejects changed copy, error handling, or additional behavior', (changed) => {
    const stock = 'CopyFiles /SILENT "source" "target"\nIfErrors 0 Done'
    expect(() => assertStockStatements(changed, stock, 'fixture')).toThrow('differs')
  })

  it('extracts CRLF macros without depending on checkout line endings', () => {
    expect(macroBody('!macro example ARG\r\n  Return\r\n!macroend\r\n', 'example')).toBe('  Return')
  })

  it('fails closed for missing or unterminated upstream routines', () => {
    expect(() => macroBody('!macro other\n!macroend', 'example')).toThrow('not found')
    expect(() => macroBody('!macro example\nReturn', 'example')).toThrow('not terminated')
  })
})
