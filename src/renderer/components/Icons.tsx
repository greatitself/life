import { providerArtwork } from '../provider-artwork'

/** Life's branching L represents research paths that share a common starting point. */
export function LifeMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className="life-mark"
      aria-hidden="true"
    >
      <path
        d="M7 5v22h19M7 16h10l8-8"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g fill="currentColor">
        <circle cx="7" cy="5" r="2.75" />
        <circle cx="7" cy="16" r="2.75" />
        <circle cx="7" cy="27" r="2.75" />
        <circle cx="26" cy="27" r="2.75" />
        <circle cx="25" cy="8" r="2.75" />
      </g>
    </svg>
  )
}

// Existing callers keep working while the application adopts the Life name.
export const RelayMark = LifeMark

/** Original SVGL artwork, rendered in the current theme's foreground color. */
export function ProviderIcon({
  provider,
  size = 20,
}: {
  provider: 'codex' | 'claude'
  size?: number
  brand?: boolean
}) {
  const artwork = providerArtwork[provider === 'claude' ? 'claude' : 'openai']

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="provider-icon"
      data-provider={provider}
      width={size}
      height={size}
      viewBox={artwork.viewBox}
      preserveAspectRatio="xMidYMid meet"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        flexShrink: 0,
        verticalAlign: 'middle',
      }}
    >
      <path d={artwork.path} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  )
}
