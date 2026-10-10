import { describe, expect, it } from 'vitest'
import {
  addUsageTokens,
  savedUsageSessions,
  usageSummary,
  usageTokens,
} from '../src/renderer/usage'
import type { Message, Thread } from '../src/renderer/state'

function message(
  details: Record<string, unknown>,
  turn = 1,
  extras: Partial<Message> = {},
): Message {
  return {
    id: `usage-${turn}`,
    role: 'assistant',
    kind: 'status',
    text: 'Usage',
    turn,
    createdAt: turn * 100,
    details,
    ...extras,
  }
}
function thread(
  provider: Thread['provider'],
  messages: Message[],
  extras: Partial<Thread> = {},
): Thread {
  return {
    id: 'thread-a',
    profileId: 'machine-a',
    provider,
    remoteId: 'remote-a',
    title: 'Tracked session',
    messages,
    busy: false,
    model: 'latest-selected-model',
    mode: 'review',
    updatedAt: 100,
    turn: 1,
    pending: [],
    ...extras,
  }
}
function claude(turns = 1, extras: Record<string, unknown> = {}) {
  return {
    usageSessionId: 'native-claude',
    usageCallId: 'process-a',
    usageRestoresSessionTotals: true,
    usage: {
      input_tokens: 700,
      output_tokens: 150,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    },
    modelUsage: {
      'claude-primary': {
        inputTokens: 700 * turns,
        outputTokens: 150 * turns,
        cacheReadInputTokens: 300 * turns,
        cacheCreationInputTokens: 50 * turns,
        thinkingTokens: 75 * turns,
        costUSD: 0.12 * turns,
        costBasis: 'list',
      },
    },
    total_cost_usd: 0.12 * turns,
    ...extras,
  }
}
function codex(turns = 1, last = 500) {
  return {
    usageSessionId: 'native-codex',
    tokenUsage: {
      total: {
        inputTokens: 1000 * turns,
        outputTokens: 200 * turns,
        cachedInputTokens: 400 * turns,
        reasoningOutputTokens: 100 * turns,
        totalTokens: 1200 * turns,
      },
      last: { inputTokens: last - 100, outputTokens: 100, totalTokens: last },
      modelContextWindow: 200000,
    },
  }
}

describe('native usage tokens', () => {
  it('does not add Codex cached input or reasoning twice', () => {
    expect(usageTokens('codex', codex().tokenUsage.total)).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 400,
      reasoningTokens: 100,
      totalTokens: 1200,
    })
  })
  it('adds disjoint Claude input categories and treats native thinking as part of output', () => {
    expect(usageTokens('claude', claude().modelUsage['claude-primary'])).toEqual({
      inputTokens: 1050,
      outputTokens: 150,
      cachedInputTokens: 300,
      cacheCreationTokens: 50,
      reasoningTokens: 75,
      totalTokens: 1200,
    })
  })
  it('keeps missing counts unknown instead of showing zero', () => {
    expect(usageTokens('codex', { inputTokens: 100 })).toEqual({ inputTokens: 100 })
    expect(usageTokens('claude', {})).toEqual({})
    expect(addUsageTokens([{}, {}])).toEqual({})
    expect(usageTokens('claude', { input_tokens: 100, output_tokens: 20 })).toEqual({
      outputTokens: 20,
    })
  })
  it('rejects malformed native numbers without coercion', () => {
    expect(
      usageTokens('codex', {
        inputTokens: '100',
        outputTokens: -1,
        cachedInputTokens: NaN,
        reasoningOutputTokens: 1.5,
        totalTokens: Infinity,
      }),
    ).toEqual({})
    expect(addUsageTokens([{ totalTokens: Number.MAX_SAFE_INTEGER }, { totalTokens: 1 }])).toEqual(
      {},
    )
  })
})

