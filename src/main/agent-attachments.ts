import { TextDecoder } from 'node:util'
import type { AgentAttachment } from '../shared/types'
import { shellQuote } from '../shared/validation'
import type { SSHConnection } from './ssh'

type Wire = Record<string, unknown>

const maximumFiles = 8
const maximumFileBytes = 10 * 1024 * 1024
const maximumTotalBytes = 25 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const imageExtensions: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function selectedAttachments(attachments: AgentAttachment[] = []): AgentAttachment[] {
  if (attachments.length > maximumFiles) throw new Error('Attach up to 8 files per message.')
  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment.remotePath !== 'string' ||
      !attachment.remotePath ||
      attachment.remotePath.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(attachment.remotePath) ||
      typeof attachment.name !== 'string' ||
      !attachment.name ||
      attachment.name.length > 1024 ||
      typeof attachment.mimeType !== 'string' ||
      attachment.mimeType.length > 200
    )
      throw new Error('Invalid attachment metadata.')
  }
  return attachments
}

function mediaType(attachment: AgentAttachment): string {
  const mime = attachment.mimeType.toLowerCase().split(';', 1)[0].trim()
  if (mime && mime !== 'application/octet-stream') return mime
  const extension = attachment.name.split('.').pop()?.toLowerCase() || ''
  return imageExtensions[extension] || (extension === 'pdf' ? 'application/pdf' : mime)
}

/** Native input blocks keep the submitted text byte-for-byte and add no Life prose. */
export function codexUserInput(prompt: string, attachments?: AgentAttachment[]): Wire[] {
  return [
    { type: 'text', text: prompt },
    ...selectedAttachments(attachments).map((attachment) =>
      imageTypes.has(mediaType(attachment))
        ? { type: 'localImage', path: attachment.remotePath }
        : { type: 'text', text: attachment.remotePath },
    ),
  ]
}

