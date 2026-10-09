import { afterEach, describe, expect, it, vi } from 'vitest'
import { structuredPatch } from 'diff'
import {
  attachmentPrompt,
  normalizeThreadAttachments,
  selectDraftAttachments,
} from '../src/renderer/attachments'
import {
  compareSidebarThreads,
  readSidebarArrangement,
  threadProjectKey,
} from '../src/renderer/sidebar-ordering'
import { normalizeQueuedMessages, queueConnectionMatches } from '../src/renderer/thread-queue'
import { normalizeThreadMetadata } from '../src/renderer/thread-metadata'
import { reportedFileChanges, summarizeSourceChanges } from '../src/renderer/thread-activity'
import type { Message, Thread } from '../src/renderer/state'
import type { ConnectionState } from '../src/shared/types'

vi.mock('diff', { spy: true })

function thread(patch: Partial<Thread> = {}): Thread {
  return {
    id: 'one',
    profileId: 'machine',
    workspace: '/one',
    provider: 'codex',
    title: 'Research',
    messages: [],
    busy: false,
    model: '',
    mode: 'review',
    updatedAt: 1,
    turn: 1,
    pending: [],
    ...patch,
  }
}
function edit(oldString: string, newString: string): Message {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    text: 'Changed file',
    title: 'Edit',
    turn: 1,
    status: 'completed',
    input: JSON.stringify({
      file_path: 'src/app.ts',
      old_string: oldString,
      new_string: newString,
    }),
  }
}
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('permanent customized workspace data', () => {
  it('retains exact small edit counts and reuses completed tool summaries', () => {
    const message = edit('one\ntwo\n', 'one\nthree\nfour\n')
    const changes = reportedFileChanges([message])
    expect(changes).toMatchObject([{ path: 'src/app.ts', additions: 2, removals: 1 }])
    expect(changes[0].diff).toContain('+three')
    expect(reportedFileChanges([message])).toEqual(changes)
    expect(structuredPatch).toHaveBeenCalledOnce()
    expect(reportedFileChanges([{ ...message }])).toEqual(changes)
    expect(structuredPatch).toHaveBeenCalledTimes(2)
  })

  it('bounds pathological wholesale rewrites before they can block the renderer', () => {
    const before = Array.from({ length: 6000 }, (_, index) => `original_line_${index}`).join('\n')
    const after = Array.from({ length: 6000 }, (_, index) => `replacement_line_${index}`).join('\n')
    expect(reportedFileChanges([edit(before, after)])).toEqual([
      { path: 'src/app.ts', truncated: true },
    ])
    expect(structuredPatch).not.toHaveBeenCalled()
    const smallBefore = Array.from({ length: 2000 }, (_, index) => `a${index}`).join('\n')
    const smallAfter = Array.from({ length: 2000 }, (_, index) => `b${index}`).join('\n')
    expect(reportedFileChanges([edit(smallBefore, smallAfter)])[0]).toMatchObject({
      path: 'src/app.ts',
      truncated: true,
    })
    expect(structuredPatch).toHaveBeenLastCalledWith(
      'src/app.ts',
      'src/app.ts',
      smallBefore,
      smallAfter,
      undefined,
      undefined,
      expect.objectContaining({ timeout: expect.any(Number), maxEditLength: 512 }),
    )
  })

  it('summarizes applied source edits without inventing unavailable line counts', () => {
    const result = summarizeSourceChanges(
      {
        summary: 'new file',
        baseRevision: 0,
        files: [{ path: 'src/renderer/new.ts', content: 'export const one = 1\n' }],
      },
      {
        extensions: [],
        revision: 0,
        paths: [],
        files: [],
        dependencies: {},
        snapshot: {
          extensions: [],
          revision: 0,
          enabled: false,
          canRollback: false,
          path: '',
          recovered: false,
        },
      },
    )
    expect(result).toMatchObject([
      { path: 'src/renderer/new.ts', additions: 1, removals: 0, kind: 'added' },
    ])
    expect(
      reportedFileChanges([
        {
          id: 'write',
          role: 'tool',
          title: 'Write',
          text: 'saved',
          input: JSON.stringify({ file_path: 'new.txt' }),
          status: 'completed',
          turn: 1,
        },
      ]),
    ).toEqual([{ path: 'new.txt' }])
  })

  it('restores queued messages paused and requires their exact saved machine/project', () => {
    const queue = normalizeQueuedMessages([
      { id: 'queued', text: 'Continue', createdAt: 1, attachments: [], paused: false },
      { id: 'bad id', text: 'skip' },
    ])
    expect(queue).toEqual([
      { id: 'queued', text: 'Continue', createdAt: 1, attachments: [], paused: true },
    ])
    const connection = {
      status: 'connected',
      profile: { id: 'machine' },
      workspace: '/one',
    } as ConnectionState
    expect(queueConnectionMatches(thread(), connection)).toBe(true)
    expect(queueConnectionMatches(thread({ workspace: '/two' }), connection)).toBe(false)
    expect(queueConnectionMatches(thread({ profileId: 'other' }), connection)).toBe(false)
  })

  it('groups projects by both machine and path and validates saved arrangement', () => {
    expect(threadProjectKey(thread())).not.toBe(threadProjectKey(thread({ profileId: 'other' })))
    expect(threadProjectKey(thread())).not.toBe(threadProjectKey(thread({ workspace: '/two' })))
    expect(compareSidebarThreads(thread({ busy: true }), thread(), 'activity')).toBeLessThan(0)
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          provider: 'claude',
          sort: 'unknown',
          group: 'scope',
          status: 'waiting',
        }),
    })
    expect(readSidebarArrangement()).toEqual({
      provider: 'claude',
      sort: 'recent',
      group: 'scope',
      status: 'waiting',
    })
  })

  it('keeps safe attachment metadata and enforces file count/size limits', () => {
    const files = Array.from({ length: 9 }, (_, index) => new File(['hello'], `file${index}.txt`))
    const selected = selectDraftAttachments([], files)
    expect(selected.attachments).toHaveLength(8)
    expect(selected.errors).toEqual(['Attach up to 8 files per message.'])
    expect(
      selectDraftAttachments(
        [],
        [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'too-large.dat')],
      ).attachments,
    ).toHaveLength(0)
    const metadata = {
      id: 'safe-id',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      remotePath: '/tmp/file.txt',
    }
    expect(normalizeThreadAttachments([metadata, { ...metadata, id: '../bad' }])).toEqual([
      metadata,
    ])
    expect(attachmentPrompt('Review', [metadata])).toBe('Review')
  })

  it('retains valid live branch/PR observations while rejecting malformed metadata', () => {
    const metadata = normalizeThreadMetadata({
      gitBranch: 'main',
      gitHost: 'example.test',
      gitObservedAt: 1,
      pullRequest: {
        number: 3,
        title: 'Research',
        url: 'https://github.com/example/project/pull/3',
      },
    })
    expect(metadata.pullRequest?.number).toBe(3)
    expect(
      normalizeThreadMetadata({
        gitBranch: 'bad\nbranch',
        pullRequest: { number: -1, title: 'bad', url: 'file:///tmp/private' },
      }).gitBranch,
    ).toBeUndefined()
  })
})
