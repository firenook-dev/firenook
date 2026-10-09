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
import { PanelTitle } from '@/components/kit'
import { useMemo, useState } from 'react'
import { useCreateDialog } from '../create'
import { type CodeTarget, documentAsCode } from '../query'
import { documentQuery } from '../queries'
import { commit, documentRoot, quoteFieldSegment } from '../rest'
import { clampWidth, INSPECTOR_MIN, useInspectorWidth } from './inspector-width'
import { type Subcollection, subcollectionsQuery } from '../subcollections'
import {
  type DraftNode,
  diffDocument,
  nodesFrom,
  parseNode,
  problemsOf,
  toJsonValue,
} from '../draft'
import { type FsDocument, type FsValue, type RestValue, encodeValue, relativeTime } from '../value'
import { CodeBlock, firestoreOrigin } from './code-popover'
import { FieldsPanel } from './field-editor'
import { useKnownFields } from './known-fields'
import { useWorkbench } from './workbench-context'

/**
 * The panel's left edge, which is also the grip for its width. A hairline
 * at rest that lights under the pointer: the edge is already there, so the
 * control is a place rather than a thing added to the panel.
 */
function WidthHandle() {
  const { width, setWidth, remember, reset } = useInspectorWidth()
  const nudge = (by: number) => {
    const panel = document.querySelector('[data-testid="inspector"]')
    const available = panel?.parentElement?.getBoundingClientRect().width ?? width
    setWidth(clampWidth(width + by, available))
    remember()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Inspector width"
      aria-valuenow={Math.round(width)}
      aria-valuemin={INSPECTOR_MIN}
      tabIndex={0}
      data-testid="inspector-resize"
      title="Drag to resize · double-click to reset"
      className="group/grip absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize outline-none"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const panel = event.currentTarget.parentElement
        const available = panel?.parentElement?.getBoundingClientRect().width
        if (!panel || available === undefined) return
        setWidth(clampWidth(panel.getBoundingClientRect().right - event.clientX, available))
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        remember()
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16
        if (event.key === 'ArrowLeft') nudge(step)
        else if (event.key === 'ArrowRight') nudge(-step)
        else return
        event.preventDefault()
      }}
      onDoubleClick={reset}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1 w-px group-hover/grip:bg-kumo-brand group-focus-visible/grip:bg-kumo-brand" />
    </div>
  )
}

export function Inspector({ path, onDelete }: { path: string; onDelete: (path: string) => void }) {
  const workbench = useWorkbench()
  const width = useInspectorWidth((state) => state.width)
  const document = useQuery(documentQuery(workbench.scope, path))
  // Names and counts in one request, shared with the grid's column: the
  // row the inspector was opened from has usually asked already.
  const subcollections = useQuery(subcollectionsQuery(workbench.database, path))

  return (
    <aside
      // Wide enough for the grid to keep working beside it, the inspector
      // sits in the flow. Below that it floats over the right of the grid
      // instead, because squeezing the grid into the remaining sliver makes
      // both halves useless.
      //
      // `relative` in the flow, never `static`: the two lay out identically,
      // but only a positioned element is a containing block, and under
      // `static` the grip on its edge escaped to an ancestor and drew itself
      // 523 px away, down the left side of the grid.
      className="absolute inset-y-0 right-0 z-20 flex min-h-0 max-w-full shrink-0 flex-col border-l border-kumo-line bg-kumo-base shadow-lg xl:relative xl:shadow-none"
      style={{ width }}
      data-testid="inspector"
    >
      <WidthHandle />
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line pr-1 pl-3">
        {/* Kumo's monospace variants are fixed at 13 px; the face is asked
            for here and the size comes from the scale. */}
        <InlineCopyText
          value={path}
          variant="body"
          size="xs"
          className="min-w-0 flex-1 truncate font-mono"
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
          <Text variant="secondary" size="sm">
            Loading…
          </Text>
        </div>
      ) : document.isError ? (
        <div className="p-4">
          <Text variant="error" size="sm">
            {document.error.message}
          </Text>
        </div>
      ) : document.data === null ? (
        <MissingDocument path={path} subcollections={subcollections.data ?? []} />
      ) : (
        <DocumentEditor
          key={`${path}:${document.data.updateTime ?? ''}`}
          document={document.data}
          onDelete={onDelete}
          // Subcollections belong with the document, above the actions: a
          // footer that is not the last thing in the panel reads as a divider.
          subcollections={<Subcollections parent={path} found={subcollections.data ?? []} />}
        />
      )}
    </aside>
  )
}

