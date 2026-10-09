import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeUserContent, codexUserInput } from '../src/main/agent-attachments'
import type { AgentAttachment } from '../src/shared/types'
import type { SSHConnection } from '../src/main/ssh'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-agent-attachments-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function attachment(
  name: string,
  mimeType: string,
  data: string | Buffer = '',
): Promise<AgentAttachment> {
  const remotePath = join(directory, name)
  await writeFile(remotePath, data)
  return { remotePath, name, mimeType }
}

// Execute the production read command against real temporary files. User paths
// stay in stdin so shell-sensitive names exercise the actual transport boundary.
function localSSH(
  runtime: 'node' | 'python3' = 'node',
  executablePath?: string,
): Pick<SSHConnection, 'exec'> {
  return {
    exec: vi.fn(async (command, options = {}) => {
      const prefix = runtime === 'node' ? '  exec node -e ' : '  exec python3 -c '
      const start = command.indexOf(prefix) + prefix.length
      const end = command.indexOf(runtime === 'node' ? '\nelif command' : '\nelse', start)
      const quoted = command.slice(start, end)
      expect(command.startsWith('if command -v node')).toBe(true)
      expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true)
      const script = quoted.slice(1, -1).replace(/'\\''/g, "'")
      const child = executablePath
        ? spawn('/bin/sh', ['-c', command], {
            signal: options.signal,
            env: { ...process.env, PATH: executablePath },
          })
        : spawn(
            runtime === 'node' ? process.execPath : 'python3',
            [runtime === 'node' ? '-e' : '-c', script],
            { signal: options.signal },
          )
      return new Promise<string>((resolve, reject) => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let length = 0
        child.stdout.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > (options.maxOutputBytes || Infinity)) {
            child.kill()
            reject(new Error('Remote output exceeds the command output limit'))
          }
          stdout.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
          else reject(new Error(Buffer.concat(stderr).toString('utf8') || `Exit ${code}`))
        })
        child.stdin.end(options.input)
      })
    }),
  }
}

