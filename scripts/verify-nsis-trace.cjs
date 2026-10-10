'use strict'

const fs = require('node:fs')
const path = require('node:path')

function macroBody(source, name) {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\s*!macro ${name}(?:\\s|$)`).test(line))
  if (start < 0) throw new Error(`NSIS macro ${name} was not found.`)
  const end = lines.findIndex((line, index) => index > start && /^\s*!macroend\s*$/.test(line))
  if (end < 0) throw new Error(`NSIS macro ${name} was not terminated.`)
  return lines.slice(start + 1, end).join('\n')
}

function statements(source, removeTrace = false) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^[;#]/.test(line))
    .filter((line) => !removeTrace || !/^!insertmacro LifeInstallerTrace "[a-z-]+"$/.test(line))
}

function assertStockStatements(actual, expected, name) {
  if (JSON.stringify(statements(actual, true)) !== JSON.stringify(statements(expected))) {
    throw new Error(
      `Life NSIS profiling ${name} differs from the resolved upstream routine. Review the upstream change before building.`,
    )
  }
}

function verify(root = path.join(__dirname, '..')) {
  const upstream = path.join(
    path.dirname(require.resolve('app-builder-lib/package.json')),
    'templates',
    'nsis',
    'include',
  )
  const extraction = fs.readFileSync(path.join(upstream, 'extractAppPackage.nsh'), 'utf8')
  const profiledExtraction = fs.readFileSync(
    path.join(root, 'build', 'installer-extract-profile.nsh'),
    'utf8',
  )
  assertStockStatements(
    macroBody(profiledExtraction, 'extractUsing7za'),
    macroBody(extraction, 'extractUsing7za'),
    'extraction',
  )

  const utility = fs
    .readFileSync(path.join(upstream, 'installUtil.nsh'), 'utf8')
    .replaceAll('\r\n', '\n')
  const handler = utility.match(/Function handleUninstallResult\n([\s\S]*?)\nFunctionEnd/)
  if (!handler) throw new Error('The resolved upstream uninstall result handler was not found.')
  const stockResult = handler[1].slice(handler[1].indexOf('  IfErrors 0 +3'))
  if (!stockResult.trim())
    throw new Error('The resolved upstream uninstall result statements were not found.')
  const include = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8')
  assertStockStatements(
    macroBody(include, 'LifeStockUninstallResult'),
    stockResult,
    'uninstall result handler',
  )
}

module.exports = { assertStockStatements, macroBody, verify }
if (require.main === module) verify()
