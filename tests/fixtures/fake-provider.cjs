#!/usr/bin/env node
// Deterministic stand-ins: no provider SDK, credentials, network calls or inference.
const { basename } = require('node:path')
const { appendFileSync, readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { createInterface } = require('node:readline')
const provider = basename(process.argv[1])
const argv = process.argv.slice(2)
const record = (value) =>
  appendFileSync(process.env.RELAY_TEST_LOG, JSON.stringify({ provider, ...value }) + '\n')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const codexModels = [
  {
    id: 'fixture-model',
    model: 'fixture-model',
    displayName: 'Fixture Codex',
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Quick' },
      { reasoningEffort: 'high', description: 'Thorough' },
    ],
    defaultReasoningEffort: 'low',
    serviceTiers: [
      { id: 'default', name: 'Standard', description: 'Standard priority' },
      { id: 'fast', name: 'Fast', description: 'Higher priority' },
    ],
    defaultServiceTier: 'default',
  },
]
const claudeModels = [
  {
    value: 'default',
    displayName: 'Default',
    description: 'Fixture account default',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
    supportsFastMode: false,
  },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Fixture balanced model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
    supportsFastMode: false,
  },
  {
    value: 'opus',
    displayName: 'Opus',
    description: 'Fixture capable model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high', 'max'],
    supportsFastMode: true,
  },
  {
    value: 'haiku',
    displayName: 'Haiku',
    description: 'Fixture compact model',
    supportsEffort: false,
    supportsFastMode: false,
  },
]
const fixtureReviewResponse = `Reviewed the connected test workspace.

The change keeps the first and final assistant messages visible while a turn settles. Tool work stays available, and intermediate reasoning follows the current turn state.

The diff contains:

- A first and last response lookup in \`src/thread-activity.ts\`.
- An explicit pending-state rule for reasoning activity.
- A research status marker in \`src/index.ts\`.
- An untracked text file that can be opened from the Files panel.

The right panel shows these actual files from the loopback SSH test project. Expand a file to compare the removed and added lines, or turn wrapping off to inspect long expressions.

This is a deterministic test conversation; no provider account or inference was used.`

function hypothesisBacklogSource(repaired = false) {
  return `import { useState } from 'react'
import clsx from 'clsx'

export function FixtureHypothesisBacklog() {
  const [count, setCount] = useState(0)
  return (
    <section aria-label="Source hypothesis backlog" className={clsx('source-hypothesis-backlog', count > 0 && 'has-hypotheses')} style={{padding:'12px 24px', borderBottom:'1px solid var(--border)', display:'flex', gap:16, alignItems:'center'}}>
      <h2 style={{fontSize:14, margin:0}}>Hypothesis backlog${repaired ? ' repaired' : ''}</h2>
      <button type="button" onClick={() => setCount(value => value + 1)}>${repaired ? 'Add experiment' : 'Add hypothesis'}</button>
      <output aria-live="polite">Hypotheses: {count}</output>
    </section>
  )
}
`
}