// Only this fixed script enters the shell. User-selected paths travel as JSON on
// stdin, never as shell arguments. Nonblocking open rejects directories/FIFOs;
// stat and every read enforce limits even if a file grows during the transfer.
const readAttachments = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 133120) throw new Error('Invalid attachment request.');
  }
  const request = JSON.parse(input);
  if (!Array.isArray(request.paths) || request.paths.length > 8)
    throw new Error('Attach up to 8 files per message.');
  const fileLimit = 10 * 1024 * 1024;
  const totalLimit = 25 * 1024 * 1024;
  let total = 0;
  const files = [];
  for (const selectedPath of request.paths) {
    if (typeof selectedPath !== 'string' || !selectedPath || selectedPath.length > 4096 || /[\x00-\x1f\x7f]/.test(selectedPath))
      throw new Error('Invalid attachment path.');
    const filename = selectedPath === '~' ? os.homedir()
      : selectedPath.startsWith('~/') ? path.join(os.homedir(), selectedPath.slice(2)) : selectedPath;
    const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Attachments must be regular files.');
      if (stat.size > fileLimit) throw new Error('Attachment exceeds the 10 MB file limit.');
      if (total + stat.size > totalLimit) throw new Error('Attachments must total 25 MB or less.');
      const chunks = [];
      let size = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, fileLimit - size + 1, totalLimit - total - size + 1));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > fileLimit) throw new Error('Attachment exceeds the 10 MB file limit.');
        if (total + size > totalLimit) throw new Error('Attachments must total 25 MB or less.');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      total += size;
      files.push({ size, data: Buffer.concat(chunks, size).toString('base64') });
    } finally {
      await file.close();
    }
  }
  process.stdout.write(JSON.stringify(files));
})().catch(error => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`

const readAttachmentsPython = String.raw`
import base64, json, os, re, stat, sys
try:
    raw = sys.stdin.buffer.read(133121)
    if len(raw) > 133120:
        raise ValueError('Invalid attachment request.')
    request = json.loads(raw.decode('utf-8'))
    paths = request.get('paths')
    if not isinstance(paths, list) or len(paths) > 8:
        raise ValueError('Attach up to 8 files per message.')
    file_limit = 10 * 1024 * 1024
    total_limit = 25 * 1024 * 1024
    total = 0
    files = []
    for selected_path in paths:
        if not isinstance(selected_path, str) or not selected_path or len(selected_path) > 4096 or re.search(r'[\x00-\x1f\x7f]', selected_path):
            raise ValueError('Invalid attachment path.')
        filename = os.path.expanduser(selected_path) if selected_path == '~' or selected_path.startswith('~/') else selected_path
        descriptor = os.open(filename, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Attachments must be regular files.')
            if info.st_size > file_limit:
                raise ValueError('Attachment exceeds the 10 MB file limit.')
            if total + info.st_size > total_limit:
                raise ValueError('Attachments must total 25 MB or less.')
            chunks = []
            size = 0
            while True:
                chunk = os.read(descriptor, min(65536, file_limit - size + 1, total_limit - total - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > file_limit:
                    raise ValueError('Attachment exceeds the 10 MB file limit.')
                if total + size > total_limit:
                    raise ValueError('Attachments must total 25 MB or less.')
                chunks.append(chunk)
            total += size
            files.append({'size': size, 'data': base64.b64encode(b''.join(chunks)).decode('ascii')})
        finally:
            os.close(descriptor)
    sys.stdout.write(json.dumps(files, separators=(',', ':')))
except Exception as error:
    sys.stderr.write(str(error))
    sys.exit(1)
`

const readAttachmentsCommand = `if command -v node >/dev/null 2>&1; then
  exec node -e ${shellQuote(readAttachments)}
elif command -v python3 >/dev/null 2>&1; then
  exec python3 -c ${shellQuote(readAttachmentsPython)}
else
  printf '%s' 'Attachments require Node.js or Python 3 on the connected machine.' >&2
  exit 127
fi`

function nativeAttachment(attachment: AgentAttachment, bytes: Buffer): Wire {
  const mime = mediaType(attachment)
  if (imageTypes.has(mime))
    return {
      type: 'image',
      source: { type: 'base64', media_type: mime, data: bytes.toString('base64') },
    }
  if (mime === 'application/pdf')
    return {
      type: 'document',
      title: attachment.name,
      source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
    }
  // A text document carries only the file's original content and user-selected
  // filename. Invalid UTF-8 or binary data stays a bare path for Claude's tools.
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
      return {
        type: 'document',
        title: attachment.name,
        source: { type: 'text', media_type: 'text/plain', data: text },
      }
  } catch {
    // Unsupported binary formats have no native Messages document block.
  }
  return { type: 'text', text: attachment.remotePath }
}

/** Read explicitly selected files for native Claude image/document content. */
export async function claudeUserContent(
  ssh: Pick<SSHConnection, 'exec'>,
  prompt: string,
  attachments?: AgentAttachment[],
  signal?: AbortSignal,
): Promise<Wire[]> {
  const selected = selectedAttachments(attachments)
  if (signal?.aborted) throw new Error('Attachment transfer cancelled.')
  const content: Wire[] = [{ type: 'text', text: prompt }]
  if (!selected.length) return content
  const output = await ssh.exec(readAttachmentsCommand, {
    input: JSON.stringify({ paths: selected.map((attachment) => attachment.remotePath) }),
    signal,
    maxOutputBytes: Math.ceil((maximumTotalBytes * 4) / 3) + 65536,
    timeoutMs: 30000,
    rendererOwned: false,
  })
  if (signal?.aborted) throw new Error('Attachment transfer cancelled.')
  let files: unknown
  try {
    files = JSON.parse(output)
  } catch {
    throw new Error('Invalid attachment response.')
  }
  if (!Array.isArray(files) || files.length !== selected.length)
    throw new Error('Invalid attachment response.')
  let total = 0
  for (const [index, value] of files.entries()) {
    if (
      !value ||
      typeof value !== 'object' ||
      !Number.isInteger(value.size) ||
      value.size < 0 ||
      value.size > maximumFileBytes ||
      typeof value.data !== 'string' ||
      value.data.length > Math.ceil((maximumFileBytes * 4) / 3) + 4 ||
      value.data.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(value.data)
    )
      throw new Error('Invalid attachment response.')
    const bytes = Buffer.from(value.data, 'base64')
    if (bytes.length !== value.size || bytes.toString('base64') !== value.data)
      throw new Error('Invalid attachment response.')
    total += bytes.length
    if (total > maximumTotalBytes) throw new Error('Attachments must total 25 MB or less.')
    content.push(nativeAttachment(selected[index], bytes))
  }
  return content
}
