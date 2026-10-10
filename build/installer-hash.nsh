!ifndef LIFE_INSTALLER_HASH_NSH
!define LIFE_INSTALLER_HASH_NSH

; SHA256 through Windows CNG. The shared Windows 10 SHA256 pseudo-handle is
; borrowed, never closed. BCrypt owns each hash object's allocation (Windows
; 7+); only a successfully acquired hash handle is destroyed by this code.
; https://learn.microsoft.com/windows/win32/seccng/cng-algorithm-pseudo-handles
; https://learn.microsoft.com/windows/win32/api/bcrypt/nf-bcrypt-bcryptcreatehash
;
; Native setup can report "unavailable" before reading any file bytes. Every
; file, read, digest or cleanup failure reports "error" and forbids fallback.
!ifdef LIFE_NATIVE_HASH_FIXTURE_UNAVAILABLE
  !ifndef LIFE_INSTALLER_HASH_FIXTURE
    !error "Forced native hash unavailability is restricted to installer fixtures."
  !endif
!endif

!macro LifeNativeHashFile FILE RESULT
  Push "${FILE}"
  Call LifeNativeHashFile
  Pop ${RESULT}
!macroend

!macro LifeHashFile FILE RESULT
  Push "${FILE}"
  Call LifeHashFile
  Pop ${RESULT}
!macroend

!macro LifeHashSaveRegisters
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
!macroend

!macro LifeHashRestoreRegisters
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
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
!macroend

; Both paths keep the same read-only, no-write/no-delete-sharing handle open
; until the digest and final size have been checked. OPEN_REPARSE_POINT guards
; the final component; the existing manifest verifier checks directory ancestry.
; BY_HANDLE_FILE_INFORMATION is 52 bytes on both Windows pointer widths.
!macro LifeHashOpenOrdinaryFile PREFIX
  System::Call 'kernel32::CreateFileW(w r0, i 0x80000000, i 1, p 0, i 3, i 0x08200000, p 0) p .r1 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_cleanup
  StrCmp $1 "-1" ${PREFIX}_cleanup
  StrCmp $1 "0" ${PREFIX}_cleanup
  System::Call 'kernel32::GetFileType(p r1) i .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_cleanup
  StrCmp $8 "1" 0 ${PREFIX}_cleanup
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 52) p .r6 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_cleanup
  StrCmp $6 "0" ${PREFIX}_cleanup
  System::Call 'kernel32::GetFileInformationByHandle(p r1, p r6) i .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_cleanup
  StrCmp $8 "0" ${PREFIX}_cleanup
  System::Call '*$6(i .R6)'
  IntOp $R6 $R6 & 0x410
  StrCmp $R6 "0" 0 ${PREFIX}_cleanup
  System::Call 'kernel32::GetFileSizeEx(p r1, *l 0 R3) i .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_cleanup
  StrCmp $8 "0" ${PREFIX}_cleanup
  System::Int64Op $R3 < 0
  Pop $R0
  StrCmp $R0 "0" 0 ${PREFIX}_cleanup
!macroend

!macro LifeHashCheckFinalFile PREFIX
  System::Call 'kernel32::GetFileSizeEx(p r1, *l 0 R5) i .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_cleanup
  StrCmp $8 "0" ${PREFIX}_cleanup
  StrCmp $R5 $R3 0 ${PREFIX}_cleanup
  System::Call 'kernel32::GetFileInformationByHandle(p r1, p r6) i .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_cleanup
  StrCmp $8 "0" ${PREFIX}_cleanup
  System::Call '*$6(i .R6)'
  IntOp $R6 $R6 & 0x410
  StrCmp $R6 "0" 0 ${PREFIX}_cleanup
!macroend

; Exact ASCII hex validation also normalizes StdUtils' result to lowercase.
!macro LifeHashNormalizeHex PREFIX FAILURE
  StrLen $R8 $7
  StrCmp $R8 "64" 0 ${FAILURE}
  ; Validate exact ASCII before case conversion, avoiding any Unicode folding.
  System::Call 'shlwapi::StrSpnW(w r7, w "0123456789abcdefABCDEF") i .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${FAILURE}
  StrCmp $8 "64" 0 ${FAILURE}
  System::Call 'user32::CharLowerBuffW(w r7 r7, i 64) i .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${FAILURE}
  StrCmp $8 "64" 0 ${FAILURE}
  StrLen $R8 $7
  StrCmp $R8 "64" 0 ${FAILURE}
