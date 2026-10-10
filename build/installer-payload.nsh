; Direct extraction is eligible only after a complete native enumeration proves
; that the existing target is an ordinary empty directory. Every uncertainty
; selects the unchanged upstream staging/copy path only when the target remains
; safe to write. Reparse paths and uncertain ancestry fail before any writes.
!macro LifeDefineEmptyPayloadDirectory
  Function LifeOrdinaryPayloadAncestry
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    IfErrors ancestry_had_error ancestry_no_error
    ancestry_had_error:
      StrCpy $7 "1"
      Goto ancestry_begin
    ancestry_no_error:
      StrCpy $7 "0"
    ancestry_begin:
      ClearErrors
      StrCpy $6 "2"
      System::Call 'kernel32::GetFullPathNameW(w r0, i 1024, w .r0, p 0) i .r1 ?re'
      Pop $3
      Pop $4
      StrCmp $4 "ok" 0 ancestry_restore
      IntCmp $1 0 ancestry_restore ancestry_restore 0
      IntCmp $1 1024 ancestry_restore 0 ancestry_restore
      ; Reject uncertain UNC/device ancestry. Resolve dot components first, then
      ; positively inspect every ordinary drive-path ancestor.
      StrCpy $2 $0 1 1
      StrCmp $2 ":" 0 ancestry_restore
      StrCpy $2 $0 1 2
      StrCmp $2 "\" 0 ancestry_restore
      StrCpy $6 "1"
      ancestry_next:
        System::Call 'kernel32::GetFileAttributesW(w r0) i .r1 ?re'
        Pop $3
        Pop $4
        StrCmp $4 "ok" 0 ancestry_invalid
        StrCmp $1 "-1" ancestry_invalid
        ; EFS/compression inherited from the temporary stage can be preserved
        ; by the stock shell copy. Do not change that behavior through direct
        ; extraction, and do not traverse junctions or symbolic links.
        IntOp $5 $1 & 0x410
        StrCmp $5 "16" 0 ancestry_invalid
        IntOp $5 $1 & 0x4800
        StrCmp $5 "0" +2
        StrCpy $6 "0"
        StrLen $2 $0
        IntCmp $2 3 ancestry_restore ancestry_invalid 0
        ancestry_find_separator:
          IntOp $2 $2 - 1
          StrCpy $5 $0 1 $2
          StrCmp $5 "\" ancestry_parent
          IntCmp $2 2 ancestry_invalid ancestry_invalid ancestry_find_separator
        ancestry_parent:
          IntCmp $2 2 0 +2 +2
          IntOp $2 $2 + 1
          StrCpy $0 $0 $2
          Goto ancestry_next
      ancestry_invalid:
        StrCpy $6 "2"
    ancestry_restore:
      StrCmp $7 "1" ancestry_restore_error
      ClearErrors
      Goto ancestry_restore_registers
    ancestry_restore_error:
      SetErrors
    ancestry_restore_registers:
      StrCpy $0 $6
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Exch $0
  FunctionEnd

  Function LifeEmptyPayloadDirectory
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    IfErrors empty_had_error empty_no_error
    empty_had_error:
      StrCpy $9 "1"
      Goto empty_begin
    empty_no_error:
      StrCpy $9 "0"
    empty_begin:
      ClearErrors
      StrCpy $8 "2"
      StrCpy $2 "0"
      StrCpy $1 "-1"
      !if ${NSIS_PTR_SIZE} = 4
        Push "$0"
        Call LifeOrdinaryPayloadAncestry
        Pop $5
        StrCmp $5 "2" empty_restore
        StrCpy $6 $5
        Push "$PLUGINSDIR"
        Call LifeOrdinaryPayloadAncestry
        Pop $5
        StrCmp $5 "2" empty_restore
        StrCmp $5 "1" +2
        StrCpy $6 "0"
        StrCmp $6 "1" +3
        StrCpy $8 "0"
        Goto empty_restore
        System::Call 'kernel32::GetFileAttributesW(w r0) i .r5 ?re'
        Pop $3
        Pop $4
        StrCmp $4 "ok" 0 empty_restore
        StrCmp $5 "-1" empty_restore
        IntOp $6 $5 & 0x10
        StrCmp $6 "16" 0 empty_restore
        IntOp $6 $5 & 0x400
        StrCmp $6 "0" 0 empty_restore
        ; WIN32_FIND_DATAW is 592 bytes in the Unicode Windows API.
        System::Alloc 592
        Pop $2
        StrCmp $2 "0" empty_restore
        System::Call 'kernel32::FindFirstFileW(w "$0\*", p r2) p .r1 ?re'
        Pop $3
        Pop $4
        StrCmp $4 "ok" 0 empty_enumeration_failed
        StrCmp $1 "-1" empty_enumeration_failed
        ; Safe ordinary nonempty directories keep upstream copy semantics.
        StrCpy $8 "0"
        empty_next_entry:
          IntOp $7 $2 + 44
          System::Call '*$7(&w260 .r3)'
          StrCmp $3 "." empty_next
          StrCmp $3 ".." empty_next empty_close
        empty_next:
          System::Call 'kernel32::FindNextFileW(p r1, p r2) i .r5 ?re'
          Pop $3
          Pop $4
          StrCmp $4 "ok" 0 empty_enumeration_failed_close
          StrCmp $5 "0" 0 empty_next_entry
          StrCmp $3 "18" 0 empty_enumeration_failed_close
          StrCpy $8 "1"
          Goto empty_close
        empty_enumeration_failed_close:
          StrCpy $8 "2"
        empty_close:
          System::Call 'kernel32::FindClose(p r1) i .r5 ?re'
          Pop $3
          Pop $4
          StrCmp $4 "ok" 0 empty_close_failed
          StrCmp $5 "0" empty_close_failed empty_cleanup
        empty_close_failed:
          StrCpy $8 "2"
          Goto empty_cleanup
        empty_enumeration_failed:
          StrCpy $8 "2"
        empty_cleanup:
          System::Free $2
      !endif
    empty_restore:
      StrCmp $9 "1" empty_restore_error
      ClearErrors
      Goto empty_restore_registers
    empty_restore_error:
      SetErrors
    empty_restore_registers:
      StrCpy $0 $8
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

