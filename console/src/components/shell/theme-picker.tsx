// Light, dark, or the operating system's choice. Sits beside the engine
// badge because it belongs to the console itself, not to any one section.
//
// Three buttons rather than a menu: all three states are visible and one
// click away, and a dropdown would have pulled Kumo's menu primitives into
// the first route for 10 KB — a third of the budget's headroom to hide
// three icons behind a click.

import { MonitorIcon, MoonIcon, SunIcon } from '@phosphor-icons/react'
import { type ThemeChoice, describeTheme, useTheme } from '@/lib/color-mode'

export const THEME_CHOICES: { choice: ThemeChoice; label: string; icon: typeof SunIcon }[] = [
  { choice: 'light', label: 'Light', icon: SunIcon },
  { choice: 'dark', label: 'Dark', icon: MoonIcon },
  { choice: 'system', label: 'Match the system', icon: MonitorIcon },
]

export function ThemePicker() {
  const choice = useTheme((state) => state.choice)
  const mode = useTheme((state) => state.mode)
  const setChoice = useTheme((state) => state.setChoice)
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-md bg-kumo-tint p-0.5"
      data-testid="theme-picker"
      data-choice={choice}
    >
      {THEME_CHOICES.map((option) => {
        const active = option.choice === choice
        return (
          <button
            key={option.choice}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={
              option.choice === 'system' ? describeTheme('system', mode) : `${option.label} theme`
            }
            title={
              option.choice === 'system' ? describeTheme('system', mode) : `${option.label} theme`
            }
            onClick={() => setChoice(option.choice)}
            className={`flex size-6 items-center justify-center rounded ${
              active
                ? 'bg-kumo-base text-kumo-default shadow-sm'
                : 'text-kumo-inactive hover:text-kumo-default'
            }`}
            data-testid={`theme-${option.choice}`}
          >
            <option.icon size={14} />
          </button>
        )
      })}
    </div>
  )
}
