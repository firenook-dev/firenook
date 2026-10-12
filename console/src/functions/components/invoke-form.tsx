// Invoke, for an HTTP function: Postman without leaving the console. The
// method and the path after the function's address (a pasted curl command
// fills the whole form), who it is called as and App Check (rows the Headers
// list shows "set by Call as", removable), the query and headers, the body,
// then Send (⌘↵). The answer streams in as the function writes it, with the
// invocation it made and that invocation's own log lines.

import { Button, DropdownMenu, Input, Select, Text } from '@cloudflare/kumo'
import { CaretDownIcon, FileArrowUpIcon, StopIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ClipboardEvent, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { IdentityPicker } from '@/components/console/identity-picker'
import { KeyValueEditor, rowId } from '@/components/console/key-value-editor'
import { BodyEditor } from '@/components/console/request/body-editor'
import { requestAsCode } from '@/components/console/request/as-code'
import { type HistoryEntry, useRequestHistory } from '@/components/console/request/history'
import { MethodSelect } from '@/components/console/request/method-select'
import { ResponseView } from '@/components/console/request/response-view'
import { SendButton } from '@/components/console/request/send-button'
import type { ResponseRecord } from '@/components/console/request/types'
import { UrlField } from '@/components/console/request/url-field'
import { formatBytes } from '@/lib/format'
import { invocationQuery } from '../api'
import { looksLikeCurl, readCurl } from '../curl-paste'
import {
  type IdentityHeader,
  identityHeaders,
  maskToken,
  useIdentityHeaders,
} from '../identity-headers'
import { httpInvokeCommand } from '../invoke-command'
import {
  bodyHeader,
  composedRequest,
  draftFromInvocation,
  emptyInvokeDraft,
  invokeProblem,
  invokeRequest,
  pathWithQuery,
  sendsBody,
  splitPath,
} from '../invoke-request'
import { createResponseBuilder, invokeFunction, stopWaiting } from '../invoke-stream'
import { type InvokeDraft, useRunDraft } from '../run-drafts'
import { CopyAsMenu, RunAnswer, RunError, RunFooter, SavedMenu } from './run-parts'

const COMMON_HEADERS = [
  'accept',
  'authorization',
  'cache-control',
  'content-type',
  'cookie',
  'origin',
  'user-agent',
  'x-api-key',
  'x-firebase-appcheck',
  'x-request-id',
]

/** One run of the form: what was sent and what came back so far. */
interface Run {
  record?: ResponseRecord | undefined
  started?: InvocationSummary | undefined
  finished?: InvocationSummary | undefined
  error?: { message: string; fix?: string | undefined } | undefined
  streaming: boolean
}

function SetRow({ header, onRemove }: { header: IdentityHeader; onRemove: () => void }) {
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-0.5 pl-1 font-mono text-[12px]"
      data-testid="identity-header"
      data-name={header.name}
    >
      <span className="w-36 shrink-0 truncate text-kumo-subtle">{header.name}</span>
      <span className="min-w-0 flex-1 truncate text-kumo-subtle">{maskToken(header.value)}</span>
      <span className="shrink-0 font-sans text-[11px] text-kumo-subtle">set by {header.setBy}</span>
      <Button
        variant="ghost"
        size="xs"
        shape="square"
        icon={<XIcon />}
        aria-label={`Remove ${header.name}`}
        onClick={onRemove}
      />
    </div>
  )
}

