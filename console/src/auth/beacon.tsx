// Authentication's piece of the shell: mounted by the shell (the registry's
// `shellMount`, a lazy chunk) wherever you are in the console while the
// section is ready, so what Auth knows reaches you without opening it.
//
// - ⌘K offers the newest SMS code ("Copy the latest SMS code · 482913 for
//   +15550100") and the newest email link ("Open the latest email link ·
//   Password reset for ada@…"), from the configured project's inbox: the
//   newest of each read once, then the `auth.inbox` feed after it.
// - A toast for each new code or link the app causes, wherever you are but
//   the Inbox ("SMS code for +15550100: 482913 · Copy", "Password reset
//   link for ada@… · Open · Copy link"), through the console's one toast
//   policy: never for the console's own sends (it said so already), never
//   for what a (re)subscription replays, never for codes found in saved
//   state or links handed back to an Admin SDK caller, and not while the
//   Inbox's Toasts switch is off.
// - Engine tokens stay true to their users: wherever a page reads as an
//   Auth user (Firestore's view as, Storage's "As", a function's "Call
//   as"), the token `resolveAuthorization` minted carries that user's
//   claims, email, providers and state; an `auth.users` window that changes
//   one of them, or deletes the user, drops the cached token, so the next
//   read mints one that says what a sign-in would now.

import { ChatTextIcon, EnvelopeSimpleIcon } from '@phosphor-icons/react'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { AuthInboxBatch } from '@/api/generated/auth/AuthInboxBatch'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthMessagePage } from '@/api/generated/auth/AuthMessagePage'
import { statusQuery } from '@/api/queries'
import { type LiveChannel, liveChannel, useLiveStatus } from '@/lib/live/channel'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { type PaletteItem, matchesQuery, usePaletteProviders } from '@/lib/palette'
import { type ToastOptions, toast } from '@/lib/toasts'
import { getMessages } from './api'
import { copyWithToast } from './clipboard'
import { MESSAGE_KIND_LABELS } from './fields'
import { consoleActionLink } from './links'
import { readUsersWindow } from './live'
import { isSms, toastText, useToastsOn } from './messages'
import { authKeys } from './queries'

// ------------------------------------------------------------------ the newest code and link

/** The newest SMS code and the newest email link the beacon knows of. */
export interface Latest {
  sms?: AuthMessage | undefined
  email?: AuthMessage | undefined
}

function newer(current: AuthMessage | undefined, message: AuthMessage): boolean {
  return current === undefined || message.id > current.id
}

/**
 * One `auth.inbox` batch folded into what the beacon holds: a newer code or
 * link replaces the one held (a replay of what it already has changes
 * nothing), a use marks it used, a cleared history forgets both.
 */
export function foldLatest(latest: Latest, batch: AuthInboxBatch): Latest {
  let next = latest
  for (const item of batch.items) {
    if (item.kind === 'cleared') next = {}
    else if (item.kind === 'issued') {
      const message = item.message
      if (message.channel === 'sms' && newer(next.sms, message)) next = { ...next, sms: message }
      else if (message.channel === 'email' && message.link && newer(next.email, message))
        next = { ...next, email: message }
    } else {
      const used = { used: true, usedAt: item.usedAt, usedBy: item.usedBy }
      if (next.sms?.id === item.id) next = { ...next, sms: { ...next.sms, ...used } }
      if (next.email?.id === item.id) next = { ...next, email: { ...next.email, ...used } }
    }
  }
  return next
}

/**
 * The earlier of two feed positions (`<epoch>.<sequence>`): following from
 * it misses neither page's newer messages (what both already hold arrives
 * again and changes nothing).
 */
export function earlierPosition(a: string, b: string): string {
  const [epochA = '', seqA = ''] = a.split('.')
  const [epochB = '', seqB = ''] = b.split('.')
  if (epochA !== epochB) return epochA > epochB ? a : b
  const left = Number(seqA)
  const right = Number(seqB)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return a
  return left <= right ? a : b
}

/** The newest message of one channel, and where the feed stood when it was read. */
const latestQuery = (project: string, channel: 'sms' | 'email') => ({
  queryKey: authKeys.latest(project, channel),
  // The configured project, so no `project` is sent.
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    getMessages('', { q: `type:${channel}`, limit: 1 }, signal),
  staleTime: Number.POSITIVE_INFINITY,
})

function seedOf(sms: AuthMessagePage, email: AuthMessagePage): Latest {
  return { sms: sms.items[0], email: email.items.find((message) => message.link) }
}

// ------------------------------------------------------------------ toasts

/** How long after the channel comes back what arrives counts as replayed, ms. */
export const QUIET_AFTER_RECONNECT_MS = 1_500

/** Where the toasts are not shown: the Inbox itself lists every message as it arrives. */
export function onInbox(pathname: string): boolean {
  return /\/auth\/inbox\/?$/.test(pathname)
}

