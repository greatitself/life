# Life 0.13.1

Life 0.13.1 fixes the release-blocking test failures from 0.13.0.

- Retire an idle Local provider opening only after its original broker handshake establishes native input-delivery support. The opening cannot initialize a replacement provider while retirement is pending. Switching environments still requires the original close delivery and actual provider exit; uncertain native input remains protected.
- Observe Studio keyboard-focus restoration after the dialog close event, preserving the assertion that focus returns to its opener at every supported test viewport.

The release pipeline requires successful verification of the exact source commit before installer publication. Typecheck, unit/integration tests, the production build, browser/Electron workflows, native fixtures, packaged compatibility, and Windows upgrade results are recorded in GitHub Actions. Fixture checks do not establish authenticated upstream-provider behavior.

The platform and experimental active-session-recovery limits described in 0.13.0 still apply. Windows supports SSH environments; native Local execution and active-session recovery require POSIX facilities. Windows and macOS packages use the existing unsigned policy.