export function InvokeForm({
  project,
  detail,
  url,
  prefill,
  onPrefilled,
  onOpenInvocation,
}: {
  project: string
  detail: FunctionDetail
  /** The function's URL as apps reach it. */
  url: string
  /** Edit and replay: an invocation to fill the draft from, once. */
  prefill?: string | undefined
  onPrefilled: () => void
  onOpenInvocation: (id: string) => void
}) {
  const summary = detail.summary
  const [draft, setDraft] = useRunDraft<InvokeDraft>(project, summary.id, emptyInvokeDraft)
  const [run, setRun] = useState<Run | null>(null)
  const [said, setSaid] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)
  const history = useRequestHistory(`functions:${summary.id}`)
  const identity = useIdentityHeaders(draft.identity, draft.appCheck, project)
  const file = useRef<HTMLInputElement>(null)
  const pathInput = useRef<HTMLDivElement>(null)

  // Edit and replay: the recorded request fills the draft, then the param goes.
  const recorded = useQuery({
    ...invocationQuery(project, prefill ?? ''),
    enabled: prefill !== undefined && project !== '',
  })
  useEffect(() => {
    if (!prefill || !recorded.data) return
    setDraft(draftFromInvocation(recorded.data.detail, draft))
    setSaid({ text: `Filled from invocation #${recorded.data.detail.summary.seq}.`, tone: 'info' })
    onPrefilled()
    // Once per prefill: the draft it writes must not run it again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, recorded.data])

  // Focus the path when the tab opens from the toolbar (`i`).
  useEffect(() => {
    pathInput.current?.querySelector('input')?.focus()
  }, [])

  const update = (patch: Partial<InvokeDraft>) => setDraft({ ...draft, ...patch })
  const problem = invokeProblem(draft)
  const contentType = bodyHeader(draft)

  const send = async () => {
    if (problem) return
    const at = new Date().toISOString()
    const builder = createResponseBuilder(at)
    setRun({ streaming: true })
    setSaid(null)
    let headers: IdentityHeader[]
    try {
      headers = await identityHeaders(draft.identity, draft.appCheck, project)
    } catch (error) {
      setRun({
        streaming: false,
        error: {
          message: error instanceof Error ? error.message : 'Could not get a token for Call as.',
        },
      })
      return
    }
    history.push(composedRequest(draft, url, headers))
    try {
      const outcome = await invokeFunction(summary.id, invokeRequest(draft, headers), {
        onFrame: (frame) => {
          const record = builder.apply(frame)
          setRun((current) => ({
            ...current,
            streaming: frame.frame !== 'finished' && frame.frame !== 'failed',
            record,
            ...(frame.frame === 'started' ? { started: frame.invocation } : {}),
            ...(frame.frame === 'finished' ? { finished: frame.invocation } : {}),
          }))
        },
      })
      setRun((current) => ({
        ...current,
        streaming: false,
        ...(outcome.failed ? { error: { message: outcome.failed } } : {}),
        ...(outcome.stopped && !outcome.finished
          ? {
              error: {
                message:
                  'Stopped waiting. The call goes on in the engine; its result arrives in the list.',
              },
            }
          : {}),
      }))
    } catch (error) {
      setRun({
        streaming: false,
        error:
          error instanceof ApiError
            ? { message: error.message, fix: error.fix }
            : { message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text')
    if (!looksLikeCurl(text)) return
    event.preventDefault()
    try {
      const pasted = readCurl(text, url)
      const { path, query } = splitPath(pasted.path)
      update({
        method: (pasted.method as InvokeDraft['method']) ?? draft.method,
        path,
        query,
        headers: pasted.headers
          .filter(
            (header) => header.key.toLowerCase() !== 'content-type' || pasted.body.kind === 'text',
          )
          .map((header) => ({ id: rowId(), key: header.key, value: header.value, enabled: true })),
        body: pasted.body,
      })
      setSaid({ text: pasted.said, tone: 'info' })
    } catch (error) {
      setSaid({ text: error instanceof Error ? error.message : String(error), tone: 'error' })
    }
  }

  const resolved = identity.data ?? []
  const composed = composedRequest(draft, url, resolved)
  const cli = httpInvokeCommand({
    name: summary.name,
    region: summary.region,
    method: draft.method,
    path: draft.path,
    hasBody: sendsBody(draft.method, draft.body),
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="invoke-form">
      <div className="grid shrink-0 gap-3 px-5 py-3">
        <div className="grid gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <MethodSelect
              value={draft.method}
              onChange={(method) =>
                update({
                  method,
                  body:
                    method === 'GET' || method === 'HEAD'
                      ? draft.body
                      : draft.body.kind === 'none'
                        ? { kind: 'json', text: '{}' }
                        : draft.body,
                })
              }
            />
            <div
              ref={pathInput}
              className="min-w-0 flex-1"
              onPasteCapture={onPaste}
              onBlurCapture={() => {
                if (!draft.path.includes('?')) return
                const { path, query } = splitPath(draft.path)
                update({ path, query: [...draft.query, ...query] })
              }}
            >
              <UrlField
                prefix={url}
                value={draft.path}
                onChange={(path) => update({ path })}
                onEnter={() => void send()}
                placeholder="/path?query, or paste a curl command"
                testId="invoke-path"
              />
            </div>
          </div>
          <span
            className="truncate font-mono text-[11px] text-kumo-subtle"
            data-testid="invoke-resolved"
          >
            {url}
            {pathWithQuery(draft) === '/' ? '' : pathWithQuery(draft)}
          </span>
          {said && (
            <Text size="xs" variant={said.tone === 'error' ? 'error' : 'secondary'}>
              {said.text}
            </Text>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <IdentityPicker
            project={project}
            value={draft.identity}
            onChange={(next) => update({ identity: next })}
            ownerLabel="No auth"
            testId="invoke-call-as"
          />
          <Select
            size="sm"
            aria-label="App Check"
            value={draft.appCheck.kind}
            onValueChange={(next) =>
              update({ appCheck: next === 'app' ? { kind: 'app', appId: '' } : { kind: 'none' } })
            }
            items={[
              { value: 'none', label: 'No App Check' },
              { value: 'app', label: 'App Check token' },
            ]}
            className="w-40 shrink-0"
          />
          {draft.appCheck.kind === 'app' && (
            <Input
              size="sm"
              className="min-w-0 flex-1 font-mono"
              value={draft.appCheck.appId}
              onChange={(event) => update({ appCheck: { kind: 'app', appId: event.target.value } })}
              placeholder="1:123:web:abc"
              aria-label="App id"
              spellCheck={false}
            />
          )}
        </div>
        <KeyValueEditor
          label="Query"
          rows={draft.query}
          onChange={(query) => update({ query })}
          keyPlaceholder="name"
          allowDisable
          testId="invoke-query"
        />
        <div className="grid gap-1">
          <KeyValueEditor
            label="Headers"
            rows={draft.headers}
            onChange={(headers) => update({ headers })}
            keyPlaceholder="header"
            suggestKeys={COMMON_HEADERS}
            allowDisable
            testId="invoke-headers"
          />
          {resolved.map((header) => (
            <SetRow
              key={header.name}
              header={header}
              onRemove={() =>
                header.name === 'authorization'
                  ? update({ identity: { kind: 'owner' } })
                  : update({ appCheck: { kind: 'none' } })
              }
            />
          ))}
          {contentType && (
            <div className="flex min-w-0 items-center gap-2 py-0.5 pl-1 font-mono text-[12px]">
              <span className="w-36 shrink-0 text-kumo-subtle">content-type</span>
              <span className="min-w-0 flex-1 truncate text-kumo-subtle">{contentType}</span>
              <span className="shrink-0 font-sans text-[11px] text-kumo-subtle">
                set by the body
              </span>
              <span className="size-[21px] shrink-0" />
            </div>
          )}
        </div>
        <div className="grid gap-1.5">
          <BodyEditor
            value={draft.body}
            onChange={(body) => update({ body })}
            kinds={['none', 'json', 'text', 'base64']}
            testId="invoke-body"
          />
          {draft.body.kind === 'base64' && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<FileArrowUpIcon />}
                onClick={() => file.current?.click()}
              >
                Choose file
              </Button>
              <span className="text-[12px] text-kumo-subtle">The file is sent as its bytes.</span>
              <input
                ref={file}
                type="file"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(event) => {
                  const chosen = event.target.files?.[0]
                  event.target.value = ''
                  if (!chosen) return
                  void chosen.arrayBuffer().then((buffer) => {
                    const bytes = new Uint8Array(buffer)
                    let binary = ''
                    for (let at = 0; at < bytes.length; at += 0x8000)
                      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
                    update({
                      body: { kind: 'base64', text: btoa(binary) },
                      headers: draft.headers.some((row) => row.key.toLowerCase() === 'content-type')
                        ? draft.headers
                        : [
                            ...draft.headers,
                            {
                              id: rowId(),
                              key: 'content-type',
                              value: chosen.type || 'application/octet-stream',
                              enabled: true,
                            },
                          ],
                    })
                    setSaid({
                      text: `Body: ${chosen.name}, ${formatBytes(chosen.size)}.`,
                      tone: 'info',
                    })
                  })
                }}
              />
            </div>
          )}
        </div>
        {problem && (
          <Text size="xs" variant="error">
            {problem}
          </Text>
        )}
      </div>
      <RunFooter
        tools={
          <>
            <HistoryDropdown
              entries={history.entries}
              onPick={(entry) =>
                update({
                  method: entry.method,
                  path: entry.codeUrl.startsWith(url)
                    ? entry.codeUrl.slice(url.length) || '/'
                    : draft.path,
                  query: entry.query.map((pair) => Object.assign({}, pair, { id: rowId() })),
                  headers: entry.headers
                    .filter(
                      (pair) => pair.key !== 'authorization' && pair.key !== 'x-firebase-appcheck',
                    )
                    .map((pair) => Object.assign({}, pair, { id: rowId() })),
                  body: entry.body,
                })
              }
            />
            <SavedMenu
              project={project}
              functionId={summary.id}
              kind="request"
              current={() => draft}
              onLoad={(test) => test.draft.kind === 'request' && setDraft(test.draft)}
            />
            <CopyAsMenu
              dialects={[
                { id: 'curl', label: 'curl', text: requestAsCode(composed, 'curl', project) },
                { id: 'fetch', label: 'fetch', text: requestAsCode(composed, 'fetch', project) },
                'command' in cli
                  ? { id: 'cli', label: 'firenook functions:invoke', text: cli.command }
                  : { id: 'cli', label: 'firenook functions:invoke', refused: cli.refused },
              ]}
            />
          </>
        }
        primary={
          <>
            {run?.streaming && (
              <Button
                variant="ghost"
                size="sm"
                icon={<StopIcon />}
                onClick={stopWaiting}
                data-testid="invoke-stop"
              >
                Stop waiting
              </Button>
            )}
            <SendButton
              onSend={() => void send()}
              pending={run?.streaming ?? false}
              disabled={problem !== undefined}
              testId="invoke-send"
            />
          </>
        }
      />
      {run && (
        <RunAnswer
          project={project}
          invocation={run.started}
          finished={run.finished}
          onOpen={onOpenInvocation}
          outcome={false}
        >
          {run.error && <RunError message={run.error.message} fix={run.error.fix} />}
          {run.record && (
            <ResponseView response={run.record} pending={run.streaming} testId="invoke-response" />
          )}
        </RunAnswer>
      )}
    </div>
  )
}

/** History ▾: the last sends from this form, newest first, to load again. */
function HistoryDropdown({
  entries,
  onPick,
}: {
  entries: readonly HistoryEntry[]
  onPick: (entry: HistoryEntry) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" size="sm" data-testid="invoke-history">
            <span className="flex items-center gap-1">
              History
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content align="start" className="w-80">
        {entries.length === 0 && (
          <div className="px-2 py-1.5 text-[12px] text-kumo-subtle">
            Nothing sent from here yet.
          </div>
        )}
        {entries.map((entry) => (
          <DropdownMenu.Item
            key={entry.sentAt}
            onClick={() => onPick(entry)}
            className="items-start"
          >
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate font-mono text-[12px]">
                {entry.method}{' '}
                {entry.codeUrl.replace(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/[^/]+/, '') || '/'}
              </span>
              <span className="text-[12px] text-kumo-subtle">
                {new Date(entry.sentAt).toLocaleTimeString()}
              </span>
            </span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
