/* Native approval choices through the real Electron renderer, IPC and SSH fixture. */
const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { readSavedThreads } = require('./desktop-history.cjs')

async function runNativeApprovalChecks(context) {
  const page = () => context.getPage()
  const proof = { ok: false, cases: [] }
  const cases = [
    {
      prompt: 'native-approval-choices-network',
      label: 'Always allow reference.example',
      decisionId: 'codex-approval:0',
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host: 'reference.example', action: 'allow' },
        },
      },
      outcome: 'approved',
      description: /persistent network allow rule/,
    },
    {
      prompt: 'native-approval-choices-session',
      label: 'Allow for this session',
      decisionId: 'codex-approval:0',
      decision: 'acceptForSession',
      outcome: 'approved',
      description: /session approval cache without prompting/,
    },
    {
      prompt: 'native-approval-choices-command-rule',
      label: 'Allow and save command rule',
      decisionId: 'codex-approval:0',
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'run', 'build'] },
      },
      outcome: 'approved',
      description: /persistent rule.*\["npm","run","build"\]/,
    },
    {
      prompt: 'native-approval-choices-session',
      label: 'Decline',
      decisionId: 'codex-approval:1',
      decision: 'decline',
      outcome: 'declined',
      description: /agent can continue the turn/,
    },
    {
      prompt: 'native-approval-choices-cancel',
      label: 'Cancel this turn',
      decisionId: 'codex-approval:1',
      decision: 'cancel',
      outcome: 'cancelled',
      description: /immediately interrupts the current turn/,
    },
  ]
  await context.workspace()
  for (const scenario of cases) {
    await context.newThread('codex')
    await context.selectPermission('ask-for-approval')
    const baseline = (await context.fixture.log()).length
    await context.send(scenario.prompt)
    const card = page().locator('.approval-card')
    await card.getByRole('button', { name: scenario.label, exact: true }).waitFor()
    assert.equal(await card.getByRole('button', { name: 'Allow once', exact: true }).count(), 0)
    assert.equal(await card.getByText(scenario.description).isVisible(), true)
    if (scenario.prompt === 'native-approval-choices-network') {
      assert.equal(await card.getByRole('button', { name: 'Decline', exact: true }).count(), 0)
      await page().screenshot({
        path: join(context.artifacts, 'native-network-approval.png'),
        fullPage: true,
      })
    }
    await card.getByRole('button', { name: scenario.label, exact: true }).click()
    await context.waitForSend()
    let wire
    let recorded
    await context.waitUntil(async () => {
      wire = (await context.fixture.log())
        .slice(baseline)
        .find(
          (entry) =>
            entry.kind === 'native-approval-choices-response' && entry.prompt === scenario.prompt,
        )
      const thread = (await readSavedThreads(page())).find(
        (thread) =>
          thread.messages.some(
            (message) => message.role === 'user' && message.text === scenario.prompt,
          ) &&
          thread.messages.some(
            (message) =>
              message.details?.response?.decisionId === scenario.decisionId &&
              message.details?.response?.label === scenario.label,
          ),
      )
      recorded = thread?.messages.findLast(
        (message) =>
          message.details?.response?.decisionId === scenario.decisionId &&
          message.details?.response?.label === scenario.label,
      )
      return Boolean(wire && recorded && !thread.busy && !thread.pending?.length)
    }, `Native ${scenario.label} response and selected scope are saved`)
    assert.equal(wire.offered, true)
    assert.deepEqual(wire.result, { decision: scenario.decision })
    assert.equal(recorded.status, scenario.outcome)
    assert.deepEqual(recorded.details.response, {
      accepted: scenario.outcome === 'approved',
      decisionId: scenario.decisionId,
      outcome: scenario.outcome,
      label: scenario.label,
    })
    proof.cases.push({
      prompt: scenario.prompt,
      nativeResponse: wire.result,
      status: recorded.status,
      response: recorded.details.response,
    })
  }
  proof.ok = true
  await writeFile(
    join(context.artifacts, 'native-approval-choices.json'),
    JSON.stringify(proof, null, 2) + '\n',
  )
  context.checks.push(
    'Native Codex network-only, session, command rule, decline and cancel choices preserve their exact responses and saved scope through Electron IPC and real SSH',
  )
  return proof
}

module.exports = { runNativeApprovalChecks }
