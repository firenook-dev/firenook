import { ClipboardText } from '@firenook/kit'

/** A read-only value with a one-click copy, for addresses and tokens. */
export function Address() {
  return (
    <div className="grid w-96 gap-3">
      <ClipboardText text="http://127.0.0.1:8080" size="base" />
      <ClipboardText text="demo-shop-local" size="sm" />
    </div>
  )
}
