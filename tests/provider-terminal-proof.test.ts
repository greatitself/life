import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Duplex, PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { Effect } from 'effect'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../src/shared/types'
import { DurableRemoteChannel } from '../src/main/durable-remote-channel'
import { REMOTE_AGENT_BROKER_SOURCE } from '../src/main/remote-agent-broker'
import { REMOTE_AGENT_BROKER_PYTHON_SOURCE } from '../src/main/remote-agent-broker-python'

type ExitFrame = {
  type: string
  cursor: number
  code: number | null
  signal: string | null
  nativeExitConfirmed?: boolean
}
type Observation = 'unobserved' | 'clean' | 'signal'

// Run the actual embedded daemon, replacing only OS/process/socket/timer edges.
// The fake child deliberately retains its output pipes so the forced path runs.
async function nodeTerminal(observation: Observation, forced: boolean): Promise<ExitFrame> {
  const root = mkdtempSync(path.join(tmpdir(), 'life-terminal-proof-'))
  const token = 'terminal-proof'
  const require = createRequire(import.meta.url)
  const timers: { ms: number; run: () => void }[] = []
  const provider = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: observation === 'clean' ? 0 : null,
    signalCode: observation === 'signal' ? 'SIGTERM' : null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  const processBoundary = Object.assign(new EventEmitter(), {
    argv: [
      '',
      Buffer.from(
        JSON.stringify({ id: 'proof', command: 'fixture', root, token, mode: 'daemon' }),
      ).toString('base64'),
    ],
    pid: 9876,
    env: {},
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    getuid: () => 0,
    kill: vi.fn(),
    exit: vi.fn(),
  })
  const server = Object.assign(new EventEmitter(), {
    listen: (_socket: string, ready: () => void) => ready(),
    close: (closed: () => void) => closed(),
  })
  const boundaries: Record<string, unknown> = {
    fs: {
      ...require('fs'),
      chmodSync: (file: string, mode: number) => {
        if (!file.endsWith('.sock')) require('fs').chmodSync(file, mode)
      },
    },
    net: { createServer: () => server },
    child_process: { spawn: () => provider },
  }
  writeFileSync(
    path.join(root, 'session.json'),
    JSON.stringify({ id: 'proof', token, command: 'fixture' }),
  )
  mkdirSync(path.join(root, 'daemon.lock'))
  try {
    await runInNewContext(REMOTE_AGENT_BROKER_SOURCE, {
      require: (name: string) => boundaries[name] ?? require(name),
      process: processBoundary,
      Buffer,
      console,
      setTimeout: (run: () => void, ms: number) => {
        const timer = { ms, run, unref() {} }
        timers.push(timer)
        return timer
      },
      clearTimeout: () => {},
    })
    expect(processBoundary.stdout.read()?.toString()).toBeUndefined()
    if (forced) {
      processBoundary.emit('SIGTERM')
      timers.find((timer) => timer.ms === 5000)!.run()
      timers.find((timer) => timer.ms === 1000)!.run()
      expect(provider.stdout.destroyed).toBe(true)
      expect(provider.stderr.destroyed).toBe(true)
      expect(processBoundary.kill.mock.calls).toEqual([
        [-4321, 'SIGTERM'],
        [-4321, 'SIGKILL'],
      ])
    } else {
      provider.emit('close', provider.exitCode, provider.signalCode)
    }
    expect(processBoundary.exit).toHaveBeenCalledWith(0)
    const journal = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n')
    expect(journal).toHaveLength(1)
    return JSON.parse(journal[0]) as ExitFrame
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Extract and execute the actual Python daemon's nested shutdown/finish/wait
// functions. No provider, daemon, socket, native signal, or background thread runs.
const pythonHarness = String.raw`
import ast, json, signal, sys, threading, types
request = json.load(sys.stdin)
outer = ast.parse(request["source"])
program = next(node.value.value for node in outer.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_LIFE_BROKER_PROGRAM" for target in node.targets))
daemon = next(node for node in ast.parse(program).body if isinstance(node, ast.FunctionDef) and node.name == "daemon")
functions = [node for node in daemon.body if isinstance(node, ast.FunctionDef) and node.name in ("shutdown", "finish_provider", "wait_provider", "settle_inputs", "cancel_inputs")]
assert len(functions) == 5
timers, frames, kills, durable_commits = [], [], [], []
code = {"unobserved": None, "clean": 0, "signal": -15}[request["observation"]]
class Timer:
    def __init__(self, seconds, callback): self.seconds, self.callback = seconds, callback
    def start(self): timers.append(self)
class Condition:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def notify_all(self): pass
def publish_many(batch, durable=False):
    if durable: durable_commits.append(batch)
    for frame in batch: frames.append({**frame, "cursor": len(frames) + 1})
namespace = {
    "mutex": threading.RLock(), "status": {"ended": False, "closing": False, "queuedBytes": 0},
    "queued": {}, "inputs": [], "input_bytes": [0], "input_condition": Condition(), "active_input": [None],
    "kill_provider": lambda name: kills.append(name), "provider": types.SimpleNamespace(poll=lambda: code, wait=lambda: code, stdin=types.SimpleNamespace(close=lambda: None)),
    "threading": types.SimpleNamespace(Timer=Timer), "publish_many": publish_many,
    "signal": signal, "os": types.SimpleNamespace(fsync=lambda _: None), "journal_fd": 1,
    "state": {}, "state_path": "fixture", "save_json": lambda *_: None,
    "time": types.SimpleNamespace(monotonic=lambda: 0), "clients": set(),
}
exec(compile(ast.Module(body=functions, type_ignores=[]), "actual-broker-functions", "exec"), namespace)
if request["forced"]:
    namespace["shutdown"]()
    next(timer for timer in timers if timer.seconds == 5).callback()
    next(timer for timer in timers if timer.seconds == 6).callback()
    assert kills == ["SIGTERM", "SIGKILL"]
else:
    namespace["wait_provider"]([types.SimpleNamespace(join=lambda: None)])
assert namespace["status"]["ended"] and namespace["state"]["exited"]
assert len(frames) == 1
assert len(durable_commits) == 1 and durable_commits[0][0]["type"] == "exit"
print(json.dumps(frames[0]))
`

function pythonTerminal(observation: Observation, forced: boolean): ExitFrame {
  return JSON.parse(
    execFileSync('python3', ['-c', pythonHarness], {
      input: JSON.stringify({ source: REMOTE_AGENT_BROKER_PYTHON_SOURCE, observation, forced }),
      encoding: 'utf8',
    }),
  ) as ExitFrame
}

class Attachment extends Duplex {
  readonly stderr = new PassThrough()
  readonly inputs: Record<string, unknown>[] = []
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.inputs.push(
      ...chunk
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
    callback()
  }
  frame(frame: Record<string, unknown>) {
    this.push(JSON.stringify(frame) + '\n')
  }
  close() {
    this.emit('close')
  }
}

class Host extends EventEmitter {
  state: ConnectionState = {
    status: 'connected',
    home: '/fixture',
    workspace: '/fixture',
    profile: {
      id: 'proof',
      name: 'Proof',
      host: 'fixture',
      port: 22,
      username: 'fixture',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/fixture',
    },
  }
  readonly attachment = new Attachment()
  async channel() {
    setImmediate(() =>
      this.attachment.frame({
        type: 'ready',
        protocol: 2,
        cursor: 0,
        lastInputSequence: 0,
        writerLease: { epoch: 1, token: 'terminal-proof-writer' },
      }),
    )
    return this.attachment as unknown as ClientChannel
  }
}

async function parsedTerminal(frame: ExitFrame) {
  const host = new Host()
  const channel = await DurableRemoteChannel.open(host, 'fixture-provider')
  const exits = vi.fn()
  const errors = vi.fn()
  channel.on('exit', exits)
  channel.on('error', errors)
  let settled = false
  const released = Effect.runPromise(channel.closeAndWaitEffect()).then((value) => {
    settled = true
    return value
  })
  await vi.waitFor(() => expect(host.attachment.inputs.at(-1)?.type).toBe('close'))
  host.attachment.frame({ type: 'ack', sequence: host.attachment.inputs.at(-1)!.sequence })
  await new Promise((resolve) => setImmediate(resolve))
  expect(settled).toBe(false)
  host.attachment.frame(frame)
  const confirmed = await released
  const secondConfirmation = await Effect.runPromise(channel.closeAndWaitEffect())
  expect(channel.transportState).toBe('closed')
  expect(host.listenerCount('state')).toBe(0)
  expect(host.listenerCount('disconnected')).toBe(0)
  if (frame.nativeExitConfirmed === false) {
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0]).toMatchObject({
      operation: 'native-exit',
      reason: 'uncertain',
    })
  } else expect(errors).not.toHaveBeenCalled()
  return { confirmed, secondConfirmation, exits: exits.mock.calls }
}

