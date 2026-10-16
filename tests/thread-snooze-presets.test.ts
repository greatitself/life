import { DateTime } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  resolveThreadSnoozePreset,
  resolveThreadSnoozePresets,
} from '../src/renderer/thread-snooze-presets'

const HOUR_MS = 60 * 60 * 1_000
const instant = (value: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(value))

describe('thread snooze presets', () => {
  it('offers the finite preset menu with exact relative deadlines and calendar wake hours', () => {
    const now = instant('2026-10-16T12:34:56.789Z')
    const choices = resolveThreadSnoozePresets(now, 'UTC')
    expect(choices.map(({ id, label, until }) => ({ id, label, until }))).toEqual([
      { id: 'hour', label: 'In 1 hour', until: instant('2026-10-16T13:34:56.789Z') },
      { id: 'three-hours', label: 'In 3 hours', until: instant('2026-10-16T15:34:56.789Z') },
      { id: 'evening', label: 'This evening', until: instant('2026-10-16T18:00:00.000Z') },
      { id: 'tomorrow', label: 'Tomorrow', until: instant('2026-10-17T09:00:00.000Z') },
      { id: 'next-week', label: 'Next week', until: instant('2026-10-19T09:00:00.000Z') },
    ])
    expect(choices.every((choice) => choice.detail.trim().length > 0)).toBe(true)
    expect(new Set(choices.map((choice) => choice.id)).size).toBe(choices.length)
    expect(choices.every((choice) => Number.isFinite(choice.until) && choice.until > now)).toBe(
      true,
    )
  })

  it.each([
    { now: '2026-10-16T16:59:59.999Z', offered: true },
    { now: '2026-10-16T17:00:00.000Z', offered: false },
    { now: '2026-10-16T17:00:00.001Z', offered: false },
    { now: '2026-10-16T19:00:00.000Z', offered: false },
  ])('offers this evening only more than one hour before 18:00 at $now', ({ now, offered }) => {
    const choices = resolveThreadSnoozePresets(instant(now), 'UTC')
    expect(choices.some((choice) => choice.id === 'evening')).toBe(offered)
  })

  it('deduplicates Monday morning on Sunday and otherwise targets the next Monday', () => {
    const sunday = resolveThreadSnoozePresets(instant('2026-10-18T12:00:00.000Z'), 'UTC')
    expect(sunday.find((choice) => choice.id === 'tomorrow')?.until).toBe(
      instant('2026-10-19T09:00:00.000Z'),
    )
    expect(sunday.some((choice) => choice.id === 'next-week')).toBe(false)
    expect(
      resolveThreadSnoozePreset('next-week', instant('2026-10-17T12:00:00.000Z'), 'UTC')?.until,
    ).toBe(instant('2026-10-19T09:00:00.000Z'))
    expect(
      resolveThreadSnoozePreset('next-week', instant('2026-10-19T08:00:00.000Z'), 'UTC')?.until,
    ).toBe(instant('2026-10-26T09:00:00.000Z'))
  })

  it.each([
    {
      transition: 'spring forward',
      now: '2026-03-07T14:00:00.000Z',
      tomorrow: '2026-03-08T13:00:00.000Z',
      nextWeek: '2026-03-09T13:00:00.000Z',
      hoursToTomorrow: 23,
    },
    {
      transition: 'fall back',
      now: '2026-10-31T13:00:00.000Z',
      tomorrow: '2026-11-01T14:00:00.000Z',
      nextWeek: '2026-11-02T14:00:00.000Z',
      hoursToTomorrow: 25,
    },
  ])('keeps 09:00 local across $transition', ({ now, tomorrow, nextWeek, hoursToTomorrow }) => {
    const choices = resolveThreadSnoozePresets(instant(now), 'America/New_York')
    const morning = choices.find((choice) => choice.id === 'tomorrow')!
    expect(morning.until).toBe(instant(tomorrow))
    expect(morning.until - instant(now)).toBe(hoursToTomorrow * HOUR_MS)
    expect(choices.find((choice) => choice.id === 'next-week')?.until).toBe(instant(nextWeek))
  })

  it.each(['2026-03-08T06:30:00.000Z', '2026-11-01T05:30:00.000Z'])(
    'keeps relative hours as elapsed time across the DST boundary at %s',
    (value) => {
      const now = instant(value)
      const choices = resolveThreadSnoozePresets(now, 'America/New_York')
      expect(choices.find((choice) => choice.id === 'hour')?.until).toBe(now + HOUR_MS)
      expect(choices.find((choice) => choice.id === 'three-hours')?.until).toBe(now + 3 * HOUR_MS)
    },
  )

  it('uses the local calendar after midnight rather than the UTC date', () => {
    expect(
      resolveThreadSnoozePreset('tomorrow', instant('2026-10-16T19:30:00.000Z'), 'Asia/Kolkata')
        ?.until,
    ).toBe(instant('2026-10-18T03:30:00.000Z'))
  })

  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    'offers no malformed or non-future choices for invalid current time %s',
    (now) => {
      expect(resolveThreadSnoozePresets(now, 'UTC')).toEqual([])
      expect(resolveThreadSnoozePreset('hour', now, 'UTC')).toBeUndefined()
    },
  )

  it('rejects an invalid explicit time zone without silently choosing another calendar', () => {
    expect(
      resolveThreadSnoozePresets(instant('2026-10-16T12:00:00.000Z'), 'Life/Invalid_Zone'),
    ).toEqual([])
  })

  it('recomputes a relative choice from selection time and retires expired evening choices', () => {
    const openedAt = instant('2026-10-16T16:45:00.000Z')
    const selectedAt = instant('2026-10-16T17:05:00.000Z')
    expect(resolveThreadSnoozePreset('hour', openedAt, 'UTC')?.until).toBe(
      instant('2026-10-16T17:45:00.000Z'),
    )
    expect(resolveThreadSnoozePreset('hour', selectedAt, 'UTC')?.until).toBe(
      instant('2026-10-16T18:05:00.000Z'),
    )
    expect(resolveThreadSnoozePreset('evening', openedAt, 'UTC')).toBeDefined()
    expect(resolveThreadSnoozePreset('evening', selectedAt, 'UTC')).toBeUndefined()
  })
})
