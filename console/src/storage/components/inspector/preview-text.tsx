// Text, JSON, code, CSV and HTML: the first 256 KB (decoded first when the
// object is gzip-encoded), highlighted in its language, with "Load all" up to
// 16 MB; JSON also as a tree, CSV as a table, HTML rendered with scripts
// off. A UTF-8 file of at most 1 MB can be edited in place: the inspector's
// Save writes the new bytes as one upload, keeping the metadata.

import { Button, Tabs, Tooltip } from '@cloudflare/kumo'
import { CornersOutIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { CodeEditor } from '@/components/code-editor'
import { JsonTree } from '@/components/console/json-tree'
import { formatBytes } from '@/lib/format'
import { type PreviewKind, decodeText, languageOf, trimPartialCharacter } from '../../content'
import { EDIT_LIMIT, TEXT_ALL, TEXT_HEAD, readHead } from '../../media'
import { ST } from '../../queries'
import { PreviewCsv } from './preview-csv'
import { PreviewHex } from './preview-hex'
import { PreviewHtml } from './preview-html'

/** Editing in place, when the inspector offers it. */
export interface TextEdit {
  /** The text being edited; `undefined` while reading. */
  draft: string | undefined
  /** Start (the text), change, or stop (`undefined`) editing. */
  onDraft: (text: string | undefined) => void
}

/** Why a file cannot be edited in place, or `undefined` when it can. */
export function editBlocked(object: StorageObjectDetail): string | undefined {
  if (object.contentEncoding === 'gzip')
    return 'Stored gzip-encoded; editing would need re-encoding.'
  if (object.size > EDIT_LIMIT)
    return 'Only files up to 1 MB are edited here; download it to change it.'
  return undefined
}

function textQuery(project: string, object: StorageObjectDetail, limit: number) {
  return {
    queryKey: [ST, project, object.bucket, 'text', object.name, object.generation, limit],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      readHead({ ...object, gzip: object.contentEncoding === 'gzip' }, limit, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  } as const
}

export function PreviewText({
  object,
  project,
  kind,
  large = false,
  edit,
  onQuickLook,
}: {
  object: StorageObjectDetail
  project: string
  kind: Extract<PreviewKind, 'text' | 'json' | 'csv' | 'html'>
  large?: boolean
  edit?: TextEdit | undefined
  onQuickLook?: (() => void) | undefined
}) {
  const queryClient = useQueryClient()
  const [limit, setLimit] = useState(TEXT_HEAD)
  const head = useQuery(textQuery(project, object, limit))
  const [view, setView] = useState<'text' | 'tree' | 'table' | 'rendered'>(
    kind === 'csv' ? 'table' : 'text',
  )
  const [formatted, setFormatted] = useState(false)
  const [starting, setStarting] = useState(false)

  if (head.isError) return <p className="text-[13px] text-kumo-danger">{head.error.message}</p>
  if (!head.data)
    return <div className={`animate-pulse rounded-md bg-kumo-tint ${large ? 'h-full' : 'h-40'}`} />
  const { bytes, complete } = head.data
  const decoded = decodeText(complete ? bytes : trimPartialCharacter(bytes))
  // Bytes that are not text read as bytes.
  if (!decoded.valid)
    return (
      <div className="grid gap-1.5">
        <span className="text-[12px] text-kumo-subtle">
          These bytes are not valid UTF-8 text, so they are shown as bytes.
        </span>
        <PreviewHex object={object} project={project} large={large} />
      </div>
    )
  const text = decoded.text
  let parsed: unknown
  let parses = false
  if (kind === 'json' && complete)
    try {
      parsed = JSON.parse(text)
      parses = true
    } catch {
      parses = false
    }
  const editing = edit?.draft !== undefined
  const blocked = editBlocked(object)
  const shown = editing
    ? (edit?.draft ?? '')
    : formatted && parses
      ? JSON.stringify(parsed, null, 2)
      : text
  const views =
    kind === 'json'
      ? [
          { value: 'text', label: 'Text' },
          { value: 'tree', label: 'Tree' },
        ]
      : kind === 'csv'
        ? [
            { value: 'table', label: 'Table' },
            { value: 'text', label: 'Text' },
          ]
        : kind === 'html'
          ? [
              { value: 'text', label: 'Source' },
              { value: 'rendered', label: 'Rendered' },
            ]
          : []
  const startEditing = async () => {
    if (!edit) return
    if (complete) {
      edit.onDraft(text)
      return
    }
    setStarting(true)
    try {
      const whole = await queryClient.fetchQuery(textQuery(project, object, EDIT_LIMIT))
      edit.onDraft(decodeText(whole.bytes).text)
    } finally {
      setStarting(false)
    }
  }

  let body: ReactNode
  if (view === 'tree' && kind === 'json' && !editing)
    body = parses ? (
      <JsonTree
        value={parsed}
        defaultDepth={2}
        height={large ? 'fill' : 320}
        ariaLabel="The JSON as a tree"
        testId="preview-json-tree"
      />
    ) : (
      <p className="text-[13px] text-kumo-subtle">
        {complete
          ? 'This is not valid JSON, so it has no tree; the text shows where it breaks.'
          : 'Only the first part is loaded, which is not a whole document; load all to see it as a tree.'}
      </p>
    )
  else if (view === 'table' && kind === 'csv' && !editing)
    body = (
      <PreviewCsv
        text={text}
        separator={
          object.contentType?.includes('tab-separated') || object.name.endsWith('.tsv') ? '\t' : ','
        }
        large={large}
      />
    )
  else if (view === 'rendered' && kind === 'html' && !editing)
    body = <PreviewHtml text={text} large={large} />
  else
    body = (
      <CodeEditor
        value={shown}
        onChange={(next) => {
          if (editing) edit?.onDraft(next)
        }}
        language={languageOf(object.contentType, object.name)}
        readOnly={!editing}
        ariaLabel={editing ? `Edit ${object.name}` : `The text of ${object.name}`}
        testId="preview-text"
      />
    )

  return (
    <div
      className={`grid min-h-0 gap-1.5 ${large ? 'h-full grid-rows-[auto_minmax(0,1fr)_auto]' : ''}`}
    >
      <div className="flex min-h-7 items-center gap-2">
        {views.length > 0 && !editing && (
          <Tabs
            size="sm"
            variant="segmented"
            value={view}
            onValueChange={(next) => setView(next as typeof view)}
            tabs={views}
          />
        )}
        <span className="ml-auto flex items-center gap-1">
          {kind === 'json' && (view === 'text' || editing) && (
            <Button
              variant="ghost"
              size="xs"
              disabled={editing ? false : !parses}
              aria-pressed={!editing && formatted}
              onClick={() => {
                if (editing) {
                  try {
                    edit?.onDraft(JSON.stringify(JSON.parse(edit.draft ?? ''), null, 2))
                  } catch {
                    // Not JSON yet: nothing to format.
                  }
                } else setFormatted((value) => !value)
              }}
              data-testid="preview-format"
            >
              Format
            </Button>
          )}
          {edit && !editing && (
            <Tooltip
              content={
                blocked ??
                'Edit the text here; Save writes it as a new generation, and your onObjectFinalized triggers run.'
              }
              render={
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<PencilSimpleIcon />}
                    disabled={blocked !== undefined}
                    loading={starting}
                    onClick={() => void startEditing()}
                    data-testid="preview-edit"
                  >
                    Edit
                  </Button>
                </span>
              }
            />
          )}
          {editing && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => edit?.onDraft(undefined)}
              data-testid="preview-edit-stop"
            >
              Stop editing
            </Button>
          )}
          {onQuickLook && (
            <Tooltip
              content="Quick Look (Shift+Space)"
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  shape="square"
                  icon={<CornersOutIcon />}
                  aria-label="Quick Look"
                  onClick={onQuickLook}
                />
              }
            />
          )}
        </span>
      </div>
      <div
        className={`flex min-h-0 flex-col ${large ? 'h-full' : ''}`}
        // A short text takes the room it needs; a long one scrolls in 320 px.
        style={
          !large && (view === 'text' || editing)
            ? { height: Math.min(320, Math.max(96, shown.split('\n').length * 20 + 16)) }
            : undefined
        }
      >
        {body}
      </div>
      <span className="text-[11px] text-kumo-subtle" data-testid="preview-text-extent">
        {object.contentEncoding === 'gzip' ? 'Stored gzip-encoded · ' : ''}
        {complete ? (
          `Showing all ${formatBytes(bytes.length)}${object.contentEncoding === 'gzip' ? ' decoded' : ''}`
        ) : (
          <>
            Showing the {object.contentEncoding === 'gzip' ? 'decoded ' : ''}first{' '}
            {formatBytes(bytes.length)}
            {object.contentEncoding === 'gzip' ? '' : ` of ${formatBytes(object.size)}`}
            {limit < TEXT_ALL && (object.contentEncoding === 'gzip' || object.size <= TEXT_ALL) && (
              <>
                {' · '}
                <button
                  type="button"
                  className="rounded-sm text-kumo-link hover:underline focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
                  onClick={() => setLimit(TEXT_ALL)}
                  data-testid="preview-load-all"
                >
                  Load all
                </button>
              </>
            )}
          </>
        )}
      </span>
    </div>
  )
}
