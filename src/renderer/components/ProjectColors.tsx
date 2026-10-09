import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConnectionProfile, ConnectionState } from '../../shared/types'
import type { Thread } from '../state'
import { threadProjectKey } from '../sidebar-ordering'
import { useBuiltinFeature } from '../builtin-extensions'

const storageKey = 'life.project-colors.v1'
const palette = [
  '#3155a6',
  '#843fa0',
  '#246d60',
  '#90432c',
  '#755623',
  '#a13551',
  '#405d7b',
  '#5d4892',
]
const ProjectColors = createContext<ReadonlyMap<string, string>>(new Map())
const ProjectColorsEnabled = createContext(true)
const noColors = new Map<string, string>()

function hash(key: string) {
  let result = 2166136261
  for (const character of key) result = Math.imul(result ^ character.charCodeAt(0), 16777619)
  return result >>> 0
}

function rgb(color: string) {
  const value = Number.parseInt(color.slice(1), 16)
  return [value >>> 16, (value >>> 8) & 255, value & 255]
}

function whiteContrast(color: string) {
  const channels = rgb(color).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  return 1.05 / (luminance + 0.05)
}

function hex(red: number, green: number, blue: number) {
  return '#' + ((red << 16) | (green << 8) | blue).toString(16).padStart(6, '0')
}

const candidates: string[] = []
for (let red = 27; red <= 147; red += 20)
  for (let green = 27; green <= 147; green += 20)
    for (let blue = 27; blue <= 147; blue += 20) {
      const color = hex(red, green, blue)
      if (whiteContrast(color) >= 4.5) candidates.push(color)
    }

function read(raw: string | null): Map<string, string> {
  const result = new Map<string, string>()
  try {
    const data = JSON.parse(raw || 'null')
    if (data?.version !== 1 || !Array.isArray(data.colors)) return result
    for (const entry of data.colors) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'string'
      )
        continue
      const color = entry[1].toLowerCase()
      if (!/^#[0-9a-f]{6}$/.test(color) || whiteContrast(color) < 4.5) continue
      const existing = result.get(entry[0])
      if (!existing || color < existing) result.set(entry[0], color)
    }
  } catch {
    // Rendering remains usable without browser storage.
  }
  return result
}

function same(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) {
  return a.size === b.size && [...a].every(([key, color]) => b.get(key) === color)
}

function merge(a: Map<string, string>, b: ReadonlyMap<string, string>) {
  const result = new Map(a)
  for (const [key, color] of b) {
    const existing = result.get(key)
    if (!existing || color < existing) result.set(key, color)
  }
  return same(a, result) ? a : result
}

function choose(key: string, used: Set<string>) {
  const preferred = palette[hash(key) % palette.length]!
  if (!used.has(preferred)) return preferred
  const existing = [...used].map(rgb)
  const best = (choices: string[]) => {
    let selected: string | undefined
    let greatestDistance = -1
    for (const color of choices) {
      if (used.has(color)) continue
      const channels = rgb(color)
      let distance = Infinity
      for (const previous of existing) {
        const squared = channels.reduce(
          (sum, channel, index) => sum + (channel - previous[index]!) ** 2,
          0,
        )
        distance = Math.min(distance, squared)
      }
      if (distance > greatestDistance) {
        greatestDistance = distance
        selected = color
      }
    }
    return selected
  }
  const selected = best(palette) || best(candidates)
  if (selected) return selected
  for (let red = 0; red <= 120; red++)
    for (let green = 0; green <= 120; green++)
      for (let blue = 0; blue <= 120; blue++) {
        const color = hex(red, green, blue)
        if (!used.has(color) && whiteContrast(color) >= 4.5) return color
      }
  throw new Error('Project color capacity exceeded.')
}

function reconcile(saved: Map<string, string>, requested: readonly string[]) {
  const keys = [...new Set([...saved.keys(), ...requested])].sort()
  const result = new Map<string, string>()
  const used = new Set<string>()
  for (const key of keys) {
    const color = saved.get(key)
    if (color && !used.has(color)) {
      result.set(key, color)
      used.add(color)
    }
  }
  for (const key of keys)
    if (!result.has(key)) {
      const color = choose(key, used)
      result.set(key, color)
      used.add(color)
    }
  return same(saved, result) ? saved : result
}

function serialize(colors: ReadonlyMap<string, string>) {
  return JSON.stringify({
    version: 1,
    colors: [...colors].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  })
}

export function ProjectColorsProvider({
  threads,
  profiles,
  connection,
  projectKeys = [],
  children,
}: {
  threads: Thread[]
  profiles: ConnectionProfile[]
  connection: ConnectionState
  projectKeys?: string[]
  children: ReactNode
}) {
  const enabled = useBuiltinFeature('project-colors')
  const [registry, setRegistry] = useState(() => {
    try {
      return read(localStorage.getItem(storageKey))
    } catch {
      return new Map<string, string>()
    }
  })
  const signature = JSON.stringify(
    [
      ...new Set([
        ...projectKeys,
        ...threads.map(threadProjectKey),
        ...profiles.flatMap((profile) => [
          JSON.stringify([profile.id, null]),
          ...(profile.workspace ? [JSON.stringify([profile.id, profile.workspace])] : []),
        ]),
        ...(connection.profile && connection.workspace
          ? [JSON.stringify([connection.profile.id, connection.workspace])]
          : []),
      ]),
    ].sort(),
  )
  const keys = useMemo(() => JSON.parse(signature) as string[], [signature])
  const colors = useMemo(
    () => (enabled ? reconcile(registry, keys) : noColors),
    [enabled, registry, keys],
  )

  useEffect(() => {
    if (!enabled) return
    try {
      const raw = localStorage.getItem(storageKey)
      const combined = reconcile(merge(colors, read(raw)), keys)
      if (!same(colors, combined)) {
        setRegistry((current) => reconcile(merge(current, combined), keys))
        return
      }
      const encoded = serialize(colors)
      if (encoded !== raw) localStorage.setItem(storageKey, encoded)
    } catch {
      // Retain all assignments in memory when storage is unavailable.
    }
    setRegistry((current) => reconcile(merge(current, colors), keys))
  }, [enabled, colors, keys])

  useEffect(() => {
    if (!enabled) return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return
      const incoming = read(event.newValue)
      setRegistry((current) => reconcile(merge(current, incoming), keys))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [enabled, keys])

  return (
    <ProjectColorsEnabled.Provider value={enabled}>
      <ProjectColors.Provider value={colors}>{children}</ProjectColors.Provider>
    </ProjectColorsEnabled.Provider>
  )
}

export function useProjectKeyColor(key: string): string {
  const colors = useContext(ProjectColors)
  const enabled = useContext(ProjectColorsEnabled)
  if (!enabled) return '#59616b'
  return colors.get(key) || palette[hash(key) % palette.length]!
}

export function useProjectColor(thread: Thread): string {
  return useProjectKeyColor(threadProjectKey(thread))
}
