// The inspector: the selected document in full. Typed editors per field,
// the JSON view, subcollections with counts, save and delete. It is a
// detail view; getting around happens in the path bar and the grid.

import {
  Badge,
  Button,
  InlineCopyText,
  Popover,
  Tabs,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { CodeIcon, FolderIcon, PlusIcon, TrashIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { statusQuery } from '@/api/queries'
import { useMemo, useState } from 'react'
import { type CodeTarget, EMPTY_QUERY, documentAsCode } from '../query'
import { collectionsQuery, countQueryOptions, documentQuery } from '../queries'
import { type WriteOperation, commit, documentRoot } from '../rest'
import {
  type FirestoreValueType,
  type FsDocument,
  type FsValue,
  type RestValue,
  editorText,
  encodeValue,
  fieldsToJson,
  fromJson,
  parseEditorText,
  relativeTime,
} from '../value'
import { CodeBlock, firestoreOrigin } from './code-popover'
import { type FieldDraft, FieldEditor, draftFor } from './field-editor'
import { useWorkbench } from './workbench-context'

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
  const workbench = useWorkbench()
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
      {subcollections.length > 0 && <Subcollections parent={path} ids={subcollections} />}
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon={<PlusIcon />}
          onClick={() => workbench.navigate({ doc: path })}
        >
          Create it
        </Button>
      </div>
    </div>
  )
}

function Subcollections({ parent, ids }: { parent: string; ids: string[] }) {
  const workbench = useWorkbench()
  if (ids.length === 0) return null
  return (
    <div className="shrink-0 border-t border-kumo-line px-3 py-2">
      <div className="mb-1">
        <Text variant="secondary" size="sm" as="p">
          Subcollections
        </Text>
      </div>
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

function draftsFrom(document: FsDocument): FieldDraft[] {
  return Object.entries(document.fields).map(([name, value]) =>
    draftFor(name, value.type, editorText(value)),
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
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => draftsFrom(document))
  const [removed, setRemoved] = useState<string[]>([])
  const [json, setJson] = useState(() => JSON.stringify(fieldsToJson(document.fields), null, 2))
  const [jsonError, setJsonError] = useState<string | undefined>()
  const [newField, setNewField] = useState('')
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

  const applyJson = () => {
    try {
      const parsed: unknown = JSON.parse(json)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('The document must be a JSON object')
      const value = fromJson(parsed)
      if (value.type !== 'map') throw new Error('The document must be a JSON object')
      const current = new Map(drafts.map((draft) => [draft.name, draft]))
      const next: FieldDraft[] = Object.entries(value.fields).map(([name, item]) => {
        const existing = current.get(name)
        // A stored type survives when JSON cannot express it (timestamps,
        // references) and the text is unchanged.
        const type: FirestoreValueType =
          existing && editorText(item) === existing.text ? existing.type : item.type
        const text = editorText(item)
        const changed = !existing || existing.text !== text || existing.type !== type
        return { name, type, text, dirty: changed, added: !existing }
      })
      const gone = drafts
        .filter((draft) => !(draft.name in value.fields))
        .map((draft) => draft.name)
      setDrafts(next)
      setRemoved((previous) => [...new Set([...previous, ...gone])])
      setJsonError(undefined)
      workbench.setTab('fields')
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }

  const addField = () => {
    const name = newField.trim()
    if (!name || drafts.some((draft) => draft.name === name)) return
    setDrafts([...drafts, { ...draftFor(name, 'string', ''), dirty: true, added: true }])
    setRemoved((previous) => previous.filter((item) => item !== name))
    setNewField('')
  }

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
      <div className="shrink-0 border-b border-kumo-line px-3 py-2">
        <Tabs
          size="sm"
          variant="segmented"
          value={workbench.tab}
          onValueChange={(value) => workbench.setTab(value as 'fields' | 'json')}
          tabs={[
            { value: 'fields', label: `Fields · ${drafts.length}` },
            { value: 'json', label: 'JSON' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {workbench.tab === 'fields' ? (
          <div className="grid gap-0.5 p-2">
            {drafts.map((draft, index) => (
              <FieldEditor
                key={draft.name}
                draft={draft}
                onChange={(next) => setDrafts(drafts.map((item, i) => (i === index ? next : item)))}
                onRemove={() => {
                  setDrafts(drafts.filter((_, i) => i !== index))
                  if (!draft.added) setRemoved((previous) => [...previous, draft.name])
                }}
                onOpenReference={(path) => workbench.setPath(path)}
              />
            ))}
            {removed.length > 0 && (
              <div className="px-2 py-1">
                <Text variant="secondary" size="sm">
                  Removing {removed.join(', ')} on save
                </Text>
              </div>
            )}
            <div className="flex items-center gap-1 px-2 pt-2">
              <input
                value={newField}
                onChange={(event) => setNewField(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addField()
                  }
                }}
                placeholder="New field name"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line outline-none placeholder:font-sans placeholder:text-kumo-inactive focus:ring-kumo-focus"
                aria-label="New field name"
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<PlusIcon />}
                onClick={addField}
                disabled={!newField.trim()}
              >
                Add field
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-2 p-3">
            <textarea
              value={json}
              onChange={(event) => setJson(event.target.value)}
              spellCheck={false}
              className="min-h-64 w-full resize-y rounded-md bg-kumo-control p-2 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
              aria-label="Document JSON"
            />
            {jsonError && (
              <Text variant="error" size="sm">
                {jsonError}
              </Text>
            )}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={applyJson}>
                Apply to fields
              </Button>
              <Text variant="secondary" size="sm">
                Timestamps and references keep their type when unchanged.
              </Text>
            </div>
          </div>
        )}
      </div>
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

function toJsonValue(value: FsValue): unknown {
  switch (value.type) {
    case 'timestamp':
      return value.value
    case 'reference':
      return value.path
    default:
      return fieldsToJson({ v: value }).v
  }
}
