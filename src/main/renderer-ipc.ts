/** Native capabilities belong to the current main document, never embedded maps. */
export function isTrustedRendererSender(
  owner: { webContents: { mainFrame: unknown } } | null,
  event: { sender: unknown; senderFrame: unknown },
): boolean {
  return Boolean(
    owner &&
    event.sender === owner.webContents &&
    event.senderFrame === owner.webContents.mainFrame,
  )
}
