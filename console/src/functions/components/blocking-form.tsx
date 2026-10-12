// Test, for a blocking function: does it let this user in? Compose a user —
// nothing is created — and send the JWT the Auth emulator would send; the
// answer is read the way the Auth emulator reads it: Blocked with the
// status and message, or Allowed with the changes it asks for. "Sign up for
// real" creates the account through the Auth emulator, which calls the
// function itself; the invocation it makes follows.

import { Button, Input, Select, Text } from '@cloudflare/kumo'
import { UserPlusIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, nativeFetch } from '@/api/client'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { JsonField, parseJsonText } from '@/components/console/json-field'
import { JsonView } from '@/components/console/json-view'
import { RequiresNotice } from '@/components/console/requires-notice'
import { SendButton } from '@/components/console/request/send-button'
import type { ResponseRecord } from '@/components/console/request/types'
import { StatusDot } from '@/components/kit'
import {
  type BlockingDecision,
  type BlockingUser,
  blockingBody,
  randomEventId,
  readBlockingResponse,
} from '../blocking'
import { createResponseBuilder, invokeFunction } from '../invoke-stream'
import { type BlockingDraft, useRunDraft } from '../run-drafts'
import { blockingWords } from '../trigger-text'
import { FormRow, RunAnswer, RunError, RunFooter, useNextInvocation } from './run-parts'

const PROVIDERS = [
  'password',
  'google.com',
  'apple.com',
  'github.com',
  'phone',
  'anonymous',
] as const

/** The account the form composes, in the Auth REST shape the JWT reads. */
export function composedUser(draft: BlockingDraft): BlockingUser | { problem: string } {
  const claims = parseJsonText(draft.claims.trim() === '' ? '{}' : draft.claims)
  if (
    !claims.ok ||
    claims.value === null ||
    typeof claims.value !== 'object' ||
    Array.isArray(claims.value)
  )
    return { problem: 'The claims are a JSON object.' }
  const uid = draft.uid.trim() || 'u_new'
  const email = draft.email.trim()
  const now = String(Date.now())
  return {
    localId: uid,
    ...(email ? { email, emailVerified: false } : {}),
    ...(draft.displayName.trim() ? { displayName: draft.displayName.trim() } : {}),
    customAttributes: JSON.stringify(claims.value),
    providerUserInfo:
      draft.provider === 'anonymous'
        ? []
        : [
            {
              providerId: draft.provider,
              ...(email ? { email } : {}),
              rawId: draft.provider === 'password' ? email || uid : uid,
            },
          ],
    createdAt: now,
    lastLoginAt: now,
  }
}

function Decision({ decision }: { decision: BlockingDecision }) {
  if (decision.kind === 'blocked')
    return (
      <div
        className="flex min-w-0 flex-wrap items-baseline gap-2"
        data-testid="blocking-decision"
        data-kind="blocked"
      >
        <StatusDot tone="warning" label="Blocked" />
        <span className="font-mono text-[12px] text-kumo-warning">{decision.status}</span>
        <span className="min-w-0 text-[13px] text-kumo-default">{decision.message}</span>
      </div>
    )
  if (decision.kind === 'invalid')
    return (
      <div
        className="flex min-w-0 items-baseline gap-2"
        data-testid="blocking-decision"
        data-kind="invalid"
      >
        <StatusDot tone="danger" label="The Auth emulator would refuse this answer" />
        <span className="text-[13px] text-kumo-default">{decision.message}</span>
      </div>
    )
  const changes = Object.keys(decision.changes)
  return (
    <div className="grid gap-1.5" data-testid="blocking-decision" data-kind="allowed">
      <div className="flex items-center gap-2">
        <StatusDot tone="success" label="Allowed" />
        <span className="text-[12px] text-kumo-subtle">
          {changes.length === 0 ? 'changes: none' : `changes: ${changes.join(', ')}`}
        </span>
      </div>
      {changes.length > 0 && (
        <div className="overflow-hidden rounded-md ring ring-kumo-line">
          <JsonView value={decision.changes} height="content" raw={false} />
        </div>
      )}
    </div>
  )
}

