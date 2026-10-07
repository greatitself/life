export function RelayMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M5 18V6h12M27 14v12H15"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m6 25 19-19M16 6h9v9"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
export function ProviderIcon({
  provider,
  size = 20,
}: {
  provider: 'codex' | 'claude'
  size?: number
}) {
  return provider === 'claude' ? (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="claude-icon"
      aria-hidden="true"
    >
      <path
        d="M12 2v20M2 12h20M5 5l14 14M5 19 19 5M8 3l8 18M3 8l18 8M3 16l18-8M8 21l8-18"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
