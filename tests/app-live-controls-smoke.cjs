#!/usr/bin/env node
// Exercise Life's actual App, UI handlers and IndexedDB in Chromium.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')
const presentation = process.argv.includes('--presentation')
const historyHydration = process.argv.includes('--history-hydration')
const providerUtilities = process.argv.includes('--provider-utilities')
const fluidity = process.argv.includes('--fluidity') || process.argv.includes('--fluidity-baseline')
const fluidityBaseline = process.argv.includes('--fluidity-baseline')

async function presentationChecks(page, checks) {
  const artifacts = resolve(__dirname, '../output/playwright/v0.8.0')
  await mkdir(artifacts, { recursive: true })
  assert.equal(
    await page
      .locator('.sidebar .life-studio-entry, .sidebar [aria-label="Live extensions"]')
      .count(),
    0,
  )
  const customize = page.getByRole('button', { name: 'Customize', exact: true })
  assert.equal(await customize.locator('.lucide-paintbrush').count(), 1)
  assert.equal(await customize.locator('span').count(), 0)
  await customize.click()
  let studio = page.getByRole('dialog', { name: 'Customize Life', exact: true })
  const studioDraft = studio.getByRole('textbox', { name: 'Describe a Life customization' })
  await studioDraft.fill('Keep this customization draft across dialog closes.')
  await page.screenshot({ path: join(artifacts, 'customize.png') })
  await studio.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await customize.click()
  assert.equal(
    await studioDraft.inputValue(),
    'Keep this customization draft across dialog closes.',
  )
  await studio.getByRole('button', { name: 'Manage and share extensions', exact: true }).click()
  await page.getByRole('dialog', { name: 'Manage extensions', exact: true }).waitFor()
  await page
    .getByRole('dialog', { name: 'Manage extensions', exact: true })
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  await studio.getByRole('button', { name: 'Close dialog', exact: true }).click()
  checks.push(
    'An icon-only Customize header button opens a state-preserving dialog; extensions are managed from it',
  )

  const environment = page.getByRole('button', { name: 'Current Active Environment', exact: true })
  assert.equal(await environment.evaluate((el) => getComputedStyle(el).borderRadius), '9999px')
  assert.equal(
    await environment.evaluate((el) => getComputedStyle(el.parentElement).borderBottomWidth),
    '0px',
  )
  checks.push('The active environment is a pill with no underline beneath its header container')

  await page.evaluate(() => {
    const emit = window.controlsTest.emit
    emit('thread-a')
    emit('thread-a', 'tool', {
      itemId: 'first-command',
      title: 'exec_command',
      text: 'Read the component files.',
      status: 'completed',
    })
    emit('thread-a', 'text', {
      itemId: 'progress',
      phase: 'commentary',
      text: 'The header is updated. I am checking the thread controls.',
    })
    emit('thread-a', 'reasoning', {
      itemId: 'reasoning',
      text: '**Checking the thread layout**\nPreserve the reported events.',
    })
    emit('thread-a', 'tool', {
      itemId: 'last-command',
      title: 'npm run typecheck',
      text: 'Types passed.',
      status: 'completed',
    })
  })
  await page
    .getByText('The header is updated. I am checking the thread controls.', { exact: true })
    .waitFor()
  assert.equal(await page.locator('.thread-action-disclosure[open]').count(), 0)
  assert.equal(await page.locator('.thread-action-disclosure').count(), 3)
  assert.equal(await page.locator('.thread-original-message').count(), 0)
  assert.equal(await page.getByText('Reasoning summary', { exact: true }).count(), 0)
  assert.equal(await page.locator('.composer-steer').count(), 0)
  await page.screenshot({ path: join(artifacts, 'running.png') })
  checks.push(
    'Actions stay collapsed around expanded progress updates, with no Original message or Reasoning summary labels',
  )

  const chooseEffort = async (name) => {
    await page.getByRole('button', { name: /^Reasoning:.*speed:/ }).click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
  }
  await chooseEffort('High')
  await page.waitForFunction(() => window.controlsTest.records.configure.length === 1)
  await page.getByRole('button', { name: /^Reasoning: High;/ }).waitFor()
  assert.equal(await page.locator('.run-settings-note').count(), 0)
  await page.evaluate(() => window.controlsTest.resolveConfiguration(0, 'Saved for next turn'))
  assert.equal(await page.getByText('Saved for next turn', { exact: true }).count(), 0)
  checks.push(
    'Running desktop controls update immediately and apply settings without status notices',
  )

  const composer = page.getByRole('textbox', { name: 'Message your coding agent' })
  const send = page.getByRole('button', { name: 'Steer current response', exact: true })
  const exact = '  Steer with exactly this text.\nNo extra words.  '
  await composer.fill(exact)
  assert.equal(
    await send.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
  )
  assert.equal(await send.evaluate((el) => getComputedStyle(el).color), 'rgb(244, 196, 78)')
  await composer.press('Enter')
  await page.waitForFunction(() => window.controlsTest.records.steering.length === 1)
  assert.equal(await page.evaluate(() => window.controlsTest.records.steering[0].prompt), exact)
  await composer.fill('Steering from the yellow send button.')
  await send.click()
  await page.waitForFunction(() => window.controlsTest.records.steering.length === 2)
  assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
  await composer.fill('Queue this exact follow-up.')
  await composer.press('Tab')
  await page.getByRole('region', { name: 'Queued follow-up messages' }).waitFor()
  await page.waitForFunction(
    () => window.controlsTest.stored().find((t) => t.id === 'thread-a').queue?.length === 1,
  )
  assert.equal(await composer.inputValue(), '')
  assert.equal(await page.evaluate(() => window.controlsTest.records.steering.length), 2)
  assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
  await page.getByRole('button', { name: 'Remove queued message', exact: true }).click()
  checks.push(
    'Enter and the yellow send button steer the exact draft; Tab queues without steering or starting another turn',
  )

  await page.evaluate(() => {
    window.controlsTest.emit('thread-a', 'text', {
      itemId: 'final',
      phase: 'final_answer',
      text: 'The requested changes are ready.',
      status: 'replace',
    })
    window.controlsTest.emit('thread-a', 'complete', { status: 'completed' })
  })
  await page.getByText('The requested changes are ready.', { exact: true }).waitFor()
  await page.getByText(/^Worked for /).waitFor()
  assert.equal(
    await page
      .locator('.thread-action-disclosure, .thread-work-activity, .thread-original-message')
      .count(),
    0,
  )
  assert.equal(
    await page
      .getByText('The header is updated. I am checking the thread controls.', { exact: true })
      .count(),
    0,
  )
  assert.ok(
    await page.evaluate(() =>
      window.controlsTest
        .stored()
        .find((t) => t.id === 'thread-a')
        .messages.some((m) => m.title === 'exec_command'),
    ),
  )
  await page.screenshot({ path: join(artifacts, 'completed.png') })
  checks.push(
    'Completion leaves only the parent final response and Worked for time; stored activity stays intact',
  )

  await chooseEffort('Medium')
  await page.waitForFunction(() => window.controlsTest.records.configure.length === 2)
  await page.getByRole('button', { name: /^Reasoning: Medium;/ }).waitFor()
  await page.evaluate(() => window.controlsTest.resolveConfiguration(1, 'Idle settings saved'))
  assert.equal(await page.locator('.run-settings-note').count(), 0)
  assert.equal(await page.getByText('Idle settings saved', { exact: true }).count(), 0)
  checks.push(
    'Idle desktop conversations send settings changes immediately without a status notice',
  )

  for (const provider of ['codex', 'claude']) {
    await page.getByRole('button', { name: 'Host chat history', exact: true }).click()
    const history = page.getByRole('dialog', { name: 'Host chat history', exact: true })
    await history
      .getByRole('button')
      .filter({ hasText: `External ${provider} conversation` })
      .click()
    await history.getByRole('button', { name: 'Bring to Life', exact: true }).click()
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
    const before = await page.evaluate(() => window.controlsTest.records.starts.length)
    await composer.fill(`Continue the imported ${provider} conversation.`)
    await composer.press('Enter')
    await page.waitForFunction(
      (before) => window.controlsTest.records.starts.length === before + 1,
      before,
    )
    const start = await page.evaluate(() => window.controlsTest.records.starts.at(-1))
    assert.equal(start.provider, provider)
    assert.equal(start.remoteId, `external-${provider}`)
    assert.equal(start.workspace, '/srv/project')
    assert.equal(start.prompt, `Continue the imported ${provider} conversation.`)
    await page.evaluate(
      (id) => window.controlsTest.emit(id, 'complete', { status: 'completed' }),
      start.sessionId,
    )
  }
  checks.push(
    'Bring to Life imports both external Codex and Claude conversations and resumes their original provider IDs and project',
  )
}

