// Try a sign-in (Activity's side tool, `?panel=try&method=`): run any way an
// app signs someone in, as a client of the emulator with the API key —
// exactly what the app does — then read the decoded token or the explained
// error, and what the call caused (a blocking function's claims, its
// refusal). A method that sends a code first fills in the code that very
// call created (`GET /auth/messages?activity=<its id>`), whatever else the
// app sends to the same phone or email meanwhile; a sign-in that stops at a
// second factor continues into it. Every call it makes is in Activity as a
// Try, and the result links its entry.

import { Button, Input, InputArea, Select, Text } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  PaperPlaneTiltIcon,
  SignInIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { EntityLink } from '@/components/console/entity-link'
import { IdentityPicker } from '@/components/console/identity-picker'
import { Inspector, InspectorSection } from '@/components/console/inspector'
import { JsonTree } from '@/components/console/json-tree'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { PanelTitle } from '@/components/kit'
import type { ViewAs } from '@/lib/identity'
import { sectionById } from '@/lib/services'
import { latencyText, stepChips } from '../activity'
import { AuthEmulatorError, callAuthEmulator, getMessagesOfCall, getUser } from '../api'
import { copyWithToast } from '../clipboard'
import { explainAuthError } from '../errors'
import { firestoreAsUser, userRef } from '../links'
import { activityEntryQuery } from '../queries'
import {
  CONTINUE_PLACEHOLDER,
  EMPTY_FIELDS,
  METHODS,
  METHOD_CALLS,
  METHOD_LABELS,
  type PendingFactor,
  type SignedIn,
  type TryFields,
  type TryMethod,
  decodeTokenPayload,
  finishSecondFactor,
  firstStep,
  missingField,
  pendingSecondFactor,
  secondStep,
  sessionInfoOf,
  signedIn,
  startSecondFactor,
  takeTryDraft,
  twoSteps,
  useTryDraft,
} from '../sign-in'
import type { TenantScope } from '../tenant-scope'
import { QUIET_CHIP } from './message-row'

/** Where the continue URL of the last sign-in link is remembered, per tenant. */
const CONTINUE_KEY = 'firenook.console.auth.continue-url'

function readContinueUrl(tenant: string | undefined): string {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CONTINUE_KEY) ?? '{}')
    const value = (stored as Record<string, unknown>)[tenant ?? '']
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

function writeContinueUrl(tenant: string | undefined, url: string): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CONTINUE_KEY) ?? '{}')
    const next = { ...(stored as Record<string, unknown>), [tenant ?? '']: url }
    localStorage.setItem(CONTINUE_KEY, JSON.stringify(next))
  } catch {
    // Not remembered in a browser that refuses storage.
  }
}

/** One call Try made: its id in Activity, and how it ended. */
type Outcome =
  | { kind: 'signed-in'; activity: number | undefined; tokens: SignedIn }
  | { kind: 'failed'; activity: number | undefined; code: string; message: string }

/** Where a two-step method stands after its first call. */
interface Sent {
  activity: number | undefined
  sessionInfo: string | undefined
  /** The message the call created, when the engine kept it. */
  message: number | undefined
}

/** A sign-in that stopped at its second factor. */
interface SecondFactor {
  credential: string
  factors: PendingFactor[]
  chosen: string | undefined
  sent: Sent | undefined
  code: string
}

/** Runs one call and says how it ended; a refusal is an outcome, not an exception. */
async function call(request: Parameters<typeof callAuthEmulator>[0]) {
  try {
    const answer = await callAuthEmulator<unknown>(request)
    return { ok: true as const, body: answer.body, activity: answer.activity }
  } catch (error) {
    if (error instanceof AuthEmulatorError)
      return {
        ok: false as const,
        code: error.code,
        message: error.message,
        activity: error.activity,
      }
    throw error
  }
}

