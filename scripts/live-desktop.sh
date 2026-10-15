#!/usr/bin/env bash
# A private native Electron desktop, displayed in a browser through noVNC.
# The renderer's Vite server is separate and is never stopped by this launcher.
set -euo pipefail
umask 077

repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
native_app_root=${LIFE_DESKTOP_APP_ROOT:-"$repository"}
[[ "$native_app_root" == /* && -d "$native_app_root" ]] || {
  echo "LIFE_DESKTOP_APP_ROOT must be an existing absolute directory." >&2
  exit 1
}
native_app_root=$(cd -- "$native_app_root" && pwd -P)
runtime=${LIFE_DESKTOP_RUNTIME:-"$HOME/.local/share/life-feedback-runtime"}
profile=${LIFE_DESKTOP_CONFIG_HOME:-"$HOME/.local/share/life-feedback"}
web_port=${LIFE_DESKTOP_PORT:-6082}
vnc_port=${LIFE_DESKTOP_VNC_PORT:-5903}
renderer=${LIFE_DESKTOP_RENDERER_URL:-http://127.0.0.1:5173}
debug_port=${LIFE_DESKTOP_DEBUG_PORT:-0}
python="$runtime/venv/bin/python3"
novnc="$runtime/noVNC"
electron="$repository/node_modules/electron/dist/electron"

for executable in Xvnc xauth setsid curl python3; do
  command -v "$executable" >/dev/null || { echo "Missing dependency: $executable" >&2; exit 1; }
done
[[ -x "$python" && -f "$novnc/vnc.html" ]] || {
  echo "Install the private noVNC runtime first; see docs/live-desktop-feedback.md." >&2
  exit 1
}
[[ -x "$electron" && -f "$native_app_root/out/main/index.js" ]] || {
  echo "Install checkout dependencies and provide a built native app at $native_app_root." >&2
  exit 1
}
"$python" -c 'import websockify' || exit 1
# Refuse occupied ports. This never reuses or terminates another desktop.
"$python" - "$web_port" "$vnc_port" "$debug_port" <<'PY'
import socket, sys
ports = []
for index, value in enumerate(sys.argv[1:]):
    try:
        port = int(value)
    except ValueError:
        raise SystemExit('Desktop ports must be integers.')
    if port == 0 and index == 2:
        continue
    if not 1 <= port <= 65535 or port in ports:
        raise SystemExit('Desktop ports must be distinct integers from 1 to 65535.')
    ports.append(port)
    with socket.socket() as probe:
        # Closed development sessions can leave TIME_WAIT connections behind.
        # Match a server's reusable bind while still rejecting live listeners.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
            probe.listen(1)
        except OSError:
            raise SystemExit(f'Port {port} is occupied; choose another LIFE_DESKTOP port. Existing services were preserved.')
PY
curl --fail --silent --connect-timeout 1 --max-time 2 --output /dev/null "$renderer/" || {
  echo "Start node scripts/live-preview.mjs first ($renderer is unavailable)." >&2
  exit 1
}

display_number=${LIFE_DESKTOP_DISPLAY:-}
if [[ -z "$display_number" ]]; then
  for candidate in $(seq 102 199); do
    if [[ ! -e "/tmp/.X$candidate-lock" && ! -e "/tmp/.X11-unix/X$candidate" ]]; then
      display_number=$candidate
      break
    fi
  done
fi
[[ "$display_number" =~ ^[0-9]+$ ]] || { echo "No free private X display." >&2; exit 1; }
[[ ! -e "/tmp/.X$display_number-lock" && ! -e "/tmp/.X11-unix/X$display_number" ]] || {
  echo "Display :$display_number is occupied. Existing desktop was preserved." >&2
  exit 1
}
mkdir -p "$runtime/logs" "$profile"
session=$(mktemp -d "$runtime/logs/session-XXXXXXXX")
authority="$session/Xauthority"
touch "$authority"
cookie=$("$python" -c 'import secrets; print(secrets.token_hex(16))')
xauth -f "$authority" add ":$display_number" MIT-MAGIC-COOKIE-1 "$cookie"
unset cookie
children=()
electron_pid=''
cleanup() {
  trap - EXIT INT TERM
  # Every group was created by this invocation with setsid. Never kill by name.
  for pid in "${children[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for attempt in $(seq 1 40); do
    alive=false
    for pid in "${children[@]}"; do
      if kill -0 -- "-$pid" 2>/dev/null; then alive=true; fi
    done
    [[ "$alive" == false ]] && break
    sleep 0.1
  done
  for pid in "${children[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  for pid in "${children[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -f -- "$authority"
  echo "Life desktop stopped. Saved profile remains at $profile; logs: $session"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# This host's Xvnc crashes in ShmDestroyPixmap during screen teardown after
# its SHM screen private is cleared. Disable that extension on this display.
setsid Xvnc ":$display_number" -geometry 1920x1080 -depth 24 -extension MIT-SHM \
  -auth "$authority" -nolisten tcp -localhost -interface 127.0.0.1 \
  -UseIPv6=0 -SecurityTypes None -AlwaysShared -rfbport "$vnc_port" \
  -desktop 'Life native feedback' >"$session/display.log" 2>&1 &
display_pid=$!
children+=("$display_pid")
"$python" - "$vnc_port" <<'PY'
import socket, sys, time
for attempt in range(100):
    try:
        with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=.2) as probe:
            if probe.recv(12).startswith(b'RFB '):
                break
    except OSError:
        pass
    time.sleep(.05)
else:
    raise SystemExit('Private VNC display failed to start; inspect display.log.')
PY

electron_arguments=("$native_app_root")
# Root needs this Chromium launch flag in this development host. Life's own
# sandbox/contextIsolation/nodeIntegration settings are unchanged.
[[ $(id -u) == 0 ]] && electron_arguments+=(--no-sandbox)
if [[ "$debug_port" != 0 ]]; then
  electron_arguments+=("--remote-debugging-port=$debug_port" --remote-debugging-address=127.0.0.1)
fi
setsid env -u ELECTRON_RUN_AS_NODE DISPLAY=":$display_number" XAUTHORITY="$authority" \
  XDG_CONFIG_HOME="$profile" ELECTRON_RENDERER_URL="$renderer" \
  "$electron" "${electron_arguments[@]}" >"$session/electron.log" 2>&1 &
electron_pid=$!
children+=("$electron_pid")

setsid "$python" -m websockify --web "$novnc" \
  "127.0.0.1:$web_port" "127.0.0.1:$vnc_port" >"$session/websockify.log" 2>&1 &
web_pid=$!
children+=("$web_pid")
ready=false
for attempt in $(seq 1 100); do
  if curl --fail --silent --connect-timeout 1 --max-time 2 --output /dev/null "http://127.0.0.1:$web_port/vnc.html"; then
    ready=true
    break
  fi
  sleep 0.05
done
[[ "$ready" == true ]] || { echo "noVNC failed to start; inspect $session/websockify.log." >&2; exit 1; }
kill -0 "$electron_pid" || { echo "Electron exited; inspect $session/electron.log." >&2; exit 1; }
cat <<EOF
Life native browser desktop is running.
Browser: http://localhost:$web_port/vnc.html?autoconnect=true&resize=scale&reconnect=true
Native app: $native_app_root
Launcher checkout: $repository
Renderer: $renderer (Vite hot reload; this launcher does not own that server)
Profile: $profile (persistent; never deleted by this launcher)
Display: :$display_number; loopback VNC: $vnc_port; loopback browser: $web_port
Launcher PID: $$; Electron PID: $electron_pid; display PID: $display_pid; websockify PID: $web_pid
Logs: $session
Close Life normally before stopping the launcher to flush current history.
Stop: Ctrl+C here, or kill -TERM $$
EOF
wait -n "${children[@]}"
