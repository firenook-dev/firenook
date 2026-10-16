import { Toolbar } from '@firenook/kit'
import { ArrowsClockwiseIcon, FunnelSimpleIcon } from '@phosphor-icons/react'

/** Search plus icon actions in one joined control, as above a grid. */
export function Search() {
  return (
    <Toolbar className="w-full max-w-md">
      <Toolbar.Input
        aria-label="Search documents"
        placeholder="Search documents"
        className="flex-1"
      />
      <Toolbar.Button icon={FunnelSimpleIcon} aria-label="Filter" />
      <Toolbar.Button icon={ArrowsClockwiseIcon} aria-label="Refresh" />
    </Toolbar>
  )
}

export function Sizes() {
  return (
    <div className="grid gap-3">
      {(['xs', 'sm', 'base', 'lg'] as const).map((size) => (
        <div key={size} className="flex items-center gap-3">
          <span className="w-10 text-sm text-kumo-subtle">{size}</span>
          <Toolbar size={size} className="w-fit">
            <Toolbar.Input aria-label={`${size} search`} placeholder="Search users" />
            <Toolbar.Button>Apply</Toolbar.Button>
          </Toolbar>
        </div>
      ))}
    </div>
  )
}
