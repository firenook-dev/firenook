// One side of an invocation's exchange as it was kept: the request (its
// method and path, headers, body) or the response (its status, headers,
// body). Sensitive header values never leave the engine in a detail; each
// is a masked value revealed through the engine's reveal route on demand.
// A body longer than the 256 KB kept says so and downloads whole as kept.

import { Button, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon } from '@phosphor-icons/react'
import type { FunctionBody } from '@/api/generated/compute/FunctionBody'
import type { FunctionHeader } from '@/api/generated/compute/FunctionHeader'
import type { InvocationDetail } from '@/api/generated/compute/InvocationDetail'
import { JsonView } from '@/components/console/json-view'
import { type KeyValueItem, KeyValueList } from '@/components/console/key-value-list'
import { PayloadView } from '@/components/console/payload-view'
import { InspectorSection } from '@/components/console/inspector'
import { download } from '@/lib/download'
import { formatBytes } from '@/lib/format'
import { invocationBodyUrl, revealHeader } from '../api'

/** A header list as facts: a sensitive one masked, revealed through the engine. */
export function headerItems(
  invocation: string,
  headers: readonly FunctionHeader[],
): KeyValueItem[] {
  return headers.map((header, index) =>
    header.sensitive || header.value === null
      ? {
          label: header.name,
          value: '',
          masked: true,
          reveal: (signal: AbortSignal) => revealHeader(invocation, header.name, signal),
          testId: `header-${header.name.toLowerCase()}-${index}`,
        }
      : {
          label: header.name,
          value: header.value,
          copy: header.value,
          testId: `header-${header.name.toLowerCase()}-${index}`,
        },
  )
}

/** A kept body's JSON value, when it is JSON and kept whole. */
export function bodyJson(
  body: FunctionBody,
  contentType: string | null,
): { value: unknown } | undefined {
  if (body.encoding !== 'text' || body.truncated) return undefined
  const looks = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(body.text)
  if (!looks) return undefined
  try {
    return { value: JSON.parse(body.text) as unknown }
  } catch {
    return undefined
  }
}

function Body({
  invocation,
  part,
  body,
  contentType,
}: {
  invocation: string
  part: 'request' | 'response'
  body: FunctionBody
  contentType: string | null
}) {
  if (body.encoding === 'empty' || body.size === 0)
    return <InspectorSection title="Body" count={0} testId={`${part}-body`} />
  const json = bodyJson(body, contentType)
  const meta = [contentType, formatBytes(body.size)].filter(Boolean).join(' · ')
  return (
    <InspectorSection
      title="Body"
      testId={`${part}-body`}
      action={
        <Button
          variant="ghost"
          size="xs"
          icon={<DownloadSimpleIcon />}
          onClick={() => void download(invocationBodyUrl(invocation, part))}
          data-testid={`${part}-download`}
        >
          Download
        </Button>
      }
    >
      <div className="grid gap-1.5">
        <span className="font-mono text-[11px] text-kumo-subtle">{meta}</span>
        {body.truncated && (
          <Text size="xs" variant="secondary">
            The first 256 KB of this {formatBytes(body.size)} body were kept; Download has what was
            kept.
          </Text>
        )}
        {json ? (
          <div className="overflow-hidden rounded-md ring ring-kumo-line">
            <JsonView value={json.value} text={body.text} height="content" raw={false} />
          </div>
        ) : (
          <div className="flex max-h-96 min-h-0 overflow-hidden rounded-md ring ring-kumo-line">
            {body.encoding === 'base64' ? (
              <PayloadView
                base64={body.text}
                contentType={contentType ?? undefined}
                filename={`${part}.bin`}
              />
            ) : (
              <PayloadView text={body.text} contentType={contentType ?? undefined} />
            )}
          </div>
        )}
      </div>
    </InspectorSection>
  )
}

export function RequestView({
  detail,
  part,
}: {
  detail: InvocationDetail
  part: 'request' | 'response'
}) {
  const id = detail.summary.id
  if (part === 'request') {
    const request = detail.request
    return (
      <div className="flex flex-col" data-testid="invocation-request">
        <InspectorSection
          title={request.target === 'url' ? 'Request' : 'Delivered to the trigger route'}
        >
          <p className="m-0 font-mono text-[12px] [overflow-wrap:anywhere] text-kumo-default">
            <span className="text-kumo-subtle">{request.method}</span> {request.path}
          </p>
        </InspectorSection>
        <InspectorSection title="Headers" count={request.headers.length} testId="request-headers">
          <KeyValueList items={headerItems(id, request.headers)} />
        </InspectorSection>
        <Body
          invocation={id}
          part="request"
          body={request.body}
          contentType={request.contentType}
        />
      </div>
    )
  }
  const response = detail.response
  if (!response)
    return (
      <div className="px-5 py-3" data-testid="invocation-response">
        <Text size="sm" variant="secondary">
          {detail.summary.outcome === null ? 'No answer yet.' : 'The function gave no answer.'}
        </Text>
      </div>
    )
  return (
    <div className="flex flex-col" data-testid="invocation-response">
      <InspectorSection title="Response">
        <p className="m-0 font-mono text-[12px] text-kumo-default">
          {response.status}
          {response.streaming && (
            <span className="font-sans text-[12px] text-kumo-subtle">
              {' '}
              · streamed in {response.chunks} chunks
            </span>
          )}
          {response.clientGone && (
            <span className="font-sans text-[12px] text-kumo-subtle">
              {' '}
              · the caller stopped reading
            </span>
          )}
        </p>
      </InspectorSection>
      <InspectorSection title="Headers" count={response.headers.length} testId="response-headers">
        <KeyValueList items={headerItems(id, response.headers)} />
      </InspectorSection>
      <Body
        invocation={id}
        part="response"
        body={response.body}
        contentType={response.contentType}
      />
    </div>
  )
}
