// One dialog for everything that makes documents: a document in a
// collection, a collection (its first document creates it) and a JSON
// import. Fields are typed from the start, so a timestamp is a timestamp.

import { Button, Checkbox, Dialog, Text, useKumoToastManager } from '@cloudflare/kumo'
import { UploadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { type CreateRequest, generateId, parseImport, useCreateDialog, validateId } from '../create'
import { useSelection } from '../selection'
import { FirestoreError, type WriteOperation, commit, documentRoot } from '../rest'
import { type RestValue, encodeFields, encodeValue, fromJson, parseEditorText } from '../value'
import { type FieldDraft, FieldsPanel, draftFor, draftsFrom } from './field-editor'
import { useWorkbench } from './workbench-context'

export function CreateDialog() {
  const request = useCreateDialog((state) => state.request)
  const session = useCreateDialog((state) => state.session)
  const close = useCreateDialog((state) => state.close)
  // The last request stays rendered while the dialog animates closed.
  const [shown, setShown] = useState(request)
  if (request !== null && request !== shown) setShown(request)
  return (
    <Dialog.Root open={request !== null} onOpenChange={(next) => !next && close()}>
      <Dialog size="lg" className="p-6">
        {shown &&
          (shown.kind === 'import' ? (
            <ImportForm key={session} collection={shown.collection} onClose={close} />
          ) : (
            <CreateForm key={session} request={shown} onClose={close} />
          ))}
      </Dialog>
    </Dialog.Root>
  )
}

function initialDrafts(request: CreateRequest): FieldDraft[] {
  if (request.kind === 'document' && request.template) return draftsFrom(request.template, true)
  return [{ ...draftFor('createdAt', 'timestamp', new Date().toISOString()), dirty: true }]
}

function CreateForm({
  request,
  onClose,
}: {
  request: Extract<CreateRequest, { kind: 'document' | 'collection' }>
  onClose: () => void
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const clearSelection = useSelection((state) => state.clear)
  const [collectionId, setCollectionId] = useState(
    request.kind === 'collection' ? (request.id ?? '') : '',
  )
  const [documentId, setDocumentId] = useState(
    request.kind === 'document' ? (request.id ?? '') : '',
  )
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => initialDrafts(request))
  const [tab, setTab] = useState<'fields' | 'json'>('fields')
  const [error, setError] = useState<string | undefined>()

  const collectionPath =
    request.kind === 'document'
      ? request.collection
      : [request.parent, collectionId.trim()].filter(Boolean).join('/')
  const collectionError =
    request.kind === 'collection' ? validateId(collectionId.trim(), 'collection') : undefined
  const documentError = documentId.trim() ? validateId(documentId.trim(), 'document') : undefined

  const create = useMutation({
    mutationFn: async () => {
      if (collectionError) throw new Error(collectionError)
      if (documentError) throw new Error(documentError)
      const root = documentRoot(workbench.scope)
      const fields: Record<string, RestValue> = {}
      const next = drafts.map((draft) => ({ ...draft }))
      let failed = false
      for (const draft of next) {
        const parsed = parseEditorText(draft.type, draft.text)
        if (!parsed.ok) {
          draft.error = parsed.error
          failed = true
          continue
        }
        fields[draft.name] = encodeValue(parsed.value, root)
      }
      if (failed) {
        setDrafts(next)
        setTab('fields')
        throw new Error('Fix the highlighted fields')
      }
      const path = `${collectionPath}/${documentId.trim() || generateId()}`
      // An explicit id must not silently replace a document already there.
      const operation: WriteOperation = documentId.trim()
        ? { create: { path, fields } }
        : { set: { path, fields } }
      try {
        await commit(workbench.scope, [operation])
      } catch (failure) {
        if (failure instanceof FirestoreError && failure.status === 412)
          throw new Error(`${path} already exists; pick another id or open it instead`, {
            cause: failure,
          })
        throw failure
      }
      return path
    },
    onSuccess: (path) => {
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
      toasts.add({
        title: request.kind === 'collection' ? 'Collection created' : 'Document added',
        description: path,
        variant: 'success',
      })
      onClose()
      if (collectionPath === workbench.collectionPath) workbench.selectDocument(path)
      else {
        clearSelection()
        workbench.navigate({ path: collectionPath, doc: path, q: undefined, group: undefined })
      }
    },
    onError: (failure) => setError(failure.message),
  })

  const title =
    request.kind === 'document' ? (
      <>
        {request.template ? 'Duplicate' : request.id ? 'Create' : 'New document in'}{' '}
        <span className="font-mono text-[0.9em]">
          {request.template
            ? request.template.path
            : request.id
              ? `${request.collection}/${request.id}`
              : request.collection}
        </span>
      </>
    ) : request.parent ? (
      <>
        New subcollection under <span className="font-mono text-[0.9em]">{request.parent}</span>
      </>
    ) : (
      'New root collection'
    )
  const submitLabel =
    request.kind === 'collection'
      ? 'Create collection'
      : request.template
        ? 'Duplicate document'
        : request.id
          ? 'Create document'
          : 'Add document'

  return (
    <div className="flex max-h-[calc(100vh-6rem)] flex-col">
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        {request.kind === 'collection'
          ? 'A collection exists once it has a document, so the first one is written here with it.'
          : 'Fields are typed as the SDK would type them; change a type from its badge.'}
      </Dialog.Description>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {request.kind === 'collection' && (
          <label className="grid gap-1">
            <Text variant="secondary" size="sm" as="span">
              Collection id
            </Text>
            <input
              value={collectionId}
              onChange={(event) => setCollectionId(event.target.value)}
              spellCheck={false}
              autoFocus
              placeholder="invoices"
              className={`h-8 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring outline-none placeholder:font-sans placeholder:text-kumo-inactive focus:ring-kumo-focus ${
                collectionId && collectionError ? 'ring-kumo-danger' : 'ring-kumo-line'
              }`}
              data-testid="new-collection-id"
            />
            {collectionId && collectionError && (
              <span className="text-[12px] text-kumo-danger">{collectionError}</span>
            )}
          </label>
        )}
        <label className="grid gap-1">
          <Text variant="secondary" size="sm" as="span">
            {request.kind === 'collection' ? 'First document id' : 'Document id'}{' '}
            <span className="text-kumo-inactive">(blank for an auto id)</span>
          </Text>
          <input
            value={documentId}
            onChange={(event) => setDocumentId(event.target.value)}
            spellCheck={false}
            autoFocus={request.kind === 'document'}
            className={`h-8 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring outline-none focus:ring-kumo-focus ${
              documentError ? 'ring-kumo-danger' : 'ring-kumo-line'
            }`}
            data-testid="new-document-id"
          />
          {documentError && <span className="text-[12px] text-kumo-danger">{documentError}</span>}
        </label>
      </div>
      <div className="mt-3 flex h-[400px] min-h-0 flex-col rounded-md ring ring-kumo-line">
        <FieldsPanel
          drafts={drafts}
          onDraftsChange={setDrafts}
          tab={tab}
          onTabChange={setTab}
          onOpenReference={(path) => workbench.selectDocument(path)}
          rows={14}
        />
      </div>
      {error && (
        <div className="mt-2">
          <Text variant="error" size="sm">
            {error}
          </Text>
        </div>
      )}
      <div className="mt-5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          <Text variant="secondary" size="sm" as="span">
            <span className="font-mono text-[0.95em]">
              {collectionPath || '…'}/{documentId.trim() || <i>auto id</i>}
            </span>
          </Text>
        </span>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => create.mutate()}
          loading={create.isPending}
          disabled={Boolean(collectionError) || Boolean(documentError)}
          data-testid="create-submit"
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

const BATCH = 200

function ImportForm({ collection, onClose }: { collection: string; onClose: () => void }) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [timestamps, setTimestamps] = useState(true)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const preview = useMemo(() => {
    if (!text.trim()) return null
    try {
      const documents = parseImport(text)
      return { documents, error: undefined }
    } catch (error) {
      return { documents: [], error: error instanceof Error ? error.message : String(error) }
    }
  }, [text])

  const run = useMutation({
    mutationFn: async () => {
      const documents = parseImport(text)
      if (documents.length === 0) throw new Error('Nothing to import')
      const root = documentRoot(workbench.scope)
      const operations: WriteOperation[] = documents.map((document) => {
        const id = document.id ?? generateId()
        const problem = validateId(id, 'document')
        if (problem) throw new Error(`${id}: ${problem}`)
        const value = fromJson(document.fields, { timestamps })
        if (value.type !== 'map') throw new Error(`${id}: fields must be an object`)
        return { set: { path: `${collection}/${id}`, fields: encodeFields(value.fields, root) } }
      })
      setProgress({ done: 0, total: operations.length })
      for (let start = 0; start < operations.length; start += BATCH) {
        // Batches go one at a time so the engine sees a steady stream.
        // oxlint-disable-next-line no-await-in-loop
        await commit(workbench.scope, operations.slice(start, start + BATCH))
        setProgress({ done: Math.min(operations.length, start + BATCH), total: operations.length })
      }
      return operations.length
    },
    onSuccess: (count) => {
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
      toasts.add({
        title: `${count.toLocaleString('en-US')} document${count === 1 ? '' : 's'} imported`,
        description: collection,
        variant: 'success',
      })
      onClose()
      if (collection !== workbench.collectionPath)
        workbench.navigate({ path: collection, doc: undefined, q: undefined, group: undefined })
    },
    onError: () => setProgress(null),
  })

  const readFile = (file: File | undefined) => {
    if (!file) return
    void file.text().then(setText)
  }

  return (
    <div className="flex max-h-[calc(100vh-6rem)] flex-col">
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">
          Import into <span className="font-mono text-[0.9em]">{collection}</span>
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        An object keyed by document id, an array of documents (auto ids), or NDJSON. Documents with
        the same id are replaced.
      </Dialog.Description>
      <div className="mt-4 grid gap-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onDrop={(event) => {
            event.preventDefault()
            readFile(event.dataTransfer.files[0])
          }}
          onDragOver={(event) => event.preventDefault()}
          rows={14}
          spellCheck={false}
          placeholder={
            '{\n  "inv_001": { "total": 120, "paidAt": "2026-09-20T09:00:00Z" },\n  "inv_002": { "total": 80 }\n}'
          }
          className="w-full resize-y rounded-md bg-kumo-control p-2 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line outline-none placeholder:text-kumo-inactive focus:ring-kumo-focus"
          aria-label="Documents as JSON"
          data-testid="import-json"
        />
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".json,.ndjson,.jsonl,application/json"
            className="hidden"
            onChange={(event) => readFile(event.target.files?.[0])}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<UploadSimpleIcon />}
            onClick={() => fileRef.current?.click()}
          >
            Choose a file
          </Button>
          <Checkbox
            checked={timestamps}
            onCheckedChange={(checked) => setTimestamps(Boolean(checked))}
            label="ISO 8601 strings become timestamps"
          />
          <span className="ml-auto">
            <Text variant="secondary" size="sm" as="span" data-testid="import-preview">
              {preview === null ? (
                'Paste or drop a file'
              ) : preview.error ? (
                <span className="text-kumo-danger">{preview.error}</span>
              ) : (
                <>
                  <span className="font-mono text-[0.95em] text-kumo-default tabular-nums">
                    {preview.documents.length.toLocaleString('en-US')}
                  </span>{' '}
                  document{preview.documents.length === 1 ? '' : 's'} ·{' '}
                  {preview.documents.some((document) => document.id !== undefined)
                    ? 'ids from keys'
                    : 'auto ids'}
                </>
              )}
            </Text>
          </span>
        </div>
      </div>
      {run.isError && (
        <div className="mt-2">
          <Text variant="error" size="sm">
            {run.error.message}
          </Text>
        </div>
      )}
      <div className="mt-5 flex items-center gap-2">
        {progress && (
          <Text variant="secondary" size="sm" as="span">
            Writing{' '}
            <span className="font-mono tabular-nums">
              {progress.done.toLocaleString('en-US')} / {progress.total.toLocaleString('en-US')}
            </span>
          </Text>
        )}
        <span className="ml-auto" />
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => run.mutate()}
          loading={run.isPending}
          disabled={!preview || Boolean(preview.error) || preview.documents.length === 0}
          data-testid="import-submit"
        >
          Import
          {preview && !preview.error ? ` ${preview.documents.length.toLocaleString('en-US')}` : ''}
        </Button>
      </div>
    </div>
  )
}
