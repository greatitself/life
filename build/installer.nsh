; Optional installer profiling and verified empty-directory extraction. Retain
; upstream process checks, uninstall result handling, retries and updater cache.
; Verify the mirrored upstream routines before either NSIS executable is built.
!system 'node "${PROJECT_DIR}/scripts/verify-nsis-trace.cjs"' = 0

; A custom check suppresses these declarations in the upstream include, even
; though this wrapper still invokes the complete upstream check.
!include "getProcessInfo.nsh"
!include "installer-payload.nsh"
Var pid

!macro LifeInstallerTrace PHASE
  Push "${PHASE}"
  Call LifeInstallerTrace
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var /GLOBAL lifePayloadVerified
    !insertmacro LifeDefineEmptyPayloadDirectory
    !ifdef APP_64
      !system 'node "${PROJECT_DIR}/scripts/generate-installer-payload.cjs" --archive "${APP_64}" --arch 64 --output "${APP_64}.life-payload.nsh"' = 0
      !include "${APP_64}.life-payload.nsh"
    !endif
    !ifdef APP_32
      !system 'node "${PROJECT_DIR}/scripts/generate-installer-payload.cjs" --archive "${APP_32}" --arch 32 --output "${APP_32}.life-payload.nsh"' = 0
      !include "${APP_32}.life-payload.nsh"
    !endif
    !ifdef APP_ARM64
      !system 'node "${PROJECT_DIR}/scripts/generate-installer-payload.cjs" --archive "${APP_ARM64}" --arch ARM64 --output "${APP_ARM64}.life-payload.nsh"' = 0
      !include "${APP_ARM64}.life-payload.nsh"
    !endif
    Function LifeInstallerTrace
      ; Consume the phase argument while restoring all registers and the stack.
      Exch $0
      Push $1
      Push $2
      Push $3
      Push $4
      IfErrors trace_had_error trace_no_error
      trace_had_error:
        StrCpy $4 "1"
        Goto trace_begin
      trace_no_error:
        StrCpy $4 "0"
      trace_begin:
        ; Work with a clean local flag; restore the caller's flag on every exit.
        ClearErrors
        ReadEnvStr $1 "LIFE_NSIS_TRACE_FILE"
        StrCmp $1 "" trace_restore
        System::Call 'kernel32::GetTickCount64() l .r2'
        FileOpen $3 "$1" a
        IfErrors trace_restore
        ; NSIS append mode opens at the beginning; seek explicitly on every call.
        FileSeek $3 0 END
        IfErrors trace_close
        FileWrite $3 "$0$\t$2$\r$\n"
      trace_close:
        FileClose $3
      trace_restore:
        StrCmp $4 "1" trace_restore_error
        ClearErrors
        Goto trace_restore_registers
      trace_restore_error:
        SetErrors
      trace_restore_registers:
        Pop $4
        Pop $3
        Pop $2
        Pop $1
        Pop $0
    FunctionEnd

    Function .onInstSuccess
      !insertmacro LifeInstallerTrace "installer-success"
    FunctionEnd
  !endif
!macroend

!macro customInit
  !insertmacro LifeInstallerTrace "installer-init"
!macroend

; This is expanded after installer.nsh has defined extractUsing7za and before
; installApplicationFiles uses it. Preserve the stock staging/copy routine behind
; an empty-target fast path and require complete verification before completion.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !ifndef LIFE_PROFILE_EXTRACT_DEFINED
      !define LIFE_PROFILE_EXTRACT_DEFINED
      !ifdef UNINSTALLER_ICON
        !error "Life's verified installer must include the uninstaller icon in its trusted payload before enabling UNINSTALLER_ICON."
      !endif
      !ifmacrodef customFiles_x64
        !error "Life's verified installer does not support files outside the trusted x64 payload."
      !endif
      !ifmacrodef customFiles_ia32
        !error "Life's verified installer does not support files outside the trusted ia32 payload."
      !endif
      !ifmacrodef customFiles_arm64
        !error "Life's verified installer does not support files outside the trusted ARM64 payload."
      !endif
      !macroundef extractUsing7za
      !include "installer-extract-profile.nsh"
    !endif
    !insertmacro LifeInstallerTrace "process-check-start"
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro LifeInstallerTrace "process-check-complete"
  !endif
!macroend

; handleUninstallResult returns immediately after a custom check. Retain its
; complete upstream result handler, including launch errors and nonzero exits.
!macro LifeStockUninstallResult
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro LifeInstallerTrace "old-uninstaller-complete"
  !insertmacro LifeStockUninstallResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro LifeInstallerTrace "old-user-uninstaller-complete"
  !insertmacro LifeStockUninstallResult
!macroend

!macro customInstall
  !insertmacro LifeInstallerTrace "cache-registration-shortcuts-complete"
!macroend
