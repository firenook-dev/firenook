// How each Firestore type reads in a grid cell: exact, copyable, and typed
// at a glance. Colour carries meaning only (a reference is a link, a
// boolean is a state), never decoration.

import { InlineCopyText } from '@cloudflare/kumo'
import { ArrowSquareInIcon } from '@phosphor-icons/react'
import { type FsValue, displayValue, formatNumber, relativeTime } from '../value'

export function IdCell({ id, missing }: { id: string; missing?: boolean | undefined }) {
  return (
    <span className={`flex items-center gap-1 ${missing ? 'italic text-kumo-subtle' : ''}`}>
      <InlineCopyText
        value={id}
        variant="mono"
        className="max-w-full truncate text-[0.9em]"
        title={id}
      >
        {id}
      </InlineCopyText>
    </span>
  )
}

export function ValueCell({
  value,
  onOpenReference,
}: {
  value: FsValue | undefined
  onOpenReference: (path: string) => void
}) {
  if (!value) return <span className="text-kumo-inactive" aria-label="not set" />
  switch (value.type) {
    case 'string':
      return (
        <span className="block truncate" title={value.value}>
          {value.value === '' ? <span className="text-kumo-inactive">""</span> : value.value}
        </span>
      )
    case 'number':
      return (
        <span
          className="block truncate font-mono text-[0.9em] tabular-nums"
          title={String(value.value)}
        >
          {formatNumber(value.value)}
        </span>
      )
    case 'boolean':
      return (
        <span
          className={`font-mono text-[0.9em] ${value.value ? 'text-kumo-success' : 'text-kumo-subtle'}`}
        >
          {value.value ? 'true' : 'false'}
        </span>
      )
    case 'timestamp':
      return (
        <span className="flex items-baseline gap-1.5" title={value.value}>
          <span className="whitespace-nowrap">{relativeTime(value.value)}</span>
          <span className="truncate font-mono text-[11px] text-kumo-subtle">
            {compactIso(value.value)}
          </span>
        </span>
      )
    case 'reference':
      return (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onOpenReference(value.path)
          }}
          className="group flex max-w-full items-center gap-1 font-mono text-[0.9em] text-kumo-link hover:underline"
          title={value.path}
        >
          <span className="truncate">{value.path}</span>
          <ArrowSquareInIcon size={12} className="shrink-0 opacity-0 group-hover:opacity-100" />
        </button>
      )
    case 'geopoint':
      return (
        <span className="font-mono text-[0.9em] tabular-nums">
          {value.latitude}, {value.longitude}
        </span>
      )
    case 'map':
    case 'array': {
      const count = value.type === 'map' ? Object.keys(value.fields).length : value.items.length
      const preview =
        value.type === 'map'
          ? Object.keys(value.fields).slice(0, 3).join(', ')
          : displayValue(value)
      return (
        <span className="flex min-w-0 items-center gap-1.5" title={preview}>
          <span className="shrink-0 rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle tabular-nums">
            {value.type === 'map' ? `{${count}}` : `[${count}]`}
          </span>
          <span className="truncate text-kumo-subtle">{value.type === 'map' ? preview : ''}</span>
        </span>
      )
    }
    case 'bytes':
      return <span className="font-mono text-[0.9em] text-kumo-subtle">{displayValue(value)}</span>
    case 'vector':
      return <span className="font-mono text-[0.9em] text-kumo-subtle">{displayValue(value)}</span>
    case 'null':
      return <span className="font-mono text-[0.9em] text-kumo-inactive">null</span>
  }
}

function compactIso(iso: string): string {
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
    .replace(/Z$/, '')
}
