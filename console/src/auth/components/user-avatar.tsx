// A user's face in a row or a header: the photo URL when the account has one
// and it loads, else initials on a quiet ground, and the dashed circle for
// an anonymous account. The photo is the developer's own test data, but it
// is still a third-party request: it is asked for only once the row is on
// screen (`loading="lazy"`, and the table only renders rows in view) and
// without a referrer.

import { cn } from '@cloudflare/kumo'
import { UserCircleDashedIcon, UserIcon } from '@phosphor-icons/react'
import { useState } from 'react'

/** Up to two letters from a name or an email: "Ada Lovelace" → "AL", "grace@x" → "G". */
export function initialsOf(name: string | null | undefined, email: string | null | undefined) {
  const source = (name ?? '').trim()
  if (source) {
    const words = source.split(/\s+/).filter(Boolean)
    const letters = words.length > 1 ? [words[0], words.at(-1)] : [words[0]]
    return letters
      .map((word) => Array.from(word ?? '')[0] ?? '')
      .join('')
      .toUpperCase()
  }
  const local = (email ?? '').split('@')[0] ?? ''
  return (Array.from(local)[0] ?? '').toUpperCase()
}

export function UserAvatar({
  photoUrl,
  name,
  email,
  anonymous,
  size = 18,
  className,
}: {
  photoUrl: string | null
  name: string | null
  email: string | null
  anonymous: boolean
  /** Pixels; 18 in a row, larger in a header. */
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  if (anonymous && !photoUrl)
    return (
      <UserCircleDashedIcon
        size={size}
        className={cn('shrink-0 text-kumo-subtle', className)}
        aria-hidden
        data-testid="user-avatar"
      />
    )
  const showPhoto = photoUrl !== null && photoUrl !== '' && failed !== photoUrl
  const initials = initialsOf(name, email)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint font-sans font-medium text-kumo-subtle',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.45)) }}
      aria-hidden
      data-testid="user-avatar"
    >
      {showPhoto ? (
        <img
          src={photoUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(photoUrl)}
        />
      ) : initials ? (
        initials
      ) : (
        <UserIcon size={Math.max(10, Math.round(size * 0.6))} />
      )}
    </span>
  )
}
