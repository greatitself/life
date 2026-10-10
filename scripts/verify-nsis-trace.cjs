'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function macroBody(source, name) {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\s*!macro ${name}(?:\\s|$)`).test(line))
  if (start < 0) throw new Error(`NSIS macro ${name} was not found.`)
  const end = lines.findIndex((line, index) => index > start && /^\s*!macroend\s*$/.test(line))
  if (end < 0) throw new Error(`NSIS macro ${name} was not terminated.`)
  return lines.slice(start + 1, end).join('\n')
}

function statements(source, removeTrace = false, removeVerification = false) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^[;#]/.test(line))
    .filter((line) => !removeTrace || !/^!insertmacro LifeInstallerTrace "[a-z-]+"$/.test(line))
    .filter(
      (line) =>
        !removeVerification ||
        (!/^!insertmacro LifeRequireVerifiedStagedPayload "\$PLUGINSDIR\\7z-out"$/.test(line) &&
          !/^!insertmacro LifeRequireVerifiedPayload "\$INSTDIR"$/.test(line)),
    )
}

function assertStockStatements(actual, expected, name, removeVerification = false) {
  if (
    JSON.stringify(statements(actual, true, removeVerification)) !==
    JSON.stringify(statements(expected))
  ) {
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
  const stockExtraction = macroBody(profiledExtraction, 'LifeStockExtractUsing7za')
  assertStockStatements(
    stockExtraction,
    macroBody(extraction, 'extractUsing7za'),
    'extraction',
    true,
  )
  const verification = statements(stockExtraction).filter((line) =>
    /^!insertmacro LifeRequireVerified(?:Staged)?Payload /.test(line),
  )
  if (
    JSON.stringify(verification) !==
      JSON.stringify([
        '!insertmacro LifeRequireVerifiedStagedPayload "$PLUGINSDIR\\7z-out"',
        '!insertmacro LifeRequireVerifiedPayload "$INSTDIR"',
      ]) ||
    !/Nsis7z::Extract "\$\{FILE\}"\s+!insertmacro LifeRequireVerifiedStagedPayload "\$PLUGINSDIR\\7z-out"/.test(
      stockExtraction,
    ) ||
    !/DoneExtract7za:\s+!insertmacro LifeRequireVerifiedPayload "\$INSTDIR"/.test(stockExtraction)
  ) {
    throw new Error(
      'The stock extraction must verify the complete stage before copying and the installed payload before completion.',
    )
  }

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

  // The successful fast probe depends on these exact upstream availability,
  // policy and path-scope semantics. Dependency updates require a fresh review.
  const processSource = fs.readFileSync(
    path.join(upstream, 'allowOnlyOneInstallerInstance.nsh'),
    'utf8',
  )
  const reviewedProcess = [
    'IS_POWERSHELL_AVAILABLE',
    'FIND_PROCESS',
    'KILL_PROCESS',
    '_CHECK_APP_RUNNING',
  ]
    .map((name) => macroBody(processSource, name).trim())
    .join('\n\n')
  if (
    createHash('sha256').update(reviewedProcess).digest('hex') !==
    '36a3247a5ca7964eb01c1d058dc1f1011a82c4fe7de9aaf8740e292ff9c71d68'
  ) {
    throw new Error(
      'The upstream process checks changed. Review the complete probe and fallback before building.',
    )
  }
  const process = fs.readFileSync(path.join(root, 'build', 'installer-process.nsh'), 'utf8')
  assertStockStatements(
    macroBody(process, 'LifeStockCheckAppRunning'),
    '!insertmacro IS_POWERSHELL_AVAILABLE\n!insertmacro _CHECK_APP_RUNNING',
    'process fallback',
  )
  if (
    !/!ifdef BUILD_UNINSTALLER\s+!insertmacro IS_POWERSHELL_AVAILABLE\s+!insertmacro _CHECK_APP_RUNNING\s+!else\s+!insertmacro LifeCheckAppRunning\s+!endif/.test(
      macroBody(include, 'customCheckAppRunning'),
    )
  ) {
    throw new Error('The uninstaller must retain its original complete process checks.')
  }
}

module.exports = { assertStockStatements, macroBody, verify }
if (require.main === module) verify()