async function providerUtilitiesChecks(page, checks, settle) {
  const artifacts = resolve(__dirname, '../output/playwright/provider-utilities')
  await mkdir(artifacts, { recursive: true })
  const usageButton = page.getByRole('button', { name: 'Usage', exact: true })
  await usageButton.click()
  const usage = page.getByRole('dialog', { name: 'Usage', exact: true })
  await usage.waitFor()
  await page.waitForFunction(() => window.controlsTest.records.usageReads.length === 2)
  assert.equal(await usage.locator('[data-usage="total-tokens"]').textContent(), '5,300')
  assert.equal(await usage.locator('[data-usage="estimated-cost"]').textContent(), '$0.24')
  assert.equal(await usage.locator('tbody > tr').count(), 3)
  assert.equal(await usage.getByText('3 native sessions', { exact: true }).isVisible(), true)
  const context = usage.getByRole('region', { name: 'Current thread context', exact: true })
  assert.equal(
    await context.count(),
    1,
    'Native context belongs to the active thread even when its session also has an imported copy',
  )
  assert.match(await context.textContent(), /500 \/ 200,000 tokens/)
  await usage
    .getByRole('combobox', { name: 'Usage machine', exact: true })
    .selectOption('machine-test')
  assert.equal(await usage.locator('[data-usage="total-tokens"]').textContent(), '4,800')
  await usage.getByRole('combobox', { name: 'Usage provider', exact: true }).selectOption('claude')
  assert.equal(await usage.locator('[data-usage="total-tokens"]').textContent(), '2,400')
  assert.equal(await usage.locator('[data-usage="estimated-cost"]').textContent(), '$0.24')
  assert.equal(await context.count(), 0)
  await usage.getByRole('combobox', { name: 'Usage machine', exact: true }).selectOption('all')
  await usage.getByRole('combobox', { name: 'Usage provider', exact: true }).selectOption('all')
  checks.push(
    'The App Usage header opens exact cumulative native totals, deduplicates an imported session, and wires machine/provider filters and current context',
  )

  const codexAccount = usage.getByRole('article', { name: 'Codex account usage', exact: true })
  const claudeAccount = usage.getByRole('article', {
    name: 'Claude Code account usage',
    exact: true,
  })
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emit('', 'account-usage', { details: test.usageSnapshot('codex', 75, 1700000000003) })
  })
  await codexAccount.getByText('75% used', { exact: true }).waitFor()
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emit('', 'account-usage', { details: test.usageSnapshot('codex', 77, 1700000000003) })
  })
  await codexAccount.getByText('77% used', { exact: true }).waitFor()
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emit('', 'account-usage', { details: test.usageSnapshot('codex', 12, 1700000000001) })
    test.emit('', 'account-usage', {
      details: test.usageSnapshot('codex', 99, 1700000000010, 'other'),
    })
  })
  await settle()
  assert.equal(await codexAccount.getByText('77% used', { exact: true }).isVisible(), true)
  assert.equal(await codexAccount.getByText('12% used', { exact: true }).count(), 0)
  assert.equal(await codexAccount.getByText('99% used', { exact: true }).count(), 0)
  await page.evaluate(() => {
    const test = window.controlsTest
    test.resolveUsage(0, test.usageSnapshot('codex', 25, 1700000000002))
    test.resolveUsage(1, {
      provider: 'claude',
      status: 'unavailable',
      fetchedAt: 1700000000004,
      limits: [],
      message: 'Claude did not report account limits.',
    })
  })
  await claudeAccount.getByText('Claude did not report account limits.', { exact: true }).waitFor()
  assert.equal(await codexAccount.getByText('77% used', { exact: true }).isVisible(), true)
  assert.equal(
    await usage.getByRole('button', { name: 'Refresh limits', exact: true }).isEnabled(),
    true,
  )
  checks.push(
    'The App routes global account snapshots independently of a thread, rejects other machines, and preserves a newer push over older pushes or reads',
  )

  await usage.getByRole('button', { name: 'Refresh limits', exact: true }).click()
  await page.waitForFunction(() => window.controlsTest.records.usageReads.length === 4)
  await page.evaluate(() => window.controlsTest.emitConnection('other'))
  await page.waitForFunction(() => window.controlsTest.records.usageReads.length === 6)
  await usage.getByText('Connected machine · Second machine', { exact: true }).waitFor()
  assert.equal(await codexAccount.getByText('75% used', { exact: true }).count(), 0)
  await page.evaluate(() => {
    const test = window.controlsTest
    test.resolveUsage(2, test.usageSnapshot('codex', 88, 1700000000020))
    test.resolveUsage(3, test.usageSnapshot('claude', 89, 1700000000020))
    test.resolveUsage(4, test.usageSnapshot('codex', 31, 1700000000030, 'other'))
    test.resolveUsage(5, test.usageSnapshot('claude', 42, 1700000000030, 'other'))
    test.emit('', 'account-usage', { details: test.usageSnapshot('codex', 96, 1700000000050) })
  })
  await codexAccount.getByText('31% used', { exact: true }).waitFor()
  await claudeAccount.getByText('42% used', { exact: true }).waitFor()
  assert.equal(await codexAccount.getByText('88% used', { exact: true }).count(), 0)
  assert.equal(await codexAccount.getByText('96% used', { exact: true }).count(), 0)
  await page.screenshot({ path: join(artifacts, 'usage.png') })
  checks.push(
    'Changing the connected machine clears global account data and ignores delayed previous-machine refresh results in the actual App dialog',
  )

  await page.evaluate(() =>
    window.controlsTest.emitConnection('other', true, {
      host: 'edited.example',
      port: 2222,
      username: 'edited-user',
    }),
  )
  await settle()
  assert.equal(
    await page.evaluate(() => window.controlsTest.records.usageReads.length),
    8,
    'Changing the SSH account refreshes direct-read limits even when the saved profile ID is unchanged',
  )
  assert.equal(await codexAccount.getByText('31% used', { exact: true }).count(), 0)
  assert.equal(await claudeAccount.getByText('42% used', { exact: true }).count(), 0)
  await page.evaluate(() => {
    const test = window.controlsTest
    test.resolveUsage(6, test.usageSnapshot('codex', 55, 1700000000060, 'connected'))
    test.resolveUsage(7, test.usageSnapshot('claude', 66, 1700000000060, 'connected'))
    test.emit('', 'account-usage', {
      details: test.usageSnapshot('codex', 98, 1700000000070, 'other'),
    })
  })
  await codexAccount.getByText('55% used', { exact: true }).waitFor()
  await claudeAccount.getByText('66% used', { exact: true }).waitFor()
  assert.equal(await codexAccount.getByText('98% used', { exact: true }).count(), 0)
  await page.evaluate(() => window.controlsTest.emitConnection('other'))
  await page.waitForFunction(() => window.controlsTest.records.usageReads.length === 10)
  await page.evaluate(() => {
    const test = window.controlsTest
    test.resolveUsage(8, test.usageSnapshot('codex', 31, 1700000000080, 'other'))
    test.resolveUsage(9, test.usageSnapshot('claude', 42, 1700000000080, 'other'))
  })
  await codexAccount.getByText('31% used', { exact: true }).waitFor()
  await usage.getByRole('button', { name: 'Close dialog', exact: true }).click()
  checks.push(
    'Editing the host, port or username under the same saved profile clears previous-account limits and refreshes the actual connected account',
  )

  await page.waitForFunction(() => window.controlsTest.records.providerUpdateReads.length >= 2)
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emitProviderUpdates(test.providerUpdatesState('0.163.0'))
    for (let index = 0; index < test.records.providerUpdateReads.length; index++)
      test.resolveProviderRead(index, test.providerUpdatesState('0.161.0'))
  })
  const updatesButton = page.getByRole('button', {
    name: 'Provider updates: 1 newer releases available',
    exact: true,
  })
  await updatesButton.waitFor()
  await settle()
  assert.equal(await updatesButton.locator('.provider-updates-count').textContent(), '1')
  await updatesButton.click()
  const updates = page.getByRole('dialog', { name: 'Provider updates', exact: true })
  await updates.getByText('Second machine', { exact: true }).waitFor()
  assert.equal(await updates.getByText('0.163.0', { exact: true }).isVisible(), true)
  assert.equal(await updates.getByText('0.161.0', { exact: true }).isVisible(), true)
  assert.equal(await updates.getByText('2.1.0', { exact: true }).count(), 2)
  const updateLink = updates
    .locator('.provider-update-card')
    .first()
    .getByRole('link', { name: /Update instructions/ })
  assert.equal(await updateLink.getAttribute('href'), 'https://developers.openai.com/codex/cli/')
  await page.screenshot({ path: join(artifacts, 'provider-updates.png') })
  checks.push(
    'CLI update pushes drive the actual header badge and dialog; an older startup get cannot replace newer global state',
  )

  await updates.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await page.waitForFunction(() => window.controlsTest.records.providerUpdateChecks.length === 1)
  assert.equal(
    await updates.getByRole('button', { name: 'Checking…', exact: true }).isDisabled(),
    true,
  )
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emitProviderUpdates(test.providerUpdatesState('0.161.0'))
    test.resolveProviderCheck(0, test.providerUpdatesState('0.164.0'))
  })
  await updates.getByRole('button', { name: 'Check for updates', exact: true }).waitFor()
  assert.equal(
    await page.locator('button.provider-updates-button').getAttribute('aria-label'),
    'Provider updates',
  )
  assert.equal(await page.locator('.provider-updates-count').count(), 0)
  assert.equal(await updates.getByText('0.164.0', { exact: true }).count(), 0)
  assert.equal(await updates.getByText('Latest release installed', { exact: true }).count(), 2)
  checks.push(
    'Manual CLI checks invoke the connected machine API, expose checking state, and keep the pushed authoritative state instead of a stale return value',
  )

  await updates.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await page.waitForFunction(() => window.controlsTest.records.providerUpdateChecks.length === 2)
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emitConnection('primary')
    test.emitProviderUpdates(test.providerUpdatesState('0.161.0'))
    test.rejectProviderCheck(1, 'OLD SECOND MACHINE UPDATE FAILURE')
  })
  await updates.getByText('Test machine', { exact: true }).waitFor()
  await settle()
  assert.equal(
    await updates.getByText('OLD SECOND MACHINE UPDATE FAILURE', { exact: true }).count(),
    0,
  )
  assert.equal(
    await updates.getByRole('button', { name: 'Check for updates', exact: true }).isEnabled(),
    true,
  )
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emitConnection('primary', false)
    test.emitProviderUpdates({
      connected: false,
      checking: false,
      providers: [
        { provider: 'codex', status: 'disconnected', stale: false },
        { provider: 'claude', status: 'disconnected', stale: false },
      ],
    })
  })
  await updates.getByText('No machine connected', { exact: true }).waitFor()
  assert.equal(
    await updates.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled(),
    true,
  )
  assert.equal(await page.locator('.provider-updates-count').count(), 0)
  await updates.getByRole('button', { name: 'Close dialog', exact: true }).click()
  checks.push(
    'CLI utility state follows machine changes and disconnects, hides old-machine check failures, and disables disconnected checks',
  )

  await page.evaluate(() => window.controlsTest.emitConnection('primary'))
  await page.getByRole('button', { name: /^Thread Alpha, OpenAI/ }).click()
  await settle()
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emit('thread-a')
    test.emit('thread-a', 'subagent', {
      itemId: 'child-run',
      agentId: 'native-live-child',
      agentName: 'Independent child check',
      title: 'Background child',
      status: 'running',
      text: 'The child remains active after its parent finishes.',
    })
    test.emit('thread-a', 'text', {
      itemId: 'utility-parent-final',
      phase: 'final_answer',
      status: 'replace',
      text: 'The parent response is complete.',
    })
    test.emit('thread-a', 'complete', { status: 'completed' })
  })
  await page.getByText('The parent response is complete.', { exact: true }).waitFor()
  await page.waitForFunction(
    () =>
      window.controlsTest.stored().find((thread) => thread.id === 'thread-a').turnStatus ===
      'completed',
  )
  const parentBefore = await page.evaluate(() => {
    const thread = window.controlsTest.stored().find((thread) => thread.id === 'thread-a')
    return {
      turnStatus: thread.turnStatus,
      messages: thread.messages
        .filter((message) => !message.agentId && ['user', 'assistant'].includes(message.role))
        .map(({ id, finishStatus, finishedAt }) => ({ id, finishStatus, finishedAt })),
    }
  })
  const stop = page.getByRole('button', {
    name: 'Stop agent and pause queued messages',
    exact: true,
  })
  await stop.waitFor()
  assert.equal(
    await page.getByRole('button', { name: 'Send message', exact: true }).isVisible(),
    true,
  )
  await stop.click()
  await page.waitForFunction(() => window.controlsTest.records.stops.length === 1)
  await stop.waitFor({ state: 'hidden' })
  await page.waitForFunction(() =>
    window.controlsTest
      .stored()
      .find((thread) => thread.id === 'thread-a')
      .messages.some(
        (message) => message.agentId === 'native-live-child' && message.status === 'interrupted',
      ),
  )
  const parentAfter = await page.evaluate(() => {
    const thread = window.controlsTest.stored().find((thread) => thread.id === 'thread-a')
    return {
      turnStatus: thread.turnStatus,
      messages: thread.messages
        .filter((message) => !message.agentId && ['user', 'assistant'].includes(message.role))
        .map(({ id, finishStatus, finishedAt }) => ({ id, finishStatus, finishedAt })),
    }
  })
  assert.equal(parentBefore.turnStatus, 'completed')
  assert.ok(parentBefore.messages.length > 0)
  assert.ok(parentBefore.messages.every((message) => message.finishStatus === 'completed'))
  assert.deepEqual(parentAfter, parentBefore)
  assert.deepEqual(await page.evaluate(() => window.controlsTest.records.stops), ['thread-a'])
  checks.push(
    'An idle completed parent with a running child still exposes Stop, calls the backend, and preserves the parent completed-turn marker',
  )
  await writeFile(join(artifacts, 'checks.json'), JSON.stringify({ checks }, null, 2))
}

