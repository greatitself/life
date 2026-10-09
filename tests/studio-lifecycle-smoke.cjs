const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'life-studio-lifecycle-'))
  const repository = path.resolve(__dirname, '..')
  let server
  let browser
  const errors = []
  try {
    await build({
      stdin: {
        resolveDir: repository,
        sourcefile: 'studio-lifecycle-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { useCustomizationStudio } from './src/renderer/useCustomizationStudio';
          import { defaultLifeConfig } from './src/shared/customization';
          const options = {
            connection: { status:'connected', home:'/home/test', profile:{
              id:'studio-machine', name:'Studio test machine', host:'test.invalid', port:22,
              username:'test', auth:'agent', privateKeyPath:'', workspace:''
            } },
            config:defaultLifeConfig,
            extensions:{extensions:[],errors:{},revision:0,path:'',canRollback:[],recovered:false},
            source:{revision:0,extensions:[],enabled:false,canRollback:false,path:'',recovered:false},
            applySettings:async () => {
              if (window.holdSettings) await new Promise(resolve => window.releaseSettings = resolve);
            }
          };
          function Fixture() {
            const studio = useCustomizationStudio(options);
            window.studio = studio;
            return <main>{studio.active?.stage}</main>;
          }
          createRoot(document.getElementById('root')).render(<Fixture />);
        `,
      },
      bundle: true,
      format: 'iife',
      outfile: path.join(directory, 'bundle.js'),
    })
    server = createServer(async (request, response) => {
      if (request.url === '/bundle.js') {
        response.setHeader('Content-Type', 'application/javascript')
        response.end(await readFile(path.join(directory, 'bundle.js')))
      } else {
        response.setHeader('Content-Type', 'text/html')
        response.end('<div id="root"></div><script src="/bundle.js"></script>')
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      window.listeners = []
      window.starts = []
      window.relay = {
        onAgent(listener) {
          window.listeners.push(listener)
          return () => {
            window.listeners = window.listeners.filter((item) => item !== listener)
          }
        },
        agent: {
          start: async (input) => {
            window.starts.push(input)
          },
          models: async () => [],
          stop: async () => {},
          dispose: async () => {},
        },
        extensions: { capabilities: [] },
        sourceCode: {
          getContext: async () => ({
            revision: 0,
            paths: [],
            files: [],
            dependencies: {},
            extensions: [],
            snapshot: {
              path: '',
              extensions: [],
              revision: 0,
              enabled: false,
              canRollback: false,
              recovered: false,
            },
          }),
        },
      }
      window.emit = (event) => window.listeners.forEach((listener) => listener(event))
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => Boolean(window.studio?.active))
    const emit = async (events) => {
      await page.evaluate((events) => {
        const sessionId = window.studio.active.id
        for (const event of events) window.emit({ sessionId, ...event })
      }, events)
    }
    const snapshot = () => page.evaluate(() => window.studio.active)
    const newRequest = async (request) => {
      await page.evaluate(() => window.studio.newSession())
      await page.waitForFunction(() => window.studio.active?.stage === 'draft')
      await page.evaluate((request) => window.studio.submit(request), request)
    }

    await page.evaluate(() => window.studio.submit('  Add a focus helper feature.\n  '))
    await emit([
      { type: 'text', itemId: 'response', text: 'Working on the focus helper.' },
      { type: 'tool', itemId: 'tool', title: 'Inspection', text: 'Running...', status: 'running' },
      { type: 'error', text: 'Provider failed.' },
    ])
    await page.waitForFunction(() => window.studio.active.stage === 'failed')
    const failed = await snapshot()
    assert.equal(failed.thread.busy, false)
    assert.equal(
      failed.thread.messages.find((message) => message.role === 'user').finishStatus,
      'failed',
    )
    assert.equal(
      failed.thread.messages.find((message) => message.role === 'assistant').finishStatus,
      'failed',
    )
    assert.equal(failed.thread.messages.find((message) => message.role === 'tool').status, 'failed')
    assert.equal(failed.thread.messages.filter((message) => message.role === 'error').length, 1)
    assert.equal(
      await page.evaluate(() => window.starts[0].prompt),
      '  Add a focus helper feature.\n  ',
    )

    await newRequest('Explain the customization workflow.')
    await emit([
      { type: 'text', itemId: 'response', text: 'The customization workflow is isolated.' },
      {
        type: 'subagent',
        agentId: 'child',
        itemId: 'child',
        title: 'Reviewer',
        status: 'running',
        text: 'Review started.',
      },
      { type: 'complete', status: 'completed' },
    ])
    await page.waitForFunction(() => window.studio.active.stage === 'complete')
    const parent = await snapshot()
    await emit([
      {
        type: 'text',
        agentId: 'child',
        itemId: 'late-text',
        text: 'The complete delayed child answer.',
      },
      {
        type: 'tool',
        agentId: 'child',
        itemId: 'late-tool',
        title: 'Child inspection',
        text: 'Original input',
        status: 'running',
      },
      {
        type: 'tool-output',
        agentId: 'child',
        itemId: 'late-tool',
        text: 'Complete delayed output.\n',
      },
      {
        type: 'approval',
        agentId: 'child',
        requestId: 'late-request',
        title: 'Allow child inspection?',
        text: 'A child permission request.',
      },
    ])
    await page.waitForFunction(() => window.studio.active.thread.pending.length === 1)
    const childRunning = await snapshot()
    assert(
      childRunning.thread.messages.some((message) =>
        message.text.includes('complete delayed child answer'),
      ),
    )
    assert(
      childRunning.thread.messages.some((message) =>
        message.text.includes('Complete delayed output.'),
      ),
    )
    assert.equal(childRunning.stage, 'complete')
    assert.equal(childRunning.thread.busy, false)
    assert.equal(
      childRunning.thread.messages.find((message) => message.role === 'user').finishStatus,
      'completed',
    )
    await emit([{ type: 'complete', agentId: 'child', status: 'completed' }])
    await page.waitForFunction(() => window.studio.active.thread.pending.length === 0)
    const childCompleted = await snapshot()
    assert(childCompleted.thread.messages.length > parent.thread.messages.length)
    assert(
      childCompleted.thread.messages
        .filter((message) => message.agentId === 'child' && message.role === 'tool')
        .every((message) => !['running', 'inProgress'].includes(message.status)),
    )
    assert.equal(
      childCompleted.thread.messages.find(
        (message) => message.agentId === 'child' && message.role === 'assistant',
      ).finishStatus,
      'completed',
    )

    await emit([
      { type: 'status', status: 'reconnecting', text: 'A late transport update.' },
      { type: 'error', text: 'A late provider diagnostic.' },
    ])
    const lateRoot = await snapshot()
    assert.equal(lateRoot.stage, 'complete')
    assert.equal(lateRoot.thread.busy, false)
    assert.equal(
      lateRoot.thread.messages.find((message) => message.role === 'user').finishStatus,
      'completed',
    )
    assert(
      lateRoot.thread.messages.some((message) => message.text === 'A late provider diagnostic.'),
    )

    await page.evaluate(() => {
      window.holdSettings = true
    })
    await newRequest('Implement a more compact default workspace.')
    await emit([
      {
        type: 'text',
        itemId: 'proposal',
        text: '<life-customization>{"density":"compact"}</life-customization>',
      },
      {
        type: 'subagent',
        agentId: 'build-child',
        itemId: 'child',
        title: 'Build reviewer',
        status: 'running',
        text: 'Still reviewing.',
      },
      { type: 'complete', status: 'completed' },
    ])
    await page.waitForFunction(
      () => window.studio.active.stage === 'applying' && Boolean(window.releaseSettings),
    )
    await emit([
      {
        type: 'text',
        agentId: 'build-child',
        itemId: 'child-answer',
        text: 'A full child answer during application.',
      },
      { type: 'complete', agentId: 'build-child', status: 'completed' },
    ])
    const duringApply = await snapshot()
    assert.equal(duringApply.stage, 'applying')
    assert.equal(duringApply.thread.busy, true)
    assert(
      duringApply.thread.messages.some((message) =>
        message.text.includes('full child answer during application'),
      ),
    )
    assert(
      duringApply.thread.messages
        .filter((message) => message.agentId === 'build-child' && message.role === 'tool')
        .every((message) => message.status !== 'running'),
    )
    await page.evaluate(() => window.releaseSettings())
    await page.waitForFunction(() => window.studio.active.stage === 'complete')

    await newRequest('Inspect this workflow and report a failure.')
    await emit([
      { type: 'text', itemId: 'failure-answer', text: 'The provider reported a failed turn.' },
      { type: 'complete', status: 'failed' },
    ])
    await page.waitForFunction(() => window.studio.active.stage === 'failed')
    assert(
      (await snapshot()).thread.messages
        .filter((message) => ['user', 'assistant'].includes(message.role))
        .every((message) => message.finishStatus === 'failed'),
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          'provider errors preserve failed root finish statuses',
          'exact user whitespace survives provider handoff',
          'late child text and tool output retained after parent completion',
          'late child approvals remain actionable and settle with child completion',
          'late child completion settles child messages without changing parent',
          'late root lifecycle diagnostics preserve completed parent',
          'child output remains visible during atomic application',
          'failed completion events stay failed',
        ],
        pageErrors: errors,
      }),
    )
  } finally {
    await browser?.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