export function TrySignIn({
  project,
  scope,
  method,
  onMethod,
  onOpenCall,
  onClose,
}: {
  project: string
  /** The page's tenant scope: a tenant's sign-ins carry its id. */
  scope: TenantScope
  method: TryMethod
  onMethod: (method: TryMethod) => void
  /** Opens one of Try's own calls in the detail. */
  onOpenCall: (id: number) => void
  onClose: () => void
}) {
  const tenant = scope.kind === 'tenant' ? scope.tenant : undefined
  const status = useQuery(statusQuery)
  const configured = status.data?.projectId
  const foreign = configured !== undefined && project !== '' && project !== configured
  const [fields, setFields] = useState<TryFields>(() => ({
    ...EMPTY_FIELDS,
    continueUrl: readContinueUrl(tenant),
    ...takeTryDraft(),
  }))
  // Fields handed over while the panel is already open ("Edit and run again").
  useEffect(
    () =>
      useTryDraft.subscribe((state) => {
        if (state.fields) setFields((current) => ({ ...current, ...takeTryDraft() }))
      }),
    [],
  )
  const set = (patch: Partial<TryFields>) => setFields((current) => ({ ...current, ...patch }))
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined)
  const [sent, setSent] = useState<Sent | undefined>(undefined)
  const [second, setSecond] = useState<SecondFactor | undefined>(undefined)
  const [picked, setPicked] = useState<ViewAs | undefined>(undefined)
  const [pickError, setPickError] = useState<string | undefined>(undefined)

  // A new method starts over.
  const [shownMethod, setShownMethod] = useState(method)
  if (shownMethod !== method) {
    setShownMethod(method)
    setOutcome(undefined)
    setSent(undefined)
    setSecond(undefined)
  }

  /** The code a call sent, read by its id: what step 2 fills in. */
  const codeOf = async (activity: number | undefined) => {
    if (activity === undefined) return undefined
    const messages = await getMessagesOfCall(project, activity)
    return messages.items[0]
  }

  /** What a signing-in answer means: signed in, stopped at a second factor, or refused. */
  const settle = (result: Awaited<ReturnType<typeof call>>) => {
    if (!result.ok) {
      setOutcome({
        kind: 'failed',
        activity: result.activity,
        code: result.code,
        message: result.message,
      })
      return
    }
    const pending = pendingSecondFactor(result.body)
    if (pending) {
      setSecond({
        ...pending,
        chosen: pending.factors[0]?.mfaEnrollmentId,
        sent: undefined,
        code: '',
      })
      return
    }
    const tokens = signedIn(result.body)
    if (tokens) {
      setOutcome({ kind: 'signed-in', activity: result.activity, tokens })
      if (tokens.refreshToken) set({ refreshToken: tokens.refreshToken })
    }
  }

  const run = async () => {
    setRunning(true)
    setOutcome(undefined)
    setSecond(undefined)
    try {
      if (twoSteps(method) && sent === undefined) {
        if (method === 'emailLink') writeContinueUrl(tenant, fields.continueUrl.trim())
        const result = await call(firstStep(method, fields, tenant))
        if (!result.ok) {
          settle(result)
          return
        }
        const message = await codeOf(result.activity)
        setSent({
          activity: result.activity,
          sessionInfo: sessionInfoOf(result.body),
          message: message?.id,
        })
        if (message) set({ code: message.code })
        return
      }
      if (twoSteps(method) && sent && (method === 'emailLink' || method === 'phone')) {
        settle(await call(secondStep(method, fields, sent.sessionInfo, tenant)))
        return
      }
      settle(await call(firstStep(method, fields, tenant)))
    } catch (error) {
      setOutcome({
        kind: 'failed',
        activity: undefined,
        code: 'NETWORK',
        message: error instanceof Error ? error.message : 'The emulator did not answer.',
      })
    } finally {
      setRunning(false)
    }
  }

  const runSecond = async () => {
    if (!second?.chosen) return
    setRunning(true)
    try {
      if (!second.sent) {
        const result = await call(startSecondFactor(second.credential, second.chosen, tenant))
        if (!result.ok) {
          settle(result)
          return
        }
        const message = await codeOf(result.activity)
        setSecond({
          ...second,
          sent: {
            activity: result.activity,
            sessionInfo: sessionInfoOf(result.body),
            message: message?.id,
          },
          code: message?.code ?? '',
        })
        return
      }
      const sessionInfo = second.sent.sessionInfo ?? ''
      const result = await call(
        finishSecondFactor(second.credential, sessionInfo, second.code, tenant),
      )
      setSecond(undefined)
      settle(result)
    } finally {
      setRunning(false)
    }
  }

  const fill = async (viewAs: ViewAs) => {
    setPicked(viewAs)
    setPickError(undefined)
    if (viewAs.kind !== 'user') return
    try {
      const detail = await getUser(project, viewAs.tenant, viewAs.uid)
      set({
        email: detail.row.email ?? '',
        password: detail.password ?? '',
        phone: detail.row.phoneNumber ?? '',
        uid: viewAs.uid,
      })
      if (detail.passwordOpaque)
        setPickError(
          'This user’s password was imported with a real hash; the emulator cannot read it back.',
        )
    } catch (error) {
      setPickError(error instanceof Error ? error.message : 'The user could not be read.')
    }
  }

  const missing =
    sent && twoSteps(method)
      ? fields.code.trim() === ''
        ? 'Enter the code.'
        : undefined
      : missingField(method, fields)
  const action = actionLabel(method, sent !== undefined)
  return (
    <Inspector
      widthKey="auth.tools"
      title={<PanelTitle>Try a sign-in</PanelTitle>}
      onClose={onClose}
      closeLabel="Close Try a sign-in"
      testId="try-sign-in"
    >
      <form
        className="grid gap-3 px-5 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!missing && !running && !foreign) void run()
        }}
      >
        <Text size="sm" variant="secondary">
          {foreign
            ? `The emulator signs clients in to its own project, ${configured}; open Try from that project.`
            : `As a client of ${tenant ? `tenant ${tenant}` : 'the project, no tenant'}, with the API key — exactly what your app does.`}
        </Text>
        <Field label="Method">
          <Select
            size="sm"
            value={method}
            onValueChange={(next) => onMethod(next as TryMethod)}
            items={Object.fromEntries(METHODS.map((value) => [value, METHOD_LABELS[value]]))}
            aria-label="Method"
            className="w-full"
            data-testid="try-method"
          />
          <Text size="xs" variant="secondary">
            What your app calls:{' '}
            <span className="font-mono text-[0.9em]">{METHOD_CALLS[method]}</span>
          </Text>
        </Field>
        {(method === 'password' ||
          method === 'signUp' ||
          method === 'emailLink' ||
          method === 'federated') && (
          <Field label="Email">
            <TextInput
              value={fields.email}
              onChange={(email) => set({ email })}
              placeholder="ada@example.test"
              testId="try-email"
              type="email"
              disabled={sent !== undefined}
            />
          </Field>
        )}
        {(method === 'password' || method === 'signUp') && (
          <Field label="Password">
            <TextInput
              value={fields.password}
              onChange={(password) => set({ password })}
              placeholder="password-1"
              testId="try-password"
            />
          </Field>
        )}
        {method === 'password' && (
          <Field label="Or fill in a user">
            <div className="flex min-w-0 items-center gap-2">
              <IdentityPicker
                project={project}
                value={picked ?? { kind: 'owner' }}
                onChange={(viewAs) => void fill(viewAs)}
                modes={['user']}
                ownerLabel="a user you pick"
                testId="try-pick-user"
              />
            </div>
            {pickError && (
              <Text size="xs" variant="secondary">
                {pickError}
              </Text>
            )}
          </Field>
        )}
        {method === 'emailLink' && (
          <Field label="Continue URL">
            <TextInput
              value={fields.continueUrl}
              onChange={(continueUrl) => set({ continueUrl })}
              placeholder={CONTINUE_PLACEHOLDER}
              testId="try-continue-url"
              disabled={sent !== undefined}
            />
          </Field>
        )}
        {method === 'phone' && (
          <Field label="Phone">
            <TextInput
              value={fields.phone}
              onChange={(phone) => set({ phone })}
              placeholder="+15550100"
              testId="try-phone"
              type="tel"
              disabled={sent !== undefined}
            />
          </Field>
        )}
        {method === 'customToken' && (
          <>
            <Field label="uid">
              <TextInput
                value={fields.uid}
                onChange={(uid) => set({ uid })}
                placeholder="u_ada"
                testId="try-uid"
              />
            </Field>
            <Field label="Custom claims (optional)">
              <InputArea
                size="sm"
                value={fields.claims}
                onChange={(event) => set({ claims: event.target.value })}
                placeholder='{"role": "admin"}'
                aria-label="Custom claims"
                spellCheck={false}
                minRows={2}
                className="w-full font-mono text-[12px]"
                data-testid="try-claims"
              />
            </Field>
          </>
        )}
        {method === 'federated' && (
          <>
            <Field label="Provider">
              <TextInput
                value={fields.providerId}
                onChange={(providerId) => set({ providerId })}
                placeholder="google.com"
                testId="try-provider"
              />
            </Field>
            <Field label="Provider account id (sub)">
              <TextInput
                value={fields.subject}
                onChange={(subject) => set({ subject })}
                placeholder="the email when left empty"
                testId="try-subject"
              />
            </Field>
            <Field label="Name (optional)">
              <TextInput
                value={fields.name}
                onChange={(name) => set({ name })}
                placeholder="Ada Lovelace"
                testId="try-name"
              />
            </Field>
          </>
        )}
        {method === 'refresh' && (
          <Field label="Refresh token">
            <InputArea
              size="sm"
              value={fields.refreshToken}
              onChange={(event) => set({ refreshToken: event.target.value })}
              placeholder="Sign in first, or paste one"
              aria-label="Refresh token"
              spellCheck={false}
              minRows={3}
              className="w-full font-mono text-[12px] [overflow-wrap:anywhere]"
              data-testid="try-refresh-token"
            />
          </Field>
        )}
        {sent && (
          <Field label={method === 'phone' ? 'Code' : 'Code in the link (oobCode)'}>
            <TextInput value={fields.code} onChange={(code) => set({ code })} testId="try-code" />
            <Text size="xs" variant="secondary">
              {sent.message === undefined ? (
                'The engine kept no message for that call; type the code.'
              ) : (
                <span className="inline-flex flex-wrap items-center gap-x-1">
                  The code that call sent, from
                  <EntityLink
                    entity={{
                      kind: 'auth.message',
                      key: String(sent.message),
                      label: `message #${sent.message}`,
                    }}
                  />
                </span>
              )}
            </Text>
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={twoSteps(method) && !sent ? <PaperPlaneTiltIcon /> : <SignInIcon />}
            loading={running}
            disabled={missing !== undefined || foreign}
            title={missing}
            data-testid="try-run"
          >
            {action}
          </Button>
          {sent && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSent(undefined)
                set({ code: '' })
              }}
              data-testid="try-start-over"
            >
              Start over
            </Button>
          )}
          {missing && (
            <Text size="xs" variant="secondary">
              {missing}
            </Text>
          )}
        </div>
      </form>
      {second && (
        <SecondFactorStep
          second={second}
          running={running}
          onChoose={(chosen) => setSecond({ ...second, chosen, sent: undefined, code: '' })}
          onCode={(code) => setSecond({ ...second, code })}
          onRun={() => void runSecond()}
        />
      )}
      {outcome && <Result project={project} outcome={outcome} onOpenCall={onOpenCall} />}
    </Inspector>
  )
}

