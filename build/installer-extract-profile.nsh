; Mirrored from app-builder-lib/templates/nsis/include/extractAppPackage.nsh.
; scripts/verify-nsis-trace.cjs requires exact stock statements after removing
; trace calls. Keep all labels, retries, error handling and fallback unchanged.
!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\7z-out"
  !insertmacro LifeInstallerTrace "extract-start"
  Nsis7z::Extract "${FILE}"
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
    !insertmacro LifeInstallerTrace "payload-complete"
!macroend
