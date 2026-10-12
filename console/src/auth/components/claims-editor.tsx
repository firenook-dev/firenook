// The Claims tab: the account's custom claims as JSON, checked as Firebase
// checks them while they are typed, with the token they produce beside them
// and where the rules read each one.
//
// - the editor marks text that is not JSON, a value that is not an object,
//   every reserved key, and the keys the minted token says something about;
//   it completes the keys other users carry;
// - the meter measures what Firebase measures (UTF-16 code units of the
//   compact JSON) against the 1,000-character limit, amber from 900;
// - "Read by your rules" comes from the rules engine's own analysis;
// - the ID token below is the engine's mint of this draft, nothing stored.
//
// The draft is the inspector's: Save (or ⌘↵ here, ⌘S anywhere) writes it
// with the rest in one `accounts:update`.

import { Button, Meter, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, InfoIcon } from '@phosphor-icons/react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { CodeEditor } from '@/components/code-editor'
import { InspectorSection } from '@/components/console/inspector'
import { formatNumber } from '@/lib/format'
import { mintToken } from '../api'
import {
  CLAIMS_LIMIT,
  FORBIDDEN_CLAIMS,
  addClaimKey,
  claimsMarks,
  formatClaims,
  meterTone,
  noteMarks,
} from '../claims'
import { type RulesTarget, rulesLineLink } from '../links'
import { authKeys, claimKeysQuery } from '../queries'
import { groupClaimReads, useClaimReadSources } from '../rules-reads'
import { tokenRequest } from '../token-request'
import { refusal } from '../user-actions'
import { ProviderSelect, TokenPreview } from './token-preview'

/** How long the preview waits after the last keystroke before it asks for a token, ms. */
const PREVIEW_SETTLE_MS = 300

/** The text once it has stopped changing for `ms`. */
function useSettled(text: string, ms: number): string {
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), ms)
    return () => clearTimeout(timer)
  }, [text, ms])
  return settled
}

