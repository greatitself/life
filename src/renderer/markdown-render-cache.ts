/** Cache immutable render descriptions; source size and entry count both bound retention. */
export class MarkdownRenderCache<T> {
  private entries = new Map<string, T>()
  private characters = 0

  constructor(
    private maximumCharacters = 1_000_000,
    private maximumEntries = 1000,
    private maximumEntryCharacters = 20_000,
  ) {}

  render(text: string, create: () => T): T {
    if (this.entries.has(text)) {
      const value = this.entries.get(text)!
      this.entries.delete(text)
      this.entries.set(text, value)
      return value
    }
    const value = create()
    if (
      text.length > this.maximumEntryCharacters ||
      text.length > this.maximumCharacters ||
      this.maximumEntries < 1
    )
      return value
    this.entries.set(text, value)
    this.characters += text.length
    while (this.characters > this.maximumCharacters || this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
      this.characters -= oldest.length
    }
    return value
  }
}
