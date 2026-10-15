#!/usr/bin/env node
// Verify the compiled artifact from the successful job for this exact source commit.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const proof = JSON.parse(fs.readFileSync('output/linux-compiled-build.json', 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(proof.sourceCommit, commit)
assert.equal(proof.platform, process.platform)
assert.equal(proof.arch, process.arch)
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
function inventory(root, relativePaths) {
  const entries = []
  function visit(name) {
    const info = fs.lstatSync(name)
    assert(!info.isSymbolicLink(), 'Source and compiled links are rejected')
    if (info.isDirectory()) {
      for (const child of fs.readdirSync(name).sort()) visit(path.join(name, child))
    } else {
      assert(info.isFile())
      const bytes = fs.readFileSync(name)
      const entry = {
        path: relativePaths ? path.relative(root, name) : name,
        size: bytes.length,
        sha256: hash(bytes),
      }
      if (relativePaths) entry.type = 'file'
      else entry.mode = info.mode & 0o7777
      entries.push(entry)
    }
  }
  visit(root)
  return entries
}
assert.deepEqual(inventory('src', true), proof.source)
const compiled = inventory('out', false)
assert.deepEqual(
  compiled,
  proof.compiled.map(({ path, bytes, sha256, mode }) => ({ path, size: bytes, sha256, mode })),
)
const main = compiled.find((entry) => entry.path === 'out/main/index.js')
assert(main)
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `main_sha256=${main.sha256}\n`)
console.log(JSON.stringify({ sourceCommit: commit, mainSha256: main.sha256, passed: true }))
