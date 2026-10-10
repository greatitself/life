#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const { mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { chromium } = require('playwright')

async function main() {
  const repository = resolve(__dirname, '..')
  const { version } = require('../package.json')
  const name = `Life-${version}-web`
  const output = join(repository, 'release/web')
  const checksums = await readFile(join(output, 'SHA256SUMS-web.txt'), 'utf8')
  for (const extension of ['tar.gz', 'zip']) {
    const filename = `${name}.${extension}`
    const contents = await readFile(join(output, filename))
    assert.ok(
      checksums.includes(`${createHash('sha256').update(contents).digest('hex')}  ${filename}\n`),
    )
    const entries = execFileSync(
      extension === 'zip' ? 'unzip' : 'tar',
      extension === 'zip' ? ['-Z1', join(output, filename)] : ['-tzf', join(output, filename)],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
    assert.ok(entries.includes(`${name}/out/web/server.cjs`))
    assert.ok(entries.includes(`${name}/dist-web/index.html`))
    assert.ok(entries.includes(`${name}/src/renderer/App.tsx`))
    assert.ok(entries.includes(`${name}/package-lock.json`))
    assert.equal(
      entries.some((entry) =>
        /(?:^|\/)\.(?:life|research|git|codex|aws|env)(?:\/|$|\.)/.test(entry),
      ),
      false,
    )
    assert.equal(
      entries.some((entry) =>
        /life-extension-backup-|node_modules\/|out\/(?:main|preload|renderer)\//.test(entry),
      ),
      false,
    )
  }

  const temporary = await mkdtemp(join(tmpdir(), 'life-web-release-check-'))
  let server
  let browser
  let log = ''
  const errors = []
  try {
    execFileSync('tar', ['-xzf', join(output, `${name}.tar.gz`), '-C', temporary])
    const root = join(temporary, name)
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, version)
    // Use this checkout's installed dependencies, while all application assets
    // and source come exclusively from the extracted release.
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
    const goalDirectory = join(root, '.life/research/release-goal')
    await mkdir(goalDirectory, { recursive: true })
    await writeFile(
      join(goalDirectory, 'goal.json'),
      JSON.stringify({
        id: 'release-goal',
        title: 'Release verification',
        goal: 'Check the released Research workspace.',
        problems: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    const listener = createServer()
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = listener.address().port
    await new Promise((resolve) => listener.close(resolve))
    server = spawn(process.execPath, ['out/web/server.cjs'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), LIFE_WEB_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => {
      log += chunk
    })
    server.stderr.on('data', (chunk) => {
      log += chunk
    })
    const url = `http://127.0.0.1:${port}/life/`
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`Released server exited: ${log}`)
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
        if (response.ok) {
          ready = true
          break
        }
      } catch {}
      await delay(200)
    }
    assert.ok(ready, `Released server did not become ready: ${log}`)
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
      ...(process.env.LIFE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.LIFE_BROWSER_EXECUTABLE }
        : {}),
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(url)
    await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).waitFor()
    const info = await page.evaluate(async () => ({
      version: (await window.relay.updates.get()).currentVersion,
      platform: window.relay.platform,
    }))
    assert.equal(info.version, version)
    assert.equal(info.platform, 'web')
    const connection = await page.evaluate(() => window.relay.connection.state())
    assert.equal(connection.profile.id, 'life-web-local')
    assert.equal(connection.status, 'connected')
    const files = await page.evaluate(() => window.relay.files.list())
    assert.ok(files.some((entry) => entry.name === 'package.json'))
    assert.equal(await page.locator('.life-browser-banner, .run-settings-note').count(), 0)
    await page.getByRole('combobox', { name: /^Agent permission mode:/ }).click()
    await page.getByRole('option', { name: 'Full access', exact: true }).click()
    await page
      .getByRole('combobox', { name: 'Agent permission mode: Full access', exact: true })
      .waitFor()
    assert.equal(await page.locator('.run-settings-note').count(), 0)
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    const sidebar = page.getByRole('complementary', { name: 'Research conversation', exact: true })
    await sidebar.getByRole('textbox').waitFor()
    assert.equal(await sidebar.locator('.thread-message-navigator').count(), 0)
    assert.equal(await sidebar.getByRole('button', { name: /^Attach/ }).count(), 0)
    assert.equal(
      await sidebar.locator('.reference-composer-context, .run-settings-note').count(),
      0,
    )
    assert.equal(
      await sidebar
        .locator('.composer')
        .evaluate((element) => getComputedStyle(element).borderRadius),
      '0px',
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify(
        {
          version,
          archives: 'verified',
          private_data: 'excluded',
          extracted_server: 'running',
          app_version: info.version,
          agents: 'usable',
          research: 'usable',
          page_errors: errors,
        },
        null,
        2,
      ),
    )
  } finally {
    await browser?.close()
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve))
      server.kill('SIGTERM')
      const timeout = setTimeout(() => server.kill('SIGKILL'), 15000)
      await exited
      clearTimeout(timeout)
    }
    await rm(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
