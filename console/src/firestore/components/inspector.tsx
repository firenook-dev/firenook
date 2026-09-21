// The inspector: the selected document in full. Typed editors per field,
// the JSON view, subcollections with counts, save and delete. It is a
// detail view; getting around happens in the path bar and the grid.

import {
  Badge,
  Button,
  InlineCopyText,
  Popover,
  Text,
  Tooltip,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  CodeIcon,
  CopyIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { statusQuery } from '@/api/queries'
import { useMemo, useState } from 'react'
import { useCreateDialog } from '../create'
import { type CodeTarget, EMPTY_QUERY, documentAsCode } from '../query'
import { collectionsQuery, countQueryOptions, documentQuery } from '../queries'
import { type WriteOperation, commit, documentRoot } from '../rest'
import {
  type FsDocument,
  type FsValue,
  type RestValue,
  encodeValue,
  parseEditorText,
  relativeTime,
} from '../value'
import { CodeBlock, firestoreOrigin } from './code-popover'
import { type FieldDraft, FieldsPanel, draftsFrom, toJsonValue } from './field-editor'
import { useWorkbench } from './workbench-context'

/** The inspector's width plus the gap before it, px; the grid uses it to know what it covers. */
export const INSPECTOR_WIDTH = 420 + 12

export function Inspector({ path, onDelete }: { path: string; onDelete: (path: string) => void }) {
  const workbench = useWorkbench()
  const document = useQuery(documentQuery(workbench.scope, path))
  const subcollections = useQuery(collectionsQuery(workbench.ownerScope, path))

  return (
    <aside
      className="flex min-h-0 w-[420px] shrink-0 flex-col rounded-lg bg-kumo-base ring ring-kumo-line"
      data-testid="inspector"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line pr-1 pl-3">
        <InlineCopyText
          value={path}
          variant="mono"
          className="min-w-0 flex-1 truncate text-[12px]"
          title={path}
        >
          {path}
        </InlineCopyText>
        {document.data?.updateTime && (
          <span title={`Updated ${document.data.updateTime}`}>
            <Badge variant="neutral">{relativeTime(document.data.updateTime)}</Badge>
          </span>
        )}
        {parentCollection(path) !== workbench.collectionPath && (
          <Tooltip
            content={`Open ${parentCollection(path)} in the grid`}
            render={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<ArrowSquareOutIcon />}
                aria-label="Open this document's collection in the grid"
                onClick={() => workbench.setPath(path)}
                data-testid="open-in-grid"
              />
            }
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<XIcon />}
          aria-label="Close the document"
          onClick={() => workbench.selectDocument(undefined)}
        />
      </header>
      {document.isPending ? (
        <div className="p-4">
          <Text variant="secondary">Loading…</Text>
        </div>
      ) : document.isError ? (
        <div className="p-4">
          <Text variant="error">{document.error.message}</Text>
        </div>
      ) : document.data === null ? (
        <MissingDocument path={path} subcollections={subcollections.data ?? []} />
      ) : (
        <DocumentEditor
          key={`${path}:${document.data.updateTime ?? ''}`}
          document={document.data}
          onDelete={onDelete}
        />
      )}
      {document.data !== null && <Subcollections parent={path} ids={subcollections.data ?? []} />}
    </aside>
  )
}

function MissingDocument({ path, subcollections }: { path: string; subcollections: string[] }) {
  const openCreate = useCreateDialog((state) => state.open)
  const collection = parentCollection(path)
  const id = path.split('/').at(-1) ?? path
  return (
    <div className="grid gap-3 p-4">
      <Text variant="heading" as="h3">
        No document here
      </Text>
      <Text variant="secondary">
        {subcollections.length > 0
          ? 'Nothing was ever written at this path, but it has subcollections; Firestore shows it in italics for the same reason.'
          : 'Nothing was ever written at this path.'}
      </Text>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<PlusIcon />}
          onClick={() => openCreate({ kind: 'document', collection, id })}
        >
          Create the document
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<FolderIcon />}
          onClick={() => openCreate({ kind: 'collection', parent: path })}
        >
          Add a subcollection
        </Button>
      </div>
      <Subcollections parent={path} ids={subcollections} />
    </div>
  )
}

