'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { getMakeNsisPath, getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows.js')

const root = path.resolve(__dirname, '..')

function nsisString(value) {
  return String(value)
    .replaceAll('$', () => '$$')
    .replaceAll('"', '$\\"')
}

function run(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 60000, cwd: root })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`)
  return result
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'life-nsis-trace-fixture-'))
  try {
    const binary = await getMakeNsisPath()
    const plugins = await getNsisPluginsPath()
    const includes = path.join(
      path.dirname(require.resolve('app-builder-lib/package.json')),
      'templates',
      'nsis',
      'include',
    )
    const executable = path.join(scratch, 'fixture.exe')
    const source = path.join(scratch, 'fixture.nsi')
    const registers = Array.from({ length: 10 }, (_, index) => [`$${index}`, `$R${index}`]).flat()
    const initialize = registers
      .map((register, index) => `StrCpy ${register} "register-${index}"`)
      .join('\n')
    const check = registers
      .map((register, index) => `StrCmp ${register} "register-${index}" 0 fixture_failed`)
      .join('\n')
    fs.writeFileSync(
      source,
      String.raw`Unicode true
Name "Life installer trace fixture"
OutFile "${nsisString(executable)}"
RequestExecutionLevel user
SilentInstall silent
!define PROJECT_DIR "${nsisString(root)}"
!addincludedir "${nsisString(includes)}"
!addincludedir "${nsisString(path.join(root, 'build'))}"
!addplugindir /x86-unicode "${nsisString(path.join(plugins, 'x86-unicode'))}"
!include "${nsisString(path.join(root, 'build', 'installer.nsh'))}"
!insertmacro customHeader
Var fixtureScratch
Var fixtureReport
Var fixtureHandle
Var fixtureHandleCount

!macro FixtureTrace PHASE
  Push "stack-bottom"
  Push "stack-top"
  !insertmacro LifeInstallerTrace "${'${PHASE}'}"
  Pop $fixtureScratch
  StrCmp $fixtureScratch "stack-top" 0 fixture_failed
  Pop $fixtureScratch
  StrCmp $fixtureScratch "stack-bottom" 0 fixture_failed
  ${check}
!macroend

Section
  ; The payload helper is defined by the real include and must remain linked.
  Push "$TEMP"
  Call LifeEmptyPayloadDirectory
  Pop $lifePayloadVerified
  ; Exercise the real process-info include so makensis -WX sees no unused helper.
  ${'${GetProcessInfo}'} 0 $pid $1 $2 $3 $4
  ReadEnvStr $fixtureReport "LIFE_NSIS_TRACE_FIXTURE_RESULT"
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
  StrCmp $2 "0" fixture_failed
  StrCpy $fixtureHandleCount $1
  ${initialize}

  ClearErrors
  !insertmacro FixtureTrace "fixture-first"
  IfErrors fixture_failed
  SetErrors
  !insertmacro FixtureTrace "fixture-second"
  IfErrors +2 0
  Goto fixture_failed
  SetErrors
  !insertmacro FixtureTrace "fixture-with-error"
  IfErrors +2 0
  Goto fixture_failed
  ClearErrors
  !insertmacro FixtureTrace "fixture-without-error"
  IfErrors fixture_failed

  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
  StrCmp $2 "0" fixture_failed
  StrCmp $1 $fixtureHandleCount 0 fixture_failed

  FileOpen $fixtureHandle "$fixtureReport" w
  IfErrors fixture_failed
  FileWrite $fixtureHandle "ok$\r$\n"
  FileClose $fixtureHandle
  SetErrorLevel 0
  Goto fixture_complete
  fixture_failed:
    SetErrorLevel 7
    Quit
  fixture_complete:
SectionEnd
`,
    )
    run(binary.path, ['-WX', '-V2', source], { ...process.env, ...binary.env })
    if (process.platform !== 'win32') {
      console.log('Real NSIS trace fixture compiled; runtime assertions require Windows.')
      return
    }

    const expected = [
      'fixture-first',
      'fixture-second',
      'fixture-with-error',
      'fixture-without-error',
      'installer-success',
    ]
    function execute(name, tracePath) {
      const report = path.join(scratch, `${name}.result`)
      const env = { ...process.env, LIFE_NSIS_TRACE_FIXTURE_RESULT: report }
      delete env.LIFE_NSIS_TRACE_FILE
      if (tracePath !== undefined) env.LIFE_NSIS_TRACE_FILE = tracePath
      run(executable, ['/S'], env)
      assert.equal(
        fs.readFileSync(report, 'utf8'),
        'ok\r\n',
        `${name}: native preservation assertions did not complete`,
      )
    }

    const trace = path.join(scratch, 'trace.tsv')
    fs.writeFileSync(trace, 'preexisting\t1\r\n', 'ascii')
    execute('append-first', trace)
    execute('append-second', trace)
    const rows = fs.readFileSync(trace, 'ascii').split('\r\n')
    assert.equal(rows.pop(), '', 'Every marker must terminate with CRLF')
    assert.equal(rows.shift(), 'preexisting\t1', 'Existing trace contents must be retained')
    assert.deepEqual(
      rows.map((row) => row.split('\t')[0]),
      [...expected, ...expected],
      'Native markers must append in exact order across repeated processes',
    )
    let previous = 0
    for (const row of rows) {
      assert.match(row, /^[a-z-]+\t\d+$/, 'Native trace row format must be phase<TAB>uptime')
      const uptime = Number(row.split('\t')[1])
      assert.ok(
        Number.isSafeInteger(uptime) && uptime > 0 && uptime >= previous,
        'Native uptime must be positive and monotonic',
      )
      previous = uptime
    }

    const absent = path.join(scratch, 'without-trace.tsv')
    execute('disabled')
    assert.equal(fs.existsSync(absent), false, 'Disabled telemetry must create no file')
    assert.deepEqual(
      fs.readdirSync(scratch).filter((file) => file.endsWith('.tsv')),
      ['trace.tsv'],
      'Disabled telemetry must not create another trace',
    )

    const unwritable = path.join(scratch, 'missing-directory', 'trace.tsv')
    execute('trace-open-fails', unwritable)
    assert.equal(
      fs.existsSync(unwritable),
      false,
      'Failed optional logging must preserve native state and not create a directory',
    )
    console.log(
      'Real Windows NSIS trace fixture passed: ordered append across two runs, all 20 registers, stack, set/clear errors, disabled logging and logging I/O failure.',
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
