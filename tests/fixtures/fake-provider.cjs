#!/usr/bin/env node
// Deterministic stand-ins: no provider SDK, credentials, network calls or inference.
const { basename } = require('node:path')
const { appendFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const provider = basename(process.argv[1])
const argv = process.argv.slice(2)
const record = (value) =>
  appendFileSync(process.env.RELAY_TEST_LOG, JSON.stringify({ provider, ...value }) + '\n')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')

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
  if (request === 'clarify customization') return 'Which part of Life would you like me to change?'
  if (request === 'no change customization')
    return 'Life already has this behavior.\n<life-customization>{}</life-customization>'
  if (request === 'explain customization')
    return 'Life supports settings and executable extensions in this same conversation.'
  if (/shadcn/i.test(request))
    return 'Replacing built-in components with actual shadcn requires source and dependency changes, followed by an application rebuild. A live extension can provide a custom view; would you like that alternative?'
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

record({ argv })
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
          data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Codex' }],
        },
      })
    if (message.method === 'thread/start' || message.method === 'thread/resume')
      send({
        id: message.id,
        result: { thread: { id: message.params.threadId || 'codex-remote-1' } },
      })
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
            response: { subtype: 'success', request_id: message.request_id, response: {} },
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
