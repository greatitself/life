import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateProviderTitle } from '../src/main/provider-titles'
import type { SSHConnection } from '../src/main/ssh'

type Wire = Record<string, any>

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  messages: Wire[] = []
  signals: string[] = []
  endedWith?: string
  respond?: (message: Wire) => void
  onEnd?: (text: string) => void
  write(text: string) {
    const message = JSON.parse(text) as Wire
    this.messages.push(message)
    queueMicrotask(() => this.respond?.(message))
    return true
  }
  end(text: string) {
    this.endedWith = text
    queueMicrotask(() => this.onEnd?.(text))
  }
  signal(value: string) {
    this.signals.push(value)
  }
  close() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }
}

function fixture(provider: 'codex' | 'claude' = 'codex', title = 'Investigate workspace crashes') {
  const channel = new Channel()
  const exec = vi.fn(async (command: string) => {
    if (command.startsWith('rm -rf')) return ''
    const path = command.match(/\.life\/metadata\/title-[a-f0-9-]+/)?.[0]
    return `/home/life/${path}`
  })
  const open = vi.fn(async (_command: string) => channel as unknown as ClientChannel)
  if (provider === 'codex')
    channel.respond = (message) => {
      if (message.method === 'initialize') channel.reply({ id: message.id, result: {} })
      if (message.method === 'config/read')
        channel.reply({
          id: message.id,
          result: {
            config: {
              mcp_servers: { research: { enabled: true }, 'server.with.dots': { enabled: true } },
              plugins: { 'plugin@registry': { mcp_servers: { external: { enabled: true } } } },
            },
          },
        })
      if (message.method === 'thread/start')
        channel.reply({ id: message.id, result: { thread: { id: 'ephemeral-title' } } })
      if (message.method === 'turn/start') {
        channel.reply({ id: message.id, result: { turn: { id: 'title-turn' } } })
        channel.reply({
          method: 'item/completed',
          params: {
            threadId: 'ephemeral-title',
            item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ title }) },
          },
        })
        channel.reply({
          method: 'turn/completed',
          params: { threadId: 'ephemeral-title', turn: { status: 'completed', items: [] } },
        })
      }
    }
  else
    channel.onEnd = () =>
      channel.reply({
        type: 'result',
        subtype: 'success',
        structured_output: { title },
      })
  return {
    ssh: { exec, channel: open } as unknown as Pick<SSHConnection, 'exec' | 'channel'>,
    channel,
    exec,
    open,
  }
}

afterEach(() => vi.useRealTimers())