!macroend

!macro LifeHashCloseFileAndBuffers PREFIX
  StrCmp $4 "0" ${PREFIX}_free_info
  System::Call 'kernel32::GlobalFree(p r4) p .r8 ?r'
  Pop $R0
  StrCmp $R0 "ok" 0 ${PREFIX}_free_read_failed
  StrCmp $8 "0" ${PREFIX}_free_info
  ${PREFIX}_free_read_failed:
    StrCpy $7 "error"
  ${PREFIX}_free_info:
    StrCmp $6 "0" ${PREFIX}_close_file
    System::Call 'kernel32::GlobalFree(p r6) p .r8 ?r'
    Pop $R0
    StrCmp $R0 "ok" 0 ${PREFIX}_free_info_failed
    StrCmp $8 "0" ${PREFIX}_close_file
  ${PREFIX}_free_info_failed:
    StrCpy $7 "error"
  ${PREFIX}_close_file:
    StrCmp $1 "-1" ${PREFIX}_restore
    StrCmp $1 "0" ${PREFIX}_restore
    System::Call 'kernel32::CloseHandle(p r1) i .r8 ?r'
    Pop $R0
    StrCmp $R0 "ok" 0 ${PREFIX}_close_file_failed
    StrCmp $8 "0" ${PREFIX}_close_file_failed ${PREFIX}_restore
  ${PREFIX}_close_file_failed:
    StrCpy $7 "error"
!macroend

