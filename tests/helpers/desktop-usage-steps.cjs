/* Native usage coverage: real Electron IPC, SSH transport and retained provider events. */
const assert = require('node:assert/strict')
const { rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const providers = { codex: 'Codex', claude: 'Claude Code' }
const tokenKeys = ['input', 'output', 'cached', 'creation', 'reasoning', 'total']

async function openUsageDialog(page) {
  await page.getByRole('button', { name: 'Usage', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Usage', exact: true })
  // The deferred loading modal has the same name. Wait for actual content,
  // rather than treating that temporary modal as the loaded usage dashboard.
  await dialog.getByRole('region', { name: 'Account limits', exact: true }).waitFor()
  return dialog
}

// This oracle reads native wire fields directly. It never imports Life's usage
// normalizer or totals functions, so a renderer accounting bug cannot validate itself.
function nativeFacts(threads) {
  const sessions = new Map()
  for (const thread of threads) {
    for (const message of thread.messages) {
      const details = message.details || {}
      let tokens
      let cost
      if (thread.provider === 'codex' && details.tokenUsage?.total) {
        const raw = details.tokenUsage.total
        tokens = {
          input: raw.inputTokens,
          output: raw.outputTokens,
          cached: raw.cachedInputTokens,
          reasoning: raw.reasoningOutputTokens,
          total: raw.totalTokens,
        }
      } else if (thread.provider === 'claude' && details.modelUsage) {
        tokens = { input: 0, output: 0, cached: 0, creation: 0, reasoning: 0, total: 0 }
        let reasoningReported = false
        for (const raw of Object.values(details.modelUsage)) {
          const input = raw.inputTokens + raw.cacheReadInputTokens + raw.cacheCreationInputTokens
          tokens.input += input
          tokens.output += raw.outputTokens
          tokens.cached += raw.cacheReadInputTokens
          tokens.creation += raw.cacheCreationInputTokens
          if (raw.thinkingTokens !== undefined) {
            tokens.reasoning += raw.thinkingTokens
            reasoningReported = true
          }
          tokens.total += input + raw.outputTokens
        }
        if (!reasoningReported) delete tokens.reasoning
        cost = details.total_cost_usd
      } else continue
      const key = JSON.stringify([
        thread.profileId,
        thread.provider,
        details.usageSessionId || message.agentId || thread.remoteId || thread.id,
        details.usageRestoresSessionTotals === false ? details.usageCallId : undefined,
      ])
      const previous = sessions.get(key)
      const observedAt = details.usageObservedAt || message.createdAt
      const next = {
        key,
        provider: thread.provider,
        profileId: thread.profileId,
        threadId: thread.id,
        observedAt,
        tokens: { ...previous?.tokens },
        cost: cost === undefined ? previous?.cost : Math.max(cost, previous?.cost || 0),
      }
      for (const [name, count] of Object.entries(tokens)) {
        if (count !== undefined) {
          assert.ok(
            Number.isSafeInteger(count) && count >= 0,
            'Native fixture reports valid counts',
          )
          next.tokens[name] = Math.max(count, previous?.tokens[name] || 0)
        }
      }
      if (previous && previous.observedAt > observedAt) {
        next.threadId = previous.threadId
        next.observedAt = previous.observedAt
      }
      sessions.set(key, next)
    }
  }
  return [...sessions.values()]
}

function totalFacts(sessions) {
  const tokens = {}
  for (const key of tokenKeys) {
    const values = sessions
      .map((session) => session.tokens[key])
      .filter((value) => value !== undefined)
    if (values.length) tokens[key] = values.reduce((sum, value) => sum + value, 0)
  }
  const costs = sessions.map((session) => session.cost).filter((value) => value !== undefined)
  return {
    sessions: sessions.length,
    tokens,
    cost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : undefined,
  }
}

async function runUsageChecks(context) {
  const page = () => context.getPage()
  const readThreads = () =>
    page().evaluate(() => JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'))
  const usageMessages = (thread) =>
    thread.messages.filter((message) => message.details?.tokenUsage || message.details?.modelUsage)
  const proof = { ok: false, requests: [], providerEvents: {}, filters: [], accountSnapshots: {} }
  await context.workspace()
  const baseline = (await context.fixture.log()).length
  const probeTurn = async (provider, prompt, { fresh = false } = {}) => {
    if (fresh) await context.newThread(provider)
    await context.send(prompt)
    let thread
    await context.waitUntil(async () => {
      thread = (await readThreads()).find(
        (item) =>
          item.provider === provider &&
          item.messages.some((message) => message.role === 'user' && message.text === prompt),
      )
      return Boolean(thread && !thread.busy && usageMessages(thread).length)
    }, `Native ${provider} usage event is retained after ${prompt}`)
    proof.requests.push({ provider, prompt, threadId: thread.id })
    return thread
  }

  let claude = await probeTurn('claude', 'usage-probe Claude first measured turn', { fresh: true })
  const firstClaude = structuredClone(usageMessages(claude).at(-1).details)
  claude = await probeTurn('claude', 'usage-probe Claude second measured turn')
  const secondClaude = usageMessages(claude).at(-1).details
  assert.ok(usageMessages(claude).length >= 2, 'Both native Claude usage snapshots survive')
  const firstModels = Object.values(firstClaude.modelUsage)
  assert.equal(firstModels.length, 1, 'The deterministic Claude fixture reports one priced model')
  assert.deepEqual(
    [
      firstModels[0].inputTokens,
      firstModels[0].cacheReadInputTokens,
      firstModels[0].cacheCreationInputTokens,
      firstModels[0].outputTokens,
    ],
    [700, 300, 50, 150],
    'Native Claude model counts retain input, cache reads, cache creation and output',
  )
  assert.equal(firstClaude.total_cost_usd, 0.12)
  assert.equal(firstModels[0].thinkingTokens, 75)
  assert.equal(firstModels[0].costUSD, 0.12)
  assert.equal(
    firstModels[0].costBasis,
    'list',
    'The priced native model identifies its cost basis',
  )
  assert.deepEqual(
    [
      Object.values(secondClaude.modelUsage)[0].inputTokens,
      Object.values(secondClaude.modelUsage)[0].cacheReadInputTokens,
      Object.values(secondClaude.modelUsage)[0].cacheCreationInputTokens,
      Object.values(secondClaude.modelUsage)[0].outputTokens,
    ],
    [1400, 600, 100, 300],
    'The second Claude result reports cumulative session counters',
  )
  assert.equal(secondClaude.total_cost_usd, 0.24)
  assert.equal(
    Object.values(secondClaude.modelUsage)[0].thinkingTokens,
    150,
    'Cumulative Claude thinking tokens remain an output subset',
  )
  proof.providerEvents.claude = { first: firstClaude, second: secondClaude }

  let codex = await probeTurn('codex', 'usage-probe Codex first measured turn', { fresh: true })
  const firstCodex = structuredClone(usageMessages(codex).at(-1).details)
  assert.deepEqual(firstCodex.tokenUsage.total, {
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 400,
    reasoningOutputTokens: 100,
    totalTokens: 1200,
  })
  codex = await probeTurn('codex', 'usage-probe Codex repeated cumulative snapshot')
  const codexDetails = usageMessages(codex).at(-1).details
  assert.deepEqual(
    codexDetails.tokenUsage.total,
    {
      inputTokens: 2000,
      outputTokens: 400,
      cachedInputTokens: 800,
      reasoningOutputTokens: 200,
      totalTokens: 2400,
    },
    'Native Codex cumulative counts retain reasoning as an output subset',
  )
  assert.equal(codexDetails.tokenUsage.last.totalTokens, 500)
  assert.equal(codexDetails.tokenUsage.modelContextWindow, 200000)
  proof.providerEvents.codex = { first: firstCodex, second: codexDetails }

  const sent = (await context.fixture.log())
    .slice(baseline)
    .map(context.promptFrom)
    .filter((prompt) => typeof prompt === 'string' && prompt.startsWith('usage-probe'))
  assert.deepEqual(
    sent,
    proof.requests.map((request) => request.prompt),
    'Measured provider turns use genuine SSH requests with literal user input',
  )

  const retained = await readThreads()
  const expectedSessions = nativeFacts(retained)
  assert.ok(expectedSessions.some((session) => session.provider === 'codex'))
  assert.ok(expectedSessions.some((session) => session.provider === 'claude'))
  const profiles = await page().evaluate(() => window.relay.profiles.list())
  const selectedMachine = profiles.find((profile) => profile.id === codex.profileId)
  assert.ok(selectedMachine, 'The measured native thread belongs to a saved machine')
  const dialog = () => page().getByRole('dialog', { name: 'Usage', exact: true })
  const open = () => openUsageDialog(page())
  const formatted = (value, cost = false) =>
    page().evaluate(
      ({ value, cost }) =>
        value === undefined
          ? 'Not reported'
          : cost
            ? new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: 'USD',
                minimumFractionDigits: 2,
                maximumFractionDigits: 4,
              }).format(value)
            : value.toLocaleString(),
      { value, cost },
    )
  const assertTotals = async (sessions, label) => {
    const totals = totalFacts(sessions)
    await context.waitUntil(
      async () =>
        (await dialog().locator('[data-usage="total-tokens"]').textContent()) ===
        (await formatted(totals.tokens.total)),
      `${label}: visible token totals match native events`,
    )
    assert.equal(
      await dialog().locator('[data-usage="estimated-cost"]').textContent(),
      await formatted(totals.cost, true),
      `${label}: provider cost is counted once`,
    )
    assert.equal(
      await dialog()
        .locator('.usage-summary')
        .getByText(
          `${totals.sessions.toLocaleString()} native ${totals.sessions === 1 ? 'session' : 'sessions'}`,
          { exact: true },
        )
        .count(),
      1,
    )
    const rows = dialog()
      .getByRole('region', { name: 'Session usage', exact: true })
      .locator('tbody tr')
    assert.equal(
      await rows.count(),
      totals.sessions,
      `${label}: one row per retained native session`,
    )
    const breakdown = await dialog()
      .locator('.usage-token-breakdown > div')
      .evaluateAll((rows) =>
        Object.fromEntries(
          rows.map((row) => [
            row.querySelector('dt').textContent,
            row.querySelector('dd').textContent,
          ]),
        ),
      )
    for (const [label, key] of [
      ['Input', 'input'],
      ['Output', 'output'],
      ['Cache creation', 'creation'],
      ['Reasoning', 'reasoning'],
    ]) {
      assert.equal(breakdown[label], await formatted(totals.tokens[key]))
    }
    assert.equal(
      await dialog().locator('.usage-summary > div').nth(2).locator('strong').textContent(),
      await formatted(totals.tokens.cached),
      `${label}: cache reads are not added twice`,
    )
    proof.filters.push({ selection: label, expected: totals })
  }
  await open()
  assert.equal(
    await dialog().evaluate((root) => {
      const allowance = root.querySelector('.usage-account-section')
      const saved = root.querySelector('.usage-summary')
      return Boolean(
        allowance &&
        saved &&
        allowance.compareDocumentPosition(saved) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }),
    true,
    'Provider account allowance appears before retained session statistics',
  )
  proof.accountAllowanceFirst = true
  await dialog().getByLabel('Usage machine', { exact: true }).selectOption('all')
  await dialog().getByLabel('Usage provider', { exact: true }).selectOption('all')
  await assertTotals(expectedSessions, 'All machines and providers')
  await dialog().getByLabel('Usage machine', { exact: true }).selectOption(codex.profileId)
  const machineSessions = expectedSessions.filter(
    (session) => session.profileId === codex.profileId,
  )
  await assertTotals(machineSessions, 'Connected saved machine')
  for (const provider of ['claude', 'codex']) {
    await dialog().getByLabel('Usage provider', { exact: true }).selectOption(provider)
    await assertTotals(
      machineSessions.filter((session) => session.provider === provider),
      `${providers[provider]} on connected machine`,
    )
    assert.equal(
      await dialog().getByRole('region', { name: 'Current thread context', exact: true }).count(),
      provider === 'codex' ? 1 : 0,
      'Current context follows the selected native provider filter',
    )
    if (provider === 'claude') {
      const breakdown = dialog().getByText('Model breakdown', { exact: true }).first()
      await breakdown.click()
      assert.equal(
        await breakdown.locator('..').locator('dl').isVisible(),
        true,
        'Native Claude model totals are expandable',
      )
    }
  }
  const contextWindow = dialog().getByRole('progressbar', {
    name: 'Current thread context utilization',
    exact: true,
  })
  assert.equal(await contextWindow.getAttribute('value'), '500')
  assert.equal(await contextWindow.getAttribute('max'), '200000')
  await dialog().getByLabel('Usage provider', { exact: true }).selectOption('all')
  await dialog().getByLabel('Usage machine', { exact: true }).selectOption('all')

  const refresh = () => dialog().getByRole('button', { name: 'Refresh limits', exact: true })
  await context.waitUntil(() => refresh().isEnabled(), 'Native account limits finish loading')
  for (const provider of ['codex', 'claude']) {
    const snapshot = await page().evaluate((name) => window.relay.agent.usage(name), provider)
    assert.equal(snapshot.provider, provider)
    assert.equal(
      snapshot.status,
      'available',
      `${providers[provider]} native account fixture responds`,
    )
    assert.ok(
      snapshot.limits.length,
      'Native account snapshots include provider utilization windows',
    )
    if (provider === 'codex') {
      assert.equal(snapshot.limits[0].primary.usedPercent, 12.5)
      assert.equal(snapshot.limits[0].secondary.usedPercent, 37)
      assert.equal(snapshot.ordinaryUsageAllowed, false)
      assert.equal(snapshot.availableResetCredits, 2)
      assert.equal(snapshot.limits[0].credits.balance, '18.00')
    } else {
      assert.deepEqual(
        snapshot.limits.map((limit) => limit.primary.usedPercent),
        [14, 43],
      )
      assert.deepEqual(snapshot.extraUsage, {
        isEnabled: true,
        amountUnit: 'minor-currency',
        monthlyLimit: 2500,
        usedCredits: 125,
        usedPercent: 5,
        currency: 'USD',
      })
    }
    proof.accountSnapshots[provider] = snapshot
    const card = dialog().getByRole('article', {
      name: `${providers[provider]} account usage`,
      exact: true,
    })
    await context.waitUntil(
      async () => (await card.getAttribute('aria-busy')) === 'false',
      `${providers[provider]} native account card settles`,
    )
    if (provider === 'codex') {
      assert.equal(
        await card
          .getByText('Provider reports ordinary usage unavailable.', { exact: true })
          .count(),
        1,
        'Low utilization never implies account access',
      )
      assert.equal(await card.getByText('Credits balance: 18.00', { exact: true }).count(), 1)
      assert.equal(await card.getByText('Available reset credits: 2', { exact: true }).count(), 1)
    } else {
      assert.equal(
        await card
          .getByText(`${await formatted(1.25, true)} used of ${await formatted(25, true)}`, {
            exact: false,
          })
          .count(),
        1,
        'Claude extra usage converts native minor USD currency amounts to dollars',
      )
      assert.equal(
        await card
          .getByText(`${await formatted(23.75, true)} left before the monthly spend cap`, {
            exact: true,
          })
          .count(),
        1,
        'Claude extra usage shows the reported monthly spend cap remaining',
      )
      assert.equal(await card.getByText('95% left', { exact: true }).count(), 1)
    }
    for (const limit of snapshot.limits) {
      for (const kind of ['primary', 'secondary']) {
        if (!limit[kind]) continue
        const remaining = Math.min(100, Math.max(0, 100 - limit[kind].usedPercent))
        const progress = card.getByRole('progressbar', {
          name: `${limit.label || limit.id} ${kind} window remaining allowance`,
          exact: true,
        })
        assert.equal(
          Number(await progress.getAttribute('value')),
          remaining,
          `${providers[provider]} account meter shows remaining native allowance`,
        )
        assert.equal(await progress.getAttribute('max'), '100')
        const expectedLabels = await page().evaluate(
          ({ used, remaining }) => {
            const format = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 1 })
            return { used: `${format(used)}% used`, left: `${format(remaining)}% left` }
          },
          { used: limit[kind].usedPercent, remaining },
        )
        const window = progress.locator('..')
        assert.equal(
          await window.getByText(expectedLabels.left, { exact: true }).count(),
          1,
          `${providers[provider]} account headline reports allowance left`,
        )
        assert.equal(
          await window.getByText(expectedLabels.used, { exact: false }).count(),
          1,
          `${providers[provider]} account caption preserves provider-reported usage`,
        )
      }
    }
  }
  const refreshBaseline = (await context.fixture.log()).length
  await refresh().click()
  await context.waitUntil(async () => {
    const records = (await context.fixture.log()).slice(refreshBaseline)
    return (
      records.some(
        (entry) =>
          entry.provider === 'codex' && entry.message?.method === 'account/rateLimits/read',
      ) &&
      records.some(
        (entry) => entry.provider === 'claude' && entry.message?.request?.subtype === 'get_usage',
      )
    )
  }, 'Refresh limits reads both provider accounts through real SSH')
  await context.waitUntil(() => refresh().isEnabled(), 'Refreshed native account limits settle')
  await assertTotals(expectedSessions, 'Account refresh preserves retained session spend')
  await dialog().evaluate((root) => {
    root.scrollTop = 0
  })
  if (context.screenshot) await context.screenshot('life-usage.png')
  else await page().screenshot({ path: join(context.screenshots, 'life-usage.png') })
  const unavailableMarker = join(context.fixture.root, 'usage-limits-error')
  try {
    await writeFile(unavailableMarker, 'Native usage smoke account outage\n')
    await refresh().click()
    for (const provider of ['codex', 'claude']) {
      await dialog()
        .getByRole('article', { name: `${providers[provider]} account usage`, exact: true })
        .getByText('Fixture account limits temporarily unavailable', { exact: true })
        .waitFor()
    }
    await context.waitUntil(() => refresh().isEnabled(), 'Failed native account refresh settles')
    await assertTotals(
      expectedSessions,
      'Account unavailability preserves saved token and cost totals',
    )
    proof.accountRefreshFailure = {
      message: 'Fixture account limits temporarily unavailable',
      savedSessionTotalsPreserved: true,
    }
    if (context.screenshot) await context.screenshot('life-usage-unavailable.png')
  } finally {
    await rm(unavailableMarker, { force: true })
  }
  await refresh().click()
  await context.waitUntil(
    async () =>
      (await refresh().isEnabled()) &&
      (await dialog()
        .getByText('Fixture account limits temporarily unavailable', { exact: true })
        .count()) === 0,
    'Native account refresh recovers after provider outage',
  )
  for (const provider of ['codex', 'claude']) {
    assert.ok(
      (await dialog()
        .getByRole('article', { name: `${providers[provider]} account usage`, exact: true })
        .getByRole('progressbar')
        .count()) > 0,
      `${providers[provider]} native allowance windows return after recovery`,
    )
  }
  await dialog().getByRole('button', { name: 'Close dialog', exact: true }).click()
  await dialog().waitFor({ state: 'hidden' })
  await open()
  await assertTotals(expectedSessions, 'Reopened usage retains native history')
  await dialog().getByRole('button', { name: 'Close dialog', exact: true }).click()
  await dialog().waitFor({ state: 'hidden' })
  proof.ok = true
  proof.nativeSessions = expectedSessions
  proof.savedMachine = { id: selectedMachine.id, name: selectedMachine.name }
  await writeFile(
    join(context.artifacts, 'desktop-usage-proof.json'),
    JSON.stringify(proof, null, 2),
  )
  context.checks.push(
    'Native usage puts remaining account allowance first, retains Codex and Claude counters and cost once, filters machine/provider, shows current context and refreshes both provider limits over SSH',
  )
}

module.exports = { runUsageChecks, openUsageDialog }
