import { Field, Input } from '@firenook/kit'

/** The wrapper every input gets: label, optional description, error. */
export function Composed() {
  return (
    <div className="grid max-w-sm gap-4">
      <Field label="Display name" description="Shown in the users table">
        <Input defaultValue="Ada Lovelace" />
      </Field>
      <Field label="Phone" required>
        <Input placeholder="+1 555 0100" />
      </Field>
    </div>
  )
}
