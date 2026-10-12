// The Inbox's reader: one code or link, with what it is for one click away.
// An email link opens through the console's own origin and does exactly what
// the email would; its action — verify, apply, revert, set a new password —
// is taken here through the client endpoint the app's SDK calls. An SMS code
// is large and copyable. Who it went to, the user it belongs to, the call that
// created it and the call that used it are links into the section that shows
// them.

import { Button, Input, Text } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, CheckCircleIcon, EnvelopeSimpleIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import { statusQuery } from '@/api/queries'
import { CopyButton } from '@/components/console/copy-button'
import { EntityLink } from '@/components/console/entity-link'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  useInspectorRoom,
} from '@/components/console/inspector'
import { KeyValueList, type KeyValueItem } from '@/components/console/key-value-list'
import { RelativeTime } from '@/components/console/relative-time'
import { CopyGlyph, useCopied } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { AuthEmulatorError } from '../api'
import { callRef, userRef } from '../links'
import {
  PASSWORD_MIN,
  actionBlocked,
  applyCode,
  deliveryText,
  isSms,
  messageAction,
  messageLabel,
  openHref,
  resetPassword,
} from '../messages'
import { authKeys, messageQuery } from '../queries'

export function MessageReader({
  project,
  id,
  loaded,
  capacity,
  focusPassword,
  onClose,
  onPrev,
  onNext,
}: {
  project: string
  id: number
  /** The message as the feed holds it (kept current as it is used); read on its own when not loaded. */
  loaded: AuthMessage | undefined
  /** How many messages the engine keeps, for the "no longer kept" line. */
  capacity: number
  /** Bumped by `a` on a password reset: the new password field takes focus. */
  focusPassword: number
  onClose: () => void
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
}) {
  const fetched = useQuery({ ...messageQuery(project, id), enabled: loaded === undefined })
  const message = loaded ?? fetched.data
  const gone = fetched.error instanceof ApiError && fetched.error.code === 'not-found'
  return (
    <Inspector
      widthKey="auth.message"
      title={
        message ? (
          <span
            className="flex min-w-0 items-center gap-1.5 text-[14px]"
            data-testid="reader-title"
          >
            <span className="shrink-0 font-semibold text-kumo-default">
              {messageLabel(message)}
            </span>
            <span className="shrink-0 text-kumo-subtle">·</span>
            <span className="truncate font-mono text-[12px] text-kumo-default">{message.to}</span>
          </span>
        ) : (
          <span className="font-mono text-[12px] text-kumo-subtle">
            Message #{formatNumber(id)}
          </span>
        )
      }
      meta={message?.at ? <RelativeTime iso={message.at} /> : undefined}
      onClose={onClose}
      closeLabel="Close the message"
      noun="message"
      onPrev={onPrev}
      onNext={onNext}
      // An SMS code's one action, Copy, is beside the code itself.
      footer={
        message && !isSms(message) ? (
          <ReaderFooter project={project} message={message} />
        ) : undefined
      }
      testId="message-reader"
    >
      {message ? (
        <ReaderBody project={project} message={message} focusPassword={focusPassword} />
      ) : gone ? (
        <p className="px-5 py-4 text-[13px] text-kumo-subtle" data-testid="reader-gone">
          {fetched.error instanceof ApiError
            ? fetched.error.message
            : `The engine no longer keeps message #${formatNumber(id)}; it keeps the newest ${formatNumber(capacity)}.`}
        </p>
      ) : fetched.error ? (
        <p className="px-5 py-4 text-[13px] text-kumo-danger">
          {fetched.error instanceof Error
            ? fetched.error.message
            : 'The message could not be read.'}
        </p>
      ) : null}
    </Inspector>
  )
}

