// The inspector's Details tab: every field the emulator stores for the
// account, in the inspector's field-line language — a 13 px English name, a
// 12 px value in a box, a 28 px line, the ember dot beside a name the next
// Save will write — and the account actions the Admin SDK has, each where
// the thing it changes is.
//
// The profile, status and the two times are the draft (Save writes them in
// one `accounts:update`); the password, revocation, providers, second
// factors and the codes a developer sends act at once, through the official
// API, as `updateUser`, `revokeRefreshTokens` and the app's SDK would.

import { Button, DatePicker, Input, Popover, Switch, Tooltip, cn } from '@cloudflare/kumo'
import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useRef, useState } from 'react'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { Anchored } from '@/components/console/completions'
import { InspectorSection } from '@/components/console/inspector'
import { MaskedValue } from '@/components/console/masked-value'
import { RelativeTime } from '@/components/console/relative-time'
import { PanelTitle } from '@/components/kit'
import { clockTime, relativeTime, utcStamp } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { providerGlyph, providerLabel } from '../providers'
import {
  type UserTarget,
  announceSent,
  changePassword,
  continueUrlKey,
  refusal,
  revokeTokens,
  sendPasswordReset,
  sendSignInLink,
  sendVerificationEmail,
  setSmsFactors,
  unlinkProvider,
} from '../user-actions'
import type { DraftField, UserDraft, UserValues } from '../user-draft'
import { LinkProviderDialog } from './link-provider-dialog'
import { UserAvatar } from './user-avatar'

/** A line of value, in a box: the ground and the ring are the box's. */
const LINE =
  'flex min-w-0 flex-1 items-start rounded-md bg-kumo-control ring focus-within:ring-kumo-focus'
/** One line of text inside the box. */
const INPUT =
  'h-8 min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[12px] text-kumo-default outline-none placeholder:text-kumo-placeholder'
/** A value that wraps rather than running off the end of its line; the mirror and the field agree to the pixel. */
const WRAP_BOX =
  'min-w-0 px-1.5 py-[5px] font-mono text-[12px] leading-[18px] whitespace-pre-wrap [overflow-wrap:break-word]'
/** The value's own word inside the box at its end: `2 d ago`. */
const WORD = 'flex h-8 shrink-0 items-center pr-1.5 pl-1 font-mono text-[11px] text-kumo-subtle'
/** A note under a value: what a change does, or why it cannot be saved. */
const NOTE = 'pt-1 text-[12px] leading-4'

/** The two columns a section's lines share: the widest name, then the values. */
function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
      {children}
    </div>
  )
}

function FieldLine({
  label,
  unsaved = false,
  problem,
  note,
  children,
  testId,
  wrap = false,
}: {
  label: string
  /** The next Save writes this field: the ember dot beside its name. */
  unsaved?: boolean
  problem?: string | undefined
  note?: ReactNode
  children: ReactNode
  testId?: string
  /** The controls may wrap under the value when the panel is narrow. */
  wrap?: boolean
}) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid items-start" data-testid={testId}>
      <span className="flex h-8 max-w-40 min-w-0 items-center gap-1.5 text-[13px] text-kumo-subtle">
        <span className="truncate">{label}</span>
        <span className="flex w-1.5 shrink-0 items-center">
          {unsaved && (
            <span className="size-1.5 rounded-full bg-kumo-brand" data-testid="unsaved-mark" />
          )}
        </span>
      </span>
      <div className="min-w-0">
        <div className={cn('flex min-w-0 items-start gap-x-2', wrap && 'flex-wrap gap-y-1')}>
          {children}
        </div>
        {problem ? (
          <p className={cn(NOTE, 'text-kumo-danger')} data-testid="field-problem">
            {problem}
          </p>
        ) : note ? (
          <p className={cn(NOTE, 'text-kumo-subtle')}>{note}</p>
        ) : null}
      </div>
    </div>
  )
}