function MissingDocument({
  path,
  subcollections,
}: {
  path: string
  subcollections: Subcollection[]
}) {
  const openCreate = useCreateDialog((state) => state.open)
  const collection = parentCollection(path)
  const id = path.split('/').at(-1) ?? path
  return (
    <div className="grid gap-3 p-4">
      <PanelTitle>No document here</PanelTitle>
      <Text variant="secondary" size="sm">
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
      <Subcollections parent={path} found={subcollections} />
    </div>
  )
}

function Subcollections({ parent, found }: { parent: string; found: Subcollection[] }) {
  const workbench = useWorkbench()
  const openCreate = useCreateDialog((state) => state.open)
  return (
    <div className="shrink-0 border-t border-kumo-line px-3 py-2" data-testid="subcollections">
      <div className="mb-1 flex items-center">
        {/* A section label in the panel's chrome, the size of the tab row
            above it rather than of the prose below. */}
        <Text variant="secondary" size="sm" as="p" DANGEROUS_className="text-[12px]">
          Subcollections{found.length > 0 ? ` · ${found.length}` : ''}
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
      {found.length === 0 && (
        <Text variant="secondary" size="sm">
          None yet.
        </Text>
      )}
      <ul className="grid gap-0.5">
        {found.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-kumo-tint"
              onClick={() => workbench.setPath(`${parent}/${child.id}`)}
            >
              <FolderIcon size={14} className="text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{child.id}</span>
              <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
                {child.documents.toLocaleString('en-US')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DocumentEditor({
  document,
  onDelete,
  subcollections,
}: {
  document: FsDocument
  onDelete: (path: string) => void
  subcollections: React.ReactNode
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const status = useQuery(statusQuery)
  const openCreate = useCreateDialog((state) => state.open)
  const [nodes, setNodes] = useState<DraftNode[]>(() => nodesFrom(document.fields, true))
  const [codeTarget, setCodeTarget] = useState<CodeTarget>('web')
  const known = useKnownFields(document.collection)

  // Both run on every keystroke, which is the point: a value that will not
  // parse says so under the row it is in, and Save knows whether there is
  // anything to save before it is pressed rather than after.
  const problems = useMemo(() => problemsOf(nodes), [nodes])
  const diff = useMemo(() => diffDocument(document.fields, nodes), [document.fields, nodes])
  const changed = Object.keys(diff.write).length + diff.clear.length
  const changedNames = useMemo(() => new Set(Object.keys(diff.write)), [diff])
  const root = documentRoot(workbench.scope)

  const save = useMutation({
    mutationFn: async () => {
      const fields: Record<string, RestValue> = {}
      for (const [name, value] of Object.entries(diff.write))
        fields[name] = encodeValue(value, root)
      // The mask carries the cleared names as well as the written ones, so
      // a removal and a rename — which is a delete and a set — are the same
      // single write as an edit, and either all of it lands or none does.
      const mask = [...Object.keys(diff.write), ...diff.clear].map(quoteFieldSegment)
      await commit(workbench.scope, [
        { update: { path: document.path, fields, mask, exists: true } },
      ])
      return changed
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
    for (const node of nodes) {
      if (node.removed === true) continue
      const parsed = parseNode(node)
      const value: FsValue = parsed.ok ? parsed.value : { type: 'string', value: node.text }
      plain[node.name] = toJsonValue(value)
      rest[node.name] = encodeValue(value, root)
    }
    return { json: plain, rest }
  }, [nodes, root])

  return (
    <>
      <FieldsPanel
        nodes={nodes}
        onNodesChange={setNodes}
        problems={problems}
        known={known}
        changed={changedNames}
        tab={workbench.tab}
        onTabChange={workbench.setTab}
        onOpenReference={(path) => workbench.selectDocument(path)}
      />
      {subcollections}
      <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-kumo-line px-3">
        <Button
          variant="primary"
          size="sm"
          onClick={() => save.mutate()}
          disabled={changed === 0 || problems.size > 0}
          loading={save.isPending}
          data-testid="save-document"
        >
          Save
        </Button>
        {save.isError ? (
          <Text variant="error" size="sm" truncate>
            {save.error.message}
          </Text>
        ) : problems.size > 0 ? (
          <Text variant="error" size="sm" data-testid="save-blocked">
            {problems.size} field{problems.size === 1 ? '' : 's'} to fix
          </Text>
        ) : changed > 0 ? (
          <Text variant="secondary" size="sm" data-testid="save-pending">
            {changed} change{changed === 1 ? '' : 's'}
          </Text>
        ) : null}
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

function parentCollection(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}