function ReaderBody({
  project,
  message,
  focusPassword,
}: {
  project: string
  message: AuthMessage
  focusPassword: number
}) {
  const sms = isSms(message)
  const facts: KeyValueItem[] = [
    {
      label: sms ? 'Phone' : 'Email',
      value: message.to,
      copy: message.to,
      testId: 'reader-to',
    },
  ]
  if (message.newEmail)
    facts.push({ label: 'New email', value: message.newEmail, copy: message.newEmail })
  facts.push({
    label: 'User',
    value: message.uid ? (
      <EntityLink
        entity={{ ...userRef(message.tenant, message.uid), label: message.uid }}
        testId="reader-user"
      />
    ) : (
      <span className="font-sans text-[13px] text-kumo-subtle">no account yet</span>
    ),
  })
  facts.push({
    label: 'Tenant',
    value: message.tenant ?? <span className="font-sans text-[13px] text-kumo-subtle">none</span>,
  })
  facts.push({ label: 'Delivery', value: deliveryText(message), mono: false })
  if (message.activity !== null)
    facts.push({
      label: 'Created by',
      value: (
        <EntityLink
          entity={callRef(message.activity, `call #${formatNumber(message.activity)}`)}
          testId="reader-created-by"
        />
      ),
    })
  facts.push({
    label: 'Used',
    value: message.used ? (
      <span className="flex flex-wrap items-center gap-x-1.5">
        {message.usedBy !== null ? (
          <EntityLink
            entity={callRef(message.usedBy, `call #${formatNumber(message.usedBy)}`)}
            testId="reader-used-by"
          />
        ) : (
          'yes'
        )}
        {message.usedAt && <RelativeTime iso={message.usedAt} className="text-kumo-subtle" />}
      </span>
    ) : (
      <span className="font-sans text-[13px] text-kumo-subtle">not yet</span>
    ),
    testId: 'reader-used',
  })
  return (
    <>
      {sms ? (
        <InspectorSection title="Code">
          <BigCode message={message} />
        </InspectorSection>
      ) : message.link ? (
        <InspectorSection title="Link">
          <p
            className="m-0 font-mono text-[12px] leading-5 [overflow-wrap:anywhere] text-kumo-default"
            data-testid="reader-link"
          >
            {message.link}
          </p>
          {message.continueUrl && (
            <p className="m-0 mt-1 text-[12px] text-kumo-subtle">
              Continues to <span className="font-mono text-[0.9em]">{message.continueUrl}</span>
            </p>
          )}
        </InspectorSection>
      ) : null}
      <ActionSection project={project} message={message} focusPassword={focusPassword} />
      <InspectorSection title="Details">
        <KeyValueList items={facts} testId="reader-facts" />
      </InspectorSection>
      <InspectorSection title="What the emulator printed" count={message.text ? undefined : 0}>
        {message.text ? (
          <p className="m-0 font-mono text-[12px] leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap text-kumo-default">
            {message.text}
          </p>
        ) : null}
      </InspectorSection>
    </>
  )
}

/** An SMS code as the developer reads it off the screen: large, with its copy. */
function BigCode({ message }: { message: AuthMessage }) {
  const { copied, copy } = useCopied()
  return (
    <div className="flex items-center gap-3">
      <span
        className={`font-mono text-[24px] leading-8 tracking-normal tabular-nums ${message.used ? 'text-kumo-subtle line-through' : 'text-kumo-default'}`}
        data-testid="reader-code"
      >
        {message.code}
      </span>
      <Button
        variant="secondary"
        size="sm"
        icon={<CopyGlyph copied={copied} />}
        onClick={() => void copy(message.code)}
        data-testid="reader-copy-code"
      >
        {copied ? 'Copied' : 'Copy code'}
      </Button>
    </div>
  )
}

/** What a call to the emulator answered, as the section says it. */
function failureText(error: unknown): string {
  if (error instanceof AuthEmulatorError) return error.message
  if (error instanceof Error) return error.message
  return 'The emulator did not answer.'
}

