// Which functions run around a sign-up and a sign-in: the blocking functions
// (`beforeCreate`, `beforeSignIn`) as the emulator itself resolves them —
// from the project's configuration first, then from Functions — with the
// credentials it forwards to them; and which functions listen to
// `user.create` and `user.delete` (compute's one matcher, `useTriggersFor`).
// While that answer is not known the rows say nothing rather than "none".
// Whether background triggers are paused is the shell banner's to say.

import { Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { AuthBlockingHook } from '@/api/generated/auth/AuthBlockingHook'
import type { AuthHooks } from '@/api/generated/auth/AuthHooks'
import { EntityLink } from '@/components/console/entity-link'
import { RequiresNotice } from '@/components/console/requires-notice'
import { sectionStatus } from '@/components/console/section-gate'
import { statusQuery } from '@/api/queries'
import { type TriggerFunction, useTriggersFor } from '@/lib/triggers'
import { activityLink } from '../links'
import { useHooksLive } from '../live'
import { hooksQuery } from '../queries'

/** A blocking function's id as Functions names it (`us-central1-beforeCreate`), from its uri. */
export function blockingFunctionId(uri: string): string | undefined {
  try {
    const parts = new URL(uri).pathname.split('/').filter(Boolean)
    const [, region, name] = parts
    return region && name ? `${region}-${name}` : undefined
  } catch {
    return undefined
  }
}

/** The credentials the emulator forwards to the blocking functions, in words. */
export function forwarded(
  hooks: Pick<AuthHooks, 'forwardIdToken' | 'forwardAccessToken' | 'forwardRefreshToken'>,
): string | undefined {
  const tokens: string[] = []
  if (hooks.forwardIdToken) tokens.push('idToken')
  if (hooks.forwardAccessToken) tokens.push('accessToken')
  if (hooks.forwardRefreshToken) tokens.push('refreshToken')
  return tokens.length > 0 ? `forwards ${tokens.join(', ')}` : undefined
}

export function HooksCard({ project, tenant }: { project: string; tenant: string | undefined }) {
  useHooksLive(project)
  const status = useQuery(statusQuery)
  const hooks = useQuery({ ...hooksQuery(project), enabled: project !== '' })
  const functionsState = sectionStatus(status.data?.sections, 'functions').state
  const created = useTriggersFor('auth', tenant ?? '', 'user.create')
  const deleted = useTriggersFor('auth', tenant ?? '', 'user.delete')
  const data = hooks.data
  const extra = data ? forwarded(data) : undefined
  return (
    <div className="grid gap-3" data-testid="hooks-card">
      {functionsState === 'absent' && (
        <div className="-mx-5 -mt-4 overflow-hidden rounded-t-lg">
          <RequiresNotice section="functions" for="Blocking functions and triggers" />
        </div>
      )}
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)_max-content] items-start gap-x-6 gap-y-2.5">
        <HookRow event="beforeCreate" hook={data?.beforeCreate} loading={!data} extra={extra} />
        <HookRow event="beforeSignIn" hook={data?.beforeSignIn} loading={!data} extra={extra} />
        <TriggerRow event="user.create" answer={created} />
        <TriggerRow event="user.delete" answer={deleted} />
      </dl>
      <Text size="sm" variant="secondary">
        beforeSendEmail and beforeSendSms are not emulated: codes and links are only logged, and
        land in the Inbox.
      </Text>
    </div>
  )
}

function Name({ children }: { children: ReactNode }) {
  return <dt className="font-mono text-[12px] leading-5 text-kumo-default">{children}</dt>
}

function Recent({ q }: { q: string }) {
  const link = activityLink({ q })
  return (
    <dd className="m-0">
      <Link
        to={link.to as never}
        search={link.search as never}
        className="text-[12px] leading-5 text-kumo-link hover:underline focus-visible:underline focus-visible:outline-none"
      >
        Recent calls ↗
      </Link>
    </dd>
  )
}

function HookRow({
  event,
  hook,
  loading,
  extra,
}: {
  event: string
  hook: AuthBlockingHook | null | undefined
  loading: boolean
  extra: string | undefined
}) {
  const id = hook ? blockingFunctionId(hook.uri) : undefined
  return (
    <>
      <Name>{event}</Name>
      <dd
        className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] leading-5"
        data-testid={`hook-${event}`}
      >
        {loading ? (
          <span className="text-kumo-subtle">…</span>
        ) : hook ? (
          <>
            {id ? (
              <EntityLink
                entity={{ kind: 'functions.function', key: id, label: hook.function ?? id }}
              />
            ) : (
              <span className="font-mono text-[12px]">{hook.function ?? hook.uri}</span>
            )}
            <span className="text-kumo-subtle">
              from {hook.source === 'config' ? 'the project’s configuration' : 'Functions'}
            </span>
            {extra && <span className="text-kumo-subtle">· {extra}</span>}
          </>
        ) : (
          <span className="text-kumo-subtle">none</span>
        )}
      </dd>
      {hook ? <Recent q="has:blocking" /> : <dd className="m-0" />}
    </>
  )
}

function TriggerRow({
  event,
  answer,
}: {
  event: string
  answer: ReturnType<typeof useTriggersFor>
}) {
  const functions: readonly TriggerFunction[] = typeof answer === 'object' ? answer.functions : []
  return (
    <>
      <Name>{event}</Name>
      <dd
        className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] leading-5"
        data-testid={`trigger-${event}`}
      >
        {answer === 'unknown' || answer === 'absent' ? null : functions.length === 0 ? (
          <span className="text-kumo-subtle">none</span>
        ) : (
          functions.map((fn) => (
            <EntityLink
              key={`${fn.codebase}|${fn.functionId}`}
              entity={{
                kind: 'functions.function',
                key: fn.functionId,
                label: fn.functionId.replace(/^[a-z]+-[a-z]+\d+-/, ''),
              }}
            />
          ))
        )}
      </dd>
      {functions.length > 0 ? <Recent q="has:trigger" /> : <dd className="m-0" />}
    </>
  )
}