/** A text value in a box; `wrap` for a value that can be any length (an email, a URL). */
function TextBox({
  value,
  onChange,
  label,
  placeholder,
  wrap = false,
  invalid = false,
  readOnly = false,
  testId,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  wrap?: boolean
  invalid?: boolean
  readOnly?: boolean
  testId?: string
}) {
  return (
    <div className={cn(LINE, invalid ? 'ring-kumo-danger' : 'ring-kumo-line')}>
      {wrap ? (
        <div className="grid min-w-0 flex-1">
          <span className={cn(WRAP_BOX, 'invisible col-start-1 row-start-1')} aria-hidden="true">
            {`${value || placeholder || ''} `}
          </span>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value.replace(/\n/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault()
            }}
            rows={1}
            spellCheck={false}
            readOnly={readOnly}
            placeholder={placeholder}
            aria-label={label}
            className={cn(
              WRAP_BOX,
              'col-start-1 row-start-1 resize-none overflow-hidden bg-transparent text-kumo-default outline-none placeholder:text-kumo-placeholder',
            )}
            data-testid={testId}
          />
        </div>
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          readOnly={readOnly}
          placeholder={placeholder}
          aria-label={label}
          className={INPUT}
          data-testid={testId}
        />
      )}
    </div>
  )
}

/**
 * An instant: typed as ISO text (the truth, with its milliseconds), with a
 * calendar and a time of day under it while the field has focus, and how
 * long ago it was inside the box.
 */
function TimeBox({
  value,
  onChange,
  label,
  invalid,
  testId,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  invalid: boolean
  testId?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const when = new Date(value.trim())
  const known = value.trim() !== '' && !Number.isNaN(when.getTime())
  const base = known ? when : new Date()
  const set = (moment: Date) => onChange(moment.toISOString())
  const panel = `${testId ?? 'time'}-picker`
  return (
    <div
      className="min-w-0 flex-1"
      onBlur={(event) => {
        const going = event.relatedTarget
        if (
          going &&
          (event.currentTarget.contains(going) || going.closest(`[data-testid="${panel}"]`))
        )
          return
        setOpen(false)
      }}
    >
      <div className={cn(LINE, invalid ? 'ring-kumo-danger' : 'ring-kumo-line')}>
        <input
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
          spellCheck={false}
          placeholder="not set"
          aria-label={label}
          className={INPUT}
          data-testid={testId}
        />
        {known && <span className={WORD}>{relativeTime(when.toISOString())}</span>}
      </div>
      {open && (
        <Anchored anchor={ref} testId={panel} width="content" room={360}>
          <div className="grid gap-2 p-2">
            <DatePicker
              mode="single"
              selected={known ? when : undefined}
              defaultMonth={base}
              onChange={(day) => {
                if (!day) return
                const next = new Date(base)
                next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate())
                set(next)
              }}
            />
            <div className="flex items-center gap-2 border-t border-kumo-line pt-2">
              <input
                type="time"
                step="1"
                value={clockTime(base, 'second')}
                onChange={(event) => {
                  const [hours = 0, minutes = 0, seconds = 0] = event.target.value
                    .split(':')
                    .map(Number)
                  const next = new Date(base)
                  next.setHours(hours, minutes, seconds)
                  set(next)
                }}
                className="h-8 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
                aria-label={`${label} time of day`}
              />
              <Button variant="secondary" size="sm" onClick={() => set(new Date())}>
                Now
              </Button>
              <span className="ml-auto font-mono text-[11px] text-kumo-subtle">
                {new Intl.DateTimeFormat().resolvedOptions().timeZone}
              </span>
            </div>
          </div>
        </Anchored>
      )}
    </div>
  )
}

/** A value shown, not edited: the data face, or a short rule for none. */
function Shown({ value, testId }: { value: string | null | undefined; testId?: string }) {
  if (!value)
    return (
      <span className="flex h-8 items-center" data-testid={testId}>
        <span className="block h-px w-3 bg-kumo-line" role="img" aria-label="not set" />
      </span>
    )
  return (
    <span
      className="flex min-h-8 min-w-0 items-center font-mono text-[12px] [overflow-wrap:anywhere] text-kumo-default"
      data-testid={testId}
    >
      {value}
    </span>
  )
}

