#!/usr/bin/env node
// Deterministic stand-ins: no provider SDK, credentials, network calls or inference.
const { basename, dirname, join } = require('node:path')
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { createInterface } = require('node:readline')
const provider = basename(process.argv[1])
const argv = process.argv.slice(2)
const metadataWorkspace = /\/\.life\/metadata\/title-[a-f0-9-]+$/.test(process.cwd())
const generatedTitle = 'Provider-generated workspace title'
const record = (value) =>
  appendFileSync(
    process.env.RELAY_TEST_LOG,
    JSON.stringify({
      provider,
      cwd: process.cwd(),
      ...value,
      ...(metadataWorkspace ? { kind: 'title-metadata' } : {}),
    }) + '\n',
  )
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

function sourceThreadResponse(prompt, request, studio) {
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
  if (!studio && !prompt.includes(contextMarker))
    throw new Error('The source request did not include Life source context.')
  const context =
    studio?.source ||
    JSON.parse(prompt.slice(prompt.indexOf(contextMarker) + contextMarker.length).split('\n')[0])
  const hasSourceRead = studio
    ? Boolean(studio.diagnostics?.sourceRead)
    : prompt.includes('Life source read results:\n')
  if (request === 'retitle the hypothesis backlog from its source') {
    const path = 'src/renderer/components/FixtureHypothesisBacklog.tsx'
    if (!hasSourceRead)
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
    if (!hasSourceRead)
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
  const repairing = studio
    ? Boolean(studio.diagnostics?.repair)
    : prompt.includes('Life repair diagnostics:\n')
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
life.handle('inspect', async () => ({ hasRequire: typeof require === 'function' }));
life.handle('connection-inspect', async () => life.invoke('connection.state', null));`,
  }
  return `<life-extension>${JSON.stringify(manifest)}</life-extension>`
}

// Native Studio context lives in the actual remote workspace. The fixture reads
// the same app-owned files a provider reads and logs their complete contents;
// this proves that context was not smuggled into the user's original message.
function studioContext(prompt, cwd) {
  const manifestPath = join(cwd, '.studio-context.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const instructions = readFileSync(join(cwd, 'AGENTS.md'), 'utf8')
  const claudeInstructions = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')
  if (
    instructions !== claudeInstructions ||
    !instructions.startsWith('# Life Customization Studio')
  )
    throw new Error('The Studio provider received inconsistent native instruction files.')
  const contextFiles = manifest.files.map((path) => ({
    path,
    content: readFileSync(join(cwd, path), 'utf8'),
  }))
  const json = (path) =>
    JSON.parse(contextFiles.find((file) => file.path === path)?.content || 'null')
  const context = {
    kind: 'studio-context',
    prompt,
    phase: manifest.phase,
    cwd,
    instructions,
    contextFiles,
    source: json('.life/source-context.json'),
    diagnostics: json('.life/diagnostics.json'),
  }
  record(context)
  return context
}

// Legacy synthetic context is retained solely for existing parser regression
// tests. Native v0.7 Studio calls use the exact original prompt plus files above.
function lifeThreadResponse(prompt, studio) {
  let request = studio ? prompt.trim() : prompt
  if (!studio) {
    if (!prompt.startsWith('The user is asking about Life itself from an ordinary chat thread.'))
      return undefined
    const marker = 'User customization request:\n'
    try {
      request = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    } catch {
      throw new Error('The Life thread prompt did not include a complete request.')
    }
  }
  if (request === 'hang customization') return null
  const source = sourceThreadResponse(prompt, request, studio)
  if (source !== undefined) return source
  if (request === 'clarify customization') return 'Which part of Life would you like me to change?'
  if (request === 'no change customization')
    return 'Life already has this behavior.\n<life-customization>{}</life-customization>'
  if (request === 'explain customization')
    return 'Life Customization Studio supports settings, executable extensions and renderer source.'
  if (/shadcn/i.test(request))
    return 'Life Customization Studio can change its renderer source and rebuild. Which select controls should I update?'
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

if (provider === 'claude' && metadataWorkspace) {
  const chunks = []
  process.stdin.on('data', (chunk) => chunks.push(chunk))
  process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks).toString('utf8')
    record({ prompt, instructions: readFileSync(join(process.cwd(), 'CLAUDE.md'), 'utf8') })
    send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: { title: generatedTitle },
    })
  })
} else {
  let sequence = 0
  let threadSequence = 0
  let pending = new Map()
  let active
  const threads = new Map()
  const codexActive = new Map()
  const usageProbeTurns = new Map()
  let claudeUsageProbeTurns = 0
  const claudeSettings = { model: 'default', effortLevel: 'low', fastMode: false }
  const sessionId =
    argv.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length) ||
    (argv.includes('--resume')
      ? argv[argv.indexOf('--resume') + 1]
      : /\/\.life\/(customization|research)\//.test(process.cwd())
        ? 'claude-scoped-' + createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)
        : 'claude-remote-1')

  function codexComplete(turn, text = 'Hello from Codex 👋') {
    if (codexActive.get(turn.threadId) !== turn) return
    codexActive.delete(turn.threadId)
    record({
      kind: metadataWorkspace ? 'title-metadata' : 'turn-completed',
      completionEvidence: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        prompt: turn.prompt,
        steering: turn.steering,
      },
    })
    send({
      method: 'item/completed',
      params: {
        threadId: turn.threadId,
        item: { id: turn.itemId, type: 'agentMessage', phase: 'final_answer', text },
      },
    })
    if (turn.prompt.startsWith('usage-probe')) {
      const count = (usageProbeTurns.get(turn.threadId) || 0) + 1
      usageProbeTurns.set(turn.threadId, count)
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: turn.threadId,
          turnId: turn.turnId,
          tokenUsage: {
            total: {
              inputTokens: 1000 * count,
              outputTokens: 200 * count,
              cachedInputTokens: 400 * count,
              reasoningOutputTokens: 100 * count,
              totalTokens: 1200 * count,
            },
            last: {
              inputTokens: 400,
              outputTokens: 100,
              cachedInputTokens: 200,
              reasoningOutputTokens: 50,
              totalTokens: 500,
            },
            modelContextWindow: 200000,
          },
        },
      })
    }
    send({
      method: 'turn/completed',
      params: { threadId: turn.threadId, turn: { id: turn.turnId, status: 'completed' } },
    })
    if (!metadataWorkspace) {
      const thread = threads.get(turn.threadId)
      if (thread) thread.name = generatedTitle
      send({
        method: 'thread/name/updated',
        params: { threadId: turn.threadId, threadName: generatedTitle },
      })
    }
  }
  function attachmentProbe(text, blocks) {
    if (!text.startsWith('native-attachment-probe')) return undefined
    const marker = 'The user attached these files as reference data:\n'
    if (!text.includes(marker)) {
      const evidence = []
      for (const block of blocks.slice(1)) {
        let bytes
        let path
        let name
        if (block.type === 'localImage' || (block.type === 'text' && block.text.startsWith('/'))) {
          path = block.path || block.text
          bytes = readFileSync(path)
          name = basename(path).replace(/^[a-zA-Z0-9-]+-(?=native-)/, '')
        } else if (block.type === 'document' || block.type === 'image') {
          bytes =
            block.source.type === 'base64'
              ? Buffer.from(block.source.data, 'base64')
              : Buffer.from(block.source.data)
          name = block.title || 'native-reference.png'
          // Claude native attachment blocks carry file bytes instead of paths.
          path = undefined
        } else
          throw new Error('The native attachment probe received an unknown native content block.')
        evidence.push({
          name,
          path,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
      if (!evidence.length) throw new Error('The native attachment probe omitted native files.')
      record(
        provider === 'codex'
          ? { attachmentEvidence: evidence }
          : { nativeAttachmentEvidence: evidence },
      )
      return `Verified ${evidence.length} remote attachment files.`
    }
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
    if (!evidence.length)
      throw new Error('The native attachment probe omitted its reference files.')
    record({ attachmentEvidence: evidence })
    return `Verified ${evidence.length} remote attachment files.`
  }
  function codexTurn(message) {
    const { threadId, input } = message.params
    const text = input[0].text
    const turn = {
      threadId,
      turnId: `turn-${++sequence}`,
      itemId: `message-${sequence}`,
      prompt: text,
      steering: [],
    }
    active = turn
    codexActive.set(threadId, turn)
    record({ kind: 'turn-started', threadId, turnId: turn.turnId, prompt: text })
    send({ id: message.id, result: { turn: { id: turn.turnId } } })
    send({ method: 'turn/started', params: { threadId, turn: { id: turn.turnId } } })
    if (metadataWorkspace) {
      record({ prompt: text, instructions: readFileSync(join(process.cwd(), 'AGENTS.md'), 'utf8') })
      codexComplete(turn, JSON.stringify({ title: generatedTitle }))
      return
    }
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
    const studio = studioContext(
      text,
      message.params.cwd || threads.get(threadId)?.cwd || process.cwd(),
    )
    const life = lifeThreadResponse(text, studio)
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
    if (text === 'native-subagent-probe') {
      const childId = `fixture-subagent-${sequence}`
      const item = {
        id: `spawn-${sequence}`,
        type: 'collabAgentToolCall',
        tool: 'spawn_agent',
        prompt: 'Inspect the native fixture output.',
        receiverThreadIds: [childId],
        agentPath: 'Fixture researcher',
        status: 'running',
      }
      send({ method: 'item/started', params: { threadId, turnId: turn.turnId, item } })
      send({
        method: 'thread/started',
        params: {
          thread: { id: childId, parentThreadId: threadId, agentNickname: 'Fixture researcher' },
        },
      })
      send({
        method: 'turn/started',
        params: { threadId: childId, turn: { id: `child-turn-${sequence}` } },
      })
      send({
        method: 'item/completed',
        params: {
          threadId: childId,
          item: {
            id: `child-message-${sequence}`,
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'Subagent inspected every visible output block.',
          },
        },
      })
      send({
        method: 'turn/completed',
        params: { threadId: childId, turn: { id: `child-turn-${sequence}`, status: 'completed' } },
      })
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId: turn.turnId,
          item: {
            ...item,
            status: 'completed',
            agentsStates: {
              [childId]: {
                status: 'completed',
                message: 'Subagent inspected every visible output block.',
              },
            },
          },
        },
      })
      codexComplete(turn, 'Native subagent work completed with its full output visible.')
      return
    }
    const attachments = attachmentProbe(text, input)
    if (attachments) {
      codexComplete(turn, attachments)
      return
    }
    if (text === 'native-research-operator-delay') {
      setTimeout(() => {
        if (codexActive.get(threadId) === turn)
          codexComplete(turn, 'The research operator turn completed.')
      }, 10000)
      return
    }
    if (text === 'queue-delay') {
      setTimeout(() => {
        if (codexActive.get(threadId) === turn)
          codexComplete(turn, 'The delayed Codex response finished.')
      }, 4000)
      return
    }
    if (text === 'native-live-setting-turn') {
      setTimeout(() => {
        if (codexActive.get(threadId) === turn)
          codexComplete(
            turn,
            'The live Codex turn completed without interruption.' +
              (turn.steering.length ? '\nSteering received: ' + turn.steering.join('\n') : ''),
          )
      }, 3500)
      return
    }
    if (text === 'continuity-delay') {
      setTimeout(() => codexComplete(turn, 'Continued after transport interruption.'), 2500)
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
  function claudeComplete(text = 'Hello from Claude 👋', turn = active) {
    if (!turn || active !== turn) return
    record({
      kind: 'turn-completed',
      completionEvidence: { turnId: turn.itemId, prompt: turn.prompt, steering: turn.steering },
    })
    send({
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { id: turn.itemId, role: 'assistant', content: [{ type: 'text', text }] },
    })
    const usage = turn.prompt.startsWith('usage-probe')
      ? {
          usage: {
            input_tokens: 700,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 50,
            output_tokens: 150,
          },
          modelUsage: {
            'claude-fixture-model': {
              inputTokens: 700 * (claudeUsageProbeTurns + 1),
              cacheReadInputTokens: 300 * (claudeUsageProbeTurns + 1),
              cacheCreationInputTokens: 50 * (claudeUsageProbeTurns + 1),
              outputTokens: 150 * (claudeUsageProbeTurns + 1),
              thinkingTokens: 75 * (claudeUsageProbeTurns + 1),
              costUSD: 0.12 * (claudeUsageProbeTurns + 1),
              costBasis: 'list',
            },
          },
          total_cost_usd: 0.12 * ++claudeUsageProbeTurns,
        }
      : {}
    send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false, ...usage })
    send({ type: 'system', subtype: 'session_state_changed', session_id: sessionId, state: 'idle' })
    send({ type: 'system', subtype: 'ai_title', session_id: sessionId, title: generatedTitle })
    active = undefined
  }
  function claudeTurn(message) {
    const text = message.message.content[0].text
    if (message.priority === 'next' && active) {
      active.steering.push(text)
      record({
        kind: 'steering-applied',
        turnId: active.itemId,
        prompt: text,
        priority: message.priority,
      })
      return
    }
    active = { itemId: `claude-message-${++sequence}`, prompt: text, steering: [] }
    record({ kind: 'turn-started', turnId: active.itemId, prompt: text })
    send({
      type: 'system',
      subtype: 'session_state_changed',
      session_id: sessionId,
      state: 'running',
    })
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
    const life = lifeThreadResponse(text, studioContext(text, process.cwd()))
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
    if (text === 'native-subagent-probe') {
      const toolId = `task-${sequence}`
      send({
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: `task-message-${sequence}`,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: 'Agent',
              input: {
                description: 'Fixture researcher',
                prompt: 'Inspect the native fixture output.',
                subagent_type: 'Explore',
              },
            },
          ],
        },
      })
      send({
        type: 'system',
        subtype: 'task_started',
        session_id: sessionId,
        task_id: `child-${sequence}`,
        tool_use_id: toolId,
        description: 'Fixture researcher',
        status: 'running',
      })
      send({
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: toolId,
        message: {
          id: `child-message-${sequence}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'Subagent inspected every visible output block.' }],
        },
      })
      send({
        type: 'user',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              content: 'Subagent inspected every visible output block.',
            },
          ],
        },
      })
      send({
        type: 'system',
        subtype: 'task_notification',
        session_id: sessionId,
        task_id: `child-${sequence}`,
        tool_use_id: toolId,
        description: 'Fixture researcher',
        status: 'completed',
        summary: 'Subagent inspected every visible output block.',
      })
      claudeComplete('Native subagent work completed with its full output visible.')
      return
    }
    const attachments = attachmentProbe(text, message.message.content)
    if (attachments) {
      claudeComplete(attachments)
      return
    }
    if (text === 'queue-delay') {
      const turn = active
      // A provider result can precede the authoritative idle signal. Life must
      // retain this active turn and hold its queue until the delayed idle event.
      send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false })
      setTimeout(() => {
        if (active === turn) claudeComplete('The delayed Claude response finished.', turn)
      }, 4000)
      return
    }
    if (text === 'native-live-setting-turn') {
      const turn = active
      setTimeout(() => {
        if (active === turn)
          claudeComplete(
            'The live Claude turn completed without interruption.' +
              (turn.steering.length ? '\nSteering received: ' + turn.steering.join('\n') : ''),
            turn,
          )
      }, 3500)
      return
    }
    if (text === 'continuity-delay') {
      const turn = active
      setTimeout(() => claudeComplete('Continued after transport interruption.', turn), 2500)
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
      send({
        type: 'system',
        subtype: 'session_state_changed',
        session_id: sessionId,
        state: 'idle',
      })
      active = undefined
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

  function nativeHistory() {
    const path = join(process.env.RELAY_TEST_HOME, '.codex', 'life-native-qa-history.json')
    if (!existsSync(path)) return { sessions: [], items: {} }
    const history = JSON.parse(readFileSync(path, 'utf8'))
    return { sessions: history.sessions || [], items: history.items || {} }
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    record({
      message,
      cwd: message.params?.cwd || threads.get(message.params?.threadId)?.cwd || process.cwd(),
    })
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
      if (
        message.method === 'account/rateLimits/read' &&
        existsSync(join(dirname(process.env.RELAY_TEST_LOG), 'usage-limits-error'))
      )
        send({
          id: message.id,
          error: { code: -32000, message: 'Fixture account limits temporarily unavailable' },
        })
      else if (message.method === 'account/rateLimits/read')
        send({
          id: message.id,
          result: {
            ordinaryUsageAllowed: false,
            rateLimits: {
              limitId: 'codex',
              limitName: 'Codex',
              planType: 'pro',
              primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1791648000 },
              secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1792166400 },
              credits: { hasCredits: true, unlimited: false, balance: '18.00' },
            },
            rateLimitResetCredits: { availableCount: 2 },
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
      if (message.method === 'thread/start') {
        const reply = {
          id: message.id,
          result: { thread: { id: message.params.threadId || 'codex-remote-1' } },
        }
        if (!message.params.threadId && ++threadSequence > 1)
          reply.result.thread.id = `codex-remote-${threadSequence}`
        threads.set(reply.result.thread.id, {
          id: reply.result.thread.id,
          cwd: message.params.cwd || process.cwd(),
          name: '',
          model: message.params.model || 'fixture-model',
          source: 'appServer',
          turns: [],
        })
        send(reply)
      }
      if (message.method === 'thread/settings/update') {
        const thread = threads.get(message.params.threadId)
        if (thread) Object.assign(thread, message.params)
        send({ id: message.id, result: { status: 'applied', threadSettings: message.params } })
      }
      if (message.method === 'turn/settings/update') {
        const turn = codexActive.get(message.params.threadId)
        if (turn && turn.turnId === message.params.turnId) {
          turn.settings = { ...turn.settings, ...message.params }
          send({ id: message.id, result: { status: 'applied' } })
        } else send({ id: message.id, result: { status: 'turn_completed' } })
      }
      if (message.method === 'turn/steer') {
        const turn = codexActive.get(message.params.threadId)
        if (!turn || turn.turnId !== message.params.expectedTurnId)
          send({
            id: message.id,
            error: { code: -32000, message: 'The expected turn is no longer active' },
          })
        else {
          const prompt = message.params.input[0].text
          turn.steering.push(prompt)
          record({ kind: 'steering-applied', threadId: turn.threadId, turnId: turn.turnId, prompt })
          send({ id: message.id, result: { turnId: turn.turnId } })
        }
      }
      if (message.method === 'thread/read') {
        const thread = nativeHistory().sessions.find(
          (session) => session.id === message.params.threadId,
        ) ||
          threads.get(message.params.threadId) || {
            id: message.params.threadId,
            cwd: process.cwd(),
            name: generatedTitle,
          }
        send({
          id: message.id,
          result: {
            thread: {
              ...thread,
              name: thread.name || generatedTitle,
              turns: message.params.includeTurns ? thread.turns || [] : [],
            },
          },
        })
      }
      if (message.method === 'thread/list') {
        const sessions = message.params.archived
          ? []
          : nativeHistory().sessions.filter(
              (session) =>
                !message.params.searchTerm ||
                (session.name || session.title || '')
                  .toLowerCase()
                  .includes(message.params.searchTerm.toLowerCase()),
            )
        const start = Number(message.params.cursor || 0)
        const limit = message.params.limit || 50
        send({
          id: message.id,
          result: {
            data: sessions.slice(start, start + limit),
            nextCursor: start + limit < sessions.length ? String(start + limit) : null,
          },
        })
      }
      if (message.method === 'thread/items/list') {
        const history = nativeHistory()
        const storedItems = history.items[message.params.threadId] || []
        const items =
          message.params.sortDirection === 'desc' ? [...storedItems].reverse() : storedItems
        const start = Number(message.params.cursor || 0)
        const limit = message.params.limit || 50
        send({
          id: message.id,
          result: {
            data: items.slice(start, start + limit),
            nextCursor: start + limit < items.length ? String(start + limit) : null,
          },
        })
      }
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
                  {
                    id: `historical-message-${index}`,
                    type: 'agentMessage',
                    text: 'x'.repeat(4096),
                  },
                ],
              }))
          record({
            resumeEvidence: {
              threadId,
              excludeTurns: message.params.excludeTurns === true,
              returnedTurns: turns.length,
            },
          })
          if (!threads.has(threadId))
            threads.set(threadId, {
              id: threadId,
              cwd: message.params.cwd || process.cwd(),
              name: generatedTitle,
              turns: [],
            })
          send({
            id: message.id,
            result: { thread: { id: threadId, name: threads.get(threadId).name, turns } },
          })
        }
        if (threadId === 'codex-delayed-resume') setTimeout(reply, 250)
        else reply()
      }
      if (message.method === 'turn/start') {
        if (message.params.input[0].text === 'request-error')
          send({
            id: message.id,
            error: { code: -32000, message: 'Codex fixture rejected request' },
          })
        else if (message.params.input[0].text === 'delay-start')
          setTimeout(() => codexTurn(message), 250)
        else codexTurn(message)
      }
      if (message.method === 'turn/interrupt') {
        const turn = codexActive.get(message.params.threadId)
        if (turn?.turnId === message.params.turnId) codexActive.delete(message.params.threadId)
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
      if (
        message.type === 'control_request' &&
        message.request.subtype === 'get_usage' &&
        existsSync(join(dirname(process.env.RELAY_TEST_LOG), 'usage-limits-error'))
      )
        send({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: message.request_id,
            error: 'Fixture account limits temporarily unavailable',
          },
        })
      else if (message.type === 'control_request' && message.request.subtype === 'get_usage')
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response: {
              session: {
                total_cost_usd: 0,
                model_usage: {},
                total_api_duration_ms: 0,
                total_duration_ms: 0,
                total_lines_added: 0,
                total_lines_removed: 0,
              },
              subscription_type: 'pro',
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 14, resets_at: '2026-10-10T16:00:00Z' },
                seven_day: { utilization: 43, resets_at: '2026-10-16T16:00:00Z' },
                extra_usage: {
                  is_enabled: true,
                  monthly_limit: 2500,
                  used_credits: 125,
                  utilization: 5,
                  currency: 'USD',
                },
              },
              behaviors: null,
            },
          },
        })
      if (message.type === 'control_request' && message.request.subtype === 'initialize')
        setTimeout(
          () => {
            send({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: message.request_id,
                response: {
                  models: claudeModels,
                  supported_models: claudeModels,
                  fast_mode_state: 'off',
                  session_state: 'idle',
                },
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
      if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
        active = undefined
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response: {} },
        })
        send({
          type: 'system',
          subtype: 'session_state_changed',
          session_id: sessionId,
          state: 'idle',
        })
      }
      if (
        message.type === 'control_request' &&
        ['set_model', 'set_permission_mode', 'apply_flag_settings', 'get_settings'].includes(
          message.request.subtype,
        )
      ) {
        if (message.request.subtype === 'set_model') claudeSettings.model = message.request.model
        if (message.request.subtype === 'set_permission_mode')
          claudeSettings.permissionMode = message.request.mode
        if (message.request.subtype === 'apply_flag_settings')
          Object.assign(claudeSettings, message.request.settings)
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response: { ...claudeSettings },
          },
        })
      }
    }
  })
}
