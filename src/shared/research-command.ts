/** Keep research setup and staged writes below SSH's single exec packet budget. */
export async function researchCommand(
  worker: string,
  input: Record<string, unknown>,
): Promise<string> {
  const content = new TextEncoder().encode(JSON.stringify({ worker, input }))
  const compressed = await new Response(
    new Blob([content]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()
  const bytes = new Uint8Array(compressed)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  const payload = btoa(binary)
  const loader =
    "const lifeResearchPayload=JSON.parse(require('node:zlib').gunzipSync(Buffer.from(process.argv[1],'base64')).toString('utf8'));process.argv[1]=JSON.stringify(lifeResearchPayload.input);eval(lifeResearchPayload.worker)"
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
  const command =
    'if command -v node >/dev/null 2>&1; then life_research_node=node; elif command -v nodejs >/dev/null 2>&1; then life_research_node=nodejs; else printf "Research file sync requires Node.js on this machine.\\n" >&2; exit 1; fi\n"$life_research_node" -e ' +
    quote(loader) +
    ' ' +
    quote(payload)
  if (new TextEncoder().encode(command).length > 30000)
    throw new Error(
      'This Research transfer exceeds the SSH command budget. Split this file into smaller edits.',
    )
  return command
}
