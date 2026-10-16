import { DateTime, Option } from 'effect'

export type ThreadSnoozePresetId = 'hour' | 'three-hours' | 'evening' | 'tomorrow' | 'next-week'

export interface ThreadSnoozePreset {
  readonly id: ThreadSnoozePresetId
  readonly label: string
  readonly until: number
  readonly detail: string
}

const HOUR_MS = 60 * 60 * 1_000

function atHour(value: DateTime.Zoned, hour: number): DateTime.Zoned {
  return DateTime.setParts(value, { hour, minute: 0, second: 0, millisecond: 0 })
}

function preset(id: ThreadSnoozePresetId, label: string, wake: DateTime.Zoned): ThreadSnoozePreset {
  const time = DateTime.format(wake, { hour: 'numeric', minute: '2-digit' })
  return {
    id,
    label,
    until: DateTime.toEpochMillis(wake),
    detail:
      id === 'next-week' ? [DateTime.format(wake, { weekday: 'short' }), time].join(' ') : time,
  }
}

/** Relative choices use elapsed hours; calendar choices keep the user's local wake hour. */
export function resolveThreadSnoozePresets(
  now: number,
  timeZone?: string,
): readonly ThreadSnoozePreset[] {
  const parsed = DateTime.makeZoned(now, { timeZone: timeZone ?? DateTime.zoneMakeLocal() })
  if (Option.isNone(parsed)) return []
  const current = parsed.value
  const choices = [
    preset('hour', 'In 1 hour', DateTime.addDuration(current, HOUR_MS)),
    preset('three-hours', 'In 3 hours', DateTime.addDuration(current, 3 * HOUR_MS)),
  ]

  const evening = atHour(current, 18)
  if (DateTime.toEpochMillis(evening) - now > HOUR_MS)
    choices.push(preset('evening', 'This evening', evening))

  const tomorrow = atHour(DateTime.add(current, { days: 1 }), 9)
  choices.push(preset('tomorrow', 'Tomorrow', tomorrow))

  const daysUntilMonday = (1 - DateTime.getPart(current, 'weekDay') + 7) % 7 || 7
  const nextWeek = atHour(DateTime.add(current, { days: daysUntilMonday }), 9)
  if (DateTime.toEpochMillis(nextWeek) !== DateTime.toEpochMillis(tomorrow))
    choices.push(preset('next-week', 'Next week', nextWeek))

  return choices
}

/** Recompute relative deadlines when a choice is selected, even if its menu stayed open. */
export function resolveThreadSnoozePreset(
  id: ThreadSnoozePresetId,
  now: number,
  timeZone?: string,
): ThreadSnoozePreset | undefined {
  return resolveThreadSnoozePresets(now, timeZone).find((choice) => choice.id === id)
}
