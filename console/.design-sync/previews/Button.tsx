import { Button } from '@firenook/kit'
import {
  ArrowsClockwiseIcon,
  DownloadIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'

const VARIANTS = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'secondary-destructive',
] as const

/** One primary per view; secondary for the rest; ghost inside tables and toolbars; destructive only for deletes. */
export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {VARIANTS.map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
    </div>
  )
}

export function WithIcons() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" icon={<PlusIcon />}>
        Add document
      </Button>
      <Button variant="secondary" icon={<DownloadIcon />}>
        Export
      </Button>
      <Button variant="ghost" icon={<ArrowsClockwiseIcon />}>
        Reload rules
      </Button>
      <Button variant="destructive" icon={<TrashIcon />}>
        Delete 3 documents
      </Button>
    </div>
  )
}

export function IconOnly() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button shape="square" icon={<PlusIcon />} aria-label="Add" />
      <Button
        shape="square"
        variant="secondary"
        icon={<ArrowsClockwiseIcon />}
        aria-label="Refresh"
      />
      <Button shape="square" variant="ghost" icon={<XIcon />} aria-label="Close" />
      <Button shape="circle" variant="secondary" icon={<KeyIcon />} aria-label="Mint token" />
    </div>
  )
}

export function Sizes() {
  return (
    <div className="grid gap-3">
      {(['xs', 'sm', 'base', 'lg'] as const).map((size) => (
        <div key={size} className="flex items-center gap-3">
          <span className="w-10 text-sm text-kumo-subtle">{size}</span>
          <Button size={size}>Primary</Button>
          <Button size={size} variant="secondary">
            Secondary
          </Button>
          <Button size={size} variant="ghost" icon={<ArrowsClockwiseIcon />}>
            Refresh
          </Button>
          <Button size={size} shape="square" icon={<PlusIcon />} aria-label="Add" />
        </div>
      ))}
    </div>
  )
}

export function States() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button loading>Saving</Button>
      <Button disabled>Disabled</Button>
      <Button variant="secondary" disabled>
        Disabled
      </Button>
      <Button variant="destructive" disabled>
        Disabled
      </Button>
    </div>
  )
}