export function BlockingForm({
  project,
  detail,
  url,
  onOpenInvocation,
}: {
  project: string
  detail: FunctionDetail
  url: string
  onOpenInvocation: (id: string) => void
}) {
  const summary = detail.summary
  const blocking = detail.blocking
  const blockingEvent = blocking?.event === 'beforeSignIn' ? 'beforeSignIn' : 'beforeCreate'
  const [draft, setDraft] = useRunDraft<BlockingDraft>(project, summary.id, () => ({
    kind: 'blocking',
    uid: 'u_new',
    email: 'new@example.test',
    displayName: '',
    provider: 'password',
    claims: '{}',
  }))
  const [run, setRun] = useState<{
    started?: InvocationSummary | undefined
    finished?: InvocationSummary | undefined
    decision?: BlockingDecision | undefined
    error?: { message: string; fix?: string | undefined } | undefined
    sending: boolean
  } | null>(null)
  const [awaiting, setAwaiting] = useState<((invocation: InvocationSummary) => boolean) | null>(
    null,
  )
  const awaited = useNextInvocation(summary.id, awaiting)
  const user = composedUser(draft)
  const problem = 'problem' in user ? user.problem : undefined
  const update = (patch: Partial<BlockingDraft>) => setDraft({ ...draft, ...patch })

  const test = async () => {
    if ('problem' in user) return
    const builder = createResponseBuilder(new Date().toISOString())
    setRun({ sending: true })
    setAwaiting(null)
    try {
      const body = blockingBody({
        target: { uri: url, projectId: project },
        event: blockingEvent,
        user,
        signInMethod: draft.provider === 'anonymous' ? undefined : draft.provider,
        iat: Math.floor(Date.now() / 1000),
        eventId: randomEventId(),
      })
      let record: ResponseRecord | undefined
      const outcome = await invokeFunction(
        summary.id,
        {
          target: 'url',
          method: 'POST',
          path: '/',
          headers: [{ name: 'content-type', value: 'application/json' }],
          body,
          encoding: 'text',
        },
        {
          onFrame: (frame) => {
            record = builder.apply(frame)
            if (frame.frame === 'started')
              setRun((current) => ({ ...current, sending: true, started: frame.invocation }))
            if (frame.frame === 'finished')
              setRun((current) => ({ ...current, sending: false, finished: frame.invocation }))
          },
        },
      )
      const text = record?.bodyText ?? ''
      setRun((current) => ({
        ...current,
        sending: false,
        ...(outcome.failed
          ? { error: { message: outcome.failed } }
          : { decision: readBlockingResponse(record?.status ?? 0, text) }),
      }))
    } catch (error) {
      setRun({
        sending: false,
        error:
          error instanceof ApiError
            ? { message: error.message, fix: error.fix }
            : { message: String(error) },
      })
    }
  }

  const signUp = useMutation({
    mutationFn: async () => {
      const email = draft.email.trim()
      if (!email) throw new Error('Give the user an email to sign up with.')
      await nativeFetch('/auth/identitytoolkit.googleapis.com/v1/accounts:signUp?key=console', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'password1',
          ...(draft.displayName.trim() ? { displayName: draft.displayName.trim() } : {}),
          returnSecureToken: true,
        }),
      }).catch((error: unknown) => {
        // A refused sign-up is the function's answer, said by the Auth emulator: shown, not thrown away.
        if (error instanceof ApiError) return error
        throw error
      })
      const started = Date.now() - 1000
      setAwaiting(
        () => (invocation: InvocationSummary) =>
          invocation.kind === 'blocking' && Date.parse(invocation.startedAt) >= started,
      )
      return email
    },
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="blocking-form">
      <div className="grid shrink-0 gap-2.5 px-5 py-3">
        <FormRow label="Wired into">
          <span className="font-mono text-[12px] text-kumo-default">
            {blockingWords(blockingEvent)}
          </span>
          {blocking && !blocking.wired && (
            <span className="text-[12px] text-kumo-warning">
              another function is the one the Auth emulator calls
            </span>
          )}
        </FormRow>
        <FormRow label="Forwards">
          <span className="text-[13px] text-kumo-default">
            {blocking
              ? [
                  blocking.forwards.idToken && 'ID token',
                  blocking.forwards.accessToken && 'access token',
                  blocking.forwards.refreshToken && 'refresh token',
                ]
                  .filter(Boolean)
                  .join(', ') || 'no credentials'
              : 'no credentials'}
          </span>
        </FormRow>
        <FormRow label="User">
          <Input
            size="sm"
            className="w-28 font-mono"
            value={draft.uid}
            onChange={(event) => update({ uid: event.target.value })}
            placeholder="uid"
            aria-label="uid"
            spellCheck={false}
          />
          <Input
            size="sm"
            className="min-w-0 flex-1 font-mono"
            value={draft.email}
            onChange={(event) => update({ email: event.target.value })}
            placeholder="email"
            aria-label="Email"
            spellCheck={false}
            data-testid="blocking-email"
          />
        </FormRow>
        <FormRow label="">
          <Input
            size="sm"
            className="min-w-0 flex-1"
            value={draft.displayName}
            onChange={(event) => update({ displayName: event.target.value })}
            placeholder="Display name"
            aria-label="Display name"
          />
          <Select
            size="sm"
            aria-label="Provider"
            value={draft.provider as (typeof PROVIDERS)[number]}
            onValueChange={(next) => update({ provider: String(next) })}
            items={PROVIDERS.map((provider) => ({ value: provider, label: provider }))}
            className="w-36 shrink-0 font-mono"
          />
        </FormRow>
        <div className="grid gap-1">
          <span className="text-[12px] text-kumo-subtle">Custom claims</span>
          <JsonField
            value={draft.claims}
            onChange={(claims) => update({ claims })}
            minLines={2}
            maxLines={8}
            ariaLabel="Custom claims"
          />
        </div>
        <Text size="xs" variant="secondary">
          Nothing is created: the function receives the JWT the Auth emulator would send for this
          user.
        </Text>
        <div className="grid gap-1.5">
          <RequiresNotice section="auth" for="Signing up for real" testId="blocking-requires" />
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-kumo-subtle">Do it for real:</span>
            <Button
              variant="secondary"
              size="sm"
              icon={<UserPlusIcon />}
              loading={signUp.isPending}
              onClick={() => signUp.mutate()}
              data-testid="blocking-sign-up"
            >
              Sign up {draft.email.trim() || 'a user'}
            </Button>
          </div>
          {signUp.error && (
            <RunError
              message={signUp.error instanceof Error ? signUp.error.message : String(signUp.error)}
            />
          )}
          {signUp.data && !awaited && (
            <p className="m-0 text-[13px] text-kumo-subtle">
              Signed up through the Auth emulator; waiting for the call it makes…
            </p>
          )}
        </div>
        {problem && (
          <Text size="xs" variant="error">
            {problem}
          </Text>
        )}
      </div>
      <RunFooter
        primary={
          <SendButton
            label="Test"
            onSend={() => void test()}
            pending={run?.sending ?? false}
            disabled={problem !== undefined}
            testId="blocking-test"
          />
        }
      />
      {(run || awaited) && (
        <RunAnswer
          project={project}
          invocation={run?.started ?? awaited}
          finished={run?.finished ?? awaited}
          onOpen={onOpenInvocation}
        >
          {run?.error && <RunError message={run.error.message} fix={run.error.fix} />}
          {run?.decision && <Decision decision={run.decision} />}
        </RunAnswer>
      )}
    </div>
  )
}