function Subcollections({ parent, ids }: { parent: string; ids: string[] }) {
  const workbench = useWorkbench()
  const openCreate = useCreateDialog((state) => state.open)
  return (
    <div className="shrink-0 border-t border-kumo-line px-3 py-2" data-testid="subcollections">
      <div className="mb-1 flex items-center">
        <Text variant="secondary" size="sm" as="p">
          Subcollections{ids.length > 0 ? ` · ${ids.length}` : ''}
        </Text>
        <span className="ml-auto">
          <Tooltip
            content="Add a subcollection under this document"
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<PlusIcon />}
                aria-label="Add a subcollection"
                onClick={() => openCreate({ kind: 'collection', parent })}
                data-testid="add-subcollection"
              />
            }
          />
        </span>
      </div>
      {ids.length === 0 && (
        <Text variant="secondary" size="sm">
          None yet.
        </Text>
      )}
      <ul className="grid gap-0.5">
        {ids.map((id) => (
          <li key={id}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-kumo-tint"
              onClick={() => workbench.setPath(`${parent}/${id}`)}
            >
              <FolderIcon size={14} className="text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{id}</span>
              <SubcollectionCount path={`${parent}/${id}`} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SubcollectionCount({ path }: { path: string }) {
  const workbench = useWorkbench()
  const count = useQuery(countQueryOptions(workbench.ownerScope, path, false, EMPTY_QUERY))
  return (
    <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
      {count.data ? count.data.count.toLocaleString('en-US') : ''}
    </span>
  )
}

function DocumentEditor({
  document,
  onDelete,
}: {
  document: FsDocument
  onDelete: (path: string) => void
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const status = useQuery(statusQuery)
  const openCreate = useCreateDialog((state) => state.open)
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => draftsFrom(document))
  const [removed, setRemoved] = useState<string[]>([])
  const [codeTarget, setCodeTarget] = useState<CodeTarget>('web')

  const dirty = removed.length > 0 || drafts.some((draft) => draft.dirty)
  const root = documentRoot(workbench.scope)

  const save = useMutation({
    mutationFn: async () => {
      const fields: Record<string, ReturnType<typeof encodeValue>> = {}
      const mask: string[] = [...removed]
      const next = drafts.map((draft) => ({ ...draft }))
      let failed = false
      for (const draft of next) {
        if (!draft.dirty) continue
        const parsed = parseEditorText(draft.type, draft.text)
        if (!parsed.ok) {
          draft.error = parsed.error
          failed = true
          continue
        }
        fields[draft.name] = encodeValue(parsed.value, root)
        mask.push(draft.name)
      }
      if (failed) {
        setDrafts(next)
        throw new Error('Fix the highlighted fields')
      }
      const operation: WriteOperation = {
        update: { path: document.path, fields, mask: mask.map(quote), exists: true },
      }
      await commit(workbench.scope, [operation])
      return mask.length
    },
    onSuccess: (count) => {
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
      toasts.add({
        title: 'Document saved',
        description: `${document.path} · ${count} field${count === 1 ? '' : 's'}`,
        variant: 'success',
      })
    },
  })

  const forCode = useMemo(() => {
    const plain: Record<string, unknown> = {}
    const rest: Record<string, RestValue> = {}
    for (const draft of drafts) {
      const parsed = parseEditorText(draft.type, draft.text)
      const value: FsValue = parsed.ok ? parsed.value : { type: 'string', value: draft.text }
      plain[draft.name] = toJsonValue(value)
      rest[draft.name] = encodeValue(value, root)
    }
    return { json: plain, rest }
  }, [drafts, root])

  return (
    <>
      <FieldsPanel
        drafts={drafts}
        onDraftsChange={(next) => {
          setDrafts(next)
          // A field brought back by JSON is no longer removed.
          setRemoved((previous) => previous.filter((name) => !next.some((d) => d.name === name)))
        }}
        removed={removed}
        onRemoved={(names) => setRemoved((previous) => [...new Set([...previous, ...names])])}
        tab={workbench.tab}
        onTabChange={workbench.setTab}
        onOpenReference={(path) => workbench.selectDocument(path)}
      />
      <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-kumo-line px-3">
        <Button
          variant="primary"
          size="sm"
          onClick={() => save.mutate()}
          disabled={!dirty}
          loading={save.isPending}
          data-testid="save-document"
        >
          Save
        </Button>
        {save.isError && (
          <Text variant="error" size="sm" truncate>
            {save.error.message}
          </Text>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Popover>
            <Popover.Trigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<CodeIcon />}
                  aria-label="Copy this document as code"
                >
                  Code
                </Button>
              }
            />
            <Popover.Content className="w-[560px] max-w-[calc(100vw-2rem)]">
              <CodeBlock
                title="This document as code"
                target={codeTarget}
                setTarget={setCodeTarget}
                code={documentAsCode(codeTarget, document.path, forCode.json, forCode.rest, {
                  project: workbench.project,
                  database: workbench.database,
                  origin: firestoreOrigin(status.data?.services),
                })}
              />
            </Popover.Content>
          </Popover>
          <Tooltip
            content="New document with these fields"
            render={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<CopyIcon />}
                aria-label="Duplicate this document"
                onClick={() =>
                  openCreate({
                    kind: 'document',
                    collection: document.collection,
                    template: document,
                  })
                }
                data-testid="duplicate-document"
              />
            }
          />
          <Button
            variant="secondary-destructive"
            size="sm"
            icon={<TrashIcon />}
            onClick={() => onDelete(document.path)}
            aria-label="Delete this document"
          >
            Delete
          </Button>
        </div>
      </footer>
    </>
  )
}

function quote(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, '\\`')}\``
}

function parentCollection(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}
