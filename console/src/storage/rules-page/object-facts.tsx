// A file as the rules saw it — the object before a request, or the one an
// upload or a metadata change proposed — as a decision's detail and the
// playground's result show it: what rules usually check first (size, type,
// metadata), the keys a change touched marked, the rest after.

import { Text } from '@cloudflare/kumo'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import { formatBytes, formatNumber } from '@/lib/format'
import { Mono, Term } from '@/rules/decision-parts'

/** A byte count as a person reads it, with the exact figure rules compare. */
export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${formatBytes(bytes)} · ${formatNumber(bytes)} bytes`
}

export function ObjectFacts({
  object,
  changed,
  absent,
  testId,
}: {
  /** Null: the file did not exist. */
  object: StorageRulesObjectView | null
  /** Custom metadata keys the change added, removed or changed. */
  changed?: readonly string[] | null | undefined
  /** What to say when there is no file. */
  absent: string
  testId?: string | undefined
}) {
  if (object === null)
    return (
      <Text size="sm" variant="secondary">
        {absent}
      </Text>
    )
  const touched = new Set(changed ?? [])
  const metadata = Object.entries(object.metadata).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )
  const removed = [...touched].filter((key) => !(key in object.metadata)).toSorted()
  return (
    <dl
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]"
      data-testid={testId}
    >
      <Term>size</Term>
      <Mono>{sizeText(object.size)}</Mono>
      <Term>contentType</Term>
      <Mono>{object.contentType ?? 'none'}</Mono>
      {object.contentEncoding && (
        <>
          <Term>contentEncoding</Term>
          <Mono>{object.contentEncoding}</Mono>
        </>
      )}
      {object.contentDisposition && (
        <>
          <Term>contentDisposition</Term>
          <Mono>{object.contentDisposition}</Mono>
        </>
      )}
      {metadata.map(([key, value]) => (
        <span key={key} className="contents" data-changed={touched.has(key) || undefined}>
          <Term>
            <span className="font-mono">metadata.{key}</span>
            {touched.has(key) && <span className="ml-1.5 text-kumo-warning">changed</span>}
          </Term>
          <Mono>{value}</Mono>
        </span>
      ))}
      {removed.map((key) => (
        <span key={key} className="contents" data-changed>
          <Term>
            <span className="font-mono">metadata.{key}</span>
            <span className="ml-1.5 text-kumo-warning">removed</span>
          </Term>
          <Mono>—</Mono>
        </span>
      ))}
      <Term>generation</Term>
      <Mono>
        {object.generation} · metageneration {object.metageneration}
      </Mono>
      <Term>updated</Term>
      <Mono>{object.updated}</Mono>
    </dl>
  )
}