function actionLabel(method: TryMethod, sent: boolean): string {
  if (method === 'emailLink') return sent ? 'Sign in with the link' : 'Send the link'
  if (method === 'phone') return sent ? 'Sign in with the code' : 'Send the code'
  if (method === 'signUp') return 'Sign up'
  if (method === 'anonymous') return 'Sign in anonymously'
  if (method === 'refresh') return 'Refresh'
  return 'Sign in'
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Text as="span" size="xs" variant="secondary">
        {label}
      </Text>
      {children}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  testId,
  type = 'text',
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId: string
  type?: 'text' | 'email' | 'tel'
  disabled?: boolean
}) {
  return (
    <Input
      size="sm"
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={placeholder ?? testId}
      spellCheck={false}
      autoComplete="off"
      disabled={disabled}
      className="w-full font-mono"
      data-testid={testId}
    />
  )
}

function SecondFactorStep({
  second,
  running,
  onChoose,
  onCode,
  onRun,
}: {
  second: SecondFactor
  running: boolean
  onChoose: (enrollmentId: string) => void
  onCode: (code: string) => void
  onRun: () => void
}) {
  return (
    <InspectorSection title="Second factor" testId="try-second-factor">
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          onRun()
        }}
      >
        <Text size="sm" variant="secondary">
          This account has a second factor: the sign-in continues as MultiFactorResolver does.
        </Text>
        <Select
          size="sm"
          value={second.chosen ?? ''}
          onValueChange={(next) => onChoose(String(next))}
          items={Object.fromEntries(
            second.factors.map((factor) => [
              factor.mfaEnrollmentId,
              `${factor.displayName ?? 'Phone'} ${factor.phone ?? ''}`.trim(),
            ]),
          )}
          aria-label="Second factor"
          className="w-full"
          disabled={second.sent !== undefined}
        />
        {second.sent && (
          <Input
            size="sm"
            value={second.code}
            onChange={(event) => onCode(event.target.value)}
            aria-label="The second factor's code"
            className="w-full font-mono"
            data-testid="try-second-code"
          />
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={running}
            disabled={!second.chosen || (second.sent !== undefined && second.code.trim() === '')}
            data-testid="try-second-run"
          >
            {second.sent ? 'Finish the sign-in' : 'Send the code'}
          </Button>
        </div>
      </form>
    </InspectorSection>
  )
}