/**
 * The toast for one message the feed delivered, or nothing. `highest` is the
 * newest id this tab already knew of when the batch came (what a replay
 * repeats), `quiet` whether the channel has just come back.
 */
export function messageToast(
  message: AuthMessage,
  context: { highest: number; quiet: boolean },
): ToastOptions | undefined {
  // A code found in saved state, or a link handed back to the Admin SDK
  // call that asked for it: nothing was sent that anyone is waiting for.
  if (message.delivery !== 'sent') return undefined
  const words = toastText(message)
  const base = {
    key: `auth.message.${message.id}`,
    title: words.title,
    description: words.description,
    tone: 'info' as const,
    // The console's own send already said so where it was made.
    echo: message.origin !== null,
    replayed: message.id <= context.highest || context.quiet,
  }
  if (isSms(message))
    return {
      ...base,
      action: {
        label: 'Copy',
        run: () => void copyWithToast(message.code, `the code ${message.code}`),
      },
    }
  const link = message.link
  if (!link) return base
  return {
    ...base,
    action: {
      label: 'Open',
      run: () => void window.open(consoleActionLink(link), '_blank', 'noopener'),
    },
    actions: [{ label: 'Copy link', run: () => void copyWithToast(link, 'the link') }],
  }
}

/** The toasts one batch hands to the policy, in order. */
export function batchToasts(
  batch: AuthInboxBatch,
  context: { highest: number; quiet: boolean },
): ToastOptions[] {
  const toasts: ToastOptions[] = []
  for (const item of batch.items) {
    if (item.kind !== 'issued') continue
    const shown = messageToast(item.message, context)
    if (shown) toasts.push(shown)
  }
  return toasts
}

/** The newest message id in a batch, or `highest` when it holds none newer. */
function newestIn(batch: AuthInboxBatch, highest: number): number {
  let newest = highest
  for (const item of batch.items)
    if (item.kind === 'issued' && item.message.id > newest) newest = item.message.id
  return newest
}

/**
 * Until when what the feed delivers is a replay: for a moment after the
 * channel comes back (a reconnect, a tab shown again after it gave its
 * subscriptions back), when the engine sends what was missed meanwhile.
 */
function useQuietUntil(): { readonly current: number } {
  const quiet = useRef(0)
  useEffect(() => {
    let previous = useLiveStatus.getState().status
    return useLiveStatus.subscribe((state) => {
      if (state.status === 'live' && previous !== 'live')
        quiet.current = Date.now() + QUIET_AFTER_RECONNECT_MS
      previous = state.status
    })
  }, [])
  return quiet
}

/** The newest code and link: read once per engine run, then followed on the feed. */
function useLatestMessages(project: string, channel: LiveChannel): Latest {
  const sms = useQuery({ ...latestQuery(project, 'sms'), enabled: project !== '' })
  const email = useQuery({ ...latestQuery(project, 'email'), enabled: project !== '' })
  // Pages read before an engine restart belong to the old engine.
  const [notBefore, setNotBefore] = useState(0)
  const seed =
    sms.data && email.data && sms.dataUpdatedAt >= notBefore && email.dataUpdatedAt >= notBefore
      ? {
          after: earlierPosition(sms.data.liveAfter, email.data.liveAfter),
          latest: seedOf(sms.data, email.data),
        }
      : undefined
  // What the feed brought since, for the seed it followed from.
  const [live, setLive] = useState<{ after: string; latest: Latest } | undefined>(undefined)
  const following = useRef(seed)
  useLayoutEffect(() => {
    following.current = seed
  })
  // The newest message id this tab knows of: a message at or below it is a replay.
  const highest = useRef(0)
  const seedHighest = Math.max(seed?.latest.sms?.id ?? 0, seed?.latest.email?.id ?? 0)
  useLayoutEffect(() => {
    if (seedHighest > highest.current) highest.current = seedHighest
  }, [seedHighest])
  const quietUntil = useQuietUntil()

  // A restarted engine has other codes: read its newest again, then follow it.
  useEffect(
    () =>
      channel.onEngineRestart(() => {
        setNotBefore(Date.now())
        // A new run numbers its messages from 1 again.
        highest.current = 0
      }),
    [channel],
  )

  useLiveTopic(
    'auth.inbox',
    seed === undefined ? null : {},
    {
      onMessages: (batch) => {
        const from = following.current
        if (!from) return
        if (useToastsOn.getState().on && !onInbox(window.location.pathname))
          for (const shown of batchToasts(batch, {
            highest: highest.current,
            quiet: Date.now() < quietUntil.current,
          }))
            toast(shown)
        highest.current = newestIn(batch, highest.current)
        setLive((current) => ({
          after: from.after,
          latest: foldLatest(current?.after === from.after ? current.latest : from.latest, batch),
        }))
      },
    },
    channel,
    { after: seed?.after },
  )
  if (!seed) return {}
  return live?.after === seed.after ? live.latest : seed.latest
}