!macro LifeVerifySelectedPayload DIRECTORY RESULT
  StrCpy ${RESULT} "0"
  ${if} $packageArch == "ARM64"
    !ifdef APP_ARM64
      !insertmacro LifeVerifyPayloadARM64 "${DIRECTORY}" ${RESULT}
    !endif
  ${elseif} $packageArch == "64"
    !ifdef APP_64
      !insertmacro LifeVerifyPayload64 "${DIRECTORY}" ${RESULT}
    !endif
  ${else}
    !ifdef APP_32
      !insertmacro LifeVerifyPayload32 "${DIRECTORY}" ${RESULT}
    !endif
  ${endif}
!macroend

!macro LifeVerifySelectedStagedPayload DIRECTORY RESULT
  StrCpy ${RESULT} "0"
  ${if} $packageArch == "ARM64"
    !ifdef APP_ARM64
      !insertmacro LifeVerifyStagedPayloadARM64 "${DIRECTORY}" ${RESULT}
    !endif
  ${elseif} $packageArch == "64"
    !ifdef APP_64
      !insertmacro LifeVerifyStagedPayload64 "${DIRECTORY}" ${RESULT}
    !endif
  ${else}
    !ifdef APP_32
      !insertmacro LifeVerifyStagedPayload32 "${DIRECTORY}" ${RESULT}
    !endif
  ${endif}
!macroend

!macro LifePreflightSelectedPayload DIRECTORY RESULT
  StrCpy ${RESULT} "0"
  ${if} $packageArch == "ARM64"
    !ifdef APP_ARM64
      !insertmacro LifePreflightPayloadARM64 "${DIRECTORY}" ${RESULT}
    !endif
  ${elseif} $packageArch == "64"
    !ifdef APP_64
      !insertmacro LifePreflightPayload64 "${DIRECTORY}" ${RESULT}
    !endif
  ${else}
    !ifdef APP_32
      !insertmacro LifePreflightPayload32 "${DIRECTORY}" ${RESULT}
    !endif
  ${endif}
!macroend

!macro LifeRejectUnsafePayloadDirectory
  DetailPrint "The installation directory cannot be safely updated."
  MessageBox MB_OK|MB_ICONSTOP "The installation directory cannot be safely updated. Please choose an ordinary installation directory." /SD IDOK
  SetErrorLevel 2
  Quit
!macroend

!macro LifeRequirePayload DIRECTORY EXACT
  !insertmacro LifeInstallerTrace "payload-verification-start"
  !if "${EXACT}" == "1"
    !insertmacro LifeVerifySelectedStagedPayload "${DIRECTORY}" $lifePayloadVerified
  !else
    !insertmacro LifeVerifySelectedPayload "${DIRECTORY}" $lifePayloadVerified
  !endif
  !insertmacro LifeInstallerTrace "payload-verification-complete"
  ${if} $lifePayloadVerified != "1"
    DetailPrint "The application payload could not be verified."
    MessageBox MB_OK|MB_ICONSTOP "The application payload could not be verified. Please download the installer again." /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro LifeRequireVerifiedPayload DIRECTORY
  !insertmacro LifeRequirePayload "${DIRECTORY}" "0"
!macroend

!macro LifeRequireVerifiedStagedPayload DIRECTORY
  !insertmacro LifeRequirePayload "${DIRECTORY}" "1"
!macroend
