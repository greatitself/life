Run `npm test` for unit tests and the loopback SSH integration suite. No account, API key, external machine, provider login, or inference is required.

The integration fixture opens a real encrypted `ssh2` connection on `127.0.0.1`, authenticates with a fixture password, executes deterministic local `codex` and `claude` stand-ins, and serves SFTP from temporary files. Each connection must explicitly trust the generated host fingerprint. Temporary provider programs are placed first in the fixture command path.

Coverage includes host trust and changed keys, credential redaction, stream framing and Unicode, command quoting, workspace confinement including symlinks, preview limits, terminal input and SSH PTY/resize requests, both provider permission and question protocols, interruptions, remote session resumption, crashed-process restart, and provider failures.

The fixture accepts SSH PTY requests but runs its shell through pipes; it does not allocate a native pseudoterminal or verify terminal control sequences. Fake providers validate the desktop's protocol behavior against deterministic messages; actual upstream provider releases and login flows still require testing on a real SSH machine.

For UI smoke tests, import `SSHFixture` from `helpers/ssh-fixture.ts`, call `await new SSHFixture().start()`, and use `fixture.input()` for the connection form. `fixture.log()` returns captured provider arguments and wire messages. Call `await fixture.close()` to terminate fixture processes and remove temporary files. The optional constructor argument points to an absolute `fixtures/fake-provider.cjs` path when running outside the repository root.
