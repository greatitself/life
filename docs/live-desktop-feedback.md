# Full Life in a laptop browser

This runs the real Electron app on its own private Linux display and streams its screen and input through noVNC. Life keeps its native preload bridge, SSH service, Codex and Claude Code protocols, terminal, permission dialogs, and saved history. The browser receives the Electron screen; the renderer uses the checkout's Vite server for hot reload.

From the laptop, forward the desktop port to this development host:

```bash
ssh -N -L 6082:127.0.0.1:6082 <your-development-host>
```

Open [Life in your laptop browser](http://localhost:6082/vnc.html?autoconnect=true&resize=scale&reconnect=true). A fresh profile opens **Local**, using the Linux development host running Electron. Choose a project there, or select an SSH environment to work on another machine. Local uses that host's installed CLIs and account configuration; it does not access your laptop's CLIs or files. SSH private key paths and native file dialogs also refer to the host running Electron. No inference request starts simply by opening the desktop.

The renderer and desktop can be started separately from the checkout:

```bash
node scripts/live-preview.mjs
# In a second terminal:
bash scripts/live-desktop.sh
```

The launcher prints the browser URL, owned process IDs, and log directory. It refuses occupied ports and displays. This host already has unrelated services on 6080 and 6081, which must remain untouched. Life uses a 1920 × 1080 desktop, loopback 6082, and private VNC 5903 by default. Only 6082 needs forwarding to the laptop; 5173 stays inside the host.

Renderer edits hot reload while the Electron backend remains running. Main-process or preload changes require a deliberate rebuild and desktop restart: finish active turns, close Life normally, stop the desktop launcher, run `npm run build`, and run the launcher again. The preview server can stay running. The launcher never watches or restarts native services automatically.

`LIFE_DESKTOP_APP_ROOT` can select a separate verified native build while the renderer continues to hot reload from the checkout. It must name an existing absolute directory containing the app's package files and built `out/main/index.js`. The Electron executable remains the checkout's installed binary. The launcher prints both the native app directory and the launcher checkout so the running native build is clear. If this override points to a frozen build, deliberately update that build or choose a newly verified app directory before restarting.

Saved connections and conversation history persist under `~/.local/share/life-feedback/Life/`. The enclosing `~/.local/share/life-feedback` is used as `XDG_CONFIG_HOME` on every launch. Closing or restarting the launcher never deletes this directory. Close Life normally before stopping the launcher so its native close handler flushes the latest conversation state. Logs remain under `~/.local/share/life-feedback-runtime/logs/`.

The browser proxy and VNC listener bind to `127.0.0.1`. Use the SSH tunnel to reach them. X11 uses a private authorization cookie and disables its TCP listener. Each launcher invocation owns its process groups and only stops those groups on exit; it leaves the Vite server and other desktops running.

The private display disables MIT-SHM to avoid this host's Xvnc teardown crash. The saved core dumps from the live desktop and two shutdown fixtures all showed `ShmDestroyPixmap → PictureCloseScreen → present_close_screen → CursorCloseScreen`. The [X server's SHM implementation](https://github.com/mirror/xserver/blob/master/Xext/shm.c) installs the crashing pixmap wrapper when that extension initializes. This launcher flag applies only to Life's private display.

## Runtime setup

This host already provides TigerVNC's `Xvnc`, `xauth`, `setsid`, Python 3, and curl. On another Linux host, install those through its package manager. Life's repository dependencies and built main/preload files must already exist.

Install the browser transport outside the repository so package files and lockfiles remain unchanged:

```bash
mkdir -p ~/.local/share/life-feedback-runtime
python3 -m venv ~/.local/share/life-feedback-runtime/venv
~/.local/share/life-feedback-runtime/venv/bin/pip install websockify==0.13.0
git clone --depth 1 --branch v1.7.0 https://github.com/novnc/noVNC.git \
  ~/.local/share/life-feedback-runtime/noVNC
```

The transport uses the official [noVNC](https://github.com/novnc/noVNC) browser client, [websockify](https://github.com/novnc/websockify) proxy, and installed [TigerVNC](https://tigervnc.org/) server.

Optional environment overrides are `LIFE_DESKTOP_APP_ROOT`, `LIFE_DESKTOP_PORT`, `LIFE_DESKTOP_VNC_PORT`, `LIFE_DESKTOP_DISPLAY`, `LIFE_DESKTOP_RUNTIME`, `LIFE_DESKTOP_CONFIG_HOME`, and `LIFE_DESKTOP_RENDERER_URL`. `LIFE_DESKTOP_DEBUG_PORT` enables an additional loopback Chromium inspection port for an explicit debugging session; its default is disabled.