describe('saved native session accounting', () => {
  it('reads the latest cumulative Claude result instead of adding resumed-turn totals', () => {
    const [session] = savedUsageSessions([
      thread('claude', [message(claude(), 1), message(claude(2), 2)]),
    ])
    expect(session.tokens.totalTokens).toBe(2400)
    expect(session.tokens.reasoningTokens).toBe(150)
    expect(session.estimatedCostUsd).toBe(0.24)
    expect(session.models).toHaveLength(1)
    expect(session.tokenCoverage).toBe('session')
    expect(session.scopeUncertain).toBeUndefined()
  })
  it('counts a provider session once when a retained conversation is copied or imported twice', () => {
    const sessions = savedUsageSessions([
      thread('claude', [message(claude())]),
      thread('claude', [message(claude())], { id: 'imported-copy' }),
    ])
    expect(sessions).toHaveLength(1)
    expect(usageSummary(sessions).tokens.totalTokens).toBe(1200)
    expect(usageSummary(sessions).estimatedCostUsd).toBe(0.12)
  })
  it('keeps old Claude process-call totals separate when resume did not restore spend', () => {
    const sessions = savedUsageSessions([
      thread('claude', [
        message(claude(1, { usageRestoresSessionTotals: false }), 1),
        message(claude(2, { usageRestoresSessionTotals: false }), 2),
        message(claude(1, { usageRestoresSessionTotals: false, usageCallId: 'process-b' }), 3),
      ]),
    ])
    expect(sessions).toHaveLength(2)
    expect(usageSummary(sessions).tokens.totalTokens).toBe(3600)
    expect(usageSummary(sessions).estimatedCostUsd).toBeCloseTo(0.36)
  })
  it('does not split restored session totals merely because Claude restarted', () => {
    const sessions = savedUsageSessions([
      thread('claude', [message(claude(), 1), message(claude(2, { usageCallId: 'process-b' }), 2)]),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].estimatedCostUsd).toBe(0.24)
  })
  it('keeps each native session reset and machine distinct', () => {
    const sessions = savedUsageSessions([
      thread('claude', [
        message(claude()),
        message(claude(1, { usageSessionId: 'new-session' }), 2),
      ]),
      thread('claude', [message(claude())], { id: 'thread-b', profileId: 'machine-b' }),
    ])
    expect(sessions).toHaveLength(3)
    expect(usageSummary(sessions).tokens.totalTokens).toBe(3600)
  })
  it('does not erase known spend when a crash result zeroes cumulative metrics', () => {
    const [session] = savedUsageSessions([
      thread('claude', [
        message(claude()),
        message(claude(0, { usageResultSubtype: 'error_during_execution' }), 2),
      ]),
    ])
    expect(session.tokens.totalTokens).toBe(1200)
    expect(session.estimatedCostUsd).toBe(0.12)
  })
  it('prefers whole-tree modelUsage over per-turn main-loop usage including subagent models', () => {
    const data = claude()
    const [session] = savedUsageSessions([
      thread('claude', [
        message({
          ...data,
          modelUsage: {
            ...data.modelUsage,
            'claude-subagent': {
              inputTokens: 80,
              outputTokens: 20,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.01,
              costBasis: 'list',
            },
          },
          total_cost_usd: 0.13,
        }),
      ]),
    ])
    expect(session.tokens.totalTokens).toBe(1300)
    expect(session.models).toHaveLength(2)
    expect(session.estimatedCostUsd).toBe(0.13)
  })
  it('sums per-turn main-loop fallback once while cumulative cost remains session scoped', () => {
    const [session] = savedUsageSessions([
      thread('claude', [
        message(claude(1, { modelUsage: undefined }), 1),
        message(claude(1, { modelUsage: undefined }), 1, { id: 'duplicate-result' }),
        message(claude(2, { modelUsage: undefined }), 2),
      ]),
    ])
    expect(session.tokens.totalTokens).toBe(2400)
    expect(session.estimatedCostUsd).toBe(0.24)
    expect(session.tokenCoverage).toBe('main-agent')
  })
  it('never invents Codex prices or attribute a cumulative session to the latest selected model', () => {
    const [session] = savedUsageSessions([
      thread('codex', [message(codex()), message(codex(2), 2)]),
    ])
    expect(session.tokens.totalTokens).toBe(2400)
    expect(session.estimatedCostUsd).toBeUndefined()
    expect(session.model).toBe('Not reported')
    expect(session.models).toEqual([])
    expect(usageSummary([session]).unpricedSessions).toBe(1)
  })
  it('uses the last-request context size and lets compaction lower context without lowering lifetime spend', () => {
    const [session] = savedUsageSessions([
      thread('codex', [message(codex(1, 500), 1), message(codex(2, 200), 2)]),
    ])
    expect(session.context).toEqual({
      usedTokens: 200,
      windowTokens: 200000,
      source: 'last-request',
    })
    expect(session.tokens.totalTokens).toBe(2400)
  })
  it('keeps child Codex usage separate without using child context for the root thread', () => {
    const sessions = savedUsageSessions([
      thread('codex', [
        message(codex()),
        message({ ...codex(), usageSessionId: 'native-child' }, 1, {
          agentId: 'child-id',
          agentName: 'Review child',
        }),
      ]),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.find((session) => session.agentId)?.title).toBe('Review child')
    expect(usageSummary(sessions).tokens.totalTokens).toBe(2400)
  })
  it('marks unpriced Claude model costs as unknown even when the provider guessed a cost', () => {
    const data = claude()
    data.modelUsage['claude-primary'].costBasis = 'unknown'
    const [session] = savedUsageSessions([thread('claude', [message(data)])])
    expect(session.tokens.totalTokens).toBe(1200)
    expect(session.estimatedCostUsd).toBeUndefined()
    expect(session.models[0].estimatedCostUsd).toBeUndefined()
    expect(session.unpricedModels).toEqual(['claude-primary'])
  })
  it('excludes unknown-model guesses from a mixed model total and marks known cost as partial', () => {
    const data = claude()
    const [session] = savedUsageSessions([
      thread('claude', [
        message({
          ...data,
          total_cost_usd: 1000.12,
          modelUsage: {
            ...data.modelUsage,
            'new-unpriced-model': {
              inputTokens: 80,
              outputTokens: 20,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 1000,
              costBasis: 'unknown',
            },
          },
        }),
      ]),
    ])
    expect(session.tokens.totalTokens).toBe(1300)
    expect(session.estimatedCostUsd).toBe(0.12)
    expect(session.unpricedModels).toEqual(['new-unpriced-model'])
    expect(usageSummary([session]).unpricedSessions).toBe(1)
  })
  it('does not relabel earlier guessed cumulative model cost when the latest request has a known rate', () => {
    const first = claude()
    first.modelUsage['claude-primary'].costBasis = 'unknown'
    const [session] = savedUsageSessions([
      thread('claude', [message(first, 1), message(claude(2), 2)]),
    ])
    expect(session.tokens.totalTokens).toBe(2400)
    expect(session.estimatedCostUsd).toBeUndefined()
    expect(session.models[0].costBasis).toBe('unknown')
    expect(session.models[0].estimatedCostUsd).toBeUndefined()
  })
  it('preserves a reported zero estimate while absent estimates stay unknown', () => {
    const sessions = savedUsageSessions([
      thread('claude', [message(claude(0))]),
      thread('codex', [message(codex())], { id: 'thread-b' }),
    ])
    expect(sessions.find((session) => session.provider === 'claude')?.estimatedCostUsd).toBe(0)
    expect(
      sessions.find((session) => session.provider === 'codex')?.estimatedCostUsd,
    ).toBeUndefined()
    expect(usageSummary(sessions).estimatedCostUsd).toBe(0)
    expect(usageSummary(sessions).unpricedSessions).toBe(1)
  })
  it('ignores unrelated provider details and reports uncertain historical counter scope', () => {
    expect(savedUsageSessions([thread('codex', [message({ plan: [] })])])).toEqual([])
    const [session] = savedUsageSessions([
      thread('claude', [message(claude(1, { usageRestoresSessionTotals: undefined }))]),
    ])
    expect(session.scopeUncertain).toBe(true)
  })
  it('labels aggregate coverage when retained native sessions omit input categories', () => {
    const sessions = savedUsageSessions([
      thread('codex', [message(codex())]),
      thread(
        'claude',
        [message({ modelUsage: { 'incomplete-model': { inputTokens: 10, outputTokens: 15 } } })],
        { id: 'thread-b' },
      ),
    ])
    expect(usageSummary(sessions).partialTokenSessions).toBe(1)
    expect(usageSummary(sessions).tokens.totalTokens).toBe(1200)
    expect(
      sessions.find((session) => session.provider === 'claude')?.tokens.totalTokens,
    ).toBeUndefined()
  })
})