function ActionSection({
  project,
  message,
  focusPassword,
}: {
  project: string
  message: AuthMessage
  focusPassword: number
}) {
  const status = useQuery(statusQuery)
  const action = messageAction(message)
  const blocked = actionBlocked(project, status.data?.projectId, message)
  const queryClient = useQueryClient()
  const refreshUser = () => {
    // The account changed (verified, new email, new password): its detail
    // is read again the next time it is shown. The table follows by itself.
    void queryClient.invalidateQueries({ queryKey: authKeys.allUserDetails(project) })
  }
  const apply = useMutation({ mutationFn: () => applyCode(message), onSuccess: refreshUser })
  const [password, setPassword] = useState('')
  const reset = useMutation({
    mutationFn: () => resetPassword(message, password),
    onSuccess: () => {
      setPassword('')
      refreshUser()
    },
  })
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusPassword > 0) field.current?.focus()
  }, [focusPassword])

  if (action.kind === 'copy' || action.kind === 'open') return null
  if (action.kind === 'apply')
    return (
      <InspectorSection title={action.label}>
        <div className="grid gap-2">
          <Text size="sm" variant="secondary">
            {message.kind === 'verifyEmail'
              ? 'Marks the email verified, as opening the link in the email would (applyActionCode).'
              : message.kind === 'recoverEmail'
                ? 'Puts the previous email back on the account, as the link in the email would.'
                : 'Changes the account’s email to the new one, as the link in the email would.'}
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => apply.mutate()}
              loading={apply.isPending}
              disabled={blocked !== undefined || apply.isSuccess}
              title={blocked}
              data-testid="reader-apply"
            >
              {action.label}
            </Button>
            {apply.isSuccess && <Done text={action.done} activity={apply.data.activity} />}
          </div>
          {blocked && !message.used && (
            <Text size="sm" variant="secondary">
              {blocked}
            </Text>
          )}
          {apply.isError && <Failure error={apply.error} />}
        </div>
      </InspectorSection>
    )
  return (
    <InspectorSection title="Set a new password">
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (password.length >= PASSWORD_MIN && blocked === undefined) reset.mutate()
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            ref={field}
            size="sm"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="New password"
            aria-label="New password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={blocked !== undefined || reset.isSuccess}
            className="w-56 font-mono"
            data-testid="reader-new-password"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={reset.isPending}
            disabled={password.length < PASSWORD_MIN || blocked !== undefined || reset.isSuccess}
            data-testid="reader-set-password"
          >
            Set password
          </Button>
        </div>
        <Text size="sm" variant="secondary">
          {reset.isSuccess ? (
            <Done text="The password is set." activity={reset.data.activity} />
          ) : (
            (blocked ??
            `At least ${PASSWORD_MIN} characters. The account’s ID tokens issued before now stop passing the emulator’s checks, as in Firebase.`)
          )}
        </Text>
        {reset.isError && <Failure error={reset.error} />}
      </form>
    </InspectorSection>
  )
}

function Done({ text, activity }: { text: string; activity: number | undefined }) {
  return (
    <span
      className="flex items-center gap-1.5 text-[13px] text-kumo-default"
      data-testid="reader-done"
    >
      <CheckCircleIcon size={14} weight="fill" className="text-kumo-success" />
      {text}
      {activity !== undefined && (
        <EntityLink entity={callRef(activity, `call #${formatNumber(activity)}`)} />
      )}
    </span>
  )
}

function Failure({ error }: { error: unknown }): ReactNode {
  return (
    <p className="m-0 text-[13px] text-kumo-danger" data-testid="reader-error">
      {failureText(error)}
    </p>
  )
}

function ReaderFooter({ project, message }: { project: string; message: AuthMessage }) {
  const status = useQuery(statusQuery)
  const { labels } = useInspectorRoom()
  const href = openHref(message)
  const action = messageAction(message)
  const foreign = actionBlocked(project, status.data?.projectId, { used: false })
  const open = (label: string, testId: string) =>
    href ? (
      <Button
        variant={action.kind === 'open' ? 'primary' : 'secondary'}
        size="sm"
        icon={<ArrowSquareOutIcon />}
        disabled={foreign !== undefined}
        title={foreign}
        onClick={() => window.open(href, '_blank', 'noopener')}
        data-testid={testId}
      >
        {label}
      </Button>
    ) : null
  return (
    <InspectorFooter
      tools={
        message.link ? (
          <>
            <CopyValue
              value={message.link}
              label="Copy link"
              glyph={<EnvelopeSimpleIcon />}
              labels={labels}
            />
            <CopyButton value={message.code} label="Copy the code" testId="reader-copy-oob" />
          </>
        ) : undefined
      }
      primary={
        action.kind === 'open'
          ? open('Open in app', 'reader-open')
          : open('Open link', 'reader-open')
      }
    />
  )
}

function CopyValue({
  value,
  label,
  glyph,
  labels,
}: {
  value: string
  label: string
  glyph: ReactNode
  labels: boolean
}) {
  const { copied, copy } = useCopied()
  const icon = copied ? <CopyGlyph copied /> : glyph
  return labels ? (
    <Button
      variant="ghost"
      size="sm"
      icon={icon}
      onClick={() => void copy(value)}
      data-testid="reader-copy"
    >
      {copied ? 'Copied' : label}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={icon}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => void copy(value)}
      data-testid="reader-copy"
    />
  )
}
