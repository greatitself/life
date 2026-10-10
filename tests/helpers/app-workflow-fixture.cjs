const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { resolve } = require('node:path')

// Keep the authoritative mock bridge shared with the existing actual-App test.
// Assert both boundaries so a harness refactor fails explicitly instead of
// silently running a different or incomplete fixture.
async function appMockSource() {
  const source = await readFile(resolve(__dirname, '../app-live-controls-smoke.cjs'), 'utf8')
  const startMarker = '    await page.addInitScript(\n'
  const endMarker = '      { historyHydration, providerUtilities, fluidity },\n    )'
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(
    start >= 0 && end > start,
    'The actual-App mock initialization must remain identifiable',
  )
  const callback = source
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/,$/, '')
  assert.ok(callback.startsWith('({ historyHydration, providerUtilities, fluidity }) => {'))
  assert.ok(callback.endsWith('}'))
  return callback
}

module.exports = { appMockSource }
