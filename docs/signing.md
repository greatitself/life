# Signing Life releases later

Signing is deferred until the owner provides the required accounts and credentials. Current Life releases remain unsigned. This document records the setup for a future signing change; adding secrets alone does not enable signing in the current release workflow.

## Windows

A publicly trusted Authenticode signature identifies the publisher. SmartScreen also evaluates reputation, so a newly signed `.exe` may still display “Windows protected your PC.” EV certificates no longer provide an immediate bypass. Signing cannot guarantee that every Windows device allows an application: organizational policy and Smart App Control also apply. [Microsoft’s current SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Choose an existing signing credential or an eligible cloud signing service:

| Route                                        | Credentials to prepare                                                                                                                          | Public configuration                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Existing exportable code-signing certificate | `WIN_CSC_LINK`: base64 PFX containing its private key; `WIN_CSC_KEY_PASSWORD`: its password                                                     | Exact certificate publisher name; RFC 3161 timestamp service                            |
| Azure Artifact Signing                       | Existing identity-validated **Public Trust** profile; `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` for an authorized application | Verified publisher CN, regional endpoint, signing account and certificate profile names |

Newly issued certificates may require a hardware or cloud key, so do not assume the certificate can be exported as a PFX. Artifact Signing has eligibility requirements and requires the certificate-profile signer role. Its short-lived certificates need timestamps; retain a consistent publisher identity rather than pinning a rotating leaf certificate. [Microsoft signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [Artifact Signing prerequisites](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [certificate management](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management).

Life currently uses electron-builder **26.17**. Future configuration must use `win.signtoolOptions` or `win.azureSignOptions`, with `win.forceCodeSigning: true` and `win.verifyUpdateCodeSignature: true`. Current unversioned documentation describes a newer signing schema; use the [v26 Windows documentation](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

Before publishing a signed release, require all of the following:

- The installer and installed `Life.exe` pass `Get-AuthenticodeSignature` with `Status = Valid`, the expected publisher, and a timestamp certificate.
- `signtool verify /pa /all /v /tw` succeeds for both executables.
- Packaged `resources/app-update.yml` contains the expected `publisherName`, so future updates verify that publisher.
- The existing Windows upgrade test still passes. Keep `appId: dev.life.desktop` and the installation identity unchanged.

[PowerShell signature verification](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature), [SignTool verification](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).

## macOS

Prepare a **Developer ID Application** certificate with its private key from an Apple Developer account. Use `CSC_LINK` for the base64 `.p12` and `CSC_KEY_PASSWORD` for its password. Choose one notarization credential group:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or
- A private App Store Connect `.p8` key, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Decode the key to a temporary file and set `APPLE_API_KEY` to its absolute path; v26 expects a file path, not base64 contents.

Store private credentials in repository Actions secrets. Leave the unused notarization group unset. [v26 signing variables](https://www.electron.build/v26/docs/features/code-signing/), [official Electron notarization credentials](https://github.com/electron/notarize#usage-with-app-store-connect-api-key).

Future macOS configuration needs `mac.forceCodeSigning: true`, `mac.hardenedRuntime: true`, `mac.notarize: true`, and explicit main/inherited entitlement files allowing JIT for Electron. Avoid adding broader executable-memory or library-validation exceptions without a demonstrated need. Missing notarization credentials can cause builder to skip notarization, so a signed-release workflow must check credentials and verify the final artifacts. [Electron notarization prerequisites](https://github.com/electron/notarize#prerequisites), [v26 macOS options](https://www.electron.build/v26/docs/mac/).

Verify the final application:

```bash
codesign --verify --deep --strict --verbose=2 "path/to/Life.app"
codesign --display --verbose=4 "path/to/Life.app"
spctl --assess --type execute --verbose=4 "path/to/Life.app"
xcrun stapler validate "path/to/Life.app"
```

Require the intended Developer ID authority/team, hardened runtime, timestamp, notarized Gatekeeper assessment and valid staple. Also sign, notarize and staple the final DMG; notarizing the application alone does not staple its container. Finalize checksums, updater metadata and any blockmaps **after** these steps change artifact bytes. Signed Mac updates also require the ZIP update payload. [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Apple distribution containers](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).

## Linux

Linux does not use Windows SmartScreen or Apple Gatekeeper. Distribution and administrator policies can still restrict execution; executable permissions, AppImage runtime dependencies and Electron sandbox compatibility are separate concerns. Current Life AppImage and `.deb` downloads include SHA-256 checksums, without a publisher signature or signed APT repository. A checksum alone does not establish publisher identity.

Future AppImage signing needs an owner-controlled signing key and independent verification. Debian repository authentication normally uses signed repository metadata and a trusted archive key; it is separate from Windows and macOS certificates. No Linux signing key or repository has been provisioned. [AppImage signatures](https://docs.appimage.org/packaging-guide/optional/signatures.html), [Debian archive authentication](https://manpages.debian.org/stable/apt/apt-secure.8.en.html).
