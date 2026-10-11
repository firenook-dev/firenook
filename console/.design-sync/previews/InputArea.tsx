import { InputArea } from '@firenook/kit'

/** Multi-line input for JSON and long values; grows with its content when autoResize is on. */
export function CustomClaims() {
  return (
    <div className="max-w-md">
      <InputArea
        label="Custom claims"
        defaultValue={'{ "role": "admin", "tenant": "shop-eu" }'}
        minRows={3}
      />
    </div>
  )
}

export function ErrorState() {
  return (
    <div className="max-w-md">
      <InputArea
        label="Rules"
        variant="error"
        error="Unexpected token on line 14"
        defaultValue={'allow read: if request.auth != null\nallow write: if false'}
        minRows={3}
      />
    </div>
  )
}