export function InspectorDetails({
  detail,
  server,
  draft,
  shown,
  changed,
  problems,
  onEdit,
  target,
  blocked,
  onActed,
}: {
  detail: AuthUserDetail
  server: UserValues
  draft: UserDraft
  /** What each field shows: the typed value while touched, else the server's. */
  shown: UserValues
  changed: ReadonlySet<DraftField>
  problems: Partial<Record<DraftField, string>>
  onEdit: <F extends DraftField>(field: F, value: UserValues[F]) => void
  target: UserTarget
  /** Why writes are refused (the tenant was deleted). */
  blocked: string | undefined
  /** An immediate action finished: the detail is read again. */
  onActed: () => void
}) {
  const row = detail.row
  const emailDirty = draft.email !== undefined && changed.has('email')
  return (
    <div className="pb-2" data-testid="inspector-details">
      <InspectorSection title="Profile" testId="section-profile">
        <FieldGrid>
          <FieldLine label="Display name" unsaved={changed.has('displayName')}>
            <TextBox
              value={shown.displayName}
              onChange={(value) => onEdit('displayName', value)}
              label="Display name"
              placeholder="not set"
              wrap
              testId="field-display-name"
            />
          </FieldLine>
          <FieldLine label="Photo URL" unsaved={changed.has('photoUrl')}>
            <TextBox
              value={shown.photoUrl}
              onChange={(value) => onEdit('photoUrl', value)}
              label="Photo URL"
              placeholder="not set"
              wrap
              testId="field-photo-url"
            />
            {shown.photoUrl && (
              <span className="flex h-8 shrink-0 items-center">
                <UserAvatar
                  photoUrl={shown.photoUrl}
                  name={shown.displayName || null}
                  email={shown.email || null}
                  anonymous={false}
                  size={24}
                />
              </span>
            )}
          </FieldLine>
          <FieldLine
            label="Email"
            unsaved={changed.has('email') || changed.has('emailVerified')}
            problem={problems.email}
            note={
              emailDirty
                ? 'Changing the email revokes this user’s ID tokens: tokens issued before now stop passing the emulator’s checks, as in Firebase.'
                : undefined
            }
          >
            <TextBox
              value={shown.email}
              onChange={(value) => onEdit('email', value)}
              label="Email"
              placeholder="not set"
              wrap
              invalid={problems.email !== undefined}
              testId="field-email"
            />
            <label className="flex h-8 shrink-0 items-center gap-1.5 text-[12px] text-kumo-subtle">
              <Switch
                variant="neutral"
                size="sm"
                checked={shown.emailVerified}
                onClick={() => onEdit('emailVerified', !shown.emailVerified)}
                aria-label="Verified email"
                data-testid="field-verified"
              />
              Verified
            </label>
          </FieldLine>
          <FieldLine
            label="Phone"
            unsaved={changed.has('phoneNumber')}
            problem={problems.phoneNumber}
          >
            <TextBox
              value={shown.phoneNumber}
              onChange={(value) => onEdit('phoneNumber', value)}
              label="Phone"
              placeholder="+15550100"
              invalid={problems.phoneNumber !== undefined}
              testId="field-phone"
            />
          </FieldLine>
        </FieldGrid>
      </InspectorSection>

      <InspectorSection title="Status" testId="section-status">
        <FieldGrid>
          <FieldLine
            label="Disabled"
            unsaved={changed.has('disabled')}
            note="Disabled users cannot sign in or refresh a token; an ID token they already hold keeps working until it expires."
          >
            <span className="flex h-8 items-center">
              <Switch
                variant="neutral"
                size="sm"
                checked={shown.disabled}
                onClick={() => onEdit('disabled', !shown.disabled)}
                aria-label="Disabled"
                data-testid="field-disabled"
              />
            </span>
          </FieldLine>
        </FieldGrid>
      </InspectorSection>

      <SecuritySection detail={detail} target={target} blocked={blocked} onActed={onActed} />
      <ProvidersSection detail={detail} target={target} blocked={blocked} onActed={onActed} />
      <MfaSection detail={detail} target={target} blocked={blocked} onActed={onActed} />
      {detail.passkeys.length > 0 && (
        <InspectorSection title="Passkeys" count={detail.passkeys.length} testId="section-passkeys">
          <ul className="grid gap-0.5">
            {detail.passkeys.map((passkey) => (
              <li key={passkey.credentialId} className="flex h-7 items-center gap-2 text-[12px]">
                <span className="truncate font-mono">{passkey.name ?? passkey.credentialId}</span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}

      <InspectorSection title="Metadata" testId="section-metadata">
        <FieldGrid>
          <FieldLine
            label="Created"
            unsaved={changed.has('createdAt')}
            problem={problems.createdAt}
          >
            <TimeBox
              value={shown.createdAt}
              onChange={(value) => onEdit('createdAt', value)}
              label="Created"
              invalid={problems.createdAt !== undefined}
              testId="field-created"
            />
          </FieldLine>
          <FieldLine
            label="Last sign-in"
            unsaved={changed.has('lastLoginAt')}
            problem={problems.lastLoginAt}
          >
            <TimeBox
              value={shown.lastLoginAt}
              onChange={(value) => onEdit('lastLoginAt', value)}
              label="Last sign-in"
              invalid={problems.lastLoginAt !== undefined}
              testId="field-last-sign-in"
            />
          </FieldLine>
          <FieldLine label="Last refresh">
            {detail.lastRefreshAt === null ? (
              <Shown value={null} />
            ) : (
              <span className="flex h-8 items-center gap-2 font-mono text-[12px]">
                {utcStamp(new Date(detail.lastRefreshAt).toISOString())}
                <RelativeTime
                  iso={new Date(detail.lastRefreshAt).toISOString()}
                  className="text-kumo-subtle"
                />
              </span>
            )}
          </FieldLine>
          <FieldLine label="Initial email">
            <Shown value={detail.initialEmail} />
          </FieldLine>
          <FieldLine label="Email link">
            <Shown value={detail.emailLinkSignIn ? 'signed in with an email link' : null} />
          </FieldLine>
        </FieldGrid>
      </InspectorSection>
      {server.email === '' && row.phoneNumber === null && row.providers.length === 0 && (
        <p className="px-5 pt-2 text-[12px] text-kumo-subtle">
          An anonymous account: it signs in with the device it was created on until a provider is
          linked.
        </p>
      )}
    </div>
  )
}

/** The password the emulator keeps recoverably, revocation, and the codes a developer sends. */
function SecuritySection({
  detail,
  target,
  blocked,
  onActed,
}: {
  detail: AuthUserDetail
  target: UserTarget
  blocked: string | undefined
  onActed: () => void
}) {
  const navigate = useNavigate()
  const [changing, setChanging] = useState(false)
  const [password, setPassword] = useState('')
  const change = useMutation({
    mutationFn: () => changePassword(target, password),
    onSuccess: () => {
      setChanging(false)
      setPassword('')
      onActed()
      toast({ key: `auth.password.${target.uid}`, title: 'Password changed', tone: 'success' })
    },
  })
  const revoke = useMutation({
    mutationFn: () => revokeTokens(target),
    onSuccess: () => {
      onActed()
      toast({ key: `auth.revoke.${target.uid}`, title: 'Refresh tokens revoked', tone: 'success' })
    },
  })
  const email = detail.row.email
  const sent = (title: string) => (activity: number | undefined) =>
    announceSent({
      project: target.project,
      activity,
      title,
      description: 'It is in the Inbox, as the message your app would have sent.',
      navigate: (link) => void navigate(link as never),
    })
  const failed = (what: string) => (error: unknown) =>
    toast({
      key: `auth.send.${target.uid}`,
      title: what,
      description: refusal(error),
      tone: 'danger',
    })
  const validSince = detail.validSince === null ? null : new Date(detail.validSince * 1_000)
  return (
    <InspectorSection title="Security" testId="section-security">
      <FieldGrid>
        <FieldLine
          label="Password"
          problem={change.isError ? refusal(change.error) : undefined}
          note={
            changing
              ? 'A new password revokes this user’s ID tokens: tokens issued before now stop passing the emulator’s checks.'
              : detail.passwordOpaque
                ? 'Imported with a real hash — the emulator cannot read it back. Set a new password to sign in locally.'
                : detail.passwordUpdatedAt !== null
                  ? `Set ${relativeTime(new Date(detail.passwordUpdatedAt).toISOString())}.`
                  : undefined
          }
          testId="field-password"
        >
          {changing ? (
            <>
              <Input
                size="sm"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="6 or more characters"
                aria-label="New password"
                className="min-w-0 flex-1 font-mono"
                autoFocus
                data-testid="new-password"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => change.mutate()}
                loading={change.isPending}
                disabled={password === ''}
                data-testid="set-password"
              >
                Set
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="flex min-h-8 min-w-0 flex-1 items-center">
                {detail.password !== null ? (
                  <MaskedValue
                    value={detail.password}
                    label="Show the password"
                    copyable
                    testId="password-masked"
                  />
                ) : detail.passwordOpaque ? (
                  <span className="font-mono text-[12px] text-kumo-subtle">imported hash</span>
                ) : (
                  <span className="text-[12px] text-kumo-subtle">No password</span>
                )}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  change.reset()
                  setChanging(true)
                }}
                disabled={blocked !== undefined}
                title={blocked}
                data-testid="change-password"
              >
                {detail.password === null && !detail.passwordOpaque ? 'Set…' : 'Change…'}
              </Button>
            </>
          )}
        </FieldLine>
        <FieldLine label="Tokens valid since" wrap>
          <span className="flex min-h-8 shrink-0 items-center font-mono text-[12px] whitespace-nowrap">
            {validSince ? utcStamp(validSince.toISOString()) : 'the account’s creation'}
          </span>
          <span className="flex-1" />
          <Popover>
            <Popover.Trigger
              render={
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={blocked !== undefined}
                  data-testid="revoke-tokens"
                >
                  Revoke refresh tokens
                </Button>
              }
            />
            <Popover.Content className="w-80">
              <div className="grid gap-2" data-testid="revoke-confirm">
                <PanelTitle>Revoke this user’s tokens</PanelTitle>
                <p className="text-[13px] text-kumo-subtle">
                  Tokens issued before now fail{' '}
                  <span className="font-mono text-[0.9em]">verifyIdToken(token, true)</span> and the
                  emulator’s own token checks (TOKEN_EXPIRED). As in the official emulator, a
                  refresh token still mints new ID tokens.
                </p>
                {revoke.isError && (
                  <p className="text-[12px] text-kumo-danger">{refusal(revoke.error)}</p>
                )}
                <div className="flex justify-end">
                  <Popover.Close
                    render={
                      <Button
                        variant="primary"
                        size="sm"
                        loading={revoke.isPending}
                        onClick={() => revoke.mutate()}
                        data-testid="revoke-confirm-button"
                      >
                        Revoke
                      </Button>
                    }
                  />
                </div>
              </div>
            </Popover.Content>
          </Popover>
        </FieldLine>
        <FieldLine label="Send">
          <span className="flex min-h-8 flex-wrap items-center gap-1.5">
            <SendButton
              label="Password reset"
              disabled={!email ? 'This user has no email address.' : blocked}
              onClick={() => {
                if (email)
                  void sendPasswordReset(target, email).then(
                    sent(`Password reset sent to ${email}`),
                    failed('The emulator did not send a password reset'),
                  )
              }}
              testId="send-reset"
            />
            <SendButton
              label="Verification email"
              disabled={!email ? 'This user has no email address.' : blocked}
              onClick={() =>
                void sendVerificationEmail(target).then(
                  sent(`Verification email sent to ${email ?? ''}`),
                  failed('The emulator did not send a verification email'),
                )
              }
              testId="send-verify"
            />
            <SignInLinkButton
              target={target}
              email={email}
              blocked={blocked}
              onSent={(activity) => sent(`Sign-in link sent to ${email ?? ''}`)(activity)}
            />
          </span>
        </FieldLine>
      </FieldGrid>
    </InspectorSection>
  )
}

function SendButton({
  label,
  disabled,
  onClick,
  testId,
}: {
  label: string
  disabled: string | undefined
  onClick: () => void
  testId: string
}) {
  const button = (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
      disabled={disabled !== undefined}
      data-testid={testId}
    >
      {label}
    </Button>
  )
  return disabled === undefined ? (
    button
  ) : (
    <Tooltip content={disabled} render={<span className="inline-flex">{button}</span>} />
  )
}

function readContinueUrl(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** "Sign-in link…": asks where the link continues (the last used for this tenant), then sends it. */
function SignInLinkButton({
  target,
  email,
  blocked,
  onSent,
}: {
  target: UserTarget
  email: string | null
  blocked: string | undefined
  onSent: (activity: number | undefined) => void
}) {
  const key = continueUrlKey(target.project, target.tenant)
  const [url, setUrl] = useState(() => readContinueUrl(key))
  const [open, setOpen] = useState(false)
  const absolute = /^https?:\/\/[^\s/]+/.test(url.trim())
  const send = useMutation({
    mutationFn: () => sendSignInLink(target, email ?? '', url.trim()),
    onSuccess: (activity) => {
      try {
        localStorage.setItem(key, url.trim())
      } catch {
        // The next one simply starts empty.
      }
      setOpen(false)
      onSent(activity)
    },
  })
  if (!email || blocked !== undefined)
    return (
      <SendButton
        label="Sign-in link…"
        disabled={!email ? 'This user has no email address.' : blocked}
        onClick={() => {}}
        testId="send-link"
      />
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button variant="secondary" size="sm" data-testid="send-link">
            Sign-in link…
          </Button>
        }
      />
      <Popover.Content className="w-96">
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (absolute) send.mutate()
          }}
          data-testid="send-link-form"
        >
          <PanelTitle>Send a sign-in link to {email}</PanelTitle>
          <p className="text-[13px] text-kumo-subtle">
            Where the link continues: a page of your app that finishes the sign-in.
          </p>
          <Input
            size="sm"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://your-app.example/finish"
            aria-label="Continue URL"
            className="w-full font-mono"
            autoFocus
            data-testid="continue-url"
          />
          {url.trim() !== '' && !absolute && (
            <p className="text-[12px] text-kumo-danger">
              The emulator needs an absolute URL, starting with http:// or https://.
            </p>
          )}
          {send.isError && <p className="text-[12px] text-kumo-danger">{refusal(send.error)}</p>}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!absolute}
              loading={send.isPending}
            >
              Send
            </Button>
          </div>
        </form>
      </Popover.Content>
    </Popover>
  )
}

