// The inspector: the selected document in full. Typed editors per field,
// the JSON view, subcollections with counts, save and delete. It is a
// detail view; getting around happens in the path bar and the grid.

import { Button, Text, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  CopyIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { CodePopover } from '@/components/console/code-popover'
import {
  Inspector as InspectorFrame,
  InspectorFooter,
  InspectorTitle,
  useInspectorRoom,
} from '@/components/console/inspector'
import { codeTab } from '@/components/console/request/as-code'
import { PanelTitle } from '@/components/kit'
import { useCreateDialog } from '../create'
import { type CodeTarget, documentAsCode } from '../query'
import { documentExample, isDocumentPath } from '../document-path'
import { documentQuery } from '../queries'
import { commit, documentRoot, quoteFieldSegment } from '../rest'
import { type Subcollection, workbenchSubcollectionsQuery } from '../subcollections'
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
  formatNumber,
  relativeTime,
} from '../value'
import { FieldsPanel } from './field-editor'
import { useKnownFields } from './known-fields'
import { TriggerChip } from './trigger-chip'
import { useGridSteps } from '../grid-steps'
import { useWorkbench } from './workbench-context'

/** The document's code, in the console's dialects: the Admin SDK is `node`'s tab. */
const CODE_TABS: ReadonlyArray<{
  target: CodeTarget
  dialect: 'web' | 'node' | 'flutter' | 'rest'
}> = [
  { target: 'web', dialect: 'web' },
  { target: 'admin', dialect: 'node' },
  { target: 'flutter', dialect: 'flutter' },
  { target: 'rest', dialect: 'rest' },
]

/** Where an app sends REST calls: the Firestore port the engine advertises. */
function firestoreOrigin(
  services: ReadonlyArray<{ name: string; host: string; port: number }> | undefined,
): string {
  const firestore = services?.find((service) => service.name === 'firestore')
  return firestore ? `http://${firestore.host}:${firestore.port}` : window.location.origin
}

/** A draft's size as the header says it. */
function readSize(path: string, nodes: readonly DraftNode[]): SizeReading {
  const fields = draftFields(nodes)
  return sizeReading(documentBytes(path, fields), anyElided(fields))
}

export function Inspector({ path, onDelete }: { path: string; onDelete: (path: string) => void }) {
  const workbench = useWorkbench()
  const steps = useGridSteps()
  // `doc=` can name something that is no document (a collection, an id
  // with no collection to read it in); nothing is asked of the engine then.
  const valid = isDocumentPath(path)
  const document = useQuery({ ...documentQuery(workbench.scope, path), enabled: valid })
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
  const subcollections = useQuery({
    ...workbenchSubcollectionsQuery(workbench, path),
    enabled: valid,
  })

  // The kit's inspector frame, which was measured on this one: the path
  // (copyable) as the title, size and age beside it, the trigger chip and
  // "open in grid" as actions, the grid's previous and next, close; its
  // width is the person's, and below `xl` it floats over the grid rather
  // than squeezing it into a sliver.
  return (
    <InspectorFrame
      widthKey="firestore"
      title={<InspectorTitle value={path} />}
      meta={
        // Size and age beside the name, the way a file list writes them.
        // Both quiet: neither is a thing to act on until the size is near
        // the ceiling, and then the size alone takes colour.
        size || document.data?.updateTime ? (
          <>
            {size && (
              // Firestore refuses a document over 1 MiB and this engine
              // does not, so a document that writes happily here can fail
              // on the first deploy. This is the only warning there is.
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
          </>
        ) : undefined
      }
      actions={
        <>
          {/* Which functions a change to this document runs, when any do;
              the functions listen to the emulator's own project only. */}
          {document.data && !workbench.foreign && (
            <TriggerChip database={workbench.database} path={path} />
          )}
          {valid && parentCollection(path) !== workbench.collectionPath && (
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
        </>
      }
      onPrev={steps.previous}
      onNext={steps.next}
      noun="document"
      onClose={() => workbench.selectDocument(undefined)}
      closeLabel="Close the document"
      testId="inspector"
    >
      {!valid ? (
        <NotADocument path={path} />
      ) : document.isPending ? (
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
    </InspectorFrame>
  )
}

/** `doc=` names no document: said in the panel's own words, nothing to create. */
function NotADocument({ path }: { path: string }) {
  const workbench = useWorkbench()
  return (
    <div className="grid gap-3 p-4" data-testid="inspector-not-a-document">
      <PanelTitle>Document not found</PanelTitle>
      <Text variant="secondary" size="sm">
        <span className="font-mono text-[0.9em]">{path}</span> is not a document’s path. A document
        is named by its collection and its id, as in{' '}
        <span className="font-mono text-[0.9em]">
          {documentExample(path, workbench.collectionPath)}
        </span>
        .
      </Text>
    </div>
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
              className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:ink"
              onClick={() => workbench.setPath(`${parent}/${child.id}`)}
            >
              <FolderIcon size={14} className="text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{child.id}</span>
              <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
                {formatNumber(child.documents)}
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
  // Code is the one control down here that changes nothing, so it is the
  // first word the row gives up when the row runs out of them, by width.
  const room = useInspectorRoom()
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
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.slot] })
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
      {/* Tools on the left, the action on the right: a footer's main button
          is where a hand goes looking for it, and Save is the one control
          down here anybody clicks twice. The rule divides the row by what
          the controls do: looking at this document (Code) on one side,
          changing which documents exist (Duplicate, Delete) on the other,
          so the two coloured controls sit at opposite ends of the row. */}
      <InspectorFooter
        tools={
          <CodePopover
            title="This document as code"
            kind="firestore.document"
            tabs={CODE_TABS.map(({ target, dialect }) =>
              codeTab(
                dialect,
                documentAsCode(target, document.path, forCode, {
                  project: workbench.project,
                  database: workbench.database,
                  origin: firestoreOrigin(status.data?.services),
                }),
              ),
            )}
            label={room.labels}
            testId="document-code"
          />
        }
        danger={
          <>
            {/* Carries its word: the header above has a copy glyph too,
                which copies the path. The tooltip says what duplicating
                means here — the fields are carried into a new document
                that does not exist until it is saved. */}
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
            {/* Red says what it does; Kumo has no ghost destructive, so the
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
          </>
        }
        primary={
          <>
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
                otherwise: outlined at rest, filled the moment the count
                beside it is not zero. */}
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
          </>
        }
      />
    </>
  )
}

function parentCollection(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}
