!ifndef LIFE_INSTALLER_PROCESS_INCLUDED
!define LIFE_INSTALLER_PROCESS_INCLUDED

!include "LogicLib.nsh"

; One complete successful CIM query can avoid the stock availability and policy
; subprocesses. Every other outcome must run the complete upstream checks.
!define LIFE_PROCESS_PROBE_MARKER "LIFE_NO_SCOPED_PROCESS_V1"
!define LIFE_PROCESS_PROBE_EXIT "73"
!define LIFE_PROCESS_PROBE_ENV "LIFE_NSIS_PROCESS_PROBE_TARGET"
!define /ifndef LIFE_PROCESS_PROBE_EXECUTABLE "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

!macro LifeDefineProcessCheck
  Function LifeNoScopedProcess
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9

    ; $0 is the returned proof, $9 preserves the caller's NSIS error flag.
    StrCpy $0 "0"
    IfErrors life_probe_had_error life_probe_no_error
    life_probe_had_error:
      StrCpy $9 "1"
      Goto life_probe_begin
    life_probe_no_error:
      StrCpy $9 "0"
    life_probe_begin:
      ClearErrors
      StrCmp $INSTDIR "" life_probe_done

      ; Preserve both the original value and whether the variable was absent.
      ; Oversized or unreadable values are left untouched and use stock checks.
      ; System's ?r status must be "ok" before native result registers can be
      ; interpreted. Without it, failed calls can return the text "error".
      System::Call 'kernel32::SetLastError(i 0) ?r'
      Pop $8
      StrCmpS $8 "ok" 0 life_probe_done
      System::Call 'kernel32::GetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", p 0, i 0) i .r2 ?re'
      Pop $3
      Pop $8
      StrCmpS $8 "ok" 0 life_probe_done
      IntCmpU $2 ${NSIS_MAX_STRLEN} life_probe_done 0 life_probe_done
      StrCpy $4 "0"
      StrCpy $1 ""
      ${If} $2 == 0
        ${If} $3 == 203
          StrCpy $4 "1"
        ${ElseIf} $3 != 0
          Goto life_probe_done
        ${EndIf}
      ${Else}
        StrCpy $5 $2
        System::Call 'kernel32::SetLastError(i 0) ?r'
        Pop $8
        StrCmpS $8 "ok" 0 life_probe_done
        System::Call 'kernel32::GetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", w .r1, i ${NSIS_MAX_STRLEN}) i .r2 ?re'
        Pop $3
        Pop $8
        StrCmpS $8 "ok" 0 life_probe_done
        ${If} $2 == 0
        ${AndIf} $3 != 0
          Goto life_probe_done
        ${EndIf}
        ; The preflight includes the terminator; a complete read excludes it.
        ; A changed or incomplete value cannot authorize an environment edit.
        IntOp $5 $5 - 1
        StrCmpS $2 $5 0 life_probe_done
      ${EndIf}

      ; The installation path is data in an inherited process environment,
      ; never source text interpolated into the PowerShell command.
      System::Call 'kernel32::SetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", w d) i .r5 ?r'
      Pop $8
      StrCmpS $8 "ok" 0 life_probe_done
      StrCmpS $5 "0" life_probe_done

      ; Materialize the entire query before testing paths. Terminating failures,
      ; missing commands, restricted policy, matches and timeouts cannot prove
      ; absence. Use precisely the same path comparison as the stock CIM path.
      nsExec::ExecToStack /TIMEOUT=2000 `"${LIFE_PROCESS_PROBE_EXECUTABLE}" -NoProfile -NonInteractive -Command "try { $$ErrorActionPreference = 'Stop'; $$null = Get-Command Get-CimInstance -ErrorAction Stop; if ((Get-ExecutionPolicy -Scope Process -ErrorAction Stop) -eq 'Restricted') { exit 74 }; $$target = [Environment]::GetEnvironmentVariable('${LIFE_PROCESS_PROBE_ENV}', 'Process'); if ([String]::IsNullOrEmpty($$target)) { exit 74 }; $$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop); if ($$processes.Count -eq 0) { exit 74 }; if (@($$processes | Where-Object { $$_.Path -and $$_.Path.StartsWith($$target, 'CurrentCultureIgnoreCase') }).Count -gt 0) { exit 74 }; [Console]::Out.Write('${LIFE_PROCESS_PROBE_MARKER}'); exit ${LIFE_PROCESS_PROBE_EXIT} } catch { exit 74 }"`
      Pop $6
      Pop $7

      ; Restore the process environment before considering the proof valid.
      ${If} $4 == "1"
        System::Call 'kernel32::SetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", p 0) i .r8 ?r'
      ${Else}
        System::Call 'kernel32::SetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", w r1) i .r8 ?r'
      ${EndIf}
      Pop $5
      StrCmpS $5 "ok" 0 life_probe_done
      StrCmpS $8 "0" life_probe_done
      StrCmpS $6 "${LIFE_PROCESS_PROBE_EXIT}" 0 life_probe_done
      StrCmpS $7 "${LIFE_PROCESS_PROBE_MARKER}" 0 life_probe_done
      StrCpy $0 "1"

    life_probe_done:
      StrCmp $9 "1" life_probe_restore_error
      ClearErrors
      Goto life_probe_restore_registers
    life_probe_restore_error:
      SetErrors
    life_probe_restore_registers:
      Pop $9
      Pop $8
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Exch $0
  FunctionEnd
!macroend

!macro LifeStockCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro LifeCheckAppRunning
  Push $R0
  Call LifeNoScopedProcess
  Pop $R0
  ${If} $R0 == "1"
    Pop $R0
  ${Else}
    Pop $R0
    !insertmacro LifeStockCheckAppRunning
  ${EndIf}
!macroend

!endif