function Result({
  project,
  outcome,
  onOpenCall,
}: {
  project: string
  outcome: Outcome
  onOpenCall: (id: number) => void
}) {
  const status = useQuery(statusQuery)
  const entry = useQuery({
    ...activityEntryQuery(project, outcome.activity ?? 0),
    enabled: outcome.activity !== undefined,
  })
  const summary = entry.data?.summary
  const chips = summary ? stepChips(summary.steps, summary.moreSteps) : []
  const openEntry =
    outcome.activity === undefined ? null : (
      <Button
        variant="ghost"
        size="xs"
        icon={<ArrowSquareOutIcon />}
        onClick={() => onOpenCall(outcome.activity ?? 0)}
        data-testid="try-open-entry"
      >
        Open entry
      </Button>
    )
  if (outcome.kind === 'failed') {
    const explained = explainAuthError(outcome.code)
    return (
      <InspectorSection title="Result" testId="try-result">
        <div className="grid gap-1.5" data-state="failed">
          <span className="flex flex-wrap items-center gap-2">
            <OutcomeChip word={outcome.code} tone="danger" mono />
            <span className="font-mono text-[11px] text-kumo-subtle">→ {explained.sdk}</span>
            {summary && (
              <span className="font-mono text-[11px] text-kumo-subtle">
                {latencyText(summary.durationMicros)}
              </span>
            )}
          </span>
          <p className="m-0 text-[13px] text-kumo-default" data-testid="try-explanation">
            {explained.explanation?.what ?? outcome.message}
          </p>
          {explained.explanation?.fix && (
            <p className="m-0 text-[12px] text-kumo-subtle">{explained.explanation.fix}</p>
          )}
          <Chips chips={chips} />
          <div>{openEntry}</div>
        </div>
      </InspectorSection>
    )
  }
  const { tokens } = outcome
  const payload = decodeTokenPayload(tokens.idToken)
  const firebase = payload?.firebase as Record<string, unknown> | undefined
  const tenant = typeof firebase?.tenant === 'string' ? firebase.tenant : undefined
  const provider =
    typeof firebase?.sign_in_provider === 'string' ? firebase.sign_in_provider : undefined
  const uid = tokens.uid ?? (typeof payload?.user_id === 'string' ? payload.user_id : undefined)
  const email = typeof payload?.email === 'string' ? payload.email : undefined
  // Only while Firestore is part of this engine (and its pages are in the console).
  const firestore =
    sectionById('firestore')?.built === true &&
    status.data?.sections.find((section) => section.id === 'firestore')?.state !== 'absent'
  return (
    <InspectorSection title="Result" testId="try-result">
      <div className="grid gap-2" data-state="signed-in">
        <span className="flex flex-wrap items-center gap-2 text-[12px] text-kumo-subtle">
          <OutcomeChip word="ok" tone="success" mono />
          {summary && (
            <span className="font-mono text-[11px]">{latencyText(summary.durationMicros)}</span>
          )}
          {tokens.isNewUser !== undefined && (
            <span>new user {tokens.isNewUser ? 'yes' : 'no'}</span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-default">
          <CheckCircleIcon size={14} weight="fill" className="text-kumo-success" />
          Signed in as
          {uid ? (
            <EntityLink
              entity={{ ...userRef(tenant, uid), label: email ?? uid }}
              testId="try-user"
            />
          ) : (
            'a user'
          )}
          {provider && (
            <span className="text-kumo-subtle">
              with <span className="font-mono text-[12px]">{provider}</span>
            </span>
          )}
        </span>
        <Chips chips={chips} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="secondary"
            size="xs"
            onClick={() =>
              void copyWithToast(`Bearer ${tokens.idToken}`, 'the Authorization header')
            }
            data-testid="try-copy-header"
          >
            Copy Authorization header
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void copyWithToast(tokens.idToken, 'the ID token')}
            data-testid="try-copy-token"
          >
            Copy ID token
          </Button>
          {firestore && uid && <FirestoreLink uid={uid} tenant={tenant} email={email} />}
          {openEntry}
        </div>
        {payload && (
          <JsonTree
            value={payload}
            defaultDepth={1}
            rootLabel="ID token"
            ariaLabel="The ID token’s payload"
            testId="try-payload"
          />
        )}
      </div>
    </InspectorSection>
  )
}

function Chips({ chips }: { chips: ReturnType<typeof stepChips> }) {
  if (chips.length === 0) return null
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="try-steps">
      {chips.map((chip) => (
        <span
          key={chip.text}
          className={`${QUIET_CHIP} ${chip.tone === 'danger' ? 'text-kumo-danger' : ''}`}
        >
          {chip.text}
        </span>
      ))}
    </span>
  )
}

function FirestoreLink({
  uid,
  tenant,
  email,
}: {
  uid: string
  tenant: string | undefined
  email: string | undefined
}) {
  const link = firestoreAsUser({ uid, tenant, email })
  return (
    <Link
      to={link.to as never}
      search={link.search as never}
      className="inline-flex h-6 items-center rounded-md px-2 text-[12px] text-kumo-link hover:ink focus-visible:ring focus-visible:ring-kumo-focus focus-visible:outline-none"
      data-testid="try-open-firestore"
    >
      Open Firestore as this user
    </Link>
  )
}
