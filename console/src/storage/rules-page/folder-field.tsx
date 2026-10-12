// A field for a folder or an object name in a bucket, completing folders as
// they are typed: the folders directly under what is typed so far, from the
// bucket's folder profile (the engine's index, never a listing). Tab or
// Enter takes the highlighted folder; Escape closes the list.

import { InputGroup } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useRef, useState } from 'react'
import { Completions } from '@/components/console/completions'
import { parentOf } from '../paths'
import { profileQuery } from '../queries'

/** Folders offered at most. */
const SHOWN = 8

/** The folders under the typed text's own folder that continue what is typed after it. */
export function folderCompletions(typed: string, children: readonly string[]): string[] {
  const folder = parentOf(typed)
  const rest = typed.slice(folder.length).toLowerCase()
  return children
    .filter((child) => child.toLowerCase().startsWith(rest))
    .slice(0, SHOWN)
    .map((child) => `${folder}${child}/`)
}

export function FolderField({
  project,
  bucket,
  value,
  onChange,
  onCommit,
  placeholder,
  ariaLabel,
  testId,
  icon,
  className,
}: {
  project: string
  bucket: string
  value: string
  onChange: (value: string) => void
  /** Enter, or a folder picked: the value is meant now, not after typing settles. */
  onCommit?: ((value: string) => void) | undefined
  placeholder: string
  ariaLabel: string
  testId: string
  icon?: ReactNode
  className?: string | undefined
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  // The folder the arrows moved to; none until they move.
  const [highlight, setHighlight] = useState(-1)
  const folder = parentOf(value)
  const profile = useQuery({
    ...profileQuery(project, bucket, folder),
    enabled: focused && bucket !== '',
  })
  const options = focused ? folderCompletions(value, profile.data?.childFolders ?? []) : []
  const current = highlight < options.length ? highlight : -1

  const pick = (next: string) => {
    onChange(next)
    onCommit?.(next)
    setHighlight(-1)
  }

  return (
    <div ref={anchor} className={className}>
      <InputGroup size="sm" className="w-full">
        {icon && <InputGroup.Addon>{icon}</InputGroup.Addon>}
        <InputGroup.Input
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            setHighlight(-1)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && options.length > 0) {
              event.preventDefault()
              setHighlight((current + 1) % options.length)
            } else if (event.key === 'ArrowUp' && options.length > 0) {
              event.preventDefault()
              setHighlight(current <= 0 ? options.length - 1 : current - 1)
            } else if (event.key === 'Tab' && options.length > 0 && !event.shiftKey) {
              const next = options[Math.max(0, current)]
              if (next !== undefined) {
                event.preventDefault()
                pick(next)
              }
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const next = current >= 0 ? options[current] : undefined
              if (next !== undefined) pick(next)
              else onCommit?.(value)
            } else if (event.key === 'Escape' && options.length > 0) {
              event.stopPropagation()
              setFocused(false)
            }
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          spellCheck={false}
          autoComplete="off"
          className="font-mono placeholder:font-sans"
          data-testid={testId}
        />
      </InputGroup>
      {options.length > 0 && (
        <Completions anchor={anchor} testId={`${testId}-completions`}>
          {options.map((option, index) => (
            <li key={option}>
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:ink ${
                  index === current ? 'bg-kumo-tint' : ''
                }`}
                // The field keeps the focus, so the list stays open under it.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
                data-testid={`${testId}-completion`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{option}</span>
                <span className="shrink-0 text-[11px] text-kumo-subtle">folder</span>
              </button>
            </li>
          ))}
        </Completions>
      )}
    </div>
  )
}