function sourceThreadResponse(prompt, request) {
  if (
    ![
      'add a hypothesis backlog directly to the Life workspace',
      'repair the hypothesis backlog after a deliberate compiler failure',
      'retitle the hypothesis backlog from its source',
      'repair the hypothesis backlog after a deliberate runtime failure',
    ].includes(request)
  )
    return undefined
  const contextMarker = 'Current Life source context JSON:\n'
  if (!prompt.includes(contextMarker))
    throw new Error('The source request did not include Life source context.')
  const context = JSON.parse(
    prompt.slice(prompt.indexOf(contextMarker) + contextMarker.length).split('\n')[0],
  )
  if (request === 'retitle the hypothesis backlog from its source') {
    const path = 'src/renderer/components/FixtureHypothesisBacklog.tsx'
    if (!prompt.includes('Life source read results:\n'))
      return `<life-source-read>${JSON.stringify({ paths: [path] })}</life-source-read>`
    const feature = context.files.find((file) => file.path === path)
    if (!feature?.content.includes('>Hypothesis backlog repaired</h2>'))
      throw new Error('The continuation omitted the current repaired hypothesis source.')
    return `<life-source>${JSON.stringify({
      summary: 'Review and retitle the existing hypothesis backlog from its source',
      baseRevision: context.revision,
      files: [
        {
          path,
          edits: [
            {
              find: '>Hypothesis backlog repaired</h2>',
              replace: '>Hypothesis backlog reviewed</h2>',
            },
          ],
        },
      ],
    })}</life-source>`
  }
  if (request === 'add a hypothesis backlog directly to the Life workspace') {
    if (!prompt.includes('Life source read results:\n'))
      return '<life-source-read>{"paths":["src/renderer/App.tsx"]}</life-source-read>'
    const app = context.files.find((file) => file.path === 'src/renderer/App.tsx')
    if (!app?.content.includes('<main className="main-workspace" id="main-content">'))
      throw new Error('The source continuation omitted the requested App.tsx workspace source.')
    return `<life-source>${JSON.stringify({
      summary: 'Add a real hypothesis backlog to the Life workspace source',
      baseRevision: context.revision,
      dependencies: { clsx: '2.1.1' },
      files: [
        {
          path: 'src/renderer/components/FixtureHypothesisBacklog.tsx',
          content: hypothesisBacklogSource(),
        },
        {
          path: 'src/renderer/App.tsx',
          edits: [
            {
              find: "import './enhancements.css'",
              replace:
                "import { FixtureHypothesisBacklog } from './components/FixtureHypothesisBacklog'\nimport './enhancements.css'",
            },
            {
              find: '<main className="main-workspace" id="main-content">',
              replace:
                '<main className="main-workspace" id="main-content">\n                <FixtureHypothesisBacklog />',
            },
          ],
        },
      ],
    })}</life-source>`
  }
  const repairing = prompt.includes('Life repair diagnostics:\n')
  if (request === 'repair the hypothesis backlog after a deliberate runtime failure')
    return `<life-source>${JSON.stringify({
      summary: repairing
        ? 'Recover the hypothesis backlog after runtime feedback'
        : 'Exercise a deliberate runtime failure with native recovery',
      baseRevision: context.revision,
      files: [
        {
          path: 'src/renderer/components/FixtureHypothesisBacklog.tsx',
          content: repairing
            ? hypothesisBacklogSource(true).replace(
                'Hypothesis backlog repaired',
                'Hypothesis backlog recovered',
              )
            : "throw new Error('Life runtime fixture')\n" + hypothesisBacklogSource(true),
        },
      ],
    })}</life-source>`
  return `<life-source>${JSON.stringify({
    summary: repairing
      ? 'Repair the hypothesis backlog after compiler feedback'
      : 'Exercise a deliberate compile failure without activating broken source',
    baseRevision: context.revision,
    files: [
      {
        path: 'src/renderer/components/FixtureHypothesisBacklog.tsx',
        content: repairing
          ? hypothesisBacklogSource(true)
          : 'export function FixtureHypothesisBacklog() { return (<section>Life fixture compiler failure }',
      },
    ],
  })}</life-source>`
}

function customizationResponse(prompt) {
  if (
    !prompt.startsWith('You are configuring Life,') ||
    !prompt.includes('Allowed settings patch schema:')
  )
    return undefined
  const patch = {
    labels: { researchTitle: 'Research lab' },
    commands: [
      {
        id: 'review-research',
        name: 'Review research',
        prompt: 'Review the research goals and propose the next experiment.',
        mode: 'plan',
      },
    ],
    widgets: [
      {
        id: 'research-notes',
        title: 'Research notes',
        kind: 'markdown',
        content: '## Experiment log\nRecord a hypothesis, run an experiment, and compare results.',
        placement: 'research',
      },
      {
        id: 'experiment-flow',
        title: 'Experiment workflow',
        kind: 'mermaid',
        content: 'flowchart LR\n  Hypothesis --> Experiment --> Result',
        placement: 'both',
      },
    ],
  }
  return `<life-customization>${JSON.stringify(patch)}</life-customization>`
}

function extensionResponse(prompt) {
  if (
    !prompt.startsWith('You are extending Life, a local Electron research application') ||
    !prompt.includes('Allowed manifest schema:')
  )
    return undefined
  const manifest = {
    id: 'research-tools',
    name: 'Research tools',
    description: 'Test executable extension',
    version: '1.0.0',
    enabled: true,
    renderer: {
      placement: 'view',
      html: '<main class="research-tools"><p class="eyebrow">LIFE RESEARCH</p><h1>Research counter</h1><p>Track experiments with a live extension.</p><button id="increment" type="button">Increment</button><output id="count" aria-live="polite">Count: 0</output><p id="connection" class="connection">Checking SSH state…</p></main>',
      css: '.research-tools{padding:32px;max-width:640px;color:var(--text)}.eyebrow,.connection{color:var(--muted);font-size:12px}.eyebrow{letter-spacing:.12em}h1{font-size:28px}button{border:1px solid var(--border);border-radius:6px;padding:9px 16px;background:var(--surface);color:var(--text)}button:disabled{opacity:.5}output{display:block;margin-top:20px;font-size:24px}',
      js: `const button = document.getElementById('increment');
const output = document.getElementById('count');
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const result = await life.call('increment', { by: 1 });
    output.textContent = 'Count: ' + result.count;
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  } finally {
    button.disabled = false;
  }
});
(async () => {
  try {
    const state = await life.invoke('connection.state', {});
    document.getElementById('connection').textContent = 'SSH: ' + state.status;
  } catch (error) {
    document.getElementById('connection').textContent = 'SSH: ' + error.message;
  }
})();`,
    },
    main: `let count = 0;
life.handle('increment', async (args) => {
  if (!args || !Number.isFinite(args.by)) throw new Error('Specify an increment amount');
  count += args.by;
  return { count };
});
life.handle('inspect', async () => ({ hasRequire: typeof require === 'function' }));`,
  }
  return `<life-extension>${JSON.stringify(manifest)}</life-extension>`
}

