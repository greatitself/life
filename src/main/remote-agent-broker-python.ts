/** Python 3 fallback for the durable SSH provider transport. Uses stdlib only. */
export const REMOTE_AGENT_BROKER_PYTHON_SOURCE = String.raw`
_LIFE_BROKER_PROGRAM = r'''
import base64
import collections
import errno
import hashlib
import hmac
import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time

MAX_INPUT = 24 * 1024 * 1024
MAX_BUFFER = 32 * 1024 * 1024

def encoded(value):
    return (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")

def emit(value):
    sys.stdout.buffer.write(encoded(value))
    sys.stdout.buffer.flush()

def read_json(file):
    try:
        with open(file, "r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return None

def save_json(file, value):
    temporary = file + "." + str(os.getpid()) + ".tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded(value))
            stream.flush()
        os.replace(temporary, file)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

def create_json(file, value):
    temporary = file + "." + str(os.getpid()) + ".new"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, file)
    finally:
        os.unlink(temporary)

def alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as error:
        return error.errno == errno.EPERM

def integer(value, minimum=0):
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= 9007199254740991

def terminal_record(file):
    try:
        with open(file, "rb") as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(max(0, size - 128 * 1024))
            lines = stream.read().rstrip().split(b"\n")
        last = json.loads(lines[-1])
        return last if last.get("type") == "exit" and integer(last.get("cursor"), 1) else None
    except (OSError, ValueError, IndexError, AttributeError):
        return None

def replay(file, after, high_water):
    try:
        stream = open(file, "rb")
    except FileNotFoundError:
        return
    with stream:
        for line in stream:
            try:
                frame = json.loads(line)
            except ValueError:
                continue
            cursor = frame.get("cursor")
            if not integer(cursor, 1) or cursor <= after:
                continue
            if cursor > high_water:
                break
            yield frame

class Client:
    def __init__(self, connection):
        self.connection = connection
        self.condition = threading.Condition()
        self.queue = collections.deque()
        self.bytes = 0
        self.closed = False
        self.finishing = False
        self.replaying = True
        self.pending = []
        self.pending_bytes = 0
        threading.Thread(target=self.write_loop, daemon=True).start()

    def send(self, frame, wait=False):
        data = encoded(frame)
        deadline = time.monotonic() + 30
        with self.condition:
            while not self.closed and self.bytes + len(data) > MAX_BUFFER:
                if not wait or time.monotonic() >= deadline:
                    self.close()
                    return False
                self.condition.wait(0.2)
            if self.closed:
                return False
            self.queue.append(data)
            self.bytes += len(data)
            self.condition.notify_all()
            return True

    def finish(self):
        with self.condition:
            self.finishing = True
            self.condition.notify_all()

    def close(self):
        with self.condition:
            if self.closed:
                return
            self.closed = True
            self.queue.clear()
            self.bytes = 0
            self.condition.notify_all()
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()

    def write_loop(self):
        try:
            while True:
                with self.condition:
                    while not self.closed and not self.queue and not self.finishing:
                        self.condition.wait()
                    if self.closed or (self.finishing and not self.queue):
                        break
                    data = self.queue.popleft()
                    self.bytes -= len(data)
                    self.condition.notify_all()
                self.connection.sendall(data)
        except OSError:
            pass
        finally:
            self.close()

def daemon(cfg, root, config_path, state_path, journal_path, lock_path, owner_path, socket_path):
    persisted = read_json(config_path)
    if not persisted or persisted.get("id") != cfg["id"] or not hmac.compare_digest(str(persisted.get("token", "")), str(cfg.get("token", ""))):
        raise RuntimeError("The remote agent daemon could not verify its session.")
    os.chmod(root, 0o700)
    save_json(owner_path, {"pid": os.getpid(), "token": cfg["token"]})
    mutex = threading.RLock()
    clients = set()
    connections = set()
    queued = {}
    input_condition = threading.Condition()
    inputs = collections.deque()
    input_bytes = [0]
    state = {"id": cfg["id"], "pid": None, "brokerPid": os.getpid(), "cursor": 0, "lastInputSequence": 0, "exited": False}
    status = {"ended": False, "closing": False, "queuedBytes": 0, "exitDeadline": None, "finishedAt": None}
    journal_fd = os.open(journal_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.fchmod(journal_fd, 0o600)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    provider = None

    def publish(frame):
        with mutex:
            if status["ended"] and frame["type"] != "exit":
                return
            state["cursor"] += 1
            frame["cursor"] = state["cursor"]
            data = encoded(frame)
            offset = 0
            while offset < len(data):
                offset += os.write(journal_fd, data[offset:])
            for client in list(clients):
                if client.closed:
                    continue
                if client.replaying:
                    client.pending.append(frame)
                    client.pending_bytes += len(data)
                    if client.pending_bytes > MAX_BUFFER:
                        client.close()
                else:
                    client.send(frame)

    def kill_provider(name):
        if provider is None or status["ended"]:
            return
        try:
            os.killpg(provider.pid, getattr(signal, name))
        except ProcessLookupError:
            pass

    def shutdown():
        with mutex:
            if status["ended"] or status["closing"]:
                return
            status["closing"] = True
            queued.clear()
            status["queuedBytes"] = 0
            with input_condition:
                inputs.clear()
                input_bytes[0] = 0
                input_condition.notify_all()
            kill_provider("SIGTERM")
            timer = threading.Timer(5, lambda: kill_provider("SIGKILL"))
            timer.daemon = True
            timer.start()
            forced = threading.Timer(6, lambda: finish_provider(provider.poll(), "SIGTERM"))
            forced.daemon = True
            forced.start()

    def input_loop():
        try:
            while True:
                with input_condition:
                    while not inputs and not status["ended"] and not status["closing"]:
                        input_condition.wait()
                    if status["ended"] or status["closing"]:
                        return
                    data = inputs.popleft()
                    if data is not None:
                        input_bytes[0] -= len(data)
                if data is None:
                    provider.stdin.close()
                    return
                offset = 0
                while offset < len(data):
                    offset += os.write(provider.stdin.fileno(), data[offset:])
        except (OSError, ValueError) as error:
            if not status["closing"] and not status["ended"]:
                publish({"type": "stderr", "data": base64.b64encode((str(error) + "\n").encode()).decode()})

    def apply(frame, waiters):
        state["lastInputSequence"] = frame["sequence"]
        save_json(state_path, state)
        if frame["type"] == "write":
            data = base64.b64decode(frame["data"], validate=True)
            with input_condition:
                inputs.append(data)
                input_bytes[0] += len(data)
                input_condition.notify_all()
        elif frame["type"] == "end":
            with input_condition:
                inputs.append(None)
                input_condition.notify_all()
        elif frame["type"] == "signal":
            kill_provider(frame["signal"])
        elif frame["type"] == "close":
            shutdown()
        for waiter in waiters:
            waiter.send({"type": "ack", "sequence": frame["sequence"]})

    def receive(client, frame):
        if not isinstance(frame, dict) or not integer(frame.get("sequence"), 1):
            raise ValueError("Invalid remote agent input sequence.")
        kind = frame.get("type")
        if kind not in ("write", "signal", "end", "close"):
            raise ValueError("Unknown remote agent command.")
        if kind == "write":
            value = frame.get("data")
            if not isinstance(value, str) or len(value) > MAX_INPUT - 1024:
                raise ValueError("Invalid remote agent input data.")
            try:
                base64.b64decode(value, validate=True)
            except (ValueError, base64.binascii.Error):
                raise ValueError("Invalid remote agent input data.")
        if kind == "signal":
            name = frame.get("signal")
            if isinstance(name, str) and not name.startswith("SIG"):
                name = "SIG" + name
            if name not in ("SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"):
                raise ValueError("Invalid remote agent signal.")
            frame["signal"] = name
        with mutex:
            sequence = frame["sequence"]
            if sequence <= state["lastInputSequence"]:
                client.send({"type": "ack", "sequence": sequence})
                return
            if status["ended"] or status["closing"]:
                raise ValueError("The remote agent session has ended.")
            if kind == "close":
                apply(frame, {client})
                return
            if sequence in queued:
                entry = queued[sequence]
                if entry[0] != frame:
                    raise ValueError("Conflicting remote agent input sequence.")
                entry[2].add(client)
            else:
                size = len(encoded(frame))
                if len(queued) >= 1024 or status["queuedBytes"] + input_bytes[0] + size > MAX_BUFFER:
                    raise ValueError("The remote agent input queue is full.")
                queued[sequence] = (frame, size, {client})
                status["queuedBytes"] += size
            while state["lastInputSequence"] + 1 in queued and not status["ended"] and not status["closing"]:
                entry = queued.pop(state["lastInputSequence"] + 1)
                status["queuedBytes"] -= entry[1]
                apply(entry[0], entry[2])

    def replay_client(client, after, high_water):
        try:
            for frame in replay(journal_path, after, high_water):
                if not client.send(frame, wait=True):
                    return
            terminal = terminal_record(journal_path)
            if terminal and terminal["cursor"] <= high_water and after >= terminal["cursor"]:
                if not client.send(terminal, wait=True):
                    return
            while not client.closed:
                with mutex:
                    pending = client.pending
                    client.pending = []
                    client.pending_bytes = 0
                    if not pending:
                        client.replaying = False
                        if status["ended"]:
                            client.finish()
                        return
                for frame in pending:
                    if not client.send(frame, wait=True):
                        return
        except (OSError, ValueError):
            client.close()

    def client_loop(connection):
        client = Client(connection)
        authenticated = False
        buffer = b""
        connection.settimeout(1)
        auth_deadline = time.monotonic() + 5
        try:
            while not client.closed:
                try:
                    data = connection.recv(65536)
                except socket.timeout:
                    if not authenticated and time.monotonic() >= auth_deadline:
                        break
                    continue
                if not data:
                    break
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if len(line) > MAX_INPUT:
                        raise ValueError("The remote agent command exceeded the transport limit.")
                    if not line:
                        continue
                    frame = json.loads(line)
                    if not authenticated:
                        if not isinstance(frame, dict) or frame.get("type") != "attach" or frame.get("id") != cfg["id"] or not isinstance(frame.get("token"), str) or not hmac.compare_digest(frame["token"], cfg["token"]):
                            return
                        authenticated = True
                        after = frame.get("cursor") if integer(frame.get("cursor")) else 0
                        with mutex:
                            clients.add(client)
                            high_water = state["cursor"]
                            client.send({"type": "ready", "pid": provider.pid, "cursor": high_water, "lastInputSequence": state["lastInputSequence"]})
                        threading.Thread(target=replay_client, args=(client, after, high_water), daemon=True).start()
                    else:
                        try:
                            receive(client, frame)
                        except (ValueError, OSError) as error:
                            client.send({"type": "error", "message": str(error)})
                if len(buffer) > MAX_INPUT:
                    break
        except (OSError, ValueError):
            pass
        finally:
            client.close()
            with mutex:
                clients.discard(client)
                connections.discard(connection)

    def output_loop(stream, kind):
        try:
            while True:
                data = os.read(stream.fileno(), 16384)
                if not data:
                    return
                publish({"type": kind, "data": base64.b64encode(data).decode("ascii")})
        finally:
            stream.close()

    def finish_provider(code, fallback_signal=None):
        with mutex:
            if status["ended"]:
                return
            status["ended"] = True
            publish({"type": "exit", "code": code if code is not None and code >= 0 else None, "signal": signal.Signals(-code).name if code is not None and code < 0 else fallback_signal})
            os.fsync(journal_fd)
            state["exited"] = True
            save_json(state_path, state)
            status["exitDeadline"] = time.monotonic() + 12
            status["finishedAt"] = time.monotonic()
            for client in list(clients):
                if not client.replaying:
                    client.finish()
            with input_condition:
                input_condition.notify_all()

    def wait_provider(readers):
        code = provider.wait()
        for reader in readers:
            reader.join()
        finish_provider(code)

    try:
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass
        server.bind(socket_path)
        os.chmod(socket_path, 0o600)
        provider = subprocess.Popen(["/bin/sh", "-c", persisted["command"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
        state["pid"] = provider.pid
        save_json(state_path, state)
        readers = [threading.Thread(target=output_loop, args=(provider.stdout, "stdout"), daemon=True), threading.Thread(target=output_loop, args=(provider.stderr, "stderr"), daemon=True)]
        for reader in readers:
            reader.start()
        threading.Thread(target=input_loop, daemon=True).start()
        threading.Thread(target=wait_provider, args=(readers,), daemon=True).start()
        signal.signal(signal.SIGTERM, lambda *_: shutdown())
        signal.signal(signal.SIGINT, lambda *_: shutdown())
        server.listen(16)
        server.settimeout(0.2)
        while True:
            with mutex:
                if status["ended"] and ((not connections and time.monotonic() - status["finishedAt"] >= 0.5) or time.monotonic() >= status["exitDeadline"]):
                    break
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            with mutex:
                connections.add(connection)
            threading.Thread(target=client_loop, args=(connection,), daemon=True).start()
    finally:
        server.close()
        if provider is not None and not status["ended"]:
            kill_provider("SIGKILL")
        for client in list(clients):
            client.close()
        os.close(journal_fd)
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass
        owner = read_json(owner_path)
        if owner and owner.get("pid") == os.getpid() and owner.get("token") == cfg["token"]:
            try:
                os.unlink(owner_path)
                os.rmdir(lock_path)
            except FileNotFoundError:
                pass

def attachment(cfg, root, config_path, state_path, journal_path, lock_path, owner_path, socket_path):
    missing = "The remote agent session is no longer available. It was not restarted and no prompt was replayed."
    if cfg.get("launch") is False and not os.path.isdir(root):
        raise RuntimeError(missing)
    if os.path.islink(root):
        raise RuntimeError("The remote agent session directory must not be a symbolic link.")
    os.makedirs(root, mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)
    connection = None
    persisted = None
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        persisted = read_json(config_path)
        if persisted and persisted.get("id") != cfg["id"]:
            raise RuntimeError("The remote agent session directory belongs to another session.")
        candidate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        candidate.settimeout(1)
        try:
            candidate.connect(socket_path)
            connection = candidate
            break
        except OSError:
            candidate.close()
        terminal = terminal_record(journal_path)
        if terminal:
            if not persisted:
                raise RuntimeError("The remote agent session could not verify its journal identity.")
            saved = read_json(state_path) or {}
            emit({"type": "ready", "pid": saved.get("pid"), "cursor": terminal["cursor"], "lastInputSequence": saved.get("lastInputSequence", 0)})
            for frame in replay(journal_path, cfg["cursor"], terminal["cursor"]):
                emit(frame)
            if cfg["cursor"] >= terminal["cursor"]:
                emit(terminal)
            return
        owner = read_json(owner_path)
        if owner and alive(owner.get("pid")):
            time.sleep(0.05)
            continue
        if os.path.lexists(lock_path):
            if os.path.islink(lock_path):
                raise RuntimeError("The remote agent session lock must not be a symbolic link.")
            age = time.time() - os.stat(lock_path).st_mtime
            if (not owner and age < 15) or (owner and age < 2):
                time.sleep(0.05)
                continue
            try:
                os.unlink(owner_path)
            except FileNotFoundError:
                pass
            os.rmdir(lock_path)
        if persisted or cfg.get("launch") is False:
            raise RuntimeError(missing)
        if os.path.exists(journal_path) or os.path.exists(state_path):
            raise RuntimeError("The remote agent session directory contains an unidentified session. No provider was started.")
        try:
            os.mkdir(lock_path, 0o700)
        except FileExistsError:
            time.sleep(0.05)
            continue
        save_json(owner_path, {"pid": os.getpid()})
        persisted = {"id": cfg["id"], "command": cfg["command"], "token": os.urandom(32).hex()}
        create_json(config_path, persisted)
        descriptor = os.open(journal_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        os.close(descriptor)
        daemon_config = dict(cfg, **persisted)
        daemon_config["mode"] = "daemon"
        daemon_source = "_LIFE_BROKER_PROGRAM = " + repr(_LIFE_BROKER_PROGRAM) + "\nexec(_LIFE_BROKER_PROGRAM)"
        descriptor = os.open(os.path.join(root, "broker.log"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            child = subprocess.Popen([sys.executable, "-c", daemon_source, base64.b64encode(json.dumps(daemon_config).encode()).decode()], stdin=subprocess.DEVNULL, stdout=descriptor, stderr=descriptor, start_new_session=True, close_fds=True)
            try:
                save_json(owner_path, {"pid": child.pid, "token": persisted["token"]})
            except FileNotFoundError:
                if not terminal_record(journal_path):
                    raise
        finally:
            os.close(descriptor)
        time.sleep(0.025)
    if connection is None or not persisted or not isinstance(persisted.get("token"), str):
        if connection is not None:
            connection.close()
        raise RuntimeError("The remote agent session could not be attached within 15 seconds.")
    connection.settimeout(None)
    connection.sendall(encoded({"type": "attach", "id": cfg["id"], "token": persisted["token"], "cursor": cfg["cursor"]}))

    def send_input():
        try:
            while True:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    try:
                        connection.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    return
                connection.sendall(data)
        except OSError:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    threading.Thread(target=send_input, daemon=True).start()
    delivered_cursor = cfg["cursor"]
    received_ready = False
    received_exit = False
    pending_frames = b""
    connection_error = None
    try:
        while True:
            data = connection.recv(65536)
            if not data:
                break
            pending_frames += data
            while b"\n" in pending_frames:
                line, pending_frames = pending_frames.split(b"\n", 1)
                if len(line) > MAX_INPUT:
                    raise RuntimeError("The remote agent broker exceeded the transport limit.")
                try:
                    frame = json.loads(line)
                except ValueError:
                    raise RuntimeError("The remote agent broker sent an invalid output frame.")
                sys.stdout.buffer.write(line + b"\n")
                sys.stdout.buffer.flush()
                if frame.get("type") == "ready":
                    received_ready = True
                if frame.get("type") in ("stdout", "stderr", "exit") and integer(frame.get("cursor"), 1):
                    delivered_cursor = max(delivered_cursor, frame["cursor"])
                if frame.get("type") == "exit":
                    received_exit = True
            if len(pending_frames) > MAX_INPUT:
                raise RuntimeError("The remote agent broker exceeded the transport limit.")
    except OSError as error:
        connection_error = error
    finally:
        connection.close()
    terminal = terminal_record(journal_path)
    if terminal and not received_exit:
        if not received_ready:
            saved = read_json(state_path) or {}
            emit({"type": "ready", "pid": saved.get("pid"), "cursor": terminal["cursor"], "lastInputSequence": saved.get("lastInputSequence", 0)})
        for frame in replay(journal_path, delivered_cursor, terminal["cursor"]):
            emit(frame)
        if delivered_cursor >= terminal["cursor"]:
            emit(terminal)
    elif connection_error and not received_exit:
        raise connection_error

def main():
    cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    if not isinstance(cfg, dict) or not isinstance(cfg.get("id"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", cfg["id"]) or not isinstance(cfg.get("command"), str) or not cfg["command"]:
        raise ValueError("Invalid remote agent session configuration.")
    cfg["cursor"] = cfg.get("cursor") if integer(cfg.get("cursor")) else 0
    root = cfg.get("root")
    if root is not None and (not isinstance(root, str) or not os.path.isabs(root)):
        raise ValueError("The remote agent session directory must be absolute.")
    root = root or os.path.join(os.path.expanduser("~"), ".life", "agent-sessions", cfg["id"])
    cfg["root"] = root
    socket_path = os.path.join(tempfile.gettempdir(), "life-" + str(os.getuid()) + "-" + hashlib.sha256((root + "\0" + cfg["id"]).encode()).hexdigest()[:28] + ".sock")
    paths = (cfg, root, os.path.join(root, "session.json"), os.path.join(root, "state.json"), os.path.join(root, "journal.jsonl"), os.path.join(root, "daemon.lock"), os.path.join(root, "daemon.lock", "owner.json"), socket_path)
    if cfg.get("mode") == "daemon":
        daemon(*paths)
    else:
        attachment(*paths)

try:
    main()
except (Exception, KeyboardInterrupt) as error:
    try:
        emit({"type": "error", "message": str(error)})
    except (BrokenPipeError, OSError):
        pass
    sys.exit(1)
'''
exec(_LIFE_BROKER_PROGRAM)
`
