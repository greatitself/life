import { StringDecoder } from 'node:string_decoder'
export class JsonLines {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  constructor(
    private onMessage: (message: Record<string, unknown>) => void,
    private onInvalid: (line: string) => void = () => {},
  ) {}
  push(chunk: Buffer | string) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (this.buffer.length > 8_000_000) {
      this.buffer = ''
      this.onInvalid('Agent output exceeded the message limit')
      return
    }
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
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