// Ordinary thread requests retain their existing remote session. These responses
// exercise the validated boundary without paid inference or project mutations.
function lifeThreadResponse(prompt) {
  if (!prompt.startsWith('The user is asking about Life itself from an ordinary chat thread.'))
    return undefined
  const marker = 'User customization request:\n'
  let request = ''
  try {
    request = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
  } catch {
    throw new Error('The Life thread prompt did not include a complete request.')
  }
  if (request === 'hang customization') return null
  const source = sourceThreadResponse(prompt, request)
  if (source !== undefined) return source
  if (request === 'clarify customization') return 'Which part of Life would you like me to change?'
  if (request === 'no change customization')
    return 'Life already has this behavior.\n<life-customization>{}</life-customization>'
  if (request === 'explain customization')
    return 'Life supports settings and executable extensions in this same conversation.'
  if (/shadcn/i.test(request))
    return 'Life can change its renderer source and rebuild from this thread. Which select controls should I update?'
  if (request === 'invalid customization')
    return '<life-customization>{"theme":"purple"}</life-customization>'
  if (request === 'mixed customization')
    return (
      customizationResponse('You are configuring Life,\nAllowed settings patch schema:') +
      extensionResponse(
        'You are extending Life, a local Electron research application\nAllowed manifest schema:',
      )
    )
  if (
    [
      'disabled customization extension',
      'worker failure customization extension',
      'delayed customization extension',
    ].includes(request)
  ) {
    const source = extensionResponse(
      'You are extending Life, a local Electron research application\nAllowed manifest schema:',
    )
    const manifest = JSON.parse(
      source.slice('<life-extension>'.length, -'</life-extension>'.length),
    )
    if (request === 'disabled customization extension') {
      manifest.id = 'disabled-fixture-extension'
      manifest.name = 'Disabled fixture extension'
      manifest.enabled = false
    } else if (request === 'worker failure customization extension') {
      manifest.id = 'broken-fixture-extension'
      manifest.name = 'Broken fixture extension'
      manifest.main = 'throw new Error("Life fixture activation failure");'
    } else {
      manifest.id = 'delayed-fixture-extension'
      manifest.name = 'Delayed fixture extension'
      manifest.main = 'await new Promise(resolve => setTimeout(resolve, 1500));\n' + manifest.main
    }
    return `<life-extension>${JSON.stringify(manifest)}</life-extension>`
  }
  if (/counter|executable extension/.test(request))
    return extensionResponse(
      'You are extending Life, a local Electron research application\nAllowed manifest schema:',
    )
  return customizationResponse('You are configuring Life,\nAllowed settings patch schema:')
}

record({ argv, cwd: process.cwd() })
if (argv.includes('--version')) {
  console.log(provider === 'codex' ? 'codex-cli test.0' : '2.test.0 (Claude Code fixture)')
  process.exit(0)
}

let sequence = 0
let pending = new Map()
let active
const sessionId =
  argv.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length) ||
  (argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : 'claude-remote-1')