describe('separate provider conversation titles', () => {
  it('sends the original Codex prompt exactly and puts title instructions only in disposable files', async () => {
    const { ssh, channel, exec, open } = fixture()
    const prompt = '  Investigate the freeze\nwith Unicode 🧠 and $(touch /tmp/unsafe)\n'
    expect(await generateProviderTitle(ssh, { provider: 'codex', prompt, cwd: '/project' })).toBe(
      'Investigate workspace crashes',
    )
    const started = channel.messages.find((message) => message.method === 'thread/start')!
    const turn = channel.messages.find((message) => message.method === 'turn/start')!
    expect(turn.params.input).toEqual([{ type: 'text', text: prompt }])
    expect(turn.params.outputSchema.properties.title.maxLength).toBe(80)
    expect(turn.params.sandboxPolicy).toEqual({ type: 'readOnly' })
    expect(started.params).toMatchObject({
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    expect(started.params).not.toHaveProperty('developerInstructions')
    expect(started.params).not.toHaveProperty('baseInstructions')
    expect(exec.mock.calls[0][0]).toContain('/AGENTS.md')
    expect(exec.mock.calls[0][0]).toContain('/CLAUDE.md')
    expect(exec.mock.calls[0][0]).not.toContain(prompt)
    expect(open.mock.calls[0][0]).not.toContain('/project')
    expect(open.mock.calls[0][0]).not.toContain(prompt)
    expect(channel.signals).toEqual(['TERM'])
    expect(channel.destroyed).toBe(true)
    expect(exec.mock.calls[1][0]).toMatch(
      /^rm -rf -- "\$HOME"\/'\.life\/metadata\/title-[a-f0-9-]+'$/,
    )
  })

  it('disables each configured MCP/plugin server rather than relying on an empty merging table', async () => {
    const { ssh, channel, open } = fixture()
    await generateProviderTitle(ssh, { provider: 'codex', prompt: 'Fix a bug', model: 'my-model' })
    const config = channel.messages.find((message) => message.method === 'thread/start')!.params
      .config
    expect(config).toEqual({
      mcp_servers: { research: { enabled: false }, 'server.with.dots': { enabled: false } },
      plugins: {
        'plugin@registry': { enabled: false, mcp_servers: { external: { enabled: false } } },
      },
      web_search: 'disabled',
    })
    expect(open.mock.calls[0][0]).toContain('features.shell_tool=false')
    expect(open.mock.calls[0][0]).toContain('features.unified_exec=false')
    expect(open.mock.calls[0][0]).toContain('features.apps=false')
    expect(
      channel.messages.find((message) => message.method === 'thread/start')!.params.model,
    ).toBe('my-model')
  })

  it('sends only exact Claude text over stdin and disables tools, MCP and persistence', async () => {
    const { ssh, channel, open } = fixture('claude')
    const prompt = 'Fix my code\nDo not add words.  '
    expect(await generateProviderTitle(ssh, { provider: 'claude', prompt, model: 'sonnet' })).toBe(
      'Investigate workspace crashes',
    )
    expect(channel.endedWith).toBe(prompt)
    const command = open.mock.calls[0][0]
    expect(command).toContain("'--tools' ''")
    expect(command).toContain("'--strict-mcp-config' '--mcp-config' '{\"mcpServers\":{}}'")
    expect(command).toContain("'--no-session-persistence'")
    expect(command).toContain('CLAUDE_CODE_DISABLE_ATTACHMENTS=1')
    expect(command).toContain(
      '\'--settings\' \'{"disableAllHooks":true,"autoMemoryEnabled":false}\'',
    )
    expect(command).toContain("'--json-schema'")
    expect(command).toContain("'--model' 'sonnet'")
    expect(command).not.toContain(prompt)
    expect(channel.destroyed).toBe(true)
  })

  it('does not generate a title or launch a process for a cancelled request', async () => {
    const { ssh, exec, open } = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(
      await generateProviderTitle(ssh, { provider: 'codex', prompt: 'Fix it' }, controller.signal),
    ).toBeUndefined()
    expect(exec).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('settles cancellation during initialization, terminates its process and removes only its metadata directory', async () => {
    const { ssh, channel, exec, open } = fixture()
    const controller = new AbortController()
    channel.respond = () => controller.abort()
    const result = generateProviderTitle(
      ssh,
      { provider: 'codex', prompt: 'Fix it' },
      controller.signal,
    )
    await expect(result).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledOnce()
    expect(channel.destroyed).toBe(true)
    expect(exec.mock.calls[1][0]).toMatch(/^rm -rf -- "\$HOME"\/'\.life\/metadata\/title-/)
  })

  it('bounds an unresponsive metadata provider to forty seconds without failing the user turn', async () => {
    vi.useFakeTimers()
    const { ssh, channel } = fixture()
    channel.respond = () => {}
    const pending = generateProviderTitle(ssh, { provider: 'codex', prompt: 'Fix it' })
    await vi.advanceTimersByTimeAsync(40_000)
    await expect(pending).resolves.toBeUndefined()
    expect(channel.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never uses the first prompt as a fallback when a provider returns ordinary prose', async () => {
    const { ssh, channel } = fixture('claude')
    channel.onEnd = () =>
      channel.reply({ type: 'result', subtype: 'success', result: 'I will fix your code now.' })
    expect(
      await generateProviderTitle(ssh, { provider: 'claude', prompt: 'My first prompt' }),
    ).toBeUndefined()
  })

  it.each(['', 'x'.repeat(81), 'Title\nwith control characters'])(
    'rejects invalid generated titles: %j',
    async (title) => {
      const { ssh } = fixture('codex', title)
      expect(
        await generateProviderTitle(ssh, { provider: 'codex', prompt: 'Original message' }),
      ).toBeUndefined()
    },
  )

  it('accepts a successful Unicode title and normalizes display whitespace', async () => {
    const { ssh } = fixture('claude', '  修复 SSH   连接 🧠  ')
    expect(await generateProviderTitle(ssh, { provider: 'claude', prompt: '修复代码' })).toBe(
      '修复 SSH 连接 🧠',
    )
  })

  it('returns no title after a provider failure or early disconnect', async () => {
    const { ssh, channel } = fixture('claude')
    channel.onEnd = () => channel.close()
    expect(
      await generateProviderTitle(ssh, { provider: 'claude', prompt: 'Fix it' }),
    ).toBeUndefined()
  })

  it("uses a completed final item instead of commentary or another thread's metadata", async () => {
    const { ssh, channel } = fixture()
    const original = channel.respond!
    channel.respond = (message) => {
      if (message.method !== 'turn/start') {
        original(message)
        return
      }
      channel.reply({ id: message.id, result: { turn: { id: 'title-turn' } } })
      channel.reply({
        method: 'turn/completed',
        params: { threadId: 'other-thread', turn: { status: 'completed', items: [] } },
      })
      channel.reply({
        method: 'item/agentMessage/delta',
        params: { threadId: 'ephemeral-title', delta: 'Thinking about a title...' },
      })
      channel.reply({
        method: 'turn/completed',
        params: {
          threadId: 'ephemeral-title',
          turn: {
            status: 'completed',
            items: [
              { type: 'agentMessage', phase: 'commentary', text: 'Drafting metadata' },
              {
                type: 'agentMessage',
                phase: 'final_answer',
                text: '{"title":"Preserve SSH sessions"}',
              },
            ],
          },
        },
      })
    }
    expect(await generateProviderTitle(ssh, { provider: 'codex', prompt: 'Fix sessions' })).toBe(
      'Preserve SSH sessions',
    )
  })

  it('rejects a failed turn even if it emitted a plausible title', async () => {
    const { ssh, channel } = fixture()
    const original = channel.respond!
    channel.respond = (message) => {
      if (message.method !== 'turn/start') {
        original(message)
        return
      }
      channel.reply({ id: message.id, result: { turn: { id: 'title-turn' } } })
      channel.reply({
        method: 'item/completed',
        params: {
          threadId: 'ephemeral-title',
          item: { type: 'agentMessage', text: '{"title":"Incomplete work"}' },
        },
      })
      channel.reply({
        method: 'turn/completed',
        params: { threadId: 'ephemeral-title', turn: { status: 'failed', items: [] } },
      })
    }
    expect(
      await generateProviderTitle(ssh, { provider: 'codex', prompt: 'Fix sessions' }),
    ).toBeUndefined()
  })

  it('bounds an unresponsive Claude task and ignores a result arriving after cancellation', async () => {
    vi.useFakeTimers()
    const { ssh, channel } = fixture('claude')
    channel.onEnd = () => {}
    const pending = generateProviderTitle(ssh, { provider: 'claude', prompt: 'Fix it' })
    await vi.advanceTimersByTimeAsync(40_000)
    await expect(pending).resolves.toBeUndefined()
    expect(channel.destroyed).toBe(true)
    channel.reply({ type: 'result', subtype: 'success', structured_output: { title: 'Too late' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('denies unexpected Codex approval requests without exposing them in the coding conversation', async () => {
    const { ssh, channel } = fixture()
    const original = channel.respond!
    channel.respond = (message) => {
      if (message.method === 'turn/start')
        channel.reply({
          id: 'approval',
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'ephemeral-title' },
        })
      original(message)
    }
    expect(await generateProviderTitle(ssh, { provider: 'codex', prompt: 'Fix it' })).toBe(
      'Investigate workspace crashes',
    )
    expect(channel.messages.find((message) => message.id === 'approval')).toMatchObject({
      error: { code: -32601 },
    })
  })

  it('cleans the known UUID path rather than trusting a malformed remote directory response', async () => {
    const { ssh, exec, open } = fixture()
    exec.mockResolvedValueOnce('/tmp/unrelated-directory')
    expect(
      await generateProviderTitle(ssh, { provider: 'codex', prompt: 'Fix it' }),
    ).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
    expect(exec.mock.calls[1][0]).not.toContain('/tmp/unrelated-directory')
  })
})
