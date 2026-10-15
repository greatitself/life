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
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time

MAX_INPUT = 24 * 1024 * 1024
MAX_BUFFER = 32 * 1024 * 1024
PROTOCOL = 2
output_lock = threading.Lock()

def encoded(value):
    return (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")

def emit(value):
    with output_lock:
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
    input_condition = threading.Condition(mutex)
    inputs = collections.deque()
    input_bytes = [0]
    input_count = [0]
    active_input = [None]
    unresolved_inputs = []
    input_receipts = integer(persisted.get("inputReceipts"), 1) and persisted["inputReceipts"] == 1
    state = {"id": cfg["id"], "protocol": PROTOCOL, "pid": None, "brokerPid": os.getpid(), "cursor": 0, "lastInputSequence": 0, "exited": False}
    status = {"ended": False, "closing": False, "queuedBytes": 0, "exitDeadline": None, "finishedAt": None, "writer": None, "writerEpoch": 0, "acceptedCount": 0, "mutationUnavailable": False, "stdinEnded": False, "inputJournalFailed": False, "journalFailed": False}
    journal_fd = os.open(journal_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.fchmod(journal_fd, 0o600)
    digest_fd = os.open(os.path.join(root, "input-digests"), os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    provider = None

    def publish_many(frames, durable=False):
        with mutex:
            if status["journalFailed"]:
                return
            published = []
            prior_cursor = state["cursor"]
            prior_size = os.fstat(journal_fd).st_size if durable else None
            try:
                for frame in frames:
                    if status["ended"] and frame["type"] != "exit":
                        continue
                    state["cursor"] += 1
                    frame["cursor"] = state["cursor"]
                    data = encoded(frame)
                    offset = 0
                    while offset < len(data):
                        written = os.write(journal_fd, data[offset:])
                        if written < 1:
                            raise OSError(errno.EIO, "The remote agent journal write did not complete.")
                        offset += written
                    published.append((frame, data))
                if durable and published:
                    os.fsync(journal_fd)
            except (OSError, ValueError):
                status["mutationUnavailable"] = True
                status["inputJournalFailed"] = True
                if durable:
                    state["cursor"] = prior_cursor
                    try:
                        os.ftruncate(journal_fd, prior_size)
                        os.fsync(journal_fd)
                    except (OSError, ValueError):
                        status["journalFailed"] = True
                else:
                    state["cursor"] = prior_cursor
                    status["journalFailed"] = True
                    queued.clear()
                    status["queuedBytes"] = 0
                    cancel_inputs()
                    if active_input[0] is not None:
                        settle_inputs([active_input[0]], "uncertain")
                        active_input[0] = None
                    input_condition.notify_all()
                if status["journalFailed"]:
                    for client in list(clients):
                        client.send({"type": "error", "message": "The remote agent journal could not be committed. Mutation ownership is unavailable."})
                        client.finish()
                raise
            for frame, data in published:
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

    def publish(frame):
        publish_many([frame])

    def settle_inputs(entries, receipt_status):
        pending = [entry for entry in entries if not entry["settled"]]
        if not pending:
            return
        failed_now = False
        if input_receipts and not status["inputJournalFailed"]:
            try:
                publish_many([{"type": "inputReceipt", "sequence": entry["frame"]["sequence"], "status": receipt_status} for entry in pending], durable=True)
            except (OSError, ValueError):
                status["inputJournalFailed"] = True
                status["mutationUnavailable"] = True
                queued.clear()
                status["queuedBytes"] = 0
                failed_now = True
                for client in list(clients):
                    client.send({"type": "error", "message": "The remote agent delivery receipt could not be committed. Mutation ownership is unavailable."})
                    if status["journalFailed"]:
                        client.finish()
        for entry in pending:
            if status["inputJournalFailed"]:
                unresolved_inputs.append({"type": entry["frame"]["type"], "sequence": entry["frame"]["sequence"]})
            entry["settled"] = True
            entry["data"] = None
            input_bytes[0] -= entry["size"]
            input_count[0] -= 1
        input_condition.notify_all()
        if failed_now:
            cancel_inputs()
            if active_input[0] is not None:
                settle_inputs([active_input[0]], "uncertain")
                active_input[0] = None

    def cancel_inputs():
        pending = list(inputs)
        settle_inputs(pending, "cancelled")
        inputs.clear()

    def kill_provider(name):
        if provider is None or status["ended"]:
            return False
        try:
            os.killpg(provider.pid, getattr(signal, name))
            return True
        except ProcessLookupError:
            return False

    def shutdown():
        with mutex:
            if status["ended"] or status["closing"]:
                return False
            status["closing"] = True
            queued.clear()
            status["queuedBytes"] = 0
            with input_condition:
                cancel_inputs()
                if active_input[0] is not None:
                    settle_inputs([active_input[0]], "uncertain")
                    active_input[0] = None
                input_condition.notify_all()
            try:
                provider.stdin.close()
            finally:
                try:
                    dispatched = kill_provider("SIGTERM")
                finally:
                    timer = threading.Timer(5, lambda: kill_provider("SIGKILL"))
                    timer.daemon = True
                    timer.start()
                    forced = threading.Timer(6, lambda: finish_provider(provider.poll(), "SIGTERM"))
                    forced.daemon = True
                    forced.start()
            return dispatched

    def input_loop():
        while True:
            with input_condition:
                while not inputs and not status["ended"] and not status["closing"] and not status["inputJournalFailed"]:
                    input_condition.wait()
                if status["ended"] or status["closing"] or status["inputJournalFailed"]:
                    return
                entry = inputs.popleft()
                active_input[0] = entry
                data = memoryview(entry["data"]) if entry["frame"]["type"] == "write" else None
            try:
                if entry["frame"]["type"] == "end":
                    with mutex:
                        if status["ended"] or status["closing"] or entry["settled"]:
                            return
                        provider.stdin.close()
                        settle_inputs([entry], "written")
                        active_input[0] = None
                    return
                offset = 0
                while offset < len(data):
                    with mutex:
                        if status["ended"] or status["closing"] or entry["settled"]:
                            return
                        descriptor = provider.stdin.fileno()
                        try:
                            written = os.write(descriptor, data[offset:])
                        except BlockingIOError:
                            written = None
                        if written is not None:
                            if written < 1:
                                raise OSError(errno.EIO, "The remote agent input write did not complete.")
                            offset += written
                    if written is None:
                        select.select([], [descriptor], [], 0.1)
                with mutex:
                    if status["ended"] or status["closing"] or entry["settled"]:
                        return
                    settle_inputs([entry], "written")
                    active_input[0] = None
            except (OSError, ValueError) as error:
                with mutex:
                    if status["ended"] or status["closing"] or entry["settled"]:
                        return
                    status["mutationUnavailable"] = True
                    queued.clear()
                    status["queuedBytes"] = 0
                    settle_inputs([entry], "uncertain")
                    active_input[0] = None
                    cancel_inputs()
                    publish({"type": "stderr", "data": base64.b64encode((str(error) + "\n").encode()).decode()})
                return

    def digest(frame):
        value = frame["data"] if frame["type"] == "write" else frame["signal"] if frame["type"] == "signal" else None
        return hashlib.sha256(json.dumps([frame["sequence"], frame["type"], value], separators=(",", ":")).encode("ascii")).digest()

    def accepted_digest(sequence):
        if os.fstat(digest_fd).st_size != status["acceptedCount"] * 40:
            raise RuntimeError("The remote agent input journal is incomplete.")
        low = 0
        high = status["acceptedCount"] - 1
        while low <= high:
            middle = (low + high) // 2
            record = os.pread(digest_fd, 40, middle * 40)
            if len(record) != 40:
                raise RuntimeError("The remote agent input journal is incomplete.")
            current = struct.unpack(">Q", record[:8])[0]
            if current == sequence:
                return record[8:]
            if current < sequence:
                low = middle + 1
            else:
                high = middle - 1
        return None

    def record_accepted(frame):
        if os.fstat(digest_fd).st_size != status["acceptedCount"] * 40:
            raise RuntimeError("The remote agent input journal is incomplete.")
        record = struct.pack(">Q", frame["sequence"]) + digest(frame)
        offset = 0
        while offset < len(record):
            offset += os.pwrite(digest_fd, record[offset:], status["acceptedCount"] * 40 + offset)
        os.fsync(digest_fd)
        status["acceptedCount"] += 1

    def release_writer(client):
        if status["writer"] is client:
            status["writer"] = None
            queued.clear()
            status["queuedBytes"] = 0

    def apply(frame, waiters):
        cancelled = frame["type"] in ("write", "end") and status["stdinEnded"]
        record_accepted(frame)
        state["lastInputSequence"] = frame["sequence"]
        save_json(state_path, state)
        for waiter in waiters:
            waiter.send({"type": "ack", "sequence": frame["sequence"]})
        data = base64.b64decode(frame["data"], validate=True) if frame["type"] == "write" and not cancelled else None
        entry = {"frame": {"type": frame["type"], "sequence": frame["sequence"]}, "data": data, "size": len(data) if data is not None else 0, "settled": False}
        input_bytes[0] += entry["size"]
        input_count[0] += 1
        if cancelled:
            settle_inputs([entry], "cancelled")
            return
        if frame["type"] in ("write", "end"):
            if frame["type"] == "end":
                status["stdinEnded"] = True
            inputs.append(entry)
            input_condition.notify_all()
        else:
            try:
                if frame["type"] == "signal":
                    dispatched = kill_provider(frame["signal"])
                else:
                    dispatched = shutdown()
                settle_inputs([entry], "written" if dispatched else "uncertain")
            except (OSError, ValueError, RuntimeError):
                status["mutationUnavailable"] = True
                settle_inputs([entry], "uncertain")
                raise

    def authorize(client, frame):
        if status["mutationUnavailable"]:
            raise ValueError("The remote agent input journal could not be committed. Mutation ownership is unavailable.")
        lease = frame.get("writerLease")
        if status["writer"] is not client or not isinstance(lease, dict) or not integer(lease.get("epoch"), 1) or lease.get("epoch") != client.writer_lease["epoch"] or lease.get("token") != client.writer_lease["token"]:
            raise ValueError("The remote agent attachment does not hold the writer lease.")

    def receive(client, frame):
        if not isinstance(frame, dict):
            raise ValueError("Invalid remote agent command envelope.")
        with mutex:
            authorize(client, frame)
        if not integer(frame.get("sequence"), 1):
            raise ValueError("Invalid remote agent input sequence.")
        kind = frame.get("type")
        if kind not in ("write", "signal", "end", "close"):
            raise ValueError("Unknown remote agent command.")
        allowed = {"type", "sequence", "writerLease"}
        if kind == "write":
            allowed.add("data")
        elif kind == "signal":
            allowed.add("signal")
        if any(key not in allowed for key in frame):
            raise ValueError("Invalid remote agent command envelope.")
        if kind == "write":
            value = frame.get("data")
            if not isinstance(value, str) or len(value) > MAX_INPUT - 1024:
                raise ValueError("Invalid remote agent input data.")
            try:
                decoded = base64.b64decode(value, validate=True)
                if base64.b64encode(decoded).decode("ascii") != value:
                    raise ValueError("Invalid remote agent input data.")
            except (ValueError, base64.binascii.Error):
                raise ValueError("Invalid remote agent input data.")
        if kind == "signal":
            name = frame.get("signal")
            if name not in ("SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"):
                raise ValueError("Invalid remote agent signal.")
            frame["signal"] = name
        with mutex:
            authorize(client, frame)
            immutable = {"type": kind, "sequence": frame["sequence"]}
            if kind == "write":
                immutable["data"] = frame["data"]
            elif kind == "signal":
                immutable["signal"] = frame["signal"]
            sequence = frame["sequence"]
            if sequence <= state["lastInputSequence"]:
                accepted = accepted_digest(sequence)
                if accepted is None or not hmac.compare_digest(accepted, digest(immutable)):
                    raise ValueError("Conflicting remote agent input sequence.")
                client.send({"type": "ack", "sequence": sequence})
                return
            if status["ended"] or status["closing"]:
                raise ValueError("The remote agent session has ended.")
            if kind in ("write", "end") and status["stdinEnded"]:
                raise ValueError("The remote agent input stream has ended.")
            if kind == "close" or (kind == "signal" and sequence == state["lastInputSequence"] + 1):
                apply(immutable, {client})
                if kind == "close":
                    return
                while state["lastInputSequence"] + 1 in queued and not status["ended"] and not status["closing"]:
                    entry = queued.pop(state["lastInputSequence"] + 1)
                    status["queuedBytes"] -= entry[1]
                    apply(entry[0], entry[2])
                return
            if sequence in queued:
                entry = queued[sequence]
                if not hmac.compare_digest(digest(entry[0]), digest(immutable)):
                    raise ValueError("Conflicting remote agent input sequence.")
                entry[2].add(client)
            else:
                size = len(encoded(frame))
                if len(queued) + input_count[0] >= 1024 or status["queuedBytes"] + input_bytes[0] + size > MAX_BUFFER:
                    raise ValueError("The remote agent input queue is full.")
                queued[sequence] = (immutable, size, {client})
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
                        client.send({"type": "replayComplete", "replayCursor": state["cursor"]})
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
                        if frame.get("command") != persisted["command"]:
                            connection.sendall(encoded({"type": "error", "message": "The remote agent session belongs to a different launch command."}))
                            return
                        if frame.get("expectedProtocol") is not None and frame.get("expectedProtocol") != PROTOCOL:
                            connection.sendall(encoded({"type": "error", "message": "Unsupported remote agent broker protocol."}))
                            return
                        if not isinstance(frame.get("controllerId"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", frame["controllerId"]) or not isinstance(frame.get("observer"), bool):
                            return
                        authenticated = True
                        after = frame.get("cursor") if integer(frame.get("cursor")) else 0
                        with mutex:
                            clients.add(client)
                            client.writer_lease = None
                            if not frame["observer"] and status["writer"] is None and not status["ended"] and not status["closing"] and not status["mutationUnavailable"]:
                                status["writerEpoch"] += 1
                                client.writer_lease = {"epoch": status["writerEpoch"], "token": os.urandom(32).hex()}
                                status["writer"] = client
                            high_water = state["cursor"]
                            ready = {"type": "ready", "protocol": PROTOCOL, "pid": provider.pid, "cursor": high_water, "lastInputSequence": state["lastInputSequence"]}
                            if input_receipts:
                                ready["inputReceipts"] = 1
                            if client.writer_lease:
                                ready["writerLease"] = client.writer_lease
                            elif status["ended"]:
                                ready["terminal"] = True
                            elif frame["observer"]:
                                ready["observer"] = True
                            else:
                                ready["writerUnavailable"] = True
                            client.send(ready)
                            if status["journalFailed"]:
                                client.send({"type": "error", "message": "The remote agent journal could not be verified. Mutation ownership is unavailable."})
                                client.finish()
                        threading.Thread(target=replay_client, args=(client, after, high_water), daemon=True).start()
                    else:
                        try:
                            receive(client, frame)
                        except ValueError as error:
                            client.send({"type": "error", "message": str(error)})
                        except (OSError, RuntimeError) as error:
                            with mutex:
                                status["mutationUnavailable"] = True
                                queued.clear()
                                status["queuedBytes"] = 0
                            client.send({"type": "error", "message": str(error)})
                if len(buffer) > MAX_INPUT:
                    break
        except (OSError, ValueError):
            pass
        finally:
            client.close()
            with mutex:
                release_writer(client)
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
            queued.clear()
            status["queuedBytes"] = 0
            cancel_inputs()
            if active_input[0] is not None:
                settle_inputs([active_input[0]], "uncertain")
                active_input[0] = None
            status["ended"] = True
            try:
                publish_many([{"type": "exit", "code": code if code is not None and code >= 0 else None, "signal": signal.Signals(-code).name if code is not None and code < 0 else fallback_signal, **({"nativeExitConfirmed": False} if code is None else {})}], durable=True)
                state["exited"] = True
                save_json(state_path, state)
            except (OSError, ValueError):
                status["mutationUnavailable"] = True
                for client in list(clients):
                    client.send({"type": "error", "message": "The remote agent terminal journal could not be committed. Mutation ownership is unavailable."})
            finally:
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
        os.set_blocking(provider.stdin.fileno(), False)
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
        os.close(digest_fd)
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
    negotiated = any(key in cfg for key in ("controllerId", "observer", "expectedProtocol"))

    class TerminalCommitUnavailable(RuntimeError):
        pass

    def terminal_ready(terminal):
        persisted = read_json(config_path)
        if not persisted or persisted.get("id") != cfg["id"]:
            raise RuntimeError("The remote agent session could not verify its journal identity.")
        if persisted.get("command") != cfg["command"]:
            raise RuntimeError("The remote agent session belongs to a different launch command.")
        saved = read_json(state_path) or {}
        protocol = persisted.get("protocol") or saved.get("protocol") or 1
        if negotiated and protocol != PROTOCOL:
            raise RuntimeError("The remote agent broker does not support the required fenced protocol.")
        ready = {"type": "ready", "protocol": protocol, "terminal": True, "pid": saved.get("pid"), "cursor": terminal["cursor"], "lastInputSequence": saved.get("lastInputSequence", 0)}
        if integer(persisted.get("inputReceipts"), 1) and persisted["inputReceipts"] == 1:
            if saved.get("id") != cfg["id"] or saved.get("exited") is not True or not integer(saved.get("cursor"), 1) or saved["cursor"] != terminal["cursor"]:
                raise TerminalCommitUnavailable("The remote agent terminal journal could not verify its durable commit. No delivery receipt was replayed.")
            ready["inputReceipts"] = 1
        return ready
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
        if persisted and persisted.get("command") != cfg["command"]:
            raise RuntimeError("The remote agent session belongs to a different launch command.")
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
            try:
                ready = terminal_ready(terminal)
            except TerminalCommitUnavailable:
                owner = read_json(owner_path)
                if owner and alive(owner.get("pid")):
                    time.sleep(0.05)
                    continue
                raise
            emit(ready)
            for frame in replay(journal_path, cfg["cursor"], terminal["cursor"]):
                emit(frame)
            if cfg["cursor"] >= terminal["cursor"]:
                emit(terminal)
            if ready["protocol"] == PROTOCOL:
                emit({"type": "replayComplete", "replayCursor": terminal["cursor"]})
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
        if persisted or cfg.get("launch") is False or cfg.get("observer") is True:
            raise RuntimeError(missing)
        if os.path.exists(journal_path) or os.path.exists(state_path) or os.path.exists(os.path.join(root, "input-digests")):
            raise RuntimeError("The remote agent session directory contains an unidentified session. No provider was started.")
        try:
            os.mkdir(lock_path, 0o700)
        except FileExistsError:
            time.sleep(0.05)
            continue
        save_json(owner_path, {"pid": os.getpid()})
        persisted = {"id": cfg["id"], "protocol": PROTOCOL, "inputReceipts": 1, "command": cfg["command"], "token": os.urandom(32).hex()}
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
    attach_frame = {"type": "attach", "id": cfg["id"], "command": cfg["command"], "token": persisted["token"], "cursor": cfg["cursor"], "controllerId": cfg.get("controllerId") or os.urandom(16).hex(), "observer": cfg.get("observer") is True}
    if negotiated:
        attach_frame["expectedProtocol"] = PROTOCOL
    connection.sendall(encoded(attach_frame))

    def send_input(ready):
        pending = b""
        try:
            while True:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    try:
                        connection.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    return
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if len(line) > MAX_INPUT:
                        raise RuntimeError("The remote agent command exceeded the transport limit.")
                    if not line:
                        continue
                    command = json.loads(line)
                    if not isinstance(command, dict):
                        raise RuntimeError("The remote agent attachment sent an invalid command.")
                    if ready.get("protocol") == PROTOCOL:
                        if not ready.get("writerLease"):
                            raise RuntimeError("The remote agent attachment does not hold the writer lease.")
                        if not negotiated and "writerLease" not in command:
                            command["writerLease"] = ready["writerLease"]
                    connection.sendall(encoded(command))
                if len(pending) > MAX_INPUT:
                    raise RuntimeError("The remote agent command exceeded the transport limit.")
        except (ValueError, RuntimeError) as error:
            emit({"type": "error", "message": str(error)})
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        except OSError:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    delivered_cursor = cfg["cursor"]
    received_ready = False
    received_exit = False
    received_replay_complete = False
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
                if len(line) > MAX_BUFFER:
                    raise RuntimeError("The remote agent broker exceeded the transport limit.")
                try:
                    frame = json.loads(line)
                except ValueError:
                    raise RuntimeError("The remote agent broker sent an invalid output frame.")
                if not isinstance(frame, dict):
                    raise RuntimeError("The remote agent broker sent an invalid output frame.")
                if not received_ready and frame.get("type") not in ("ready", "error"):
                    raise RuntimeError("The remote agent broker emitted output before its ready handshake.")
                if frame.get("type") == "ready":
                    if received_ready:
                        raise RuntimeError("The remote agent broker sent a duplicate ready handshake.")
                    if negotiated and frame.get("protocol") != PROTOCOL:
                        raise RuntimeError("The remote agent broker does not support the required fenced protocol.")
                    received_ready = True
                    emit(frame)
                    if not frame.get("terminal"):
                        threading.Thread(target=send_input, args=(frame,), daemon=True).start()
                else:
                    emit(frame)
                if frame.get("type") in ("stdout", "stderr", "inputReceipt", "exit") and integer(frame.get("cursor"), 1):
                    delivered_cursor = max(delivered_cursor, frame["cursor"])
                if frame.get("type") == "exit":
                    received_exit = True
                if frame.get("type") == "replayComplete":
                    received_replay_complete = True
            if len(pending_frames) > MAX_BUFFER:
                raise RuntimeError("The remote agent broker exceeded the transport limit.")
    except OSError as error:
        connection_error = error
    finally:
        connection.close()
    terminal = terminal_record(journal_path)
    terminal_info = terminal_ready(terminal) if terminal else None
    if terminal and (not received_exit or (terminal_info["protocol"] == PROTOCOL and not received_replay_complete)):
        if not received_ready:
            emit(terminal_info)
        for frame in replay(journal_path, delivered_cursor, terminal["cursor"]):
            emit(frame)
        if delivered_cursor >= terminal["cursor"]:
            emit(terminal)
        if terminal_info["protocol"] == PROTOCOL:
            emit({"type": "replayComplete", "replayCursor": terminal["cursor"]})
    elif connection_error and not received_exit:
        raise connection_error

def main():
    cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    if not isinstance(cfg, dict) or not isinstance(cfg.get("id"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", cfg["id"]) or not isinstance(cfg.get("command"), str) or not cfg["command"]:
        raise ValueError("Invalid remote agent session configuration.")
    cfg["cursor"] = cfg.get("cursor") if integer(cfg.get("cursor")) else 0
    if "controllerId" in cfg and (not isinstance(cfg["controllerId"], str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", cfg["controllerId"])):
        raise ValueError("Invalid remote agent controller identity.")
    if "observer" in cfg and not isinstance(cfg["observer"], bool):
        raise ValueError("Invalid remote agent observer configuration.")
    if "expectedProtocol" in cfg and (not integer(cfg["expectedProtocol"]) or cfg["expectedProtocol"] != PROTOCOL):
        raise ValueError("Unsupported remote agent broker protocol.")
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