function codexComplete(turn, text = 'Hello from Codex 👋') {
  send({
    method: 'item/completed',
    params: { threadId: turn.threadId, item: { id: turn.itemId, type: 'agentMessage', text } },
  })
  send({
    method: 'turn/completed',
    params: { threadId: turn.threadId, turn: { id: turn.turnId, status: 'completed' } },
  })
}
function attachmentProbe(text) {
  if (!text.startsWith('native-attachment-probe')) return undefined
  const marker = 'The user attached these files as reference data:\n'
  const references = text.slice(text.indexOf(marker) + marker.length).split('\n')
  const evidence = []
  for (const line of references) {
    if (!line.startsWith('{')) break
    const reference = JSON.parse(line)
    if (
      !/^\/tmp\/life-thread-attachments\.[a-zA-Z0-9]+\/[a-zA-Z0-9-]+-[a-zA-Z0-9._-]+$/.test(
        reference.path,
      )
    )
      throw new Error('The native attachment probe received an unexpected remote reference path.')
    const bytes = readFileSync(reference.path)
    evidence.push({
      name: reference.name,
      path: reference.path,
      mime: reference.mime,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  if (!evidence.length) throw new Error('The native attachment probe omitted its reference files.')
  record({ attachmentEvidence: evidence })
  return `Verified ${evidence.length} remote attachment files.`
}
function codexTurn(message) {
  const { threadId, input } = message.params
  const text = input[0].text
  const turn = { threadId, turnId: `turn-${++sequence}`, itemId: `message-${sequence}` }
  active = turn
  send({ id: message.id, result: { turn: { id: turn.turnId } } })
  send({ method: 'turn/started', params: { threadId, turn: { id: turn.turnId } } })
  send({
    method: 'item/agentMessage/delta',
    params: { threadId, itemId: turn.itemId, delta: 'Hello ' },
  })
  send({
    method: 'item/agentMessage/delta',
    params: { threadId, itemId: turn.itemId, delta: 'from Codex 👋' },
  })
  const customization = customizationResponse(text)
  if (customization) {
    codexComplete(turn, customization)
    return
  }
  const extension = extensionResponse(text)
  if (extension) {
    codexComplete(turn, extension)
    return
  }
  const life = lifeThreadResponse(text)
  if (life !== undefined) {
    if (life !== null) codexComplete(turn, life)
    return
  }
  if (text === 'remote-life-markers') {
    codexComplete(turn, '<life-customization>{"theme":"light"}</life-customization>')
    return
  }
  if (text === 'Review the fixture changes') {
    codexComplete(turn, fixtureReviewResponse)
    return
  }
  const attachments = attachmentProbe(text)
  if (attachments) {
    codexComplete(turn, attachments)
    return
  }
  if (text === 'queue-delay') {
    setTimeout(() => {
      if (active === turn) codexComplete(turn, 'The delayed Codex response finished.')
    }, 4000)
    return
  }
  if (text === 'hang' || text === 'delay-start') return
  if (text === 'provider-error') {
    send({
      method: 'turn/completed',
      params: {
        threadId,
        turn: {
          id: turn.turnId,
          status: 'failed',
          error: { message: 'Codex fixture login expired' },
        },
      },
    })
    return
  }
  if (text === 'process-exit') {
    process.stderr.write('Codex fixture crashed\n')
    process.exit(2)
  }
  if (text === 'approval' || text === 'question') {
    const id = 9000 + sequence
    pending.set(id, turn)
    if (text === 'question') {
      send({
        id,
        method: 'item/tool/requestUserInput',
        params: {
          threadId,
          questions: [
            {
              id: 'language',
              header: 'Language',
              question: 'Which language?',
              options: [{ label: 'TypeScript', description: 'Typed JavaScript' }],
            },
          ],
        },
      })
    } else {
      send({
        method: 'item/started',
        params: {
          threadId,
          item: { id: 'command-' + sequence, type: 'commandExecution', command: 'npm test' },
        },
      })
      send({
        method: 'item/commandExecution/outputDelta',
        params: { threadId, itemId: 'command-' + sequence, delta: 'fixture output\n' },
      })
      send({
        id,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, command: 'npm test', reason: 'Run project checks' },
      })
    }
    return
  }
  codexComplete(turn)
}
function claudeComplete(text = 'Hello from Claude 👋') {
  send({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: active.itemId, role: 'assistant', content: [{ type: 'text', text }] },
  })
  send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false })
}
function claudeTurn(message) {
  const text = message.message.content[0].text
  active = { itemId: `claude-message-${++sequence}` }
  send({
    type: 'stream_event',
    session_id: sessionId,
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: active.itemId } },
  })
  send({
    type: 'stream_event',
    session_id: sessionId,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
  })
  send({
    type: 'stream_event',
    session_id: sessionId,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'from Claude 👋' } },
  })
  const customization = customizationResponse(text)
  if (customization) {
    claudeComplete(customization)
    return
  }
  const extension = extensionResponse(text)
  if (extension) {
    claudeComplete(extension)
    return
  }
  const life = lifeThreadResponse(text)
  if (life !== undefined) {
    if (life !== null) claudeComplete(life)
    return
  }
  if (text === 'remote-life-markers') {
    claudeComplete('<life-customization>{"theme":"light"}</life-customization>')
    return
  }
  if (text === 'Review the fixture changes') {
    claudeComplete(fixtureReviewResponse)
    return
  }
  const attachments = attachmentProbe(text)
  if (attachments) {
    claudeComplete(attachments)
    return
  }
  if (text === 'queue-delay') {
    const turn = active
    setTimeout(() => {
      if (active === turn) claudeComplete('The delayed Claude response finished.')
    }, 4000)
    return
  }
  if (text === 'hang') return
  if (text === 'provider-error') {
    send({
      type: 'result',
      session_id: sessionId,
      is_error: true,
      subtype: 'error_during_execution',
      errors: ['Claude fixture login expired'],
    })
    return
  }
  if (text === 'process-exit') {
    process.stderr.write('Claude fixture crashed\n')
    process.exit(2)
  }
  if (text === 'approval' || text === 'question') {
    const request_id = `permission-${sequence}`
    pending.set(request_id, true)
    send({
      type: 'control_request',
      request_id,
      request: {
        subtype: 'can_use_tool',
        tool_name: text === 'question' ? 'AskUserQuestion' : 'Bash',
        input:
          text === 'question'
            ? {
                questions: [
                  {
                    question: 'Which language?',
                    header: 'Language',
                    options: [{ label: 'TypeScript', description: 'Typed JavaScript' }],
                  },
                ],
              }
            : { command: 'npm test' },
      },
    })
    return
  }
  claudeComplete()
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  record({ message })
  if (provider === 'codex') {
    if (pending.has(message.id) && !message.method) {
      const turn = pending.get(message.id)
      pending.delete(message.id)
      codexComplete(turn, JSON.stringify(message.result))
      return
    }
    if (message.method === 'initialize')
      setTimeout(
        () => send({ id: message.id, result: { userAgent: 'fixture' } }),
        Number(process.env.RELAY_TEST_INIT_DELAY || 0),
      )
    if (message.method === 'model/list')
      send({
        id: message.id,
        result: {
          data: codexModels,
        },
      })
    if (message.method === 'config/read')
      send({
        id: message.id,
        result: {
          config: { model: 'fixture-model', model_reasoning_effort: 'low', service_tier: null },
          origins: {},
          layers: null,
        },
      })
    if (message.method === 'thread/start')
      send({
        id: message.id,
        result: { thread: { id: message.params.threadId || 'codex-remote-1' } },
      })
    if (message.method === 'thread/resume') {
      const threadId = message.params.threadId
      if (threadId === 'codex-hung-resume') return
      const reply = () => {
        // A real old conversation can exceed framing limits if its historical
        // turns are repeated. Native QA asserts the documented metadata-only flag.
        const turns = message.params.excludeTurns
          ? []
          : Array.from({ length: 4096 }, (_, index) => ({
              id: `historical-turn-${index}`,
              items: [
                { id: `historical-message-${index}`, type: 'agentMessage', text: 'x'.repeat(4096) },
              ],
            }))
        record({
          resumeEvidence: {
            threadId,
            excludeTurns: message.params.excludeTurns === true,
            returnedTurns: turns.length,
          },
        })
        send({ id: message.id, result: { thread: { id: threadId, turns } } })
      }
      if (threadId === 'codex-delayed-resume') setTimeout(reply, 250)
      else reply()
    }
    if (message.method === 'turn/start') {
      if (message.params.input[0].text === 'request-error')
        send({ id: message.id, error: { code: -32000, message: 'Codex fixture rejected request' } })
      else if (message.params.input[0].text === 'delay-start')
        setTimeout(() => codexTurn(message), 250)
      else codexTurn(message)
    }
    if (message.method === 'turn/interrupt') {
      send({ id: message.id, result: {} })
      send({
        method: 'turn/completed',
        params: {
          threadId: message.params.threadId,
          turn: { id: message.params.turnId, status: 'interrupted' },
        },
      })
    }
  } else {
    if (message.type === 'control_request' && message.request.subtype === 'initialize')
      setTimeout(
        () => {
          send({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: message.request_id,
              response: { models: claudeModels, fast_mode_state: 'off' },
            },
          })
          send({ type: 'system', subtype: 'init', session_id: sessionId })
        },
        Number(process.env.RELAY_TEST_INIT_DELAY || 0),
      )
    if (message.type === 'user') claudeTurn(message)
    if (message.type === 'control_response' && pending.has(message.response.request_id)) {
      pending.delete(message.response.request_id)
      claudeComplete(JSON.stringify(message.response.response))
    }
    if (message.type === 'control_request' && message.request.subtype === 'interrupt')
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      })
  }
})
