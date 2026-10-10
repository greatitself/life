!ifndef LIFE_INSTALLER_MODERN_NSH
!define LIFE_INSTALLER_MODERN_NSH

; Production x64 installers must embed both prepared resources. Fixtures opt in
; explicitly so a Linux compile can still exercise the unchanged legacy path.
!ifdef APP_64
  !ifndef LIFE_NSIS_MODERN_FIXTURE
    !ifndef LIFE_MODERN_ENABLED
      !define LIFE_MODERN_ENABLED
    !endif
  !endif
!endif
!ifdef LIFE_MODERN_ENABLED
  !ifndef APP_64
    !error "The modern decoder requires a trusted x64 application payload."
  !endif
  !ifndef LIFE_MODERN_DECODER_EXE
    !define LIFE_MODERN_DECODER_EXE "${PROJECT_DIR}/output/installer-tools/windows-x64/7za-26.04-x64.exe"
  !endif
  !ifndef LIFE_MODERN_PLUGIN_DIR
    !define LIFE_MODERN_PLUGIN_DIR "${PROJECT_DIR}/output/installer-tools/nsis-plugins/x86-unicode"
  !endif
  !include "x64.nsh"
  !addplugindir /x86-unicode "${LIFE_MODERN_PLUGIN_DIR}"
!endif

!macro LifeModernExtract FILE RESULT
  !ifdef LIFE_MODERN_ENABLED
    ${If} $packageArch == "64"
      Push "${FILE}"
      Call LifeModernExtract
      Pop ${RESULT}
    ${Else}
      StrCpy ${RESULT} "unavailable"
    ${EndIf}
  !else
    StrCpy ${RESULT} "unavailable"
  !endif
!macroend

; Retain a read-only, no-write/no-delete-sharing handle across hashing and the
; complete child/job lifetime. The hash helper opens a compatible second reader;
; the original handle prevents replacement between verification and execution.
!macro LifeModernOpenOrdinaryFile FILE HANDLE REGISTER
  System::Call 'kernel32::CreateFileW(w "${FILE}", i 0x80000000, i 1, p 0, i 3, i 0x08200000, p 0) p .${REGISTER} ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 modern_cleanup
  StrCmp ${HANDLE} "-1" modern_cleanup
  StrCmp ${HANDLE} "0" modern_cleanup
  System::Call 'kernel32::GetFileType(p ${REGISTER}) i .R2 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 modern_cleanup
  StrCmp $R2 "1" 0 modern_cleanup
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 52) p .r3 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 modern_cleanup
  StrCmp $3 "0" modern_cleanup
  System::Call 'kernel32::GetFileInformationByHandle(p ${REGISTER}, p r3) i .R2 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 modern_cleanup
  StrCmp $R2 "0" modern_cleanup
  System::Call '*$3(i .R2) ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 modern_cleanup
  IntOp $R2 $R2 & 0x410
  StrCmp $R2 "0" 0 modern_cleanup
  System::Call 'kernel32::GlobalFree(p r3) p .R2 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 modern_cleanup
  StrCmp $R2 "0" 0 modern_cleanup
  StrCpy $3 "0"
!macroend

