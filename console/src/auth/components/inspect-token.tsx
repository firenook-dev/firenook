// Inspect a token: paste an ID token, a session cookie, a custom token or a
// refresh token and see what it is, who it names, and how each consumer
// would judge it — Firestore and Storage rules, the Auth emulator's own
// calls, `verifyIdToken` with and without the revocation check, a sign-in —
// each with the reason and the fix: expired, issued before the user's tokens
// were revoked, a disabled or unknown user, another tenant, another project,
// signed by production. The engine decodes and judges (`POST
// /auth/token/inspect`); nothing changes. A token Sign in as minted
// ("View the token…") comes with what the engine said as it minted it —
// for whom, the beforeSignIn run, what differs from a real sign-in — said
// above the verdicts for as long as that token is the one in the box.

import { Button, InputArea, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { AuthTokenCheck } from '@/api/generated/auth/AuthTokenCheck'
import type { AuthTokenConsumer } from '@/api/generated/auth/AuthTokenConsumer'
import type { AuthTokenInspection } from '@/api/generated/auth/AuthTokenInspection'
import type { AuthTokenKind } from '@/api/generated/auth/AuthTokenKind'
import { EntityLink } from '@/components/console/entity-link'
import { Inspector, InspectorSection } from '@/components/console/inspector'
import { JsonTree } from '@/components/console/json-tree'
import { PanelTitle, StatusDot } from '@/components/kit'
import { formatDuration, relativeTime } from '@/lib/format'
import { inspectToken } from '../api'
import { type MintedNote, takeHandedOffToken, useInspectHandoff } from '../inspect-handoff'
import { AUTH } from '../queries'
import { callRef, userRef } from '../links'

const KINDS: Readonly<Record<AuthTokenKind, string>> = {
  idToken: 'ID token',
  sessionCookie: 'Session cookie',
  customToken: 'Custom token',
  refreshToken: 'Refresh token',
  unknown: 'Not a token the console recognises',
}

/** Who judges a token, in the words a developer calls them. */
export function consumerLabel(consumer: AuthTokenConsumer, kind: AuthTokenKind): string {
  switch (consumer) {
    case 'rules':
      return 'Firestore and Storage rules'
    case 'authEmulator':
      return 'The Auth emulator (accounts:lookup)'
    case 'verify':
      return kind === 'sessionCookie' ? 'verifySessionCookie(cookie)' : 'verifyIdToken(token)'
    case 'verifyRevoked':
      return kind === 'sessionCookie'
        ? 'verifySessionCookie(cookie, true)'
        : 'verifyIdToken(token, true)'
    case 'signIn':
      return kind === 'refreshToken' ? 'The refresh grant (securetoken)' : 'signInWithCustomToken'
  }
}

/** The line under the box: "ID token · unsigned (alg none) · tenant acme". */
export function kindLine(inspection: AuthTokenInspection): string {
  const parts = [KINDS[inspection.kind]]
  if (inspection.kind === 'idToken' || inspection.kind === 'sessionCookie') {
    const alg = typeof inspection.header?.alg === 'string' ? inspection.header.alg : undefined
    parts.push(inspection.signed ? `signed (${alg ?? 'a real algorithm'})` : 'unsigned (alg none)')
  }
  if (inspection.project) parts.push(`project ${inspection.project}`)
  parts.push(inspection.tenant ? `tenant ${inspection.tenant}` : 'no tenant')
  return parts.join(' · ')
}

/** How long the panel waits after the last keystroke before it asks the engine, ms. */
const SETTLE_MS = 300

export function InspectToken({ project, onClose }: { project: string; onClose: () => void }) {
  const [opened] = useState(takeHandedOffToken)
  const [text, setText] = useState(opened?.token ?? '')
  const [note, setNote] = useState<MintedNote | undefined>(opened?.minted)
  // A token handed over while the panel is already open replaces what is in it.
  useEffect(
    () =>
      useInspectHandoff.subscribe((state) => {
        if (!state.handed) return
        const handed = takeHandedOffToken()
        if (!handed) return
        setText(handed.token)
        setNote(handed.minted)
      }),
    [],
  )
  const [settled, setSettled] = useState(text.trim())
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text.trim()), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [text])
  const inspection = useQuery({
    queryKey: [AUTH, project, 'inspect', settled],
    queryFn: ({ signal }) => inspectToken(project, settled, signal),
    enabled: settled !== '' && project !== '',
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
  })
  const result = settled === '' ? undefined : inspection.data
  // The note speaks for the minted token only: another one in the box drops it.
  const minted = note && note.minted.idToken === text.trim() ? note : undefined
  return (
    <Inspector
      widthKey="auth.tools"
      title={<PanelTitle>Inspect a token</PanelTitle>}
      onClose={onClose}
      closeLabel="Close Inspect a token"
      testId="inspect-token"
    >
      <div className="grid gap-2 px-5 py-3">
        <div className="relative">
          <InputArea
            size="sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste an ID token, session cookie, custom token or refresh token"
            aria-label="The token to inspect"
            spellCheck={false}
            autoComplete="off"
            minRows={4}
            className="w-full resize-y pr-8 font-mono text-[12px] [overflow-wrap:anywhere]"
            data-testid="inspect-token-input"
          />
          {text !== '' && (
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              icon={<XIcon />}
              aria-label="Clear the token"
              onClick={() => setText('')}
              className="absolute top-1 right-1"
            />
          )}
        </div>
        {inspection.error && settled !== '' && (
          <Text size="sm" variant="error">
            {inspection.error instanceof Error
              ? inspection.error.message
              : 'The engine did not answer.'}
          </Text>
        )}
        {result && (
          <p
            className="m-0 flex flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-default"
            data-testid="inspect-token-kind"
          >
            {kindLine(result)}
            {result.uid && (
              <>
                <span className="text-kumo-subtle">·</span>
                <span className="text-kumo-subtle">user</span>
                {result.userExists ? (
                  <EntityLink
                    entity={{ ...userRef(result.tenant, result.uid), label: result.uid }}
                    testId="inspect-token-user"
                  />
                ) : (
                  <span className="font-mono text-[12px] text-kumo-default">
                    {result.uid}{' '}
                    <span className="font-sans text-[12px] text-kumo-subtle">
                      (no such account now)
                    </span>
                  </span>
                )}
              </>
            )}
          </p>
        )}
      </div>
      {minted && <MintedNoteView note={minted} />}
      {result && (
        <>
          <InspectorSection title="Verdicts" testId="inspect-token-verdicts">
            <ul className="m-0 grid list-none gap-2.5 p-0">
              {result.checks.map((check) => (
                <TokenVerdict key={check.consumer} check={check} kind={result.kind} />
              ))}
            </ul>
          </InspectorSection>
          {result.payload && (
            <InspectorSection title="Payload">
              <JsonTree
                value={result.payload}
                defaultDepth={2}
                ariaLabel="The token’s payload"
                testId="inspect-token-payload"
              />
            </InspectorSection>
          )}
          {result.header && (
            <InspectorSection title="Header">
              <JsonTree value={result.header} ariaLabel="The token’s header" />
            </InspectorSection>
          )}
        </>
      )}
      {!result && settled === '' && (
        <p className="m-0 px-5 pb-4 text-[13px] text-kumo-subtle">
          The console decodes it and asks each consumer, the way your app’s token would be judged:
          the rules, the Auth emulator and the Admin SDK. Nothing is changed.
        </p>
      )}
    </Inspector>
  )
}

