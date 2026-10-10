#!/usr/bin/env node
// Real shared Life UI served from the production GitHub Pages artifact.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { readFile, stat, mkdir, writeFile } = require('node:fs/promises')
const { resolve, extname, sep } = require('node:path')
const { chromium } = require('playwright')
const directory = process.env.LIFE_WEB_PREVIEW_DIR
  ? resolve(process.env.LIFE_WEB_PREVIEW_DIR)
  : resolve(__dirname, '..', 'dist-web')
const artifacts = resolve(process.env.LIFE_WEB_ARTIFACTS_DIR || 'output/playwright/web-preview')
const checks = []
const errors = []
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}
async function main() {
  await stat(resolve(directory, 'index.html'))
  await mkdir(artifacts, { recursive: true })
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (!pathname.startsWith('/life/')) {
        response.writeHead(404)
        response.end()
        return
      }
      const file = resolve(directory, pathname.slice('/life/'.length) || 'index.html')
      if (!file.startsWith(directory + sep)) {
        response.writeHead(404)
        response.end()
        return
      }
      const contents = await readFile(file)
      response.writeHead(200, {
        'Content-Type': mime[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      response.end(contents)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = process.env.LIFE_WEB_URL || `http://127.0.0.1:${address.port}/life/`
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    await page.goto(base)
    await page
      .getByRole('heading', { name: /^What do you want to do in life-example\s*\?$/ })
      .waitFor()
    assert.equal(
      await page.getByRole('complementary', { name: 'Browser preview information' }).count(),
      0,
    )
    const shell = await page.locator('.app-shell').boundingBox()
    assert.equal(shell.y, 0)
    assert.equal(shell.height, await page.evaluate(() => innerHeight))
    assert.equal(await page.getByRole('group', { name: 'Window controls' }).isVisible(), false)
    const native = await page.evaluate(async () => {
      const state = await window.relay.connection.state()
      const before = localStorage.length
      const failure = await window.relay.agent
        .start({
          sessionId: 'preview-test',
          provider: 'codex',
          prompt: 'exact request',
          mode: 'review',
        })
        .then(
          () => '',
          (error) => error.message,
        )
      return { state, failure, before, after: localStorage.length }
    })
    assert.equal(native.state.codex, undefined)
    assert.equal(native.state.claude, undefined)
    assert.match(native.failure, /browser preview.*desktop app/i)
    checks.push(
      'Shared desktop UI fills the viewport without a preview header; native runs rejected without simulated output',
    )
    await page.screenshot({ path: resolve(artifacts, 'agents-dark.png') })
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.screenshot({ path: resolve(artifacts, 'agents-light.png') })
    await page.reload()
    await page
      .getByRole('heading', { name: /^What do you want to do in life-example\s*\?$/ })
      .waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    checks.push('Light and dark themes persist across reload')
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await page
      .locator('.research-header-goal')
      .filter({ hasText: 'Example: Reliable research workflow' })
      .waitFor()
    const researchChat = page.getByRole('complementary', { name: 'Research conversation' })
    assert.equal(await page.locator('.research-sidebar .research-goals-heading').count(), 0)
    assert.equal(await page.locator('.research-sidebar .research-goal-picker').count(), 0)
    assert.equal(await page.locator('.research-sidebar .research-overview-button').count(), 0)
    assert.equal(await page.locator('.research-method-goal').count(), 0)
    assert.equal(await researchChat.locator('.research-problem-start').count(), 0)
    assert.equal(await researchChat.locator('.composer-caption').count(), 0)
    assert.equal(
      await researchChat
        .getByRole('button', { name: 'Attach images or files', exact: true })
        .count(),
      0,
    )
    const composerLayout = await researchChat.locator('.composer').evaluate((element) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      const sidebar = element.closest('.research-agent-sidebar').getBoundingClientRect()
      return {
        radius: style.borderRadius,
        borders: [style.borderLeftWidth, style.borderRightWidth, style.borderBottomWidth],
        leftGap: box.left - sidebar.left,
        rightGap: sidebar.right - box.right,
        bottomGap: sidebar.bottom - box.bottom,
      }
    })
    assert.equal(composerLayout.radius, '0px')
    assert.deepEqual(composerLayout.borders, ['0px', '0px', '0px'])
    assert.ok(Math.abs(composerLayout.leftGap) <= 1, JSON.stringify(composerLayout))
    assert.ok(Math.abs(composerLayout.rightGap) <= 1, JSON.stringify(composerLayout))
    assert.ok(Math.abs(composerLayout.bottomGap) <= 1, JSON.stringify(composerLayout))
    const permissionControl = researchChat.getByRole('combobox', {
      name: /^Agent permission mode:/,
    })
    await permissionControl.click()
    assert.deepEqual(await page.locator('.reference-permission-title').allTextContents(), [
      'Ask for approval',
      'Read-only',
      'Approve for me',
      'Full access',
    ])
    await page.getByRole('option', { name: 'Full access', exact: true }).click()
    assert.equal(await permissionControl.textContent(), 'Full access')
    await researchChat.getByRole('combobox', { name: /^Model:/ }).click()
    await page.getByRole('option', { name: 'Claude default', exact: true }).click()
    await page.getByRole('textbox', { name: /^Message Claude Code about/ }).waitFor()
    await permissionControl.click()
    assert.deepEqual(await page.locator('.reference-permission-title').allTextContents(), [
      'Manual',
      'Accept edits',
      'Auto',
      "Don't ask",
      'Bypass permissions',
    ])
    await page.getByRole('option', { name: 'Manual', exact: true }).click()
    await researchChat.getByRole('combobox', { name: /^Model:/ }).click()
    await page.getByRole('option', { name: 'Codex default', exact: true }).click()
    checks.push(
      'Research composer reaches the sidebar borders with square corners and no duplicate goal sections; access choices use each provider’s native modes without Plan',
    )
    await page.getByRole('button', { name: 'New goal', exact: true }).click()
    let dialog = page.getByRole('dialog')
    await dialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Browser persistence proof')
    await dialog
      .getByRole('textbox', { name: 'Goal', exact: true })
      .fill('A real browser-local goal, without remote execution.')
    await dialog.getByRole('button', { name: 'Create goal', exact: true }).click()
    await page
      .locator('.research-header-goal')
      .filter({ hasText: 'Browser persistence proof' })
      .waitFor()
    await page.waitForFunction(() =>
      Object.values(JSON.parse(localStorage.getItem('life.web.research.files.v1') || '{}')).some(
        (contents) =>
          typeof contents === 'string' && contents.includes('Browser persistence proof'),
      ),
    )
    assert.equal(
      await page
        .getByRole('alert')
        .filter({ hasText: /Research.*error|sync.*attention/i })
        .count(),
      0,
    )
    await page.getByRole('button', { name: 'Add problem', exact: true }).first().click()
    dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Measurable obstacle')
    await dialog
      .getByRole('textbox', { name: 'Problem', exact: true })
      .fill('Resolve and test the smallest requirement.')
    await dialog.getByRole('button', { name: 'Add problem', exact: true }).click()
    await page.waitForFunction(() =>
      Object.values(JSON.parse(localStorage.getItem('life.web.research.files.v1') || '{}')).some(
        (contents) => typeof contents === 'string' && contents.includes('Measurable obstacle'),
      ),
    )
    await page.reload()
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await page
      .locator('.research-header-goal')
      .filter({ hasText: 'Browser persistence proof' })
      .waitFor()
    assert.ok((await page.getByRole('button', { name: /Measurable obstacle/ }).count()) > 0)
    checks.push('Research goal and problem creation persist to actual local files across reload')
    await page
      .getByRole('navigation', { name: 'Research tools' })
      .getByRole('button', { name: /^Requirements(?: \d+)?$/ })
      .click()
    await page.getByRole('button', { name: 'Add requirement', exact: true }).first().click()
    dialog = page.getByRole('dialog')
    await dialog
      .getByRole('textbox', { name: /^Statement/ })
      .fill('Persist each research record without losing its identity.')
    await dialog
      .getByRole('textbox', { name: /^Acceptance criterion/ })
      .fill('After reload the same requirement ID and statement remain in goal.json.')
    await dialog.getByRole('button', { name: 'Save requirement', exact: true }).click()
    assert.equal(
      await page.getByRole('combobox', { name: 'Research operation', exact: true }).count(),
      0,
    )
    await page.waitForFunction(() =>
      Object.values(JSON.parse(localStorage.getItem('life.web.research.files.v1') || '{}')).some(
        (contents) => {
          if (typeof contents !== 'string' || !contents.includes('Browser persistence proof'))
            return false
          try {
            const goal = JSON.parse(contents)
            return goal.method?.requirements.some(
              (row) =>
                row.statement === 'Persist each research record without losing its identity.',
            )
          } catch {
            return false
          }
        },
      ),
    )
    await page.reload()
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await page
      .getByRole('navigation', { name: 'Research tools' })
      .getByRole('button', { name: /^Requirements(?: \d+)?$/ })
      .click()
    await page
      .getByRole('button', {
        name: 'Inspect requirement: Persist each research record without losing its identity.',
        exact: true,
      })
      .waitFor()
    assert.equal(
      await page.getByRole('combobox', { name: 'Research operation', exact: true }).count(),
      0,
    )
    await page
      .getByRole('navigation', { name: 'Research tools' })
      .getByRole('button', { name: /^Approaches(?: \d+)?$/ })
      .click()
    assert.equal(
      await page.getByRole('button', { name: 'Select operation', exact: true }).count(),
      0,
    )
    assert.equal(
      await page.locator('.research-method-operator-catalog [data-selected="true"]').count(),
      0,
    )
    checks.push(
      'Structured requirements persist across reload, without a next-message approach selector',
    )
    await page.getByRole('button', { name: 'Current Active Environment', exact: true }).click()
    assert.ok(
      (await page
        .getByRole('dialog')
        .getByText('/browser/.life/research', { exact: true })
        .count()) > 0,
    )
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click()
    checks.push('Research environment uses its own browser-local .life/research directory')
    await page.screenshot({ path: resolve(artifacts, 'research-light.png') })
    await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
    await page.screenshot({ path: resolve(artifacts, 'research-dark.png') })
    const doc = await page.evaluate(async () =>
      window.relay.researchDocuments.register(
        `<html><body><button id="proof" onclick="let access;try { void parent.relay; access='allowed' } catch { access='denied' };document.getElementById('result').textContent = typeof window.relay + '/' + access">Run isolated map</button><p id="result">pending</p></body></html>`,
      ),
    )
    await page.evaluate((url) => {
      const iframe = document.createElement('iframe')
      iframe.id = 'preview-map-proof'
      // The response's HTTP CSP supplies the opaque sandbox. An attribute would bypass its worker.
      iframe.src = url
      iframe.style.cssText =
        'position:fixed;top:90px;left:300px;width:300px;height:160px;background:white;z-index:9999'
      document.body.append(iframe)
    }, doc.url)
    const frame = page.frameLocator('#preview-map-proof')
    await frame.getByRole('button', { name: 'Run isolated map', exact: true }).click()
    assert.equal(await frame.locator('#result').textContent(), 'undefined/denied')
    // APIRequestContext bypasses Service Workers; the browser frame above proves actual response execution.
    assert.equal(await page.evaluate(() => Boolean(window.relay)), true)
    await page.evaluate(async (id) => {
      document.getElementById('preview-map-proof').remove()
      await window.relay.researchDocuments.revoke(id)
    }, doc.id)
    checks.push('Interactive HTML map scripts run in an opaque sandbox with no Life API')
    await page.evaluate(() => {
      const files = JSON.parse(localStorage.getItem('life.web.research.files.v1') || '{}')
      const entry = Object.entries(files).find(
        ([path, value]) =>
          path.endsWith('/goal.json') && JSON.parse(value).title === 'Browser persistence proof',
      )
      const goal = JSON.parse(entry[1])
      const directory = entry[0].slice(0, -'/goal.json'.length)
      files[directory + '/map.html'] =
        `<button onclick="document.getElementById('selection-proof').textContent = typeof window.relay;parent.postMessage({type:'life-research-select',problemId:'${goal.problems[0].id}'},'*')">Select preview problem</button><p id="selection-proof">pending</p>`
      localStorage.setItem('life.web.research.files.v1', JSON.stringify(files))
    })
    await page
      .getByRole('button', { name: 'Research goal: Browser persistence proof', exact: true })
      .click()
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: 'Browser persistence proof', exact: true })
      .click()
    await page
      .getByRole('navigation', { name: 'Research tools' })
      .getByRole('button', { name: 'Map', exact: true })
      .click()
    const actualMap = page.frameLocator('iframe.research-html-map')
    await actualMap.getByRole('button', { name: 'Select preview problem', exact: true }).click()
    assert.equal(await actualMap.locator('#selection-proof').textContent(), 'undefined')
    await page
      .getByRole('complementary', { name: 'Research conversation' })
      .getByRole('textbox', { name: 'Message Codex about Measurable obstacle', exact: true })
      .waitFor()
    checks.push(
      'Actual Research HTML map renders through the shared component and selects the correct problem',
    )
    const builtin = await page.evaluate(async () => {
      let state = await window.relay.sourceCode.get()
      const item = state.extensions.find((entry) => entry.features?.includes('compact-attachments'))
      await window.relay.sourceCode.setExtensionEnabled(item.id, false)
      state = await window.relay.sourceCode.get()
      return {
        id: item.id,
        enabled: state.extensions.find((entry) => entry.id === item.id).enabled,
      }
    })
    assert.equal(builtin.enabled, false)
    await page.reload()
    await page
      .getByRole('heading', { name: /^What do you want to do in life-example\s*\?$/ })
      .waitFor()
    const choice = await page.evaluate(
      async (id) =>
        (await window.relay.sourceCode.get()).extensions.find((entry) => entry.id === id).enabled,
      builtin.id,
    )
    assert.equal(choice, false)
    await page.evaluate(
      async (id) => window.relay.sourceCode.setExtensionEnabled(id, true),
      builtin.id,
    )
    checks.push(
      'Built-in feature changes are real and persist independently of native source compilation',
    )
    await page.getByRole('button', { name: 'Customize', exact: true }).click()
    await page.getByRole('heading', { name: 'Make Life yours', exact: true }).first().waitFor()
    await page.screenshot({ path: resolve(artifacts, 'studio-dark.png') })
    await page
      .getByRole('dialog', { name: 'Customize Life', exact: true })
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click()
    await page
      .getByRole('navigation', { name: 'Workspace views' })
      .getByRole('button', { name: 'Map', exact: true })
      .click()
    await page.screenshot({ path: resolve(artifacts, 'map-dark.png') })
    checks.push('Studio and Map render from the same application')
    const mapFeatureId = await page.evaluate(async () => {
      const state = await window.relay.sourceCode.get()
      const item = state.extensions.find((entry) => entry.features?.includes('project-map'))
      await window.relay.sourceCode.setExtensionEnabled(item.id, false)
      return item.id
    })
    await page.getByRole('heading', { name: 'Project Map is disabled', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: 'Manage extensions', exact: true }).count(),
      0,
    )
    await page.getByRole('button', { name: 'Customize Life', exact: true }).click()
    const customization = page.getByRole('dialog', { name: 'Customize Life', exact: true })
    await customization
      .getByRole('button', { name: 'Manage and share extensions', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Manage extensions', exact: true })
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click()
    await customization.waitFor()
    await page.evaluate(
      async (id) => window.relay.sourceCode.setExtensionEnabled(id, true),
      mapFeatureId,
    )
    await customization.getByRole('button', { name: 'Close dialog', exact: true }).click()
    checks.push('Disabled features route extension management through Customize and return to it')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await page.getByRole('button', { name: 'Research', exact: true }).waitFor()
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
    await page.screenshot({ path: resolve(artifacts, 'mobile.png') })
    checks.push('Mobile browser layout stays within the viewport')
    assert.deepEqual(errors, [])
    await writeFile(
      resolve(artifacts, 'proof.json'),
      JSON.stringify({ checks, errors, passed: checks.length, url: base }, null, 2),
    )
    console.log(JSON.stringify({ passed: checks.length, checks, errors, artifacts }, null, 2))
  } catch (error) {
    await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {})
    await writeFile(
      resolve(artifacts, 'failure.json'),
      JSON.stringify(
        {
          errors,
          checks,
          html: await page
            .locator('body')
            .innerHTML()
            .catch(() => ''),
          storage: await page
            .evaluate(() =>
              Object.fromEntries(
                Object.keys(localStorage)
                  .filter((key) => key.includes('research'))
                  .map((key) => [key, localStorage.getItem(key)]),
              ),
            )
            .catch(() => ({})),
          body: await page
            .locator('body')
            .innerText()
            .catch(() => ''),
        },
        null,
        2,
      ),
    )
    throw error
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