/** The claims as the preview sends them, or why there is no preview for this text. */
function previewClaims(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    if (Object.keys(parsed).some((key) => FORBIDDEN_CLAIMS.includes(key))) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** A line of a ruleset, as a link to its rules page at that line (the rules pages' own schema). */
function RulesLine({
  target,
  line,
  testId,
}: {
  target: RulesTarget
  line: number
  testId?: string
}) {
  const link = rulesLineLink(target, line)
  return (
    <Link
      to={link.to as never}
      search={link.search as never}
      className="font-mono text-kumo-link underline-offset-2 hover:underline"
      data-testid={testId}
    >
      {line}
    </Link>
  )
}

const TONE_CLASS = {
  quiet: undefined,
  crowded: 'bg-kumo-warning',
  over: 'bg-kumo-danger',
} as const

export function ClaimsEditor({
  detail,
  project,
  tenant,
  text,
  onChange,
  problem,
  onSave,
}: {
  detail: AuthUserDetail
  project: string
  tenant: string | undefined
  text: string
  onChange: (text: string) => void
  /** Why Save would be refused for these claims (from the draft). */
  problem: string | undefined
  onSave: () => void
}) {
  const uid = detail.row.uid
  const keys = useQuery({ ...claimKeysQuery(project, tenant), enabled: project !== '' })
  const [provider, setProvider] = useState<string | undefined>(undefined)
  const settled = useSettled(text, PREVIEW_SETTLE_MS)
  const claims = previewClaims(settled)
  const compact = claims === undefined ? undefined : JSON.stringify(claims)
  const preview = useQuery({
    queryKey: [
      ...authKeys.project(project),
      'claims-preview',
      tenant ?? '',
      uid,
      provider ?? '',
      compact,
    ],
    queryFn: ({ signal }) =>
      mintToken(project, tokenRequest({ uid, tenant, provider, claims }), signal),
    enabled: project !== '' && claims !== undefined,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30_000,
    retry: false,
  })
  const minted = claims === undefined ? undefined : preview.data
  const length = (() => {
    const parsed = previewClaims(text)
    return parsed === undefined ? undefined : JSON.stringify(parsed).length
  })()
  const tone = length === undefined ? 'quiet' : meterTone(length)
  const marks = [
    ...claimsMarks(text),
    ...(minted ? noteMarks(text, { shadowed: minted.shadowed, overrides: minted.overrides }) : []),
  ]
  const others = (keys.data?.keys ?? []).slice(0, 8)
  const draftKeys = (() => {
    const parsed = previewClaims(text)
    return parsed === undefined ? [] : Object.keys(parsed)
  })()
  const reads = useClaimReadSources(true)
  const grouped = groupClaimReads(reads.sources)
  const formatted = formatClaims(text)
  return (
    <div className="pb-2" data-testid="claims-editor">
      <InspectorSection title="Custom claims" testId="section-claims">
        <div className="grid gap-2">
          <div data-testid="claims-meter" data-tone={tone}>
            <Meter
              label="Characters, as Firebase counts them"
              value={Math.min(length ?? 0, CLAIMS_LIMIT)}
              max={CLAIMS_LIMIT}
              customValue={
                length === undefined
                  ? 'not JSON yet'
                  : `${formatNumber(length)} / ${formatNumber(CLAIMS_LIMIT)} characters`
              }
              {...(TONE_CLASS[tone] ? { indicatorClassName: TONE_CLASS[tone] } : {})}
            />
          </div>
          {/* ⌘↵ saves from here: taken before CodeMirror reads it as "insert a blank line". */}
          <div
            className="flex h-56 min-h-0 flex-col"
            onKeyDownCapture={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                event.stopPropagation()
                onSave()
              }
            }}
          >
            <CodeEditor
              value={text}
              onChange={onChange}
              language="json"
              marks={marks}
              jsonCompletion={{ keys: () => (keys.data?.keys ?? []).map((key) => key.key) }}
              tidyPaste={(pasted) => formatClaims(pasted)}
              ariaLabel="Custom claims"
              testId="claims-text"
            />
          </div>
          {problem && (
            <p className="text-[12px] text-kumo-danger" data-testid="claims-problem">
              {problem}
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                if (formatted !== undefined) onChange(formatted)
              }}
              disabled={formatted === undefined || formatted === text}
              data-testid="claims-format"
            >
              Format
            </Button>
            {others.length > 0 && (
              <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-[12px] text-kumo-subtle">
                Keys other users have:
                {others.map((key, index) => (
                  <span key={key.key} className="inline-flex items-center">
                    {index > 0 && <span className="pr-1">·</span>}
                    <Tooltip
                      content={`Add ${key.key} to these claims`}
                      render={
                        <button
                          type="button"
                          onClick={() => onChange(addClaimKey(text, key.key, key.samples[0]))}
                          disabled={draftKeys.includes(key.key) || formatted === undefined}
                          className="rounded-sm font-mono text-[12px] text-kumo-link enabled:hover:underline disabled:text-kumo-subtle"
                          data-testid="claims-other-key"
                        >
                          {key.key}
                        </button>
                      }
                    />
                    <span className="pl-0.5 font-mono text-[11px] tabular-nums">
                      ({formatNumber(key.users)})
                    </span>
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
      </InspectorSection>
      {(reads.firestore || reads.storage) && (
        <InspectorSection title="Read by your rules" testId="section-claim-reads">
          {formatted === undefined ? (
            <p className="text-[12px] text-kumo-subtle">Shown once the claims are JSON.</p>
          ) : draftKeys.length === 0 && grouped.dynamic.length === 0 ? (
            <p className="text-[12px] text-kumo-subtle">These claims are empty.</p>
          ) : (
            <ul className="grid gap-1">
              {draftKeys.map((key) => {
                const places = grouped.byKey.get(key) ?? []
                return (
                  <li
                    key={key}
                    className="flex min-w-0 items-baseline gap-3 text-[12px]"
                    data-testid="claim-read"
                  >
                    <span className="w-24 shrink-0 truncate font-mono text-kumo-default">
                      {key}
                    </span>
                    {places.length === 0 ? (
                      <span className="text-kumo-subtle">
                        {grouped.dynamic.length > 0
                          ? 'not read by name (a rule reads a claim chosen at run time)'
                          : 'not read by any rules'}
                      </span>
                    ) : (
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        {places.map((place, index) => (
                          <span key={place.label} className="inline-flex items-baseline gap-1">
                            {index > 0 && <span className="text-kumo-subtle">·</span>}
                            <span className="font-mono text-kumo-subtle">{place.label}</span>
                            <span className="text-kumo-subtle">
                              {place.lines.length === 1 ? 'line' : 'lines'}
                            </span>
                            {place.lines.map((line, at) => (
                              <span key={line} className="inline-flex items-baseline">
                                <RulesLine
                                  target={place.target}
                                  line={line}
                                  testId="claim-read-line"
                                />
                                {at < place.lines.length - 1 && ','}
                              </span>
                            ))}
                            <ArrowSquareOutIcon
                              size={11}
                              className="self-center text-kumo-subtle"
                              aria-hidden
                            />
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {grouped.dynamic.length > 0 && (
            <p
              className="mt-2 flex items-start gap-1.5 text-[12px] text-kumo-subtle"
              data-testid="claim-reads-dynamic"
            >
              <span className="flex h-4 items-center">
                <InfoIcon size={12} />
              </span>
              <span>
                {grouped.dynamic.length === 1
                  ? '1 rule reads'
                  : `${grouped.dynamic.length} rules read`}{' '}
                a claim chosen at run time (
                {grouped.dynamic.map((read, index) => (
                  <span key={`${read.label}:${read.line}`}>
                    {index > 0 && ', '}
                    {read.label} line <RulesLine target={read.target} line={read.line} />
                  </span>
                ))}
                ).
              </span>
            </p>
          )}
        </InspectorSection>
      )}
      <InspectorSection
        title="The ID token these claims produce"
        testId="section-token"
        action={
          <ProviderSelect
            providers={minted?.providers ?? detail.row.providers}
            provider={provider ?? minted?.provider ?? detail.row.providers[0]}
            onProvider={setProvider}
          />
        }
      >
        <TokenPreview
          minted={minted}
          error={
            claims === undefined
              ? 'The token appears once the claims are a JSON object without reserved keys.'
              : preview.isError
                ? refusal(preview.error)
                : undefined
          }
        />
      </InspectorSection>
    </div>
  )
}
