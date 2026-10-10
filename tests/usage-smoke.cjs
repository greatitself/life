#!/usr/bin/env node
// Run the actual Usage dialog in Chromium, including account race/error states.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-usage-'))
  const output = resolve(__dirname, '../output/playwright/usage-v0.11.1')
  await mkdir(output, { recursive: true })
  const checks = []
  const errors = []
  let browser
  let server
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'usage-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { StrictMode, useCallback, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { UsageDialog } from './src/renderer/components/UsageDialog'
          import './src/renderer/styles.css'
          const codex = { tokenUsage: { total: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, reasoningOutputTokens: 100, totalTokens: 1200 }, last: { inputTokens: 400, outputTokens: 100, totalTokens: 500 }, modelContextWindow: 200000 } }
          const claude = n => ({ usageSessionId: 'native-claude', usageCallId: 'call-a', usageRestoresSessionTotals: true, usage: { input_tokens: 700, output_tokens: 150, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 }, modelUsage: { 'claude-primary': { inputTokens: 700*n, outputTokens: 150*n, cacheReadInputTokens: 300*n, cacheCreationInputTokens: 50*n, thinkingTokens: 75*n, costUSD: .12*n, costBasis: 'list' } }, total_cost_usd: .12*n })
          const msg = (details, turn) => ({ id: 'usage-'+turn, role: 'assistant', kind: 'status', text: 'Usage', turn, createdAt: 100*turn, details })
          const base = { busy: false, model: 'currently-selected-model', mode: 'review', updatedAt: 1000, turn: 2, pending: [] }
          const threads = [
            { ...base, id: 'codex-a', profileId: 'machine-a', remoteId: 'codex-native-a', provider: 'codex', title: 'Review native Codex', messages: [msg(codex, 1)] },
            { ...base, id: 'claude-a', profileId: 'machine-a', remoteId: 'claude-native-a', provider: 'claude', title: 'Review cumulative Claude', messages: [msg(claude(1), 1), msg(claude(2), 2)] },
            { ...base, id: 'codex-b', profileId: 'machine-b', remoteId: 'codex-native-b', provider: 'codex', title: 'Other machine work', messages: [msg({ tokenUsage: { total: { inputTokens: 400, outputTokens: 100, cachedInputTokens: 0, totalTokens: 500 } } }, 1)] },
            { ...base, id: 'codex-import', profileId: 'machine-a', remoteId: 'codex-native-a', provider: 'codex', title: 'Imported Codex copy', messages: [msg({ ...codex, tokenUsage: { ...codex.tokenUsage, last: { inputTokens: 600, outputTokens: 100, totalTokens: 700 } } }, 3)] },
          ]
          const profiles = [{ id: 'machine-a', name: 'Research machine', host: 'research.example' }, { id: 'machine-b', name: 'Build machine', host: 'build.example' }]
          const fixture = window.usageFixture = { fail: false, defer: false, resetOnly: false, reads: [], pending: [], selected: [] }
          function snapshot(provider, machine) {
            const fetchedAt = Date.now()
            if(fixture.resetOnly && provider === 'codex') return { provider, status: 'available', fetchedAt, limits: [{ id: 'reset-only', label: 'Reset-only allowance', primary: { windowDurationMins: 300, resetsAt: 1791648000 } }] }
            return provider === 'codex' ? { provider, status: 'available', fetchedAt, limits: [{ id: 'codex', label: machine === 'machine-a' ? 'Machine A bucket' : 'Machine B bucket', primary: { usedPercent: machine === 'machine-a' ? 12.5 : 20, windowDurationMins: 300, resetsAt: 1791648000 }, secondary: { usedPercent: 37, windowDurationMins: 10080 }, credits: { hasCredits: true, unlimited: false, balance: '18.00' } }], ordinaryUsageAllowed: machine === 'machine-b', availableResetCredits: 2 } : { provider, status: 'available', fetchedAt, accountType: 'pro', limits: [{ id: 'weekly', label: 'Weekly usage', primary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 1792166400 } }], extraUsage: { isEnabled: true, amountUnit: 'minor-currency', usedCredits: 125, monthlyLimit: 2500, usedPercent: 5, currency: 'USD' } }
          }
          function Fixture() {
            const [open, setOpen] = useState(false)
            const [machine, setMachine] = useState('machine-a')
            const [connected, setConnected] = useState(true)
            const [live, setLive] = useState([])
            const [retained, setRetained] = useState(threads)
            fixture.switchMachine = id => { setMachine(id); setLive([]) }
            fixture.connect = value => setConnected(value)
            fixture.incomplete = value => setRetained(value ? [...threads, { ...base, id: 'incomplete', profileId: 'machine-b', remoteId: 'incomplete-native', provider: 'claude', title: 'Incomplete provider record', messages: [msg({ modelUsage: { 'incomplete-model': { inputTokens: 10, outputTokens: 15 } } }, 1)] }] : threads)
            fixture.publish = () => setLive([{ ...snapshot('codex', machine), fetchedAt: Date.now()+10000, limits: [{ id: 'live', label: 'Live account bucket', primary: { usedPercent: 64, windowDurationMins: 300 } }] }])
            fixture.resolvePending = () => { for(const pending of fixture.pending.splice(0)) pending.resolve(snapshot(pending.provider, pending.machine)) }
            const read = useCallback(provider => {
              fixture.reads.push({ provider, machine })
              if(fixture.defer) return new Promise(resolve => fixture.pending.push({ provider, machine, resolve }))
              return new Promise((resolve, reject) => setTimeout(() => fixture.fail ? reject(new Error('Native account limits temporarily unavailable')) : resolve(snapshot(provider, machine)), 100))
            }, [machine])
            return <div data-theme="dark" style={{ padding: 24 }}>
              <button className="button secondary" onClick={() => setOpen(true)}>Usage</button>
              {open ? <UsageDialog open={open} onOpenChange={setOpen} threads={retained} profiles={profiles} activeThreadId="codex-a" activeProfileId={machine} connected={connected} accountSnapshots={live} onReadUsage={read} onSelectThread={id => fixture.selected.push(id)} /> : null}
            </div>
          }
          createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>)
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      try {
        const path = request.url.split('?')[0]
        const file = ['fixture.js', 'fixture.css'].find((name) => path === '/' + name)
        response.setHeader(
          'Content-Type',
          file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
        )
        response.end(
          file
            ? await readFile(join(directory, file))
            : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Life usage</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        )
      } catch (error) {
        response.statusCode = 500
        response.end(String(error))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: 'Usage', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Usage', exact: true })
    await dialog.waitFor()
    assert.ok(
      await dialog.evaluate((element) => element.getBoundingClientRect().width > 800),
      'Desktop usage dashboard uses its full readable width',
    )
    assert.equal(await dialog.locator('[data-usage="total-tokens"]').innerText(), '4,100')
    assert.equal(await dialog.locator('[data-usage="estimated-cost"]').innerText(), '$0.24')
    assert.equal(await dialog.getByText('3 native sessions', { exact: true }).count(), 1)
    assert.equal(
      await dialog
        .getByText('2 sessions have unreported or incomplete cost', { exact: true })
        .count(),
      1,
    )
    checks.push(
      'Cumulative Claude snapshots counted once; Codex tokens are retained without invented costs',
    )

    const codexAccount = dialog.getByRole('article', { name: 'Codex account usage', exact: true })
    await codexAccount.getByText('12.5% used', { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(() => window.usageFixture.reads.length),
      2,
      'Lazy first-open StrictMode effect replay shares the two promptless account reads',
    )
    assert.equal(await codexAccount.getByText('87.5% left', { exact: true }).count(), 1)
    assert.equal(await codexAccount.getByText('63% left', { exact: true }).count(), 1)
    assert.equal(
      await codexAccount
        .getByRole('progressbar', {
          name: 'Machine A bucket primary window remaining allowance',
          exact: true,
        })
        .getAttribute('value'),
      '87.5',
    )
    assert.equal(await codexAccount.getByText('5-hour allowance', { exact: true }).count(), 1)
    assert.equal(await codexAccount.getByText('Weekly allowance', { exact: true }).count(), 1)
    assert.equal(await codexAccount.getByText(/Resets Oct 10/).count(), 1)
    assert.equal(
      await dialog.evaluate((element) =>
        Boolean(
          element
            .querySelector('.usage-account-section')
            .compareDocumentPosition(element.querySelector('.usage-summary')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
      true,
    )
    checks.push(
      'Promptless account allowance is first, remaining percentages and native windows are exact, and lazy StrictMode first-open reads are coalesced',
    )
    assert.equal(
      await codexAccount
        .getByText('Provider reports ordinary usage unavailable.', { exact: true })
        .count(),
      1,
    )
    assert.equal(await codexAccount.getByText('Credits balance: 18.00', { exact: true }).count(), 1)
    assert.equal(
      await codexAccount.getByText('Available reset credits: 2', { exact: true }).count(),
      1,
    )
    assert.equal(
      await dialog
        .getByRole('progressbar', { name: 'Current thread context utilization', exact: true })
        .getAttribute('value'),
      '500',
    )
    assert.equal(await dialog.getByText('500 / 200,000 tokens', { exact: true }).count(), 1)
    assert.equal(await dialog.getByText('Imported Codex copy', { exact: true }).count(), 1)
    assert.equal(await dialog.getByText('700 / 200,000 tokens', { exact: true }).count(), 0)
    await dialog
      .getByRole('article', { name: 'Claude Code account usage', exact: true })
      .getByText('43% used', { exact: true })
      .waitFor()
    assert.equal(
      await dialog
        .getByRole('article', { name: 'Claude Code account usage', exact: true })
        .getByText('57% left', { exact: true })
        .count(),
      1,
    )
    assert.equal(
      await dialog.getByText('Enabled · $1.25 used of $25.00', { exact: true }).count(),
      1,
    )
    assert.equal(
      await dialog.getByText('$23.75 left before the monthly spend cap', { exact: true }).count(),
      1,
    )
    checks.push(
      'Native allowance remains unavailable despite low utilization; context uses last request and account balances retain native values',
    )

    await dialog.getByLabel('Usage provider', { exact: true }).selectOption('claude')
    assert.equal(await dialog.locator('[data-usage="total-tokens"]').innerText(), '2,400')
    assert.equal(
      await dialog.getByRole('article', { name: 'Codex account usage', exact: true }).count(),
      0,
    )
    await dialog.getByText('Model breakdown', { exact: true }).click()
    assert.equal(await dialog.getByText('2,400 tokens · $0.24 (list)', { exact: true }).count(), 1)
    await dialog.getByLabel('Usage provider', { exact: true }).selectOption('codex')
    await dialog.getByLabel('Usage machine', { exact: true }).selectOption('machine-b')
    assert.equal(await dialog.locator('[data-usage="total-tokens"]').innerText(), '500')
    assert.equal(await dialog.locator('[data-usage="estimated-cost"]').innerText(), 'Not reported')
    await dialog.getByLabel('Usage provider', { exact: true }).selectOption('claude')
    assert.equal(
      await dialog
        .getByText(
          'No usage has been reported for this selection. Run an agent turn to begin tracking.',
          { exact: true },
        )
        .count(),
      1,
    )
    await dialog.getByLabel('Usage machine', { exact: true }).selectOption('all')
    await dialog.getByLabel('Usage provider', { exact: true }).selectOption('all')
    checks.push(
      'Provider and machine filters isolate saved usage and show an empty state instead of false zero totals',
    )

    await page.evaluate(() => {
      window.usageFixture.fail = true
    })
    await dialog.getByRole('button', { name: 'Refresh limits', exact: true }).click()
    await codexAccount.getByRole('alert').waitFor()
    assert.equal(
      await codexAccount.getByRole('alert').innerText(),
      'Native account limits temporarily unavailable',
    )
    assert.equal(await dialog.locator('[data-usage="total-tokens"]').innerText(), '4,100')
    assert.equal(await codexAccount.getByText(/Last-known usage/).count(), 1)
    await page.evaluate(() => {
      window.usageFixture.fail = false
    })
    await dialog.getByRole('button', { name: 'Refresh limits', exact: true }).click()
    await codexAccount.getByRole('alert').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => window.usageFixture.reads.length >= 6)
    checks.push('Native account read errors keep saved totals and recover after manual refresh')

    await page.evaluate(() => {
      window.usageFixture.resetOnly = true
    })
    await dialog.getByRole('button', { name: 'Refresh limits', exact: true }).click()
    await codexAccount.getByText('Reset-only allowance', { exact: true }).waitFor()
    assert.equal(
      await codexAccount.getByText('Remaining allowance not reported', { exact: true }).count(),
      1,
    )
    assert.equal(await codexAccount.getByRole('progressbar').count(), 0)
    assert.equal(await codexAccount.getByText(/Resets Oct 10/).count(), 1)
    assert.equal(await codexAccount.getByText('100% left', { exact: true }).count(), 0)
    await page.evaluate(() => {
      window.usageFixture.resetOnly = false
    })
    await dialog.getByRole('button', { name: 'Refresh limits', exact: true }).click()
    await codexAccount.getByText('Machine A bucket', { exact: true }).waitFor()
    checks.push(
      'A reset-only native window keeps its reset time and shows unknown remaining allowance without a fabricated full meter',
    )

    await page.evaluate(() => {
      window.usageFixture.defer = true
    })
    await dialog.getByRole('button', { name: 'Refresh limits', exact: true }).click()
    await page.waitForFunction(() => window.usageFixture.pending.length === 2)
    await page.evaluate(() => {
      window.usageFixture.defer = false
      window.usageFixture.switchMachine('machine-b')
    })
    await codexAccount.getByText('Machine B bucket', { exact: true }).waitFor()
    await page.evaluate(() => window.usageFixture.resolvePending())
    assert.equal(await codexAccount.getByText('Machine A bucket', { exact: true }).count(), 0)
    assert.equal(
      await codexAccount
        .getByText('Provider reports ordinary usage available.', { exact: true })
        .count(),
      1,
    )
    await page.evaluate(() => window.usageFixture.publish())
    await codexAccount.getByText('Live account bucket', { exact: true }).waitFor()
    assert.equal(await codexAccount.getByText('64% used', { exact: true }).count(), 1)
    assert.equal(await codexAccount.getByText('36% left', { exact: true }).count(), 1)
    checks.push(
      'Slow reads from a previous machine are discarded and newer native account events update the open dialog',
    )

    await page.evaluate(() => window.usageFixture.incomplete(true))
    await dialog
      .getByText('1 session has incomplete token counts. Totals include only reported values.', {
        exact: true,
      })
      .waitFor()
    assert.equal(await dialog.locator('[data-usage="total-tokens"]').innerText(), '4,100')
    assert.equal(await dialog.getByText('4 native sessions', { exact: true }).count(), 1)
    await page.evaluate(() => window.usageFixture.incomplete(false))
    await dialog
      .getByText('1 session has incomplete token counts. Totals include only reported values.', {
        exact: true,
      })
      .waitFor({ state: 'hidden' })
    checks.push(
      'Incomplete native counts remain unknown and numeric aggregates explicitly identify their partial coverage',
    )
    await page.screenshot({ path: join(output, 'usage.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(
      await dialog.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth
      }),
      true,
    )
    await page.screenshot({ path: join(output, 'usage-narrow.png') })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.textContent === 'Usage', undefined, {
      timeout: 2000,
    })
    assert.equal(
      await page
        .getByRole('button', { name: 'Usage', exact: true })
        .evaluate((element) => document.activeElement === element),
      true,
    )
    await page.getByRole('button', { name: 'Usage', exact: true }).click()
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Review cumulative Claude', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.usageFixture.selected), ['claude-a'])
    checks.push(
      'The dialog fits narrow windows, restores keyboard focus, and opens the selected saved session',
    )

    assert.deepEqual(errors, [])
    const proof = { ok: true, checks, errors, completedAt: new Date().toISOString() }
    await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
  } catch (error) {
    await writeFile(
      join(output, 'proof.json'),
      JSON.stringify({ ok: false, checks, errors, error: String(error.stack || error) }, null, 2) +
        '\n',
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