async function fluidityChecks(page, checks, settle) {
  const directory = resolve(__dirname, '../output/playwright/app-fluidity')
  await mkdir(directory, { recursive: true })
  await page.waitForFunction(() => document.querySelectorAll('.thread-row').length >= 400)
  await page.waitForTimeout(700)
  await settle()
  assert.ok(
    await page.evaluate(() => window.controlsTest.metrics.sidebarRowRenders >= 408),
    'The actual SidebarThread render probe must observe the initial saved rows',
  )
  const summarize = async (label, started) => {
    const metrics = await page.evaluate(() => window.controlsTest.metrics)
    const durations = metrics.commits.map((commit) => commit.actualDuration).sort((a, b) => a - b)
    return {
      label,
      elapsedMs: Math.round(performance.now() - started),
      sidebarRowRenders: metrics.sidebarRowRenders,
      historyTextReads: metrics.historyTextReads,
      commits: durations.length,
      totalRenderMs: Math.round(durations.reduce((sum, value) => sum + value, 0)),
      worstRenderMs: Math.round(durations.at(-1) || 0),
    }
  }
  const composer = page.getByRole('textbox', { name: 'Message your coding agent', exact: true })
  await composer.focus()
  await page.evaluate(() => window.controlsTest.resetMetrics())
  let started = performance.now()
  await composer.pressSequentially('Fluid input', { delay: 20 })
  await settle()
  const typing = await summarize('Typing with 400 retained conversations', started)
  assert.equal(await composer.inputValue(), 'Fluid input')
  assert.equal(await page.locator('.thread-row').count(), 408)
  if (!fluidityBaseline) {
    assert.equal(
      typing.historyTextReads,
      0,
      'A closed Find a thread dialog must not scan any saved message text while typing',
    )
    assert.equal(
      typing.sidebarRowRenders,
      0,
      'Unchanged sidebar rows must not rerender for composer edits',
    )
  }
  checks.push(
    'Typing a literal draft preserves all 408 sidebar threads without scanning closed search history or rerendering unchanged rows',
  )

  await page.evaluate(() => window.controlsTest.resetMetrics())
  started = performance.now()
  await page.evaluate(() => {
    const test = window.controlsTest
    test.emit('fluidity-thread-123')
    for (let index = 0; index < 80; index++)
      test.emit('fluidity-thread-123', 'text', {
        itemId: 'background-stream',
        text: 'Background delta ' + index + '. ',
      })
  })
  await page.waitForTimeout(45)
  await settle()
  const streaming = await summarize('80 background provider deltas', started)
  assert.equal(await composer.inputValue(), 'Fluid input')
  assert.match(
    await page.locator('.thread-row.active').getAttribute('aria-label'),
    /^Thread Alpha,/,
  )
  if (!fluidityBaseline) {
    assert.equal(streaming.historyTextReads, 0)
    assert.ok(
      streaming.sidebarRowRenders <= 8,
      'Only the changed background row may rerender for a token batch',
    )
  }
  checks.push(
    'A burst of 80 provider deltas to a background thread preserves the current conversation and draft, and updates only the affected row',
  )

  await page.evaluate(() => window.controlsTest.resetMetrics())
  started = performance.now()
  await page.getByRole('button', { name: 'Research', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.app-shell').dataset.view === 'investigation',
  )
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.thread-row').length >= 400)
  await composer.waitFor()
  await settle()
  const switching = await summarize('Research and Agents view switches', started)
  assert.equal(await composer.inputValue(), 'Fluid input')
  assert.match(
    await page.locator('.thread-row.active').getAttribute('aria-label'),
    /^Thread Alpha,/,
  )
  checks.push(
    'Switching Research and Agents retains the active conversation and exact draft with hundreds of saved threads',
  )

  const arranged = page
    .locator('.thread-card-shell')
    .filter({ has: page.getByRole('button', { name: /^Saved thread 42,/ }) })
  await arranged.getByRole('button', { name: /^Saved thread 42,/ }).click()
  await settle()
  await page.getByRole('button', { name: /^Reasoning:.*speed:/ }).click()
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
  await page.waitForFunction(() => window.controlsTest.records.configure.length === 1)
  assert.equal(
    await page.evaluate(() => window.controlsTest.records.configure[0].sessionId),
    'fluidity-thread-42',
  )
  await page.getByRole('combobox', { name: 'Model: Test model', exact: true }).click()
  await page.getByRole('option', { name: 'Updated model', exact: true }).click()
  await page.waitForFunction(() => window.controlsTest.records.configure.length === 2)
  assert.equal(
    await page.evaluate(() => window.controlsTest.records.configure[1].model),
    'updated-test-model',
  )
  await page.getByRole('button', { name: /^Thread Alpha,/ }).click()
  assert.equal(await composer.inputValue(), 'Fluid input')
  await arranged.getByRole('button', { name: 'Settle', exact: true }).click()
  await page.getByText('Settled (1)', { exact: true }).click()
  await arranged.getByRole('button', { name: /^Saved thread 42,/ }).click()
  await settle()
  assert.match(
    await page.getByRole('button', { name: /^Reasoning:.*speed:/ }).getAttribute('aria-label'),
    /Reasoning: High/,
    'The memoized row selects its newest thread and restores its saved reasoning setting',
  )
  assert.equal(
    await page.getByRole('combobox', { name: 'Model: Updated model', exact: true }).count(),
    1,
  )
  // A pointer hover on another row may remain open alongside this row's focus card.
  await page.getByRole('button', { name: /^Thread Alpha,/ }).hover()
  await page
    .locator('.life-thread-hover-title')
    .getByText('Thread Alpha', { exact: true })
    .waitFor()
  await composer.focus()
  await arranged.getByRole('button', { name: /^Saved thread 42,/ }).focus()
  const hover = page.locator('.life-thread-hover').filter({
    has: page.locator('.life-thread-hover-title').filter({ hasText: /^Saved thread 42$/ }),
  })
  await hover.getByText('updated-test-model', { exact: true }).waitFor()
  assert.match(await hover.textContent(), /Reasoning: high/)
  await arranged.getByRole('button', { name: 'Restore', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.project-list .thread-row').length === 408,
  )
  await page.getByRole('button', { name: /^Thread Alpha,/ }).click()
  assert.equal(await composer.inputValue(), 'Fluid input')
  checks.push(
    'Memoized sidebar selection, hover details and Settle/Restore use current model and reasoning settings after live configuration, and preserve a different thread’s draft',
  )

  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Find a thread', exact: true })
  await search
    .getByRole('textbox', { name: 'Search saved threads', exact: true })
    .fill('NEEDLE-TARGET')
  const match = search.locator('.search-results > button')
  await page.waitForFunction(
    () => document.querySelectorAll('.search-modal .search-results > button').length === 1,
  )
  assert.match(await match.textContent(), /Saved thread 250/)
  assert.ok(
    await page.evaluate(() => window.controlsTest.metrics.historyTextReads >= 32000),
    'The real full-text probe must observe retained messages when Find a thread is open',
  )
  await page.evaluate(() =>
    window.controlsTest.emit('fluidity-thread-250', 'title', { title: 'Native renamed thread' }),
  )
  await page.waitForFunction(() =>
    document
      .querySelector('.search-results > button')
      ?.textContent.includes('Native renamed thread'),
  )
  await search
    .getByRole('textbox', { name: 'Search saved threads', exact: true })
    .fill('Saved thread 250')
  await search.getByText('No matching threads. Try another search.', { exact: true }).waitFor()
  await search
    .getByRole('textbox', { name: 'Search saved threads', exact: true })
    .fill('NEEDLE-TARGET')
  await match.waitFor()
  await match.click()
  await search.waitFor({ state: 'hidden' })
  assert.match(
    await page.locator('.thread-row.active').getAttribute('aria-label'),
    /^Native renamed thread,/,
  )
  assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
  checks.push(
    'Open global search finds exact saved message content case-insensitively, immediately reflects a native rename, and selects the latest thread without starting an agent',
  )

  await page.getByRole('button', { name: 'Thread actions', exact: true }).click()
  await page.keyboard.press('Control+k')
  await search
    .getByRole('textbox', { name: 'Search saved threads', exact: true })
    .fill('NEEDLE-TARGET')
  await match.waitFor()
  // Invoke the actual deletion handler while its open search retains a filtered result.
  await page.evaluate(() => {
    const action = [...document.querySelectorAll('.thread-menu button')].find(
      (button) => button.textContent.trim() === 'Delete thread',
    )
    if (!action || action.disabled) throw new Error('The native idle thread must be deletable')
    action.click()
  })
  await search.getByText('No matching threads. Try another search.', { exact: true }).waitFor()
  assert.equal(await match.count(), 0)
  assert.equal(await page.getByRole('button', { name: /^Native renamed thread,/ }).count(), 0)
  await search.getByRole('button', { name: 'Close dialog', exact: true }).click()
  checks.push(
    'Deleting a saved thread through the App action invalidates a still-open full-text search result immediately',
  )

  await page.keyboard.press('Control+,')
  const connections = page.getByRole('dialog', { name: 'Connect a machine', exact: true })
  await connections.locator('.saved-profile > button').filter({ hasText: 'Test machine' }).click()
  await connections
    .getByRole('textbox', { name: 'Machine name optional', exact: true })
    .fill('Edited machine')
  await connections
    .getByRole('textbox', { name: 'Hostname or IP', exact: true })
    .fill('fresh.example')
  await connections.getByRole('button', { name: 'Save profile', exact: true }).click()
  await connections.getByText('Connection profile saved.', { exact: true }).waitFor()
  await connections.getByRole('button', { name: 'New machine', exact: true }).click()
  await connections
    .getByRole('textbox', { name: 'Machine name optional', exact: true })
    .fill('Added machine')
  await connections
    .getByRole('textbox', { name: 'Hostname or IP', exact: true })
    .fill('added.example')
  await connections.getByRole('textbox', { name: 'Username', exact: true }).fill('newuser')
  await connections
    .getByRole('combobox', { name: 'Authentication', exact: true })
    .selectOption('agent')
  await connections.getByRole('button', { name: 'Save profile', exact: true }).click()
  await connections.getByText('Connection profile saved.', { exact: true }).waitFor()
  await connections.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const alpha = page.getByRole('button', { name: /^Thread Alpha,/ })
  assert.equal(
    await alpha.locator('.thread-cloud-icon').getAttribute('aria-label'),
    'fresh.example',
  )
  await page.locator('.project-heading').filter({ hasText: 'Added machine' }).click()
  await connections.waitFor()
  assert.equal(
    await connections.getByRole('textbox', { name: 'Hostname or IP', exact: true }).inputValue(),
    'added.example',
  )
  assert.equal(
    await connections.getByRole('textbox', { name: 'Username', exact: true }).inputValue(),
    'newuser',
  )
  await connections.getByRole('button', { name: 'Close dialog', exact: true }).click()
  checks.push(
    'Saving an edited profile refreshes existing row host details, and a newly saved machine opens its exact latest connection profile from the sidebar',
  )

  if (!fluidityBaseline) {
    const alphaAge = alpha.locator('time')
    assert.equal(await alphaAge.textContent(), 'Now')
    const currentTime = await page.evaluate(() => Date.now())
    await settle()
    await page.evaluate(() => window.controlsTest.resetMetrics())
    await page.clock.setFixedTime(currentTime + 120000)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('.thread-row')].find((button) =>
        button.getAttribute('aria-label')?.startsWith('Thread Alpha,'),
      )
      return row?.querySelector('time')?.textContent === '2m'
    })
    assert.equal(
      await page.evaluate(() => window.controlsTest.metrics.sidebarRowRenders),
      0,
      'A minute refresh updates age text without rerendering complete sidebar rows',
    )
    await page.getByRole('button', { name: /^Filters, sorting and arrangement/ }).click()
    const filters = page.getByRole('dialog', {
      name: 'Filters, sorting and arrangement',
      exact: true,
    })
    await filters.getByRole('combobox', { name: 'Arrange by', exact: true }).selectOption('date')
    await filters.getByRole('button', { name: 'Done', exact: true }).click()
    await page
      .locator('.sidebar-project-thread-heading h3')
      .filter({ hasText: /^Today$/ })
      .waitFor()
    const tomorrow = new Date(currentTime)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 1, 0, 0)
    await page.clock.setFixedTime(tomorrow)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page
      .locator('.sidebar-project-thread-heading h3')
      .filter({ hasText: /^Yesterday$/ })
      .waitFor()
    assert.equal(
      await page
        .locator('.sidebar-project-thread-heading h3')
        .filter({ hasText: /^Today$/ })
        .count(),
      0,
    )
    checks.push(
      'Shared sidebar time updates idle age labels and Today/Yesterday groups after resumed local time without any thread or provider event',
    )
  }

  const proof = {
    baseline: fluidityBaseline,
    savedThreads: 408,
    retainedMessages: 32000,
    typing,
    streaming,
    switching,
    checks,
  }
  await writeFile(
    join(directory, fluidityBaseline ? 'before.json' : 'after.json'),
    JSON.stringify(proof, null, 2),
  )
  console.log(JSON.stringify(proof, null, 2))
}

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-app-live-controls-'))
  const checks = []
  const errors = []
  let browser
  let server
  let page
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'app-live-controls-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { Profiler } from 'react'
          import {createRoot} from 'react-dom/client'
          import {App} from './src/renderer/App'
          import {defaultLifeConfig} from './src/shared/customization'
          import './src/renderer/styles.css'
          window.testConfig = {...defaultLifeConfig, workspacePanel:false}
          createRoot(document.getElementById('root')).render(<React.StrictMode>${fluidity ? '<Profiler id="Life App" onRender={(id, phase, actualDuration, baseDuration) => window.controlsTest.metrics.commits.push({phase,actualDuration,baseDuration})}><App/></Profiler>' : '<App/>'}</React.StrictMode>)
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: {
        'process.env.NODE_ENV': '"development"',
      },
      logLevel: 'silent',
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
      plugins: fluidity
        ? [
            {
              name: 'actual-app-fluidity-probes',
              setup(builder) {
                builder.onLoad({ filter: /(?:App|SidebarThread)\.tsx$/ }, async ({ path }) => {
                  let contents = await readFile(path, 'utf8')
                  if (path.endsWith('/SidebarThread.tsx')) {
                    assert.ok(
                      contents.includes('  const [hovered, setHovered]'),
                      'SidebarThread source must match the actual render probe',
                    )
                    contents = contents.replace(
                      '  const [hovered, setHovered]',
                      '  window.controlsTest.metrics.sidebarRowRenders++;\n  const [hovered, setHovered]',
                    )
                  } else {
                    assert.ok(
                      contents.includes('.messages.map((m) => m.text)'),
                      'App source must match the actual full-text search probe',
                    )
                    contents = contents.replaceAll(
                      '.messages.map((m) => m.text)',
                      '.messages.map((m) => { window.controlsTest.metrics.historyTextReads++; return m.text })',
                    )
                  }
                  return { contents, loader: 'tsx' }
                })
              },
            },
          ]
        : [],
    })
    server = createServer(async (request, response) => {
      const file =
        request.url === '/fixture.js'
          ? 'fixture.js'
          : request.url === '/fixture.css'
            ? 'fixture.css'
            : undefined
      response.setHeader(
        'Content-Type',
        file?.endsWith('.js')
          ? 'text/javascript'
          : file?.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      )
      response.end(
        file
          ? await readFile(join(directory, file))
          : '<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      ({ historyHydration, providerUtilities, fluidity }) => {
        const profile = {
          id: 'machine-test',
          name: 'Test machine',
          host: 'test.example',
          port: 22,
          username: 'tester',
          auth: 'agent',
          privateKeyPath: '',
          workspace: '/srv/project',
        }
        const connection = {
          status: 'connected',
          profile,
          home: '/home/tester',
          workspace: profile.workspace,
          codex: '0.161.0',
          claude: '2.1.0',
        }
        const listeners = new Set()
        const connectionListeners = new Set()
        const providerUpdateListeners = new Set()
        const records = {
          steering: [],
          configure: [],
          starts: [],
          stateReads: 0,
          heldStateReads: 0,
          heldWrites: 0,
          historyLoads: 0,
          historySaves: [],
          stops: [],
          providerUpdateReads: [],
          providerUpdateChecks: [],
          usageReads: [],
        }
        const pendingProviderReads = []
        const pendingProviderChecks = []
        const pendingUsageReads = []
        let holdState = false
        let holdWrites = false
        const states = []
        const writes = []
        const configurations = []
        const off = () => () => {}
        const emptySource = {
          revision: 0,
          enabled: false,
          canRollback: false,
          path: '',
          recovered: false,
          extensions: [],
          builtInRevision: 0,
        }
        const emptyExtensions = {
          extensions: [],
          revision: 0,
          path: '',
          errors: {},
          canRollback: [],
          recovered: false,
        }
        const thread = (id, title) => ({
          id,
          profileId: profile.id,
          workspace: profile.workspace,
          provider: 'codex',
          title,
          remoteId: 'remote-' + id,
          messages: [
            {
              id: id + '-request',
              role: 'user',
              text: 'Original request',
              ...(historyHydration && id === 'thread-a'
                ? {
                    attachments: [
                      {
                        id: 'hydration-attachment',
                        name: 'kept.txt',
                        mime: 'text/plain',
                        size: 11,
                      },
                    ],
                  }
                : {}),
              turn: 1,
              createdAt: Date.now(),
            },
          ],
          busy: false,
          model: 'test-model',
          reasoningEffort: 'medium',
          serviceTier: 'default',
          mode: 'review',
          updatedAt: Date.now(),
          turn: 1,
          pending: [],
        })
        const reservedCases = ['research', 'customization', 'metadata'].flatMap((purpose) =>
          ['marker', 'directory'].map((classification) => ({
            purpose,
            classification,
            id: `legacy-${purpose}-${classification}`,
          })),
        )
        const savedThreads = [
          thread('thread-a', 'Thread Alpha'),
          thread('thread-b', 'Thread Beta'),
          ...reservedCases.map((item) =>
            thread(item.id, `Legacy ${item.purpose} ${item.classification}`),
          ),
          { ...thread('verified-studio', 'Saved Studio conversation'), purpose: 'customization' },
        ]
        if (fluidity) {
          for (let index = 0; index < 400; index++) {
            const id = 'fluidity-thread-' + index
            savedThreads.push({
              ...thread(id, 'Saved thread ' + index),
              updatedAt: Date.now() - 1000 - index,
              messages: Array.from({ length: 80 }, (_, message) => ({
                id: id + ':message:' + message,
                role: message % 2 ? 'assistant' : 'user',
                text:
                  (index === 250 && message === 40 ? 'needle-target ' : '') +
                  'Retained provider output and coding discussion. '.repeat(6),
                turn: Math.floor(message / 2),
                finishStatus: 'completed',
                createdAt: 1000 + message,
                finishedAt: 2000 + message,
              })),
            })
          }
        }
        const otherProfile = {
          ...profile,
          id: 'machine-other',
          name: 'Second machine',
          host: 'second.example',
          workspace: '/srv/second',
        }
        let savedProfiles = providerUtilities ? [profile, otherProfile] : [profile]
        if (providerUtilities) {
          const usageMessage = (id, details, turn) => ({
            id,
            role: 'tool',
            kind: 'status',
            title: 'Usage and cost',
            text: 'Usage and cost',
            status: 'completed',
            details,
            turn,
            createdAt: turn * 100,
          })
          const codexUsage = (multiple, session = 'native-usage-codex') => ({
            usageSessionId: session,
            tokenUsage: {
              total: {
                inputTokens: 1000 * multiple,
                outputTokens: 200 * multiple,
                cachedInputTokens: 400 * multiple,
                reasoningOutputTokens: 100 * multiple,
                totalTokens: 1200 * multiple,
              },
              last: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
              modelContextWindow: 200000,
            },
          })
          const claudeUsage = (multiple) => ({
            usageSessionId: 'native-usage-claude',
            usageCallId: 'restored-call',
            usageRestoresSessionTotals: true,
            modelUsage: {
              'native-claude-model': {
                inputTokens: 700 * multiple,
                outputTokens: 150 * multiple,
                cacheReadInputTokens: 300 * multiple,
                cacheCreationInputTokens: 50 * multiple,
                thinkingTokens: 75 * multiple,
                costUSD: 0.12 * multiple,
                costBasis: 'list',
              },
            },
            total_cost_usd: 0.12 * multiple,
          })
          savedThreads[0].messages.push(
            usageMessage('codex-usage-first', codexUsage(1), 1),
            usageMessage('codex-usage-later', codexUsage(2), 2),
          )
          savedThreads[1].provider = 'claude'
          savedThreads[1].messages.push(
            usageMessage('claude-usage-first', claudeUsage(1), 1),
            usageMessage('claude-usage-later', claudeUsage(2), 2),
          )
          savedThreads.push({
            ...thread('usage-import-copy', 'Imported Alpha usage copy'),
            remoteId: 'remote-thread-a',
            messages: [usageMessage('codex-usage-copy', codexUsage(2), 2)],
          })
          savedThreads.push({
            ...thread('usage-other-machine', 'Second machine usage'),
            profileId: otherProfile.id,
            workspace: otherProfile.workspace,
            messages: [
              usageMessage(
                'other-machine-usage',
                {
                  usageSessionId: 'native-other',
                  tokenUsage: { total: { inputTokens: 400, outputTokens: 100, totalTokens: 500 } },
                },
                1,
              ),
            ],
          })
        }
        localStorage.setItem(
          'relay.threads.v1',
          JSON.stringify(fluidity ? savedThreads.slice(0, 9) : savedThreads),
        )
        const historyPages = reservedCases.map((item) => ({
          session: {
            id: 'codex:remote-' + item.id,
            provider: 'codex',
            remoteId: 'remote-' + item.id,
            title: `Native ${item.purpose} ${item.classification}`,
            workspace:
              item.classification === 'directory'
                ? connection.home + '/.life/' + item.purpose + '/reserved'
                : profile.workspace,
            ...(item.classification === 'marker' ? { lifePurpose: item.purpose } : {}),
            createdAt: 1,
            updatedAt: 2,
            source: 'cli',
          },
          messages: [
            {
              id: 'native:' + item.id,
              role: 'user',
              text: 'Native reserved transcript must never enter Agents.',
              turn: 1,
            },
          ],
          subagents: [],
          warnings: [],
        }))
        historyPages.push({
          session: {
            id: 'codex:remote-thread-b',
            provider: 'codex',
            remoteId: 'remote-thread-b',
            title: 'Native Beta newer transcript',
            workspace: profile.workspace,
            createdAt: 1,
            updatedAt: 2,
            source: 'cli',
          },
          messages: [
            {
              id: 'native:later-beta',
              role: 'user',
              text: 'New external content must not overwrite the saved Life transcript.',
              turn: 1,
            },
          ],
          subagents: [],
          warnings: [],
        })
        historyPages.push({
          session: {
            id: 'codex:remote-verified-studio',
            provider: 'codex',
            remoteId: 'remote-verified-studio',
            title: 'Native verified Studio',
            workspace: connection.home + '/.life/customization/saved',
            lifePurpose: 'customization',
            createdAt: 1,
            updatedAt: 2,
            source: 'cli',
          },
          messages: [],
          subagents: [],
          warnings: [],
        })
        for (const provider of ['codex', 'claude']) {
          historyPages.push({
            session: {
              id: `${provider}:external-${provider}`,
              provider,
              remoteId: `external-${provider}`,
              title: `External ${provider} conversation`,
              workspace: profile.workspace,
              createdAt: 1,
              updatedAt: 2,
              source: 'cli',
            },
            messages: [
              {
                id: `${provider}:external-user`,
                role: 'user',
                text: `Earlier ${provider} request.`,
                turn: 1,
              },
            ],
            subagents: [],
            warnings: [],
          })
        }
        localStorage.setItem('life.active-thread.v1', 'thread-a')
        const originalTransaction = IDBDatabase.prototype.transaction
        IDBDatabase.prototype.transaction = function (...args) {
          const transaction = originalTransaction.apply(this, args)
          if (!holdWrites || args[1] !== 'readwrite') return transaction
          let complete
          transaction.addEventListener('complete', (event) => {
            records.heldWrites++
            writes.push(() => complete?.call(transaction, event))
          })
          return new Proxy(transaction, {
            set(target, key, value) {
              if (key === 'oncomplete') {
                complete = value
                return true
              }
              return Reflect.set(target, key, value, target)
            },
            get(target, key) {
              const value = Reflect.get(target, key, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }
        window.relay = {
          platform: 'win32',
          onAgent: (callback) => {
            listeners.add(callback)
            return () => listeners.delete(callback)
          },
          onConnection: (callback) => {
            connectionListeners.add(callback)
            return () => connectionListeners.delete(callback)
          },
          onHostKey: off,
          profiles: {
            list: async () => structuredClone(savedProfiles),
            save: async (input) => {
              savedProfiles = [
                ...savedProfiles.filter((item) => item.id !== input.id),
                structuredClone(input),
              ]
            },
          },
          sshConfig: { list: async () => ({ path: '/home/tester/.ssh/config', hosts: [] }) },
          connection: {
            state: async () => {
              records.stateReads++
              if (holdState) {
                records.heldStateReads++
                await new Promise((resolve) => states.push(resolve))
              }
              return structuredClone(connection)
            },
            execute: async (input) =>
              input.command.includes('LIFE_ATTACHMENT_DIR=')
                ? 'LIFE_BASE64=-d\nLIFE_ATTACHMENT_DIR=/tmp/life-thread-attachments.ABCDEF\n'
                : input.command.includes('LIFE_ATTACHMENT_OK')
                  ? 'LIFE_ATTACHMENT_OK'
                  : 'LIFE_BRANCH=main\nLIFE_PR=',
            selectWorkspace: async () => structuredClone(connection),
            cancel: async () => {},
          },
          agent: {
            models: async () => [
              {
                id: 'test-model',
                name: 'Test model',
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Medium' },
                  { reasoningEffort: 'high', description: 'High' },
                ],
                serviceTiers: [
                  { id: 'default', name: 'Default' },
                  { id: 'fast', name: 'Fast' },
                ],
              },
              ...(fluidity
                ? [
                    {
                      id: 'updated-test-model',
                      name: 'Updated model',
                      defaultReasoningEffort: 'medium',
                      supportedReasoningEfforts: [
                        { reasoningEffort: 'medium', description: 'Medium' },
                        { reasoningEffort: 'high', description: 'High' },
                      ],
                      serviceTiers: [{ id: 'default', name: 'Default' }],
                    },
                  ]
                : []),
            ],
            steer: async (input) => {
              records.steering.push(structuredClone(input))
            },
            configure: (input) => {
              records.configure.push(structuredClone(input))
              return new Promise((resolve, reject) => configurations.push({ resolve, reject }))
            },
            start: async (input) => {
              records.starts.push(structuredClone(input))
            },
            stop: async (sessionId) => {
              records.stops.push(sessionId)
              if (providerUtilities)
                listeners.forEach((fn) =>
                  fn({
                    sessionId,
                    type: 'complete',
                    status: 'interrupted',
                    agentId: 'native-live-child',
                    itemId: 'child-run',
                  }),
                )
            },
            dispose: async () => {},
            ...(providerUtilities
              ? {
                  usage: (provider) => {
                    records.usageReads.push({ provider, profileId: connection.profile.id })
                    return new Promise((resolve, reject) =>
                      pendingUsageReads.push({ resolve, reject }),
                    )
                  },
                }
              : {}),
          },
          customization: {
            get: async () => ({ config: window.testConfig, revision: 0, canUndo: false, path: '' }),
            onChange: off,
          },
          extensions: {
            get: async () => emptyExtensions,
            onState: off,
            onRecovery: off,
            capabilities: [],
          },
          sourceCode: { get: async () => emptySource, onState: off },
          updates: {
            get: async () => ({ status: 'unsupported', currentVersion: '0.7.0' }),
            onState: off,
          },
          window: { state: async () => false, onState: off },
          forwarding: {
            get: async () => ({ enabled: false, active: false, ports: [] }),
            onState: off,
          },
          hostHistory: {
            list: async () => ({
              sessions: historyPages.map((page) => structuredClone(page.session)),
              warnings: [],
            }),
            read: async (input) =>
              structuredClone(historyPages.find((page) => page.session.id === input.id)),
            cancel: async () => {},
          },
        }
        window.controlsTest = {
          records,
          metrics: { sidebarRowRenders: 0, historyTextReads: 0, commits: [] },
          resetMetrics: () => {
            window.controlsTest.metrics = { sidebarRowRenders: 0, historyTextReads: 0, commits: [] }
          },
          emit: (id, type = 'status', extra = {}) =>
            listeners.forEach((fn) => fn({ sessionId: id, type, status: 'running', ...extra })),
          holdState: (value) => {
            holdState = value
          },
          releaseStates: () => {
            holdState = false
            for (const resolve of states.splice(0)) resolve()
          },
          holdWrites: (value) => {
            holdWrites = value
          },
          releaseWrites: () => {
            holdWrites = false
            for (const resolve of writes.splice(0)) resolve()
          },
          resolveConfiguration: (index, note) =>
            configurations[index].resolve({ applied: 'live', note }),
          rejectConfiguration: (index, message) => configurations[index].reject(new Error(message)),
          stored: () => JSON.parse(localStorage.getItem('relay.threads.v1')),
          emitConnection: (machine = 'primary', connected = true, profileOverrides = {}) => {
            Object.assign(connection, {
              status: connected ? 'connected' : 'disconnected',
              profile: { ...(machine === 'primary' ? profile : otherProfile), ...profileOverrides },
              home: machine === 'primary' ? '/home/tester' : '/home/second',
              workspace: machine === 'primary' ? profile.workspace : otherProfile.workspace,
            })
            connectionListeners.forEach((fn) => fn(structuredClone(connection)))
          },
          accountIdentity: (machine = 'primary') => {
            const account =
              machine === 'connected'
                ? connection.profile
                : machine === 'primary'
                  ? profile
                  : otherProfile
            return JSON.stringify([account.host, account.port, account.username])
          },
          usageSnapshot: (provider, usedPercent, fetchedAt, machine = 'primary') => ({
            provider,
            status: 'available',
            fetchedAt,
            machineIdentity: window.controlsTest.accountIdentity(machine),
            limits: [
              {
                id: 'native-limit',
                label: 'Native account window',
                primary: { usedPercent, windowDurationMins: 300, resetsAt: 2000000000 },
              },
            ],
          }),
          resolveUsage: (index, value) => pendingUsageReads[index].resolve(structuredClone(value)),
          rejectUsage: (index, message) => pendingUsageReads[index].reject(new Error(message)),
          providerUpdatesState: (latest = '0.162.0', checking = false) => ({
            connected: connection.status === 'connected',
            machineId: JSON.stringify([
              connection.profile.host.toLowerCase(),
              connection.profile.port,
              connection.profile.username,
              connection.home,
            ]),
            machineLabel: connection.profile.name,
            checking,
            providers: [
              {
                provider: 'codex',
                status: latest === connection.codex ? 'current' : 'update-available',
                installedVersion: connection.codex,
                latestVersion: latest,
                stale: false,
              },
              {
                provider: 'claude',
                status: 'current',
                installedVersion: connection.claude,
                latestVersion: connection.claude,
                stale: false,
              },
            ],
          }),
          emitProviderUpdates: (state) =>
            providerUpdateListeners.forEach((fn) => fn(structuredClone(state))),
          resolveProviderRead: (index, state) =>
            pendingProviderReads[index].resolve(structuredClone(state)),
          resolveProviderCheck: (index, state) =>
            pendingProviderChecks[index].resolve(structuredClone(state)),
          rejectProviderCheck: (index, message) =>
            pendingProviderChecks[index].reject(new Error(message)),
        }
        if (providerUtilities)
          window.relay.providerUpdates = {
            get: () => {
              records.providerUpdateReads.push(true)
              return new Promise((resolve, reject) =>
                pendingProviderReads.push({ resolve, reject }),
              )
            },
            onState: (callback) => {
              providerUpdateListeners.add(callback)
              return () => providerUpdateListeners.delete(callback)
            },
            check: () => {
              records.providerUpdateChecks.push({ profileId: connection.profile.id })
              window.controlsTest.emitProviderUpdates(
                window.controlsTest.providerUpdatesState('0.162.0', true),
              )
              return new Promise((resolve, reject) =>
                pendingProviderChecks.push({ resolve, reject }),
              )
            },
          }
        if (historyHydration) {
          let releaseHistory
          let rejectHistory
          let historyFailure
          const pendingHistory = new Promise((resolve, reject) => {
            releaseHistory = resolve
            rejectHistory = reject
          })
          window.relay.conversations = {
            load: () => {
              records.historyLoads++
              return pendingHistory
            },
            save: async (threads, savedAt) => {
              if (historyFailure) throw historyFailure
              records.historySaves.push({ threads: structuredClone(threads), savedAt })
            },
          }
          window.controlsTest.releaseHistory = () =>
            releaseHistory({
              version: 1,
              savedAt: Date.now(),
              threads: structuredClone(savedThreads),
            })
          window.controlsTest.rejectHistory = () => {
            historyFailure = new Error('Unreadable original native history was preserved')
            rejectHistory(historyFailure)
          }
        }
        if (fluidity)
          window.relay.conversations = {
            load: async () => ({
              version: 1,
              savedAt: Date.now(),
              threads: structuredClone(savedThreads),
            }),
            save: async (threads, savedAt) =>
              records.historySaves.push({ threadCount: threads.length, savedAt }),
          }
      },
      { historyHydration, providerUtilities, fluidity },
    )
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const settle = async () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    if (historyHydration) {
      await page.getByText('Loading saved conversations…', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: /^Thread Alpha, OpenAI/ }).count(), 0)
      assert.equal(
        await page.getByRole('button', { name: 'Thread actions', exact: true }).count(),
        0,
      )
      assert.equal(await page.locator('.app-body').getAttribute('inert'), '')
      await page.keyboard.press('Control+n')
      assert.equal(await page.evaluate(() => window.controlsTest.records.historySaves.length), 0)
      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('life-thread-attachments', 1)
          request.onupgradeneeded = () =>
            request.result.createObjectStore('files', { keyPath: 'id' })
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readwrite')
          tx.objectStore('files').put({
            id: 'hydration-attachment',
            blob: new Blob(['proof bytes']),
          })
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        })
        db.close()
        window.controlsTest.releaseHistory()
      })
      await page.getByRole('button', { name: /^Thread Alpha, OpenAI/ }).waitFor()
      assert.equal(await page.locator('.app-body').getAttribute('inert'), null)
      assert.equal(await page.evaluate(() => window.controlsTest.records.historyLoads), 1)
      const attachment = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('life-thread-attachments', 1)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const value = await new Promise((resolve, reject) => {
          const request = db
            .transaction('files', 'readonly')
            .objectStore('files')
            .get('hydration-attachment')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        db.close()
        return value ? value.blob.text() : null
      })
      assert.equal(attachment, 'proof bytes')
      await page.getByRole('button', { name: 'Thread actions', exact: true }).click()
      assert.equal(
        await page.getByRole('button', { name: 'Delete thread', exact: true }).isEnabled(),
        true,
      )
      checks.push(
        'Held native hydration exposes no editable cached threads, writes no history, preserves attachment blobs, and consumes one StrictMode load',
      )
      await page.reload()
      await page.getByText('Loading saved conversations…', { exact: true }).waitFor()
      await page.evaluate(() => window.controlsTest.rejectHistory())
      await page.getByRole('button', { name: /^Thread Alpha, OpenAI/ }).waitFor()
      assert.equal(await page.locator('.app-body').getAttribute('inert'), null)
      await page.evaluate(() => window.__lifeFlushConversationHistory())
      assert.equal(await page.evaluate(() => window.controlsTest.records.historySaves.length), 0)
      assert.ok(
        (await page.evaluate(() => window.controlsTest.stored())).some(
          (thread) => thread.id === 'thread-a',
        ),
      )
      checks.push(
        'Failed native loading restores usable local cached history without accepting a replacement disk checkpoint',
      )
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify(
          { ok: true, historyHydration: true, checks, browserErrors: errors },
          null,
          2,
        ),
      )
      return
    }
    await page.getByRole('textbox', { name: 'Message your coding agent' }).waitFor()
    await page.waitForFunction(() => window.controlsTest.records.stateReads >= 2)
    await settle()
    if (presentation) {
      await presentationChecks(page, checks)
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify({ ok: true, presentation: true, checks, browserErrors: errors }, null, 2),
      )
      return
    }
    if (providerUtilities) {
      await providerUtilitiesChecks(page, checks, settle)
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify(
          { ok: true, providerUtilities: true, checks, browserErrors: errors },
          null,
          2,
        ),
      )
      return
    }
    if (fluidity) {
      await fluidityChecks(page, checks, settle)
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify(
          { ok: true, fluidity: true, baseline: fluidityBaseline, checks, browserErrors: errors },
          null,
          2,
        ),
      )
      return
    }
    await page.evaluate(() => window.controlsTest.emit('thread-a'))
    await page.getByRole('button', { name: 'Steer current response', exact: true }).waitFor()
    const literal = '  Exact steering text.\n\nNo extra words.  '
    await page.getByRole('textbox', { name: 'Message your coding agent' }).fill(literal)
    await page.evaluate(() => {
      window.controlsTest.holdState(true)
      const button = document.querySelector('.send-button.steer-send')
      button.click()
      button.click()
    })
    await page.waitForFunction(() => window.controlsTest.records.heldStateReads >= 1)
    await settle()
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.heldStateReads),
      1,
      'Two rapid clicks acquire only one connection-state request',
    )
    await page.evaluate(() => window.controlsTest.releaseStates())
    await page.waitForFunction(() => window.controlsTest.records.steering.length === 1)
    await settle()
    assert.equal(await page.evaluate(() => window.controlsTest.records.steering[0].prompt), literal)
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    checks.push(
      'Rapid double steering during a delayed connection read sends the literal draft exactly once',
    )

    await page.locator('input[type="file"]').setInputFiles({
      name: 'held-attachment.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Real IndexedDB payload'),
    })
    await page.getByText('Uploaded · ready to send', { exact: true }).waitFor()
    await page
      .getByRole('textbox', { name: 'Message your coding agent' })
      .fill('  Steer with the real attachment.\n')
    await page.evaluate(() => {
      window.controlsTest.holdWrites(true)
      const button = document.querySelector('.send-button.steer-send')
      button.click()
      button.click()
    })
    await page.waitForFunction(() => window.controlsTest.records.heldWrites >= 1)
    await settle()
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.heldWrites),
      1,
      'The steering mutex is held before saving attachments',
    )
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.steering.length),
      1,
      'Steering waits for durable IndexedDB attachment storage',
    )
    await page.evaluate(() => window.controlsTest.releaseWrites())
    await page.waitForFunction(() => window.controlsTest.records.steering.length === 2)
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.steering[1].attachments.length),
      1,
    )
    checks.push(
      'Rapid double steering during delayed real IndexedDB storage sends one attachment request',
    )

    const chooseEffort = async (name) => {
      await page.getByRole('button', { name: /^Reasoning:.*speed:/ }).click()
      await page.getByRole('menuitemradio', { name, exact: true }).click()
    }
    await chooseEffort('High')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 1)
    await page.getByRole('button', { name: /^Thread Beta, OpenAI/ }).click()
    await settle()
    await page.evaluate(() => window.controlsTest.resolveConfiguration(0, 'OLD ALPHA NOTICE'))
    await settle()
    assert.equal(await page.getByText('OLD ALPHA NOTICE', { exact: true }).count(), 0)
    checks.push(
      'An acknowledged configuration for thread A does not appear after selecting thread B',
    )

    await page.evaluate(() => window.controlsTest.emit('thread-b'))
    await chooseEffort('High')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 2)
    await page.getByRole('button', { name: /^Thread Alpha, OpenAI/ }).click()
    await settle()
    await page.evaluate(() => window.controlsTest.rejectConfiguration(1, 'OLD BETA FAILURE'))
    await settle()
    assert.equal(await page.getByText('OLD BETA FAILURE', { exact: true }).count(), 0)
    checks.push('A rejected configuration for thread B does not appear after selecting thread A')

    await chooseEffort('Medium')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 3)
    await chooseEffort('High')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 4)
    await page.evaluate(() => window.controlsTest.resolveConfiguration(3, 'LATEST ALPHA NOTICE'))
    await settle()
    assert.equal(await page.locator('.run-settings-note').count(), 0)
    await page.evaluate(() =>
      window.controlsTest.resolveConfiguration(2, 'SUPERSEDED ALPHA NOTICE'),
    )
    await settle()
    assert.equal(await page.getByText('SUPERSEDED ALPHA NOTICE', { exact: true }).count(), 0)
    assert.equal(await page.getByText('LATEST ALPHA NOTICE', { exact: true }).count(), 0)
    checks.push(
      'Out-of-order acknowledgements stay quiet and preserve the latest selected settings',
    )

    const openNativeHistory = async (title) => {
      await page.getByRole('button', { name: 'Host chat history', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Host chat history', exact: true })
      await dialog.locator('.host-history-session').filter({ hasText: title }).click()
      await dialog
        .locator('.host-history-preview-header')
        .getByRole('button', { name: /^(Open in (Life|Research)|Bring to Life)$/ })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await settle()
    }
    for (const purpose of ['research', 'customization', 'metadata']) {
      for (const classification of ['marker', 'directory']) {
        await openNativeHistory(`Native ${purpose} ${classification}`)
        assert.match(
          await page.locator('.thread-row.active').getAttribute('aria-label'),
          /^Thread Alpha,/,
        )
        assert.equal(await page.locator('.app-shell').getAttribute('data-view'), 'workspace')
        assert.equal(
          await page.evaluate(() => localStorage.getItem('life.active-thread.v1')),
          'thread-a',
        )
        assert.equal(
          await page.locator('.toast').count(),
          1,
          'Reserved native session reports its owning domain',
        )
        const expected =
          purpose === 'research'
            ? 'Research'
            : purpose === 'customization'
              ? 'Life Studio'
              : 'internal conversation-title task'
        assert.ok((await page.locator('.toast').innerText()).includes(expected))
      }
      checks.push(
        `Legacy ${purpose} native history cannot bypass its reserved domain using a matching unclassified Life thread`,
      )
    }
    await openNativeHistory('Native Beta newer transcript')
    assert.match(
      await page.locator('.thread-row.active').getAttribute('aria-label'),
      /^Thread Beta,/,
    )
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.active-thread.v1')),
      'thread-b',
    )
    assert.equal(await page.locator('[data-message-id="thread-b-request"]').count(), 1)
    assert.equal(
      await page
        .getByText('New external content must not overwrite the saved Life transcript.', {
          exact: true,
        })
        .count(),
      0,
    )
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    checks.push(
      'Opening ordinary existing host history reuses its saved Life thread and preserves its transcript',
    )
    await openNativeHistory('Native verified Studio')
    assert.equal(await page.locator('.app-shell').getAttribute('data-view'), 'workspace')
    await page.getByRole('dialog', { name: 'Customize Life', exact: true }).waitFor()
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.active-thread.v1')),
      'thread-b',
    )
    assert.equal(
      await page.getByRole('button', { name: /^Saved Studio conversation, OpenAI/ }).count(),
      0,
    )
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    checks.push(
      'Verified Studio history keeps its dedicated route without creating or selecting an Agents thread',
    )
    assert.deepEqual(errors, [])
    const proof = {
      ok: true,
      checks,
      browserErrors: errors,
      records: await page.evaluate(() => window.controlsTest.records),
    }
    if (process.env.LIFE_APP_CONTROLS_PROOF)
      await writeFile(process.env.LIFE_APP_CONTROLS_PROOF, JSON.stringify(proof, null, 2))
    console.log(JSON.stringify(proof, null, 2))
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          browserErrors: errors,
          checks,
          text: page ? (await page.locator('body').innerText()).slice(0, 10000) : '',
        },
        null,
        2,
      ),
    )
    throw error
  } finally {
    await browser?.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
