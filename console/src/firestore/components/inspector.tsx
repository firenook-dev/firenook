// The inspector: the selected document in full. Typed editors per field,
// the JSON view, subcollections with counts, save and delete. It is a
// detail view; getting around happens in the path bar and the grid.

import {
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
import { CODE_LABEL_AT, clampWidth, INSPECTOR_MIN, useInspectorWidth } from './inspector-width'
import { type Subcollection, subcollectionsQuery } from '../subcollections'
import {
  type DraftNode,
  diffDocument,
  draftFields,
  nodesFrom,
  parseNode,
  problemsOf,
} from '../draft'
import { type SizeReading, anyElided, documentBytes, sizeReading } from '../size'
import {
  type FsDocument,
  type FsValue,
  type RestValue,
  compactIso,
  encodeValue,
  relativeTime,
} from '../value'
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

/** A draft's size as the header says it. */
function readSize(path: string, nodes: readonly DraftNode[]): SizeReading {
  const fields = draftFields(nodes)
  return sizeReading(documentBytes(path, fields), anyElided(fields))
}

export function Inspector({ path, onDelete }: { path: string; onDelete: (path: string) => void }) {
  const workbench = useWorkbench()
  const width = useInspectorWidth((state) => state.width)
  const document = useQuery(documentQuery(workbench.scope, path))
  // The editor below holds the draft; the header up here says how big it
  // is. What the editor last reported is kept against the editor it came
  // from, so a document switched to — or rewritten by another client,
  // which remounts the editor under a new key — shows its stored size
  // rather than the last draft's until it is edited, and a stored
  // document and its untouched draft are the same size anyway.
  const editorKey = `${path}:${document.data?.updateTime ?? ''}`
  const [drafted, setDrafted] = useState<{ key: string; reading: SizeReading }>()
  const stored = useMemo(
    () => (document.data ? readSize(path, nodesFrom(document.data.fields, true)) : undefined),
    [path, document.data],
  )
  const size = drafted?.key === editorKey ? drafted.reading : stored
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
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line pr-3 pl-5">
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
        {/* Size and age beside the name, the way a file list writes them.
            Both quiet: neither is a thing to act on until the size is
            near the ceiling, and then the size alone takes colour. */}
        {(size || document.data?.updateTime) && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-kumo-subtle tabular-nums">
            {size && (
              // Firestore refuses a document over 1 MiB and this engine
              // does not, so a document that writes happily here can
              // fail on the first deploy. This is the only warning
              // there is.
              <Tooltip
                content={size.title}
                render={
                  <span
                    data-testid="document-size"
                    className={`cursor-default ${
                      size.tone === 'over'
                        ? 'text-kumo-danger'
                        : size.tone === 'crowded'
                          ? 'text-kumo-warning'
                          : ''
                    }`}
                  >
                    {size.text}
                  </span>
                }
              />
            )}
            {size && document.data?.updateTime && <span aria-hidden>·</span>}
            {/* `updateTime` is the engine's record of the last write, not
                one of the document's fields: a document whose `createdAt`
                says August can have been written to since, and this is
                the one that says so. It names itself on hover because a
                bare "1 mo ago" does not say which event it counts from. */}
            {document.data?.updateTime && (
              <Tooltip
                content={`Last changed ${compactIso(document.data.updateTime)}`}
                render={
                  <span data-testid="document-changed" className="cursor-default">
                    {relativeTime(document.data.updateTime)}
                  </span>
                }
              />
            )}
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
          key={editorKey}
          document={document.data}
          onDelete={onDelete}
          onSize={(reading) => setDrafted({ key: editorKey, reading })}
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
    <div className="shrink-0 border-t border-kumo-line px-5 py-2" data-testid="subcollections">
      {/* Empty, this section is one line. It used to be the tallest band
          in the panel — 56 px against the footer's 42 — and the only one
          with nothing in it, because a 12 px label was followed by a
          13 px "None yet." in the same grey: a sentence larger than its
          own heading, so there was no heading, just two grey lines of
          which the louder said nothing. The count says it instead, and
          the absence of a list says it twice. */}
      <div className={`flex items-center ${found.length > 0 ? 'mb-1' : ''}`}>
        {/* A section label in the panel's chrome, the size of the tab row
            above it rather than of the prose below. */}
        <Text variant="secondary" size="sm" as="p" DANGEROUS_className="text-[12px]">
          Subcollections · {found.length > 0 ? found.length : 'none'}
        </Text>
        <span className="ml-auto">
          {/* `sm`, not `xs`: Kumo's extra-small square renders 12 px at a
              14 px root, which is below any sane hit target and half the
              size of every other icon button in the panel. */}
          <Tooltip
            content="Add a subcollection under this document"
            render={
              <Button
                variant="ghost"
                size="sm"
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
  onSize,
  subcollections,
}: {
  document: FsDocument
  onDelete: (path: string) => void
  /** The draft's size, each time the draft changes. */
  onSize: (reading: SizeReading) => void
  subcollections: React.ReactNode
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const status = useQuery(statusQuery)
  const openCreate = useCreateDialog((state) => state.open)
  const [nodes, setNodes] = useState<DraftNode[]>(() => nodesFrom(document.fields, true))
  const [jsonError, setJsonError] = useState<string | undefined>()
  const [codeTarget, setCodeTarget] = useState<CodeTarget>('web')
  // The footer is as wide as the panel, so the panel's own width is the
  // footer's measurement and no observer of its own is needed.
  const roomForTheWord = useInspectorWidth((state) => state.width) >= CODE_LABEL_AT
  // Every change to the draft goes through here, so the size the header
  // shows moves as you type rather than after Save — which is the only
  // moment it can save you anything.
  const changeNodes = (next: DraftNode[]) => {
    setNodes(next)
    onSize(readSize(document.path, next))
  }
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

  // The REST shape alone: it is the one that carries the types, and the
  // plain JSON beside it is what made three of the four dialects emit a
  // document that is not this one.
  const forCode = useMemo(() => {
    const rest: Record<string, RestValue> = {}
    for (const node of nodes) {
      if (node.removed === true) continue
      const parsed = parseNode(node)
      const value: FsValue = parsed.ok ? parsed.value : { type: 'string', value: node.text }
      rest[node.name] = encodeValue(value, root)
    }
    return rest
  }, [nodes, root])

  return (
    <>
      <FieldsPanel
        nodes={nodes}
        onNodesChange={changeNodes}
        problems={problems}
        known={known}
        changed={changedNames}
        tab={workbench.tab}
        onTabChange={workbench.setTab}
        onJsonError={setJsonError}
        onOpenReference={(path) => workbench.selectDocument(path)}
      />
      {subcollections}
      <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-kumo-line px-5">
        {/* Tools on the left, the action on the right: a footer's main
            button is where a hand goes looking for it, and Save is the
            one control down here anybody clicks twice. The risk that
            invites — seating the confirming action against the
            destroying one — is answered by sending the tools the other
            way, so the two coloured controls sit at opposite ends of the
            row with three hundred pixels between them. */}
        <div className="flex shrink-0 items-center gap-1">
          {/* The only control down here that changes nothing — it opens
              a panel showing how to fetch this document in code — so it
              is the first word the row gives up when the row runs out
              of them. It gives it up late: see CODE_LABEL_AT. The
              tooltip stands either way, because a glyph on its own has
              to be hoverable to be nameable. */}
          <Popover>
            <Tooltip
              content="This document as code"
              render={
                <Popover.Trigger
                  render={
                    // Two elements rather than one with the word
                    // conditional on it: Kumo draws a labelled button
                    // and an icon-only one from different shapes of
                    // props, a square among them, and a `children` that
                    // is sometimes undefined satisfies neither.
                    roomForTheWord ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<CodeIcon />}
                        aria-label="This document as code"
                        data-testid="document-code"
                      >
                        Code
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        icon={<CodeIcon />}
                        aria-label="This document as code"
                        data-testid="document-code"
                      />
                    )
                  }
                />
              }
            />
            <Popover.Content className="w-[560px] max-w-[calc(100vw-2rem)]">
              <CodeBlock
                title="This document as code"
                target={codeTarget}
                setTarget={setCodeTarget}
                code={documentAsCode(codeTarget, document.path, forCode, {
                  project: workbench.project,
                  database: workbench.database,
                  origin: firestoreOrigin(status.data?.services),
                })}
              />
            </Popover.Content>
          </Popover>
          {/* The rule divides the row by what the controls do, not by
              which one is frightening: looking at this document on one
              side, changing which documents exist on the other. Delete
              confirms in a dialog, so seating it beside Duplicate costs
              nothing a misclick could not take back. */}
          <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" />
          {/* Carries its word now. It was the one bare glyph in a row of
              labelled controls, and a bare copy glyph in particular: the
              header above has one too, which copies the path. The
              tooltip says what duplicating means here, which a label
              cannot — the fields are carried into a new document that
              does not exist until it is saved. */}
          <Tooltip
            content="Opens a new document with these fields"
            render={
              <Button
                variant="ghost"
                size="sm"
                icon={<CopyIcon />}
                onClick={() =>
                  openCreate({
                    kind: 'document',
                    collection: document.collection,
                    template: document,
                  })
                }
                data-testid="duplicate-document"
              >
                Duplicate
              </Button>
            }
          />
          {/* Red says what it does; the border was saying it twice. A
              bordered destructive button was the strongest mark in the
              footer at rest — louder than Save, in an editor whose usual
              business is reading. Kumo has no ghost destructive, so the
              colour rides on the children of a ghost. */}
          <Button
            variant="ghost"
            size="sm"
            icon={<TrashIcon className="text-kumo-danger" />}
            onClick={() => onDelete(document.path)}
            aria-label="Delete this document"
          >
            <span className="text-kumo-danger">Delete</span>
          </Button>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {save.isError ? (
            <Text variant="error" size="sm" truncate>
              {save.error.message}
            </Text>
          ) : jsonError !== undefined ? (
            // The JSON view holds text that is not a document. The rows
            // behind it are the last ones that were, and writing those
            // would be writing something other than what is on screen.
            <Text variant="error" size="sm" truncate data-testid="save-blocked">
              The JSON does not parse yet
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
          {/* The fill says there is something to save, and says nothing
              otherwise. It used to be the brand fill always, which a
              disabled button draws at half opacity — so "nothing to save"
              and "save now" differed only by translucency, and a washed
              accent still pulled the eye hardest in a panel you mostly
              read. Outlined at rest, filled the moment the count beside
              it is not zero. */}
          <Button
            variant={changed > 0 && jsonError === undefined ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => save.mutate()}
            disabled={changed === 0 || problems.size > 0 || jsonError !== undefined}
            loading={save.isPending}
            data-testid="save-document"
          >
            Save
          </Button>
        </div>
      </footer>
    </>
  )
}

function parentCollection(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}
