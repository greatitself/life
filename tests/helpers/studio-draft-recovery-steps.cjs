const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

// These steps drive the production App. Only its native bridge is a stand-in.
async function studioDraftRecoveryChecks(fixture) {
  const {
    open,
    openStudio,
    records,
    stored,
    bytes,
    draftBytes,
    draftStored,
    flush,
    settle,
    exportSession,
    exportRecovery,
    assertNoExecution,
    pass,
    proof,
    session,
    rejected,
    exact,
    exactInput,
    unsent,
  } = fixture

  for (const boundary of ['context', 'start']) {
    for (const revision of ['A-to-B', 'A-to-B-to-A']) {
      const initial = session(
        'send-race-' + boundary + '-' + revision,
        'Pending send draft ownership',
      )
      delete initial.thread.remoteId
      const seed = [null, initial, rejected]
      const requestA = '  Inspect the Studio implementation exactly as requested Ω.\n  '
      const requestB = '  Independent unsent request B 😀.\nKeep this new draft.  '
      const drafts = { [initial.id]: requestA, futureDraftField: { exact } }
      const { context, page } = await open(
        'send-race-' + boundary + '-' + revision,
        'app',
        seed,
        initial.id,
        false,
        drafts,
      )
      const dialog = await openStudio(page)
      const composer = dialog.getByRole('textbox', { name: 'Describe a Life customization' })
      assert.equal(await composer.inputValue(), requestA)
      await page.evaluate((boundary) => {
        if (boundary === 'context') window.studioRecoveryTest.holdContext(true)
        else window.studioRecoveryTest.holdStart(true)
      }, boundary)
      await dialog.getByRole('button', { name: 'Send customization request', exact: true }).click()
      await page.waitForFunction(
        (boundary) =>
          boundary === 'context'
            ? window.studioRecoveryTest.records.contextCalls.length === 1
            : window.studioRecoveryTest.records.starts.length === 1,
        boundary,
      )
      await composer.fill(requestB)
      if (revision === 'A-to-B-to-A') await composer.fill(requestA)
      const latestDraft = revision === 'A-to-B-to-A' ? requestA : requestB
      await page.evaluate((boundary) => {
        if (boundary === 'context') window.studioRecoveryTest.releaseContext()
        else window.studioRecoveryTest.releaseStart()
      }, boundary)
      await page.waitForFunction(() => window.studioRecoveryTest.records.resolvedStarts === 1)
      await settle(page)
      assert.equal(
        await composer.inputValue(),
        latestDraft,
        'The previous async submission must not clear a newer draft revision',
      )
      assert.equal((await draftStored(page))[initial.id], latestDraft)
      assert.deepEqual((await draftStored(page)).futureDraftField, drafts.futureDraftField)
      const activity = await records(page)
      assert.equal(activity.starts.length, 1)
      assert.equal(activity.starts[0].prompt, requestA)
      assert.equal(activity.starts[0].remoteId, undefined)
      await flush(page)
      const saved = (await stored(page))[1]
      assert.equal(saved.request, requestA)
      assert.equal(saved.thread.messages.at(-1).text, requestA)
      assert.deepEqual(
        saved.thread.messages.slice(0, initial.thread.messages.length),
        initial.thread.messages,
      )
      await dialog.getByRole('button', { name: 'Stop customization', exact: true }).click()
      await flush(page)
      const stopped = await records(page)
      proof.stopDraftChecks ||= []
      proof.stopDraftChecks.push({
        boundary,
        revision,
        startsBefore: activity.starts.length,
        startsAfter: stopped.starts.length,
        stops: stopped.stops,
        latestDraft: await composer.inputValue(),
        expectedDraft: latestDraft,
      })
      assert.equal(
        stopped.starts.length,
        1,
        'Stopping the previous run must never submit the current draft',
      )
      assert.equal(await composer.inputValue(), latestDraft)
      pass(
        boundary +
          ' await, ' +
          revision +
          ': the actual composer preserves the newer draft while sending only the original exact request',
      )
      await context.close()
    }
  }

  {
    const initial = session('opaque-draft-map', 'Lossless draft map recovery')
    initial.draft = { futureConversationDraft: { exact: exactInput, unchanged: true } }
    const seed = [null, initial, rejected]
    const drafts = Object.fromEntries([
      [initial.id, exact],
      ['future-draft', { opaque: { exact } }],
      ['invalid\nidentifier', 'Opaque key text Ω'],
      ['constructor', { future: exactInput }],
      ['__proto__', { fixturePolluted: true }],
      ['prototype', 37],
      ['toJSON', { future: exact }],
      ['unknown-string', 'Retain unknown string draft\r\nΩ'],
    ])
    const { context, page } = await open('opaque-draft-map', 'app', seed, initial.id, false, drafts)
    const dialog = await openStudio(page)
    assert.deepEqual(
      await exportRecovery(page, dialog, initial.id),
      {
        version: 1,
        conversation: initial,
        draft: { sessionId: initial.id, text: exact },
      },
      'An untouched saved draft retains exact CRLF and UTF-16 code units in its recovery download',
    )
    await dialog.getByRole('textbox', { name: 'Describe a Life customization' }).fill(unsent)
    assert.equal(
      await page.evaluate(() =>
        Object.hasOwn(window.studioRecoveryTest.draftStored(), '__proto__'),
      ),
      true,
      'The persisted draft map retains its own inert prototype-like key',
    )
    assert.deepEqual(await draftStored(page), { ...drafts, [initial.id]: unsent })
    assert.equal(await page.evaluate(() => Object.prototype.fixturePolluted), undefined)
    assert.deepEqual(
      await exportSession(page, dialog, initial.id),
      initial,
      'The existing conversation export stays the exact raw session',
    )
    assert.deepEqual(await exportRecovery(page, dialog, initial.id), {
      version: 1,
      conversation: initial,
      draft: { sessionId: initial.id, text: unsent },
    })
    assert.equal(await bytes(page), JSON.stringify(seed))
    await assertNoExecution(page)
    pass(
      'Draft edits preserve opaque/prototype-like map entries; recovery downloads include exact unsent text and unchanged raw conversation fields',
    )
    await context.close()
  }

  {
    const initial = session('protected-draft-value', 'Protected nonstring saved draft')
    const seed = [null, initial, rejected]
    const drafts = { [initial.id]: { futureDraftFormat: { exact } }, unrelated: 'Keep this text' }
    const { context, page } = await open(
      'protected-draft-value',
      'app',
      seed,
      initial.id,
      false,
      drafts,
    )
    const dialog = await openStudio(page)
    const composer = dialog.getByRole('textbox', { name: 'Describe a Life customization' })
    assert.equal(await composer.inputValue(), '')
    await composer.fill(unsent)
    await dialog
      .getByRole('alert')
      .filter({ hasText: /unsupported format/ })
      .waitFor()
    assert.equal(await draftBytes(page), JSON.stringify(drafts))
    assert.deepEqual((await records(page)).draftWriteAttempts, [])
    assert.deepEqual(await exportRecovery(page, dialog, initial.id), {
      version: 1,
      conversation: initial,
      draft: { sessionId: initial.id, text: unsent },
    })
    await flush(page)
    assert.equal(await draftBytes(page), JSON.stringify(drafts))
    assert.equal(await composer.inputValue(), unsent)
    pass(
      'A selected nonstring draft stays untouched while the editable replacement remains available through recovery export',
    )
    await context.close()
  }

  for (const rawDrafts of ['{Malformed drafts Ω\r\n', '[null,{"future":true}]', 'null', '17']) {
    const initial = session('unreadable-draft-map', 'Unreadable stored drafts')
    const seed = [null, initial, rejected]
    const { context, page } = await open(
      'unreadable-map-' + rawDrafts.slice(0, 8),
      'app',
      seed,
      initial.id,
      false,
      undefined,
      { draftsRaw: rawDrafts },
    )
    const dialog = await openStudio(page)
    await dialog.getByRole('textbox', { name: 'Describe a Life customization' }).fill(unsent)
    await dialog
      .getByRole('alert')
      .filter({ hasText: /drafts could not be read/ })
      .waitFor()
    await flush(page)
    assert.equal(await draftBytes(page), rawDrafts)
    assert.deepEqual((await records(page)).draftWriteAttempts, [])
    assert.equal(await bytes(page), JSON.stringify(seed))
    assert.deepEqual(await exportRecovery(page, dialog, initial.id), {
      version: 1,
      conversation: initial,
      draft: { sessionId: initial.id, text: unsent },
    })
    await assertNoExecution(page)
    await context.close()
  }
  pass(
    'Malformed and non-object draft-store bytes survive editing and lifecycle flushes; recovery exports preserve current text',
  )

  {
    const initial = session('draft-read-failure', 'Draft storage read failure')
    const seed = [null, initial, rejected]
    const rawDrafts = JSON.stringify({ [initial.id]: 'Unread stored draft Ω', future: { exact } })
    const { context, page } = await open(
      'draft-read-failure',
      'app',
      seed,
      initial.id,
      false,
      undefined,
      { draftsRaw: rawDrafts, draftReadFailure: true },
    )
    const dialog = await openStudio(page)
    await dialog.getByRole('textbox', { name: 'Describe a Life customization' }).fill(unsent)
    await dialog
      .getByRole('alert')
      .filter({ hasText: /drafts could not be read/ })
      .waitFor()
    await flush(page)
    assert.equal(await draftBytes(page), rawDrafts)
    assert.deepEqual((await records(page)).draftWriteAttempts, [])
    assert.deepEqual(await exportRecovery(page, dialog, initial.id), {
      version: 1,
      conversation: initial,
      draft: { sessionId: initial.id, text: unsent },
    })
    assert.equal(await bytes(page), JSON.stringify(seed))
    await assertNoExecution(page)
    pass(
      'A draft-store read failure preserves inaccessible saved bytes and exposes current text through recovery export',
    )
    await context.close()
  }

  for (const retry of ['pagehide', 'dialog-close']) {
    const initial = session('draft-quota-' + retry, 'Quota failed draft retry')
    const seed = [null, initial, rejected]
    const drafts = { [initial.id]: 'Durable draft before quota failure', future: { exact } }
    const { context, page } = await open(
      'draft-quota-' + retry,
      'app',
      seed,
      initial.id,
      false,
      drafts,
      { draftWriteFailure: true },
    )
    let dialog = await openStudio(page)
    const composer = () => dialog.getByRole('textbox', { name: 'Describe a Life customization' })
    await composer().fill(unsent)
    await dialog
      .getByRole('alert')
      .filter({ hasText: /Could not save your Studio draft/ })
      .waitFor()
    assert.equal(await draftBytes(page), JSON.stringify(drafts))
    assert.ok((await records(page)).draftWriteAttempts.length >= 1)
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    dialog = await openStudio(page)
    assert.equal(await composer().inputValue(), unsent)
    await dialog
      .getByRole('alert')
      .filter({ hasText: /Could not save your Studio draft/ })
      .waitFor()
    await page.evaluate(() => window.studioRecoveryTest.failDraftWrites(false))
    if (retry === 'pagehide') await flush(page)
    else {
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
      await page.waitForFunction(() => window.studioRecoveryTest.records.draftWrites.length === 1)
      dialog = await openStudio(page)
    }
    await dialog
      .getByRole('alert')
      .filter({ hasText: /Could not save your Studio draft/ })
      .waitFor({ state: 'hidden' })
    assert.deepEqual(await draftStored(page), { ...drafts, [initial.id]: unsent })
    assert.equal((await records(page)).draftWrites.length, 1)
    assert.equal(await composer().inputValue(), unsent)
    assert.equal(await bytes(page), JSON.stringify(seed))
    await assertNoExecution(page)
    pass(
      retry +
        ': draft quota failure stays visible across dialog close and retries the dirty text without another edit',
    )
    await context.close()
  }

  {
    const initial = session('oversized-draft', 'Large saved unsent request')
    delete initial.thread.remoteId
    initial.draft = { futureConversationDraft: { exactInput } }
    const seed = [null, initial, rejected]
    const huge = '  Oversized exact saved Studio draft Ω\n' + 'x'.repeat(1_000_010) + '  '
    const drafts = { [initial.id]: huge, opaque: { exact } }
    const { context, page } = await open('oversized-draft', 'app', seed, initial.id, false, drafts)
    const dialog = await openStudio(page)
    const composer = dialog.getByRole('textbox', { name: 'Describe a Life customization' })
    assert.ok(
      (await composer.inputValue()) === huge,
      'The complete oversized saved draft is visible and editable',
    )
    const edited = huge + 'Still editable Ω'
    await composer.fill(edited)
    assert.ok((await composer.inputValue()) === edited)
    assert.ok((await draftStored(page))[initial.id] === edited)
    const recovery = await exportRecovery(page, dialog, initial.id)
    assert.equal(recovery.version, 1)
    assert.deepEqual(recovery.conversation, initial)
    assert.equal(recovery.draft.sessionId, initial.id)
    assert.ok(
      recovery.draft.text === edited,
      'The recovery download keeps all oversized draft code units',
    )
    for (const submit of ['button', 'Enter']) {
      if (submit === 'button')
        await dialog
          .getByRole('button', { name: 'Send customization request', exact: true })
          .click()
      else await composer.press('Enter')
      await dialog
        .getByRole('alert')
        .filter({ hasText: /(?:1,000,000|1000000|too large|too long)/i })
        .waitFor()
      await settle(page)
      assert.ok((await composer.inputValue()) === edited)
      assert.equal(await bytes(page), JSON.stringify(seed))
      const activity = await records(page)
      assert.deepEqual(activity.contextCalls, [])
      assert.deepEqual(activity.primaryWriteAttempts, [])
      await assertNoExecution(page)
    }
    proof.oversizedDraft = {
      codeUnits: edited.length,
      sha256: createHash('sha256').update(edited).digest('hex'),
    }
    pass(
      'Saved drafts over one million code units remain editable and exportable; button and Enter refuse submission before any provider or history action',
    )
    await context.close()
  }
}

module.exports = { studioDraftRecoveryChecks }
