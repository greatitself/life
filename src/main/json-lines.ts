import { StringDecoder } from 'node:string_decoder'
export class JsonLines {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private discarding = false
  constructor(
    private onMessage: (message: Record<string, unknown>) => void,
    private onInvalid: (line: string) => void = () => {},
    private maxFrameLength = 8_000_000,
  ) {}
  push(chunk: Buffer | string) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      const end = newline < 0 ? text.length : newline
      if (!this.discarding) {
        if (this.buffer.length + end - offset > this.maxFrameLength) {
          this.buffer = ''
          this.discarding = true
          this.onInvalid('Agent output exceeded the message limit')
        } else this.buffer += text.slice(offset, end)
      }
      if (newline < 0) return
      offset = newline + 1
      if (this.discarding) {
        this.discarding = false
        continue
      }
      const line = this.buffer.trim()
      this.buffer = ''
      if (!line) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        this.onInvalid(line)
        continue
      }
      if (value && typeof value === 'object' && !Array.isArray(value))
        this.onMessage(value as Record<string, unknown>)
    }
  }
}
