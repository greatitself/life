import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useSidebarMinute } from '../sidebar-clock'
import { resolveThreadSnoozePreset, resolveThreadSnoozePresets } from '../thread-snooze-presets'

/** The hover control and thread menu offer the same local-calendar wake times. */
export function ThreadSnoozeMenuItems({ onSnooze }: { onSnooze: (until: number) => void }) {
  useSidebarMinute()
  const choices = resolveThreadSnoozePresets(Date.now())
  return choices.map((choice) => (
    <DropdownMenu.Item
      key={choice.id}
      className="life-thread-menu-item life-thread-snooze-preset"
      textValue={choice.label}
      onSelect={() => {
        const selected = resolveThreadSnoozePreset(choice.id, Date.now())
        if (selected) onSnooze(selected.until)
      }}
    >
      <span>{choice.label}</span>
      <span className="life-thread-snooze-time">{choice.detail}</span>
    </DropdownMenu.Item>
  ))
}
