// Inspect a token: paste an ID token, a session cookie, a custom token or a
// refresh token and see what it is, who it names, and how each consumer
// would judge it — Firestore and Storage rules, the Auth emulator's own
// calls, `verifyIdToken` with and without the revocation check, a sign-in —
// each with the reason and the fix: expired, issued before the user's tokens
// were revoked, a disabled or unknown user, another tenant, another project,
// signed by production. The engine decodes and judges (`POST
// /auth/token/inspect`); nothing changes.

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
import { inspectToken } from '../api'
import { takeInspectDraft, useInspectDraft } from '../inspect-draft'
import { takeHandedOffToken } from '../inspect-handoff'
import { AUTH } from '../queries'
import { userRef } from '../links'

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
  // The token dialog hands its token over through inspect-handoff; a call's
  // "Inspect this token" through the draft, which also reaches an open panel.
  const [text, setText] = useState(() => takeHandedOffToken() ?? takeInspectDraft())
  // A token handed over while the panel is already open replaces what is in it.
  useEffect(
    () =>
      useInspectDraft.subscribe((state) => {
        if (state.token) setText(takeInspectDraft())
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
      {result && (
        <>
          <InspectorSection title="Verdicts" testId="inspect-token-verdicts">
            <ul className="m-0 grid list-none gap-2.5 p-0">
              {result.checks.map((check) => (
                <Verdict key={check.consumer} check={check} kind={result.kind} />
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

function Verdict({ check, kind }: { check: AuthTokenCheck; kind: AuthTokenKind }) {
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