/** Linked sign-in providers, with Link and Unlink. */
function ProvidersSection({
  detail,
  target,
  blocked,
  onActed,
}: {
  detail: AuthUserDetail
  target: UserTarget
  blocked: string | undefined
  onActed: () => void
}) {
  const [linking, setLinking] = useState(false)
  const unlink = useMutation({
    mutationFn: (providerId: string) => unlinkProvider(target, providerId),
    onSuccess: onActed,
    onError: (error) =>
      toast({
        key: `auth.unlink.${target.uid}`,
        title: 'The emulator did not unlink the provider',
        description: refusal(error),
        tone: 'danger',
      }),
  })
  const providers = detail.providerInfo
  return (
    <InspectorSection
      title="Providers"
      count={providers.length}
      testId="section-providers"
      action={
        <Button
          variant="ghost"
          size="sm"
          icon={<PlusIcon />}
          onClick={() => setLinking(true)}
          disabled={blocked !== undefined}
          data-testid="link-provider"
        >
          Link
        </Button>
      }
    >
      <ul className="grid min-w-0 gap-0.5">
        {providers.map((provider) => {
          const Glyph = providerGlyph(provider.providerId)
          const last = providers.length <= 1
          return (
            <li
              key={`${provider.providerId}|${provider.rawId ?? ''}`}
              className="group/provider flex min-h-8 min-w-0 items-center gap-2 rounded-md text-[12px]"
              data-testid="provider-row"
            >
              <Glyph
                size={14}
                className="shrink-0 text-kumo-subtle"
                aria-label={providerLabel(provider.providerId)}
              />
              <span className="shrink-0 font-mono text-kumo-default">{provider.providerId}</span>
              {provider.rawId && provider.rawId !== provider.email && (
                <Tooltip
                  content={provider.rawId}
                  render={
                    <span className="max-w-24 min-w-0 truncate font-mono text-kumo-subtle">
                      {provider.rawId}
                    </span>
                  }
                />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-kumo-subtle">
                {[provider.email ?? provider.phoneNumber, provider.displayName]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="shrink-0">
                <UnlinkButton
                  providerId={provider.providerId}
                  last={last}
                  blocked={blocked}
                  pending={unlink.isPending && unlink.variables === provider.providerId}
                  onUnlink={() => unlink.mutate(provider.providerId)}
                />
              </span>
            </li>
          )
        })}
      </ul>
      <LinkProviderDialog
        open={linking}
        onOpenChange={setLinking}
        target={target}
        detail={detail}
        onLinked={onActed}
      />
    </InspectorSection>
  )
}

/** Unlink, asking first when it is the account's last way to sign in. */
function UnlinkButton({
  providerId,
  last,
  blocked,
  pending,
  onUnlink,
}: {
  providerId: string
  last: boolean
  blocked: string | undefined
  pending: boolean
  onUnlink: () => void
}) {
  const what =
    providerId === 'password'
      ? ' Unlinking password also removes the email and its verification, as Firebase does.'
      : ''
  if (!last && providerId !== 'password')
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onUnlink}
        loading={pending}
        disabled={blocked !== undefined}
        data-testid="unlink-provider"
      >
        Unlink
      </Button>
    )
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={blocked !== undefined}
            data-testid="unlink-provider"
          >
            Unlink
          </Button>
        }
      />
      <Popover.Content className="w-80">
        <div className="grid gap-2">
          <PanelTitle>Unlink {providerId}</PanelTitle>
          <p className="text-[13px] text-kumo-subtle">
            {last ? 'The user will have no way to sign in.' : ''}
            {what}
          </p>
          <div className="flex justify-end">
            <Popover.Close
              render={
                <Button variant="primary" size="sm" onClick={onUnlink} data-testid="unlink-confirm">
                  Unlink
                </Button>
              }
            />
          </div>
        </div>
      </Popover.Content>
    </Popover>
  )
}