!macro LifeDefineModernDecoder
  !ifdef LIFE_MODERN_ENABLED
    Function LifeModernExtract
      Exch $0
      !insertmacro LifeHashSaveRegisters
      IfErrors modern_had_error modern_no_error
      modern_had_error:
        StrCpy $9 "1"
        Goto modern_begin
      modern_no_error:
        StrCpy $9 "0"
      modern_begin:
        ClearErrors
        StrCpy $1 "-1"
        StrCpy $2 "-1"
        StrCpy $3 "0"
        StrCpy $7 "error"
        ${IfNot} ${IsNativeAMD64}
          Goto modern_unavailable
        ${EndIf}

        ; Use a private ordinary temporary directory without changing OUTDIR
        ; or the installer's current working directory. Never overwrite an
        ; existing decoder: open and verify the same pinned ordinary file.
        Push "$PLUGINSDIR"
        Call LifeOrdinaryPayloadAncestry
        Pop $R2
        StrCmp $R2 "1" 0 modern_unavailable
        StrCpy $4 "$PLUGINSDIR\life-modern-decoder"
        StrCpy $5 "$4\7za-26.04-x64.exe"
        System::Call 'kernel32::GetFileAttributesW(w r4) i .R2 ?re'
        Pop $R1
        Pop $R0
        StrCmp $R0 "ok" 0 modern_unavailable
        StrCmp $R2 "-1" modern_create_directory modern_check_directory
      modern_create_directory:
        StrCmp $R1 "2" modern_create_directory_confirmed
        StrCmp $R1 "3" 0 modern_unavailable
      modern_create_directory_confirmed:
        CreateDirectory "$4"
        IfErrors modern_unavailable
      modern_check_directory:
        Push "$4"
        Call LifeOrdinaryPayloadAncestry
        Pop $R2
        StrCmp $R2 "1" 0 modern_unavailable
        System::Call 'kernel32::GetFileAttributesW(w r5) i .R2 ?re'
        Pop $R1
        Pop $R0
        StrCmp $R0 "ok" 0 modern_cleanup
        StrCmp $R2 "-1" modern_embed_decoder modern_open_decoder
      modern_embed_decoder:
        StrCmp $R1 "2" modern_embed_decoder_confirmed
        StrCmp $R1 "3" 0 modern_cleanup
      modern_embed_decoder_confirmed:
        Push "$4"
        Call LifeEmptyPayloadDirectory
        Pop $R2
        StrCmp $R2 "1" 0 modern_unavailable
        File /oname=$PLUGINSDIR\life-modern-decoder\7za-26.04-x64.exe "${LIFE_MODERN_DECODER_EXE}"
        IfErrors modern_cleanup
      modern_open_decoder:
        !insertmacro LifeModernOpenOrdinaryFile "$5" $1 r1
        !insertmacro LifeModernOpenOrdinaryFile "$0" $2 r2
        !insertmacro LifeHashFile "$5" $R2
        StrCmp $R2 "15d4c788c148e3677e2fc1c4a01f191fb6669eba4f6acf8a465f0f1a6f1e1260" 0 modern_cleanup

        ; The embedded installer CRC and the complete trusted output manifest
        ; remain active. The ordinary archive handle denies writes/deletion
        ; until the plugin has proved that its entire job is drained.
        !insertmacro LifeInstallerTrace "modern-decoder-start"
        Push "life-modern-launch-boundary"
        LifeInstallerLauncher::Launch "$5" "$0" "$INSTDIR"
        Pop $7
        StrCmp $7 "ok" modern_check_launch_boundary
        StrCmp $7 "unavailable" modern_check_launch_boundary
        StrCmp $7 "error" modern_check_launch_boundary
        ; A missing/unloadable plugin leaves all three arguments untouched.
        ; Any other invalid return violates the child-quiescence contract, so
        ; terminate rather than entering extraction recovery with uncertainty.
        IfErrors 0 modern_launch_contract_failed
        StrCmp $7 $5 0 modern_launch_contract_failed
        Pop $R2
        StrCmp $R2 $0 0 modern_launch_contract_failed
        Pop $R2
        StrCmp $R2 $INSTDIR 0 modern_launch_contract_failed
        StrCpy $7 "unavailable"
      modern_check_launch_boundary:
        Pop $R2
        StrCmp $R2 "life-modern-launch-boundary" 0 modern_launch_contract_failed
        Goto modern_cleanup
      modern_launch_contract_failed:
        SetErrorLevel 2
        Quit
      modern_unavailable:
        StrCpy $7 "unavailable"
      modern_cleanup:
        StrCmp $3 "0" modern_close_archive
        System::Call 'kernel32::GlobalFree(p r3) p .R2 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 modern_free_info_failed
        StrCmp $R2 "0" modern_close_archive
      modern_free_info_failed:
        StrCpy $7 "error"
      modern_close_archive:
        StrCmp $2 "-1" modern_close_decoder
        StrCmp $2 "0" modern_close_decoder
        System::Call 'kernel32::CloseHandle(p r2) i .R2 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 modern_close_archive_failed
        StrCmp $R2 "0" modern_close_archive_failed modern_close_decoder
      modern_close_archive_failed:
        StrCpy $7 "error"
      modern_close_decoder:
        StrCmp $1 "-1" modern_trace_result
        StrCmp $1 "0" modern_trace_result
        System::Call 'kernel32::CloseHandle(p r1) i .R2 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 modern_close_decoder_failed
        StrCmp $R2 "0" modern_close_decoder_failed modern_trace_result
      modern_close_decoder_failed:
        StrCpy $7 "error"
      modern_trace_result:
        StrCmp $7 "ok" modern_trace_ok
        StrCmp $7 "unavailable" modern_trace_unavailable
        !insertmacro LifeInstallerTrace "modern-decoder-result-error"
        Goto modern_restore
      modern_trace_ok:
        !insertmacro LifeInstallerTrace "modern-decoder-result-ok"
        Goto modern_restore
      modern_trace_unavailable:
        !insertmacro LifeInstallerTrace "modern-decoder-result-unavailable"
      modern_restore:
        StrCmp $9 "1" modern_restore_error
        ClearErrors
        Goto modern_restore_registers
      modern_restore_error:
        SetErrors
      modern_restore_registers:
        StrCpy $0 $7
        !insertmacro LifeHashRestoreRegisters
    FunctionEnd
  !endif
!macroend

!endif