describe('exact agent messages and selected attachment blocks', () => {
  const prompt = '  /life literal\r\n```${doNotInterpolate}```\n👋 café\t '

  it('preserves the whole Codex prompt without trimming, labels or extra blocks', () => {
    expect(codexUserInput(prompt)).toEqual([{ type: 'text', text: prompt }])
    expect(codexUserInput('')).toEqual([{ type: 'text', text: '' }])
  })

  it('preserves the whole Claude prompt and does not read files without explicit selection', async () => {
    const ssh = localSSH()
    expect(await claudeUserContent(ssh, prompt)).toEqual([{ type: 'text', text: prompt }])
    expect(ssh.exec).not.toHaveBeenCalled()
  })

  it.each([
    ['image/png', 'design.png'],
    ['image/jpeg', 'photo.jpg'],
    ['image/gif', 'animated.gif'],
    ['image/webp', 'preview.webp'],
    ['', 'unknown-type.PNG'],
    ['application/octet-stream', 'unknown-type.jpeg'],
  ])('sends a native Codex local image for %s %s', async (mime, name) => {
    const selected = await attachment(name, mime)
    expect(codexUserInput(prompt, [selected])).toEqual([
      { type: 'text', text: prompt },
      { type: 'localImage', path: selected.remotePath },
    ])
  })

  it('represents Codex non-image files as exact bare paths instead of unsupported mentions', async () => {
    const selected = await attachment('diagram.svg', 'image/svg+xml', '<svg/>')
    const pdf = await attachment('report.pdf', 'application/pdf', '%PDF-1.7')
    expect(codexUserInput(prompt, [selected, pdf])).toEqual([
      { type: 'text', text: prompt },
      { type: 'text', text: selected.remotePath },
      { type: 'text', text: pdf.remotePath },
    ])
  })

  it('sends native Claude raster images, PDF and whole original text documents in selection order', async () => {
    const image = await attachment('pixel.png', 'image/png', Buffer.from([137, 80, 78, 71]))
    const pdf = await attachment('report.pdf', 'application/pdf', '%PDF-1.7\nuser content')
    const text = '\ufeff  # Document\r\n👋 unchanged\n'
    const code = await attachment('source.ts', 'application/octet-stream', text)
    const ssh = localSSH()
    expect(await claudeUserContent(ssh, prompt, [image, pdf, code])).toEqual([
      { type: 'text', text: prompt },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from([137, 80, 78, 71]).toString('base64'),
        },
      },
      {
        type: 'document',
        title: 'report.pdf',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('%PDF-1.7\nuser content').toString('base64'),
        },
      },
      {
        type: 'document',
        title: 'source.ts',
        source: { type: 'text', media_type: 'text/plain', data: text },
      },
    ])
    expect(ssh.exec).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ssh.exec).mock.calls[0][1]).toMatchObject({
      rendererOwned: false,
      timeoutMs: 30000,
    })
  })

  it.each([Buffer.from([0, 1, 2]), Buffer.from([1, 2, 3]), Buffer.from([0xff, 0xfe, 0xfd])])(
    'keeps unsupported Claude binary files as their exact path',
    async (bytes) => {
      const selected = await attachment('archive.bin', 'application/octet-stream', bytes)
      expect(await claudeUserContent(localSSH(), prompt, [selected])).toEqual([
        { type: 'text', text: prompt },
        { type: 'text', text: selected.remotePath },
      ])
    },
  )

  it('never puts shell-sensitive selected paths in the command', async () => {
    const selected = await attachment(
      "$(touch SHELL_EXECUTED) `echo bad` 'quoted'.txt",
      'text/plain',
      'literal content',
    )
    const ssh = localSSH()
    const content = await claudeUserContent(ssh, prompt, [selected])
    expect(content[1]).toMatchObject({ source: { data: 'literal content' } })
    const [command, options] = vi.mocked(ssh.exec).mock.calls[0]
    expect(command).not.toContain(selected.remotePath)
    expect(JSON.parse(options!.input!)).toEqual({ paths: [selected.remotePath] })
  })

  it('reads a Unicode path and keeps Unicode file content unchanged', async () => {
    const selected = await attachment('résumé-👋.md', 'text/markdown', '研究 👋\r\n')
    expect(await claudeUserContent(localSSH(), prompt, [selected])).toEqual([
      { type: 'text', text: prompt },
      {
        type: 'document',
        title: selected.name,
        source: { type: 'text', media_type: 'text/plain', data: '研究 👋\r\n' },
      },
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'selects the real Python fallback on a host without Node and preserves selected native blocks',
    async () => {
      const executablePath = join(directory, 'python-only-bin')
      await mkdir(executablePath)
      await symlink('/usr/bin/python3', join(executablePath, 'python3'))
      const text = '\ufeff👋 résumé\r\n  original text\t'
      const selected = await attachment(
        "$(touch PYTHON_SHELL_EXECUTED) '研究'.txt",
        'text/plain',
        text,
      )
      const image = await attachment('image.png', 'image/png', Buffer.from([137, 80, 78, 71]))
      const ssh = localSSH('python3', executablePath)
      expect(await claudeUserContent(ssh, prompt, [selected, image])).toEqual([
        { type: 'text', text: prompt },
        {
          type: 'document',
          title: selected.name,
          source: { type: 'text', media_type: 'text/plain', data: text },
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from([137, 80, 78, 71]).toString('base64'),
          },
        },
      ])
      expect(vi.mocked(ssh.exec).mock.calls[0][0]).not.toContain(selected.remotePath)
    },
  )

  it('enforces the exact per-file limit with the real Python reader', async () => {
    const selected = await attachment('python-exact.bin', 'application/octet-stream')
    await truncate(selected.remotePath, 10 * 1024 * 1024)
    expect(await claudeUserContent(localSSH('python3'), prompt, [selected])).toEqual([
      { type: 'text', text: prompt },
      { type: 'text', text: selected.remotePath },
    ])
    await truncate(selected.remotePath, 10 * 1024 * 1024 + 1)
    await expect(claudeUserContent(localSSH('python3'), prompt, [selected])).rejects.toThrow(
      '10 MB file limit',
    )
  })

  it('rejects a real Python batch above the 25 MB aggregate limit', async () => {
    const files: AgentAttachment[] = []
    for (const [index, size] of [10, 10, 6].entries()) {
      const selected = await attachment(`python-${index}.bin`, 'application/octet-stream')
      await truncate(selected.remotePath, size * 1024 * 1024)
      files.push(selected)
    }
    await expect(claudeUserContent(localSSH('python3'), prompt, files)).rejects.toThrow(
      '25 MB or less',
    )
  })

  it('rejects a directory using the real Python reader', async () => {
    const selected = {
      remotePath: directory,
      name: 'directory',
      mimeType: 'application/octet-stream',
    }
    await expect(claudeUserContent(localSSH('python3'), prompt, [selected])).rejects.toThrow(
      'regular files',
    )
  })

  it('rejects nine selected files before any remote read or prompt submission', async () => {
    const selected = await attachment('notes.txt', 'text/plain', 'notes')
    const files = Array(9).fill(selected)
    const ssh = localSSH()
    expect(() => codexUserInput(prompt, files)).toThrow('Attach up to 8 files')
    await expect(claudeUserContent(ssh, prompt, files)).rejects.toThrow('Attach up to 8 files')
    expect(ssh.exec).not.toHaveBeenCalled()
  })

  it('rejects an oversized real remote file before allocating its contents', async () => {
    const selected = await attachment('large.bin', 'application/octet-stream')
    await truncate(selected.remotePath, 10 * 1024 * 1024 + 1)
    await expect(claudeUserContent(localSSH(), prompt, [selected])).rejects.toThrow(
      '10 MB file limit',
    )
  })

  it('accepts the exact per-file limit and preserves every byte', async () => {
    const selected = await attachment('exact.txt', 'text/plain')
    await writeFile(selected.remotePath, 'x'.repeat(10 * 1024 * 1024))
    const content = await claudeUserContent(localSSH(), prompt, [selected])
    expect((content[1].source as Record<string, unknown>).data).toBe('x'.repeat(10 * 1024 * 1024))
  })

  it('rejects a real batch above the 25 MB aggregate limit', async () => {
    const files: AgentAttachment[] = []
    for (const [index, size] of [10, 10, 6].entries()) {
      const selected = await attachment(`${index}.bin`, 'application/octet-stream')
      await truncate(selected.remotePath, size * 1024 * 1024)
      files.push(selected)
    }
    await expect(claudeUserContent(localSSH(), prompt, files)).rejects.toThrow('25 MB or less')
  })

  it('rejects a directory and missing file without a partially assembled message', async () => {
    const valid = await attachment('valid.txt', 'text/plain', 'valid')
    await expect(
      claudeUserContent(localSSH(), prompt, [valid, { ...valid, remotePath: directory }]),
    ).rejects.toThrow('regular files')
    await expect(
      claudeUserContent(localSSH(), prompt, [{ ...valid, remotePath: join(directory, 'missing') }]),
    ).rejects.toThrow('ENOENT')
  })

  it('honors cancellation before reading and after a late remote response', async () => {
    const selected = await attachment('notes.txt', 'text/plain', 'original')
    const before = new AbortController()
    before.abort()
    const ssh = localSSH()
    await expect(claudeUserContent(ssh, prompt, [selected], before.signal)).rejects.toThrow(
      'cancelled',
    )
    expect(ssh.exec).not.toHaveBeenCalled()
    const after = new AbortController()
    const late = {
      exec: vi.fn(async () => {
        after.abort()
        return JSON.stringify([{ size: 8, data: Buffer.from('original').toString('base64') }])
      }),
    }
    await expect(claudeUserContent(late, prompt, [selected], after.signal)).rejects.toThrow(
      'cancelled',
    )
  })

  it.each(
    [
      [],
      [{ size: 4, data: '%%%%' }],
      [{ size: 4, data: 'YQ==' }],
      [{ size: 1, data: 'YR==' }],
      [{ size: -1, data: '' }],
      [{ size: 10 * 1024 * 1024 + 1, data: '' }],
    ].map((response) => ({ response })),
  )('rejects malformed or inconsistent remote responses $response', async ({ response }) => {
    const selected = await attachment('notes.txt', 'text/plain', 'notes')
    await expect(
      claudeUserContent({ exec: vi.fn(async () => JSON.stringify(response)) }, prompt, [selected]),
    ).rejects.toThrow('Invalid attachment response')
  })
})
