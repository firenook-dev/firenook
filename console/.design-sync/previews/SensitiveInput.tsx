import { SensitiveInput } from '@firenook/kit'

/** Masks a token or secret by default; reveal on click, copy on hover. */
export function CustomToken() {
  return (
    <div className="max-w-md">
      <SensitiveInput
        label="Custom token"
        defaultValue="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJ1XzlmM2syIn0"
      />
    </div>
  )
}