describe('provider terminal proof through actual broker functions and Durable parser', () => {
  it.each(['node', 'python'] as const)(
    '%s refuses forced cleanup without an observed child exit',
    async (runtime) => {
      const frame =
        runtime === 'node'
          ? await nodeTerminal('unobserved', true)
          : pythonTerminal('unobserved', true)
      const parsed = await parsedTerminal(frame)
      expect({ marker: frame.nativeExitConfirmed, ...parsed }).toEqual({
        marker: false,
        confirmed: false,
        secondConfirmation: false,
        exits: [],
      })
    },
  )

  it.each([
    ['node', 'clean', true],
    ['node', 'signal', true],
    ['node', 'clean', false],
    ['node', 'signal', false],
    ['python', 'clean', true],
    ['python', 'signal', true],
    ['python', 'clean', false],
    ['python', 'signal', false],
  ] as const)(
    '%s preserves observed %s exit confirmation (forced=%s)',
    async (runtime, observation, forced) => {
      const frame =
        runtime === 'node'
          ? await nodeTerminal(observation, forced)
          : pythonTerminal(observation, forced)
      const parsed = await parsedTerminal(frame)
      expect(frame.nativeExitConfirmed).toBeUndefined()
      expect(frame.code).toBe(observation === 'clean' ? 0 : null)
      if (observation === 'signal') expect(frame.signal).toBe('SIGTERM')
      expect(parsed).toEqual({
        confirmed: true,
        secondConfirmation: true,
        exits: [[observation === 'clean' ? 0 : undefined, frame.signal]],
      })
    },
  )

  it.each([
    { code: null, signal: 'SIGKILL', nativeExitConfirmed: false, expected: false },
    { code: 0, signal: null, nativeExitConfirmed: false, expected: false },
    { code: 0, signal: null, expected: true },
    { code: null, signal: 'SIGTERM', expected: true },
    { code: 0, signal: null, nativeExitConfirmed: true, expected: true },
  ])(
    'uses explicit terminal confirmation while accepting legacy normal frames: %j',
    async ({ expected, ...frame }) => {
      const parsed = await parsedTerminal({ type: 'exit', cursor: 1, ...frame })
      expect(parsed.confirmed).toBe(expected)
      expect(parsed.secondConfirmation).toBe(expected)
      expect(parsed.exits).toHaveLength(expected ? 1 : 0)
    },
  )
})