!macro LifeDefineHashFile
  !ifndef LIFE_HASH_FUNCTIONS_DEFINED
    !define LIFE_HASH_FUNCTIONS_DEFINED
    Function LifeNativeHashFile
      Exch $0
      !insertmacro LifeHashSaveRegisters
      IfErrors native_hash_had_error native_hash_no_error
      native_hash_had_error:
        StrCpy $9 "1"
        Goto native_hash_begin
      native_hash_no_error:
        StrCpy $9 "0"
      native_hash_begin:
        ClearErrors
        StrCpy $1 "-1"
        StrCpy $3 "0"
        StrCpy $4 "0"
        StrCpy $6 "0"
        StrCpy $7 "error"
        !insertmacro LifeHashOpenOrdinaryFile native_hash
        !ifdef LIFE_NATIVE_HASH_FIXTURE_UNAVAILABLE
          Goto native_hash_unavailable
        !endif
        ; BCRYPT_SHA256_ALG_HANDLE is the borrowed pseudo-handle 0x41.
        ; BCRYPT_HASH_LENGTH's property name is "HashDigestLength".
        System::Call 'bcrypt::BCryptGetProperty(p 0x41, w "HashDigestLength", *i 0 R2, i 4, *i 0 R1, i 0) i .r8 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_unavailable
        StrCmp $8 "0" 0 native_hash_unavailable
        StrCmp $R1 "4" 0 native_hash_unavailable
        StrCmp $R2 "32" 0 native_hash_unavailable
        System::Call 'bcrypt::BCryptCreateHash(p 0x41, *p 0 R2, p 0, i 0, p 0, i 0, i 0) i .r8 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_unavailable
        StrCmp $8 "0" 0 native_hash_unavailable
        StrCmp $R2 "0" native_hash_unavailable
        ; A failed API call's output is not an owned handle. Transfer only a
        ; positively successful, non-null result to the cleanup-owned register.
        StrCpy $3 $R2
        ; The only large buffer is bounded at 1 MiB. Fixed GlobalAlloc gives
        ; a direct pointer; GlobalFree's return value is checked on every exit.
        System::Call 'kernel32::GlobalAlloc(i 0, p 1048576) p .r4 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_cleanup
        StrCmp $4 "0" native_hash_cleanup
        StrCpy $R4 "0"
      native_hash_read:
        System::Call 'kernel32::ReadFile(p r1, p r4, i 1048576, *i 0 R5, p 0) i .r8 ?re'
        Pop $R1
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_cleanup
        StrCmp $8 "0" native_hash_read_failed
        StrCmp $R5 "0" native_hash_eof
        IntCmp $R5 1048576 native_hash_add native_hash_add native_hash_cleanup
      native_hash_add:
        IntCmp $R5 0 native_hash_cleanup native_hash_cleanup 0
        System::Int64Op $R4 + $R5
        Pop $R4
        System::Int64Op $R4 < 0
        Pop $R0
        StrCmp $R0 "0" 0 native_hash_cleanup
        System::Int64Op $R4 > $R3
        Pop $R0
        StrCmp $R0 "0" 0 native_hash_cleanup
        System::Call 'bcrypt::BCryptHashData(p r3, p r4, i R5, i 0) i .r8 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_cleanup
        StrCmp $8 "0" native_hash_read native_hash_cleanup
      native_hash_read_failed:
        ; A synchronous regular-file EOF is normally TRUE/count zero. Also
        ; recognize a reported ERROR_HANDLE_EOF only with zero bytes read.
        StrCmp $R1 "38" 0 native_hash_cleanup
        StrCmp $R5 "0" 0 native_hash_cleanup
      native_hash_eof:
        StrCmp $R4 $R3 0 native_hash_cleanup
        !insertmacro LifeHashCheckFinalFile native_hash
        ; Reuse the read buffer only after the synchronous read has completed.
        System::Call 'bcrypt::BCryptFinishHash(p r3, p r4, i 32, i 0) i .r8 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_cleanup
        StrCmp $8 "0" 0 native_hash_cleanup
        System::Call 'crypt32::CryptBinaryToStringW(p r4, i 32, i 0x4000000c, w .R8, *i 65 R1) i .r8 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_cleanup
        StrCmp $8 "0" native_hash_cleanup
        StrCmp $R1 "64" 0 native_hash_cleanup
        StrCpy $7 $R8
        !insertmacro LifeHashNormalizeHex native_hash native_hash_invalid_hex
        Goto native_hash_cleanup
      native_hash_invalid_hex:
        StrCpy $7 "error"
        Goto native_hash_cleanup
      native_hash_unavailable:
        StrCpy $7 "unavailable"
      native_hash_cleanup:
        StrCmp $3 "0" native_hash_free_buffers
        System::Call 'bcrypt::BCryptDestroyHash(p r3) i .r8 ?r'
        Pop $R0
        StrCmp $R0 "ok" 0 native_hash_destroy_failed
        StrCmp $8 "0" native_hash_free_buffers
      native_hash_destroy_failed:
        ; BCrypt owns the object's memory. Never manually free a live object
        ; or publish a digest/fallback opportunity after destruction failed.
        StrCpy $7 "error"
      native_hash_free_buffers:
        !insertmacro LifeHashCloseFileAndBuffers native_hash
      native_hash_restore:
        StrCpy $0 $7
        StrCmp $9 "1" native_hash_restore_error
        ClearErrors
        Goto native_hash_restore_registers
      native_hash_restore_error:
        SetErrors
      native_hash_restore_registers:
        !insertmacro LifeHashRestoreRegisters
    FunctionEnd

    Function LifeHashFile
      Exch $0
      !insertmacro LifeHashSaveRegisters
      IfErrors hash_file_had_error hash_file_no_error
      hash_file_had_error:
        StrCpy $9 "1"
        Goto hash_file_begin
      hash_file_no_error:
        StrCpy $9 "0"
      hash_file_begin:
        ClearErrors
        StrCpy $1 "-1"
        StrCpy $4 "0"
        StrCpy $6 "0"
        !insertmacro LifeNativeHashFile "$0" $7
        StrCmp $7 "unavailable" hash_file_fallback hash_file_restore
      hash_file_fallback:
        StrCpy $7 "error"
        ; Recheck and hold a safe native handle throughout the complete stock
        ; rehash. Neither structural errors nor partial native hashes get here.
        !insertmacro LifeHashOpenOrdinaryFile hash_file
        ${StdUtils.HashFile} $7 "SHA2-256" "$0"
        IfErrors hash_file_invalid_hex
        !insertmacro LifeHashNormalizeHex hash_file hash_file_invalid_hex
        ; Keep the candidate private until metadata and all cleanup succeed.
        StrCpy $5 $7
        StrCpy $7 "error"
        !insertmacro LifeHashCheckFinalFile hash_file
        StrCpy $7 $5
        Goto hash_file_cleanup
      hash_file_invalid_hex:
        StrCpy $7 "error"
      hash_file_cleanup:
        !insertmacro LifeHashCloseFileAndBuffers hash_file
      hash_file_restore:
        StrCpy $0 $7
        StrCmp $9 "1" hash_file_restore_error
        ClearErrors
        Goto hash_file_restore_registers
      hash_file_restore_error:
        SetErrors
      hash_file_restore_registers:
        !insertmacro LifeHashRestoreRegisters
    FunctionEnd
  !endif
!macroend

!endif
