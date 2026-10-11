import { Input } from '@firenook/kit'

/** Label above, optional description below. Sizes match Button. */
export function Labelled() {
  return (
    <div className="grid max-w-sm gap-4">
      <Input label="Collection id" placeholder="users" />
      <Input
        label="Email"
        description="Used as the sign-in identifier"
        defaultValue="ada@example.test"
      />
    </div>
  )
}

export function Sizes() {
  return (
    <div className="grid max-w-sm gap-3">
      <Input size="xs" placeholder="xs · 20 px" />
      <Input size="sm" placeholder="sm · 26 px, for toolbars and dense forms" />
      <Input size="base" placeholder="base · 36 px" />
      <Input size="lg" placeholder="lg · 40 px" />
    </div>
  )
}

/** The error variant carries its message in the field. */
export function ErrorState() {
  return (
    <div className="grid max-w-sm gap-4">
      <Input
        label="Document id"
        variant="error"
        error="An id cannot contain a slash"
        defaultValue="u/9f3k2"
      />
    </div>
  )
}

export function Disabled() {
  return (
    <div className="grid max-w-sm gap-4">
      <Input label="Project id" defaultValue="demo-shop-local" disabled />
    </div>
  )
}
