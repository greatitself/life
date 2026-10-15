import { describe, expect, it } from 'vitest'
import { createPullRequestLinksProjector } from '../src/renderer/pull-request-links'

const firstPull = 'https://github.com/openai/codex/pull/123'
const secondPull = 'https://github.com/anthropics/claude-code/pull/456'

describe('pull request links projection', () => {
  it('does not inspect messages while inactive and retains the previous links', () => {
    const project = createPullRequestLinksProjector()
    const inactive = new Proxy([{ text: secondPull }], {
      get() {
        throw new Error('Inactive transcripts must not be inspected')
      },
    })
    expect(project(inactive, false)).toEqual([])

    const links = project([{ text: firstPull }], true)
    expect(project(inactive, false)).toBe(links)
    expect(project([{ text: secondPull }], true)).toEqual([secondPull])
  })

  it('reads settled message text once while new immutable messages stream', () => {
    let settledReads = 0
    let streamingReads = 0
    const settled = {
      get text() {
        settledReads++
        return `Review ${firstPull}`
      },
    }
    const streaming = (text: string) => ({
      get text() {
        streamingReads++
        return text
      },
    })
    const project = createPullRequestLinksProjector()
    const initial = [settled, streaming('Working')]
    const links = project(initial, true)
    expect(project(initial, true)).toBe(links)
    expect(project([...initial], true)).toBe(links)
    expect(project([settled, streaming('Working on the review')], true)).toBe(links)
    expect(project([settled, streaming(`Done: ${secondPull}`)], true)).toEqual([
      firstPull,
      secondPull,
    ])
    expect(settledReads).toBe(1)
    expect(streamingReads).toBe(3)
  })

  it('keeps the ordered links accurate after replacement, removal, and reorder', () => {
    const project = createPullRequestLinksProjector()
    const first = { text: firstPull }
    const second = { text: secondPull }
    expect(project([first, second, first], true)).toEqual([firstPull, secondPull])
    expect(project([second, first], true)).toEqual([secondPull, firstPull])
    expect(project([first, { ...second, text: firstPull }], true)).toEqual([firstPull])
    expect(project([second], true)).toEqual([secondPull])
    expect(project([], true)).toEqual([])
    expect(project([first, second], true)).toEqual([firstPull, secondPull])
    expect(project(undefined, true)).toEqual([])
  })

  it('retains the same result when duplicate links or unrelated text change', () => {
    const project = createPullRequestLinksProjector()
    const links = project([{ text: firstPull }, { text: secondPull }], true)
    expect(
      project([{ text: `Updated: ${firstPull} ${firstPull}` }, { text: secondPull }], true),
    ).toBe(links)
    expect(project([{ text: `${firstPull}\n${secondPull}` }, { text: 'No links' }], true)).toBe(
      links,
    )
    const empty = project([], true)
    expect(project([{ text: 'Unrelated content' }], true)).toBe(empty)
  })

  it('preserves the original URL matching rules and first occurrence order', () => {
    const messages = [
      {
        text: [
          'https://github.com/Owner_1/Repo.name-2/pull/007/?tab=files',
          'http://github.com/owner/repo/pull/1',
          'https://github.com/owner/repo/issues/2',
          'https://github.com/owner/repo/pull/not-a-number',
          'https://gitlab.com/owner/repo/pull/3',
          `${secondPull}#discussion`,
        ].join('\n'),
      },
      { text: `${firstPull}, ${secondPull}.` },
      { text: 'https://github.com/owner/repo/pull/' },
      { text: '999' },
    ]
    expect(createPullRequestLinksProjector()(messages, true)).toEqual([
      'https://github.com/Owner_1/Repo.name-2/pull/007',
      secondPull,
      firstPull,
    ])
  })
})
