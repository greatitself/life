; Mirrored from app-builder-lib/templates/nsis/include/extractAppPackage.nsh.
; scripts/verify-nsis-trace.cjs requires exact stock statements after removing
; trace and payload verification calls. All upstream retry/fallback behavior is
; retained for nonempty targets and uncertain environments.
!macro LifeStockExtractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\7z-out"
  !insertmacro LifeInstallerTrace "extract-start"
  Nsis7z::Extract "${FILE}"
  !insertmacro LifeRequireVerifiedStagedPayload "$PLUGINSDIR\7z-out"
  !insertmacro LifeInstallerTrace "extract-complete"
  Pop $R0
  SetOutPath $R0

  # Retry counter
  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1

    # Attempt to copy files in atomic way
    !insertmacro LifeInstallerTrace "payload-copy-start"
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
    !insertmacro LifeInstallerTrace "payload-copy-complete"
    IfErrors 0 DoneExtract7za

    DetailPrint `Can't modify "${PRODUCT_NAME}"'s files.`
    ${if} $R1 < 5
      # Try copying a few times before asking for a user action.
      Goto RetryExtract7za
    ${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    ${endIf}

    # As an absolutely last resort after a few automatic attempts and user
    # intervention - we will just overwrite everything with `Nsis7z::Extract`
    # even though it is not atomic and will ignore errors.

    # Clear the temporary folder first to make sure we don't use twice as
    # much disk space.
    !insertmacro LifeInstallerTrace "extract-fallback-cleanup-start"
    RMDir /r "$PLUGINSDIR\7z-out"
    !insertmacro LifeInstallerTrace "extract-fallback-cleanup-complete"

    !insertmacro LifeInstallerTrace "extract-fallback-start"
    Nsis7z::Extract "${FILE}"
    !insertmacro LifeInstallerTrace "extract-fallback-complete"
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
    !insertmacro LifeRequireVerifiedPayload "$INSTDIR"
    !insertmacro LifeInstallerTrace "payload-complete"
!macroend

!macro extractUsing7za FILE
  Push "$INSTDIR"
  Call LifeEmptyPayloadDirectory
  Pop $lifePayloadVerified
  ${if} $lifePayloadVerified == "2"
    !insertmacro LifeRejectUnsafePayloadDirectory
  ${endif}
  ; Inspect every expected destination before the first write, including paths
  ; that will be merged by the unchanged fallback copy routine.
  Push $lifePayloadVerified
  !insertmacro LifePreflightSelectedPayload "$INSTDIR" $lifePayloadVerified
  ${if} $lifePayloadVerified != "1"
    Pop $lifePayloadVerified
    !insertmacro LifeRejectUnsafePayloadDirectory
  ${endif}
  Pop $lifePayloadVerified
  ${if} $lifePayloadVerified == "1"
    !insertmacro LifeInstallerTrace "payload-direct-start"
    !insertmacro LifeInstallerTrace "extract-start"
    Nsis7z::Extract "${FILE}"
    !insertmacro LifeInstallerTrace "extract-complete"
    !insertmacro LifeInstallerTrace "payload-verification-start"
    !insertmacro LifeVerifySelectedStagedPayload "$INSTDIR" $lifePayloadVerified
    !insertmacro LifeInstallerTrace "payload-verification-complete"
    ${if} $lifePayloadVerified == "1"
      !insertmacro LifeInstallerTrace "payload-direct-complete"
      !insertmacro LifeInstallerTrace "payload-complete"
      Goto LifeExtractComplete
    ${else}
      ; A failed direct extraction never registers or launches the application.
      ; Re-extract into the stock stage, verify it before copying, and retain
      ; every original copy retry and final installed-payload verification.
      !insertmacro LifeInstallerTrace "payload-direct-fallback"
    ${endif}
  ${endif}
  !insertmacro LifeStockExtractUsing7za "${FILE}"
  LifeExtractComplete:
!macroend