/** SMS second factors: add one, remove one. */
function MfaSection({
  detail,
  target,
  blocked,
  onActed,
}: {
  detail: AuthUserDetail
  target: UserTarget
  blocked: string | undefined
  onActed: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const existing = detail.mfa.map((factor) => ({
    enrollmentId: factor.enrollmentId,
    phoneNumber: factor.phoneNumber ?? '',
    displayName: factor.displayName,
    enrolledAt: factor.enrolledAt,
  }))
  const save = useMutation({
    mutationFn: (factors: Parameters<typeof setSmsFactors>[1]) => setSmsFactors(target, factors),
    onSuccess: () => {
      setAdding(false)
      setPhone('')
      setName('')
      onActed()
    },
  })
  const valid = /^\+[1-9]\d{1,14}$/.test(phone.replace(/[\s().-]/g, ''))
  return (
    <InspectorSection
      title="Multi-factor"
      count={detail.mfa.length}
      testId="section-mfa"
      action={
        <Button
          variant="ghost"
          size="sm"
          icon={<PlusIcon />}
          onClick={() => {
            save.reset()
            setAdding(true)
          }}
          disabled={blocked !== undefined}
          data-testid="add-factor"
        >
          SMS factor
        </Button>
      }
    >
      {(detail.mfa.length > 0 || adding) && (
        <div className="grid gap-1.5">
          <ul className="grid gap-0.5">
            {detail.mfa.map((factor) => (
              <li
                key={factor.enrollmentId}
                className="flex min-h-8 items-center gap-2 text-[12px]"
                data-testid="factor-row"
              >
                <span className="shrink-0 font-mono text-kumo-default">{factor.phoneNumber}</span>
                {factor.displayName && (
                  <span className="min-w-0 truncate text-kumo-subtle">{factor.displayName}</span>
                )}
                {factor.enrolledAt && (
                  <RelativeTime
                    iso={factor.enrolledAt}
                    prefix="enrolled"
                    className="text-kumo-subtle"
                  />
                )}
                <span className="ml-auto shrink-0">
                  <Tooltip
                    content="Remove this factor"
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        icon={<TrashIcon />}
                        aria-label={`Remove ${factor.phoneNumber ?? 'this factor'}`}
                        disabled={blocked !== undefined}
                        onClick={() =>
                          save.mutate(
                            existing.filter((item) => item.enrollmentId !== factor.enrollmentId),
                          )
                        }
                        data-testid="remove-factor"
                      />
                    }
                  />
                </span>
              </li>
            ))}
          </ul>
          {adding && (
            <form
              className="flex items-start gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                if (valid)
                  save.mutate([
                    ...existing,
                    {
                      phoneNumber: phone.replace(/[\s().-]/g, ''),
                      displayName: name.trim() || null,
                    },
                  ])
              }}
              data-testid="add-factor-form"
            >
              <Input
                size="sm"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+15550199"
                aria-label="Phone number of the factor"
                className="w-36 font-mono"
                autoFocus
              />
              <Input
                size="sm"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name (optional)"
                aria-label="Name of the factor"
                className="min-w-0 flex-1"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!valid}
                loading={save.isPending}
              >
                Add
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </form>
          )}
          {save.isError && <p className="text-[12px] text-kumo-danger">{refusal(save.error)}</p>}
          {!detail.row.emailVerified && (
            <p className="text-[12px] text-kumo-subtle">
              Firebase requires a verified email before a user enrols a second factor from your app;
              the Admin SDK can add one regardless.
            </p>
          )}
        </div>
      )}
    </InspectorSection>
  )
}