/** What Sign in as said as it minted the token: for whom, beforeSignIn, what differs from a real sign-in. */
export function MintedNoteView({ note }: { note: MintedNote }) {
  const { minted } = note
  const factor = minted.secondFactor?.phoneNumber
  const before = minted.beforeSignIn
  return (
    <InspectorSection title="Minted by Sign in as" testId="inspect-token-minted">
      <div className="grid gap-2 text-[13px]">
        <p className="m-0 text-kumo-default">
          For {note.who}, as a {minted.provider} sign-in{factor ? ` with the factor ${factor}` : ''}
          ; expires {relativeTime(minted.expiresAt)}. Nothing was stored.
        </p>
        {before && (
          <p className="m-0 text-kumo-default" data-testid="inspect-token-before-sign-in">
            beforeSignIn ({before.function ?? 'your function'}) ran in{' '}
            {formatDuration(before.durationMicros / 1_000)}
            {before.customClaims.length > 0
              ? `; custom claims ${before.customClaims.join(', ')}`
              : ''}
            {before.sessionClaims.length > 0
              ? `; session claims ${before.sessionClaims.join(', ')}`
              : ''}
            ; its call <EntityLink entity={callRef(before.call, `#${before.call}`)} />.
          </p>
        )}
        {minted.differences.length > 0 && (
          <div className="grid gap-1" data-testid="inspect-token-differences">
            <PanelTitle as="h4">What differs from a real sign-in</PanelTitle>
            <ul className="m-0 grid list-disc gap-1 pl-5 text-kumo-subtle">
              {minted.differences.map((difference) => (
                <li key={difference}>{difference}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </InspectorSection>
  )
}

/** One consumer's verdict: a dot, who judges, then the reason and the fix. */
export function TokenVerdict({ check, kind }: { check: AuthTokenCheck; kind: AuthTokenKind }) {
  return (
    <li
      className="grid gap-0.5"
      data-testid="inspect-token-verdict"
      data-consumer={check.consumer}
      data-ok={check.ok}
    >
      <span className="flex items-center gap-2">
        <StatusDot
          tone={check.ok ? 'success' : 'danger'}
          label={check.ok ? 'Accepted' : 'Refused'}
        />
        <span className="font-mono text-[12px] text-kumo-default">
          {consumerLabel(check.consumer, kind)}
        </span>
      </span>
      {check.reason && <span className="pl-3.5 text-[13px] text-kumo-default">{check.reason}</span>}
      {check.fix && <span className="pl-3.5 text-[12px] text-kumo-subtle">{check.fix}</span>}
    </li>
  )
}