async function copyCode(message: AuthMessage) {
  try {
    await navigator.clipboard.writeText(message.code)
    toast({ key: 'auth.latest-code', title: `Copied ${message.code}`, tone: 'success' })
  } catch {
    toast({
      key: 'auth.latest-code',
      title: 'The browser did not let the console copy',
      description: `The code for ${message.to} is ${message.code}.`,
      tone: 'warning',
    })
  }
}

/** The ⌘K items for what the beacon holds; unused messages only, since a used one works no more. */
export function latestItems(latest: Latest): PaletteItem[] {
  const items: PaletteItem[] = []
  const sms = latest.sms
  if (sms && !sms.used)
    items.push({
      id: 'auth.latest-sms',
      title: 'Copy the latest SMS code',
      description: `${sms.code} for ${sms.to}`,
      keywords: `otp sms code phone verification ${sms.code} ${sms.to}`,
      icon: <ChatTextIcon size={16} />,
      run: () => void copyCode(sms),
    })
  const email = latest.email
  if (email?.link && !email.used) {
    const link = email.link
    items.push({
      id: 'auth.latest-link',
      title: 'Open the latest email link',
      description: `${MESSAGE_KIND_LABELS[email.kind]} for ${email.to}`,
      keywords: `email link verification reset sign-in ${email.to}`,
      icon: <EnvelopeSimpleIcon size={16} />,
      run: () => {
        window.open(consoleActionLink(link), '_blank', 'noopener')
      },
    })
  }
  return items
}

function useLatestPalette(latest: Latest) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    const items = latestItems(latest)
    if (items.length === 0) return undefined
    register('auth.beacon', (query) => {
      const shown = items.filter((item) => matchesQuery(item, query))
      return shown.length > 0 ? [{ label: 'Authentication', items: shown }] : []
    })
    return () => unregister('auth.beacon')
  }, [latest, register, unregister])
}

// ------------------------------------------------------------------ fresh engine tokens

/** A cached engine token's place: `['auth', project, 'token', tenant, uid]`. */
function isTokenKey(key: readonly unknown[]): boolean {
  return key[0] === 'auth' && key[2] === 'token'
}

/** Every project and tenant with an engine token in the cache, as one stable string. */
export function tokenScopes(client: QueryClient): string {
  const scopes = new Set<string>()
  for (const query of client.getQueryCache().findAll({ queryKey: ['auth'] })) {
    const key = query.queryKey
    if (isTokenKey(key) && typeof key[1] === 'string' && typeof key[3] === 'string')
      scopes.add(`${key[1]}\u0000${key[3]}`)
  }
  return [...scopes].toSorted().join('\n')
}

/** One project and tenant's users, followed while a token of theirs is cached. */
function TokenScope({
  project,
  tenant,
  channel,
}: {
  project: string
  tenant: string
  channel: LiveChannel
}) {
  const client = useQueryClient()
  const tokens = ['auth', project, 'token', tenant] as const
  useLiveTopic(
    'auth.users',
    tenant === '' ? { project } : { project, tenant },
    {
      onChanged: (changed) => {
        for (const uid of readUsersWindow(changed).staleTokens)
          client.removeQueries({ queryKey: [...tokens, uid], exact: true })
      },
      // Everyone went, or windows were missed: every token of the scope is
      // minted again on its next use.
      onCleared: () => client.removeQueries({ queryKey: tokens }),
      onReset: () => client.removeQueries({ queryKey: tokens }),
    },
    channel,
  )
  return null
}

function TokenFreshness({ channel }: { channel: LiveChannel }) {
  const client = useQueryClient()
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (
          (event.type === 'added' || event.type === 'removed') &&
          isTokenKey(event.query.queryKey)
        )
          notify()
      }),
    [client],
  )
  const scopes = useSyncExternalStore(subscribe, () => tokenScopes(client))
  if (scopes === '') return null
  return (
    <>
      {scopes.split('\n').map((scope) => {
        const [project = '', tenant = ''] = scope.split('\u0000')
        return <TokenScope key={scope} project={project} tenant={tenant} channel={channel} />
      })}
    </>
  )
}

// ------------------------------------------------------------------ the beacon

/** The beacon over a given channel (the page's own one in the shell). */
export function Beacon({ channel }: { channel: LiveChannel }) {
  const status = useQuery(statusQuery)
  const latest = useLatestMessages(status.data?.projectId ?? '', channel)
  useLatestPalette(latest)
  return <TokenFreshness channel={channel} />
}

export default function AuthBeacon() {
  return <Beacon channel={liveChannel} />
}
