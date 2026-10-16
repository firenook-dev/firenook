import { Toasty, useKumoToastManager } from '@firenook/kit'
import { useEffect, useRef, useState } from 'react'

function ShowOnce({
  title,
  description,
  variant,
}: {
  title: string
  description: string
  variant: 'success' | 'info' | 'error'
}) {
  const toasts = useKumoToastManager()
  const shown = useRef(false)
  useEffect(() => {
    if (shown.current) return
    shown.current = true
    toasts.add({ title, description, variant, timeout: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function Viewport({
  title,
  description,
  variant,
}: {
  title: string
  description: string
  variant: 'success' | 'info' | 'error'
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  return (
    <div
      ref={setBox}
      className="relative h-28 w-[420px] overflow-hidden rounded-lg bg-kumo-canvas ring ring-kumo-hairline [contain:paint]"
    >
      <Toasty {...(box ? { container: box } : {})}>
        <ShowOnce title={title} description={description} variant={variant} />
        <span />
      </Toasty>
    </div>
  )
}

/** Wrap the app in Toasty; call useKumoToastManager().add(...) with the same words as the button that caused it. */
export function Variants() {
  return (
    <div className="grid gap-3">
      <Viewport
        title="Document saved"
        description="users/u_9f3k2 at revision 4,812"
        variant="success"
      />
      <Viewport
        title="Rules reloaded"
        description="3 changes from firestore.rules"
        variant="info"
      />
      <Viewport
        title="Write denied"
        description="Rules line 14: request.auth is null"
        variant="error"
      />
    </div>
  )
}
