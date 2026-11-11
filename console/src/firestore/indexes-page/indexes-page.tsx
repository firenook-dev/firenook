// The Firestore indexes of one database, as a page of their own, the way
// Firebase's console files them beside Data and Rules: the file they are
// declared in, the indexes the app's queries needed that it does not
// declare, and what it declares — composite indexes and single-field
// overrides.
//
// The file is the one source here. Production keeps indexes in the project
// and the file is what a deploy sends; the emulator has nothing but the
// file. So Add writes the entry into `firestore.indexes.json` and Remove
// takes it out, as a person would in an editor, and the engine puts the
// file in force at once: the row that needed it turns to declared while the
// page watches. A save in an editor does the same, and every open page
// follows it.

import { LayerCard, Text } from '@cloudflare/kumo'
import { FileTextIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '@/api/client'
import { SectionPage } from '@/components/console/section-page'
import { Page } from '@/components/shell/page'
import { useRouteSearch } from '@/lib/search-params'
import { DatabasePicker } from '../components/database-picker'
import { DEFAULT_DATABASE } from '../components/workbench-context'
import {
  type DatabaseIndexes,
  type DeclaredIndexList,
  type IndexFileEntry,
  databaseFile,
  declaredIndexesKey,
  editIndexes,
  missingIndexesKey,
  neededIn,
  useIndexes,
} from '../indexes'
import { DeclaredFieldOverrides, DeclaredIndexes } from './declared-indexes'
import { fileName } from './file-name'
import { NeededIndexes } from './needed-indexes'

/** The page's search params (`routes/firestore_.indexes.tsx`). */
export type IndexesSearch = {
  db?: string | undefined
}

/** One edit the page is making: what it adds and takes out, and which control asked. */
export interface IndexEdit {
  /** The control that asked, so its button alone shows the wait. */
  key: string
  add: IndexFileEntry[]
  remove: IndexFileEntry[]
}

/** What a part of the page needs to change the file. */
export interface IndexEditing {
  /** Why the file cannot be changed here, when it cannot. */
  blocked: string | undefined
  /** The key of the edit under way. */
  pending: string | undefined
  /** Why the last edit was refused, and which control asked for it. */
  error: Error | null
  errorKey: string | undefined
  /** Whether `--strict-indexes` refuses a query whose index is not declared. */
  strict: boolean
  run: (edit: IndexEdit, then?: () => void) => void
}

export function IndexesPage() {
  const { search, update } = useRouteSearch<IndexesSearch>(
    '/firestore_/indexes',
    '/firestore/indexes',
  )
  const database = search.db ?? DEFAULT_DATABASE
  const { declared, missing, error } = useIndexes()
  const file = databaseFile(declared, database)
  const editing = useIndexEditing(database, file, declared?.strict ?? false)
  const needed = neededIn(missing, database)

  return (
    <SectionPage
      section="firestore"
      page="indexes"
      title="Firestore indexes"
      testId="firestore-indexes"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Page className="mx-auto grid w-full max-w-[1080px] gap-8 pb-12">
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Text variant="heading" size="lg" as="h2">
                Indexes
              </Text>
              <DatabasePicker
                value={database}
                onChange={(next) =>
                  update({ db: next === DEFAULT_DATABASE ? undefined : next }, { replace: true })
                }
                className="w-60 shrink-0"
              />
            </div>
            {error ? (
              <Text variant="error">{error.message}</Text>
            ) : declared ? (
              <FileStatus file={file} database={database} strict={declared.strict} />
            ) : (
              <Text variant="secondary">Reading the indexes…</Text>
            )}
            {/* A refused Remove is said in its own dialog. */}
            {editing.error && !editing.errorKey?.startsWith('remove|') ? (
              <EditError error={editing.error} />
            ) : null}
          </div>
          {missing && needed.length > 0 ? (
            <NeededIndexes
              list={missing}
              items={needed}
              database={database}
              file={file}
              editing={editing}
            />
          ) : null}
          <Card
            id="composite"
            title="Composite indexes"
            count={file?.indexes.length}
            note="Indexes on two or more fields. Firestore never creates these by itself, and most queries that filter or sort on more than one field need one."
          >
            <DeclaredIndexes file={file} loading={!declared} editing={editing} />
          </Card>
          <Card
            id="single-field"
            title="Single-field overrides"
            count={file?.fieldOverrides.length}
            note="Firestore indexes every field automatically, within one collection. An override changes how one field is indexed. A collection group query on a single field needs one, because it searches every collection with that name."
          >
            <DeclaredFieldOverrides file={file} loading={!declared} editing={editing} />
          </Card>
        </Page>
      </div>
    </SectionPage>
  )
}

/**
 * Edits to `database`'s file, one at a time: each names the version of the
 * file the page read, and the answer is the file as it is in force now.
 */
function useIndexEditing(
  database: string,
  file: DatabaseIndexes | undefined,
  strict: boolean,
): IndexEditing {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (edit: IndexEdit) =>
      editIndexes({
        database,
        revision: file?.revision ?? null,
        add: edit.add,
        remove: edit.remove,
      }),
    onSuccess: (edited) => {
      queryClient.setQueryData<DeclaredIndexList>(declaredIndexesKey, (previous) =>
        previous
          ? {
              ...previous,
              databases: previous.databases.map((entry) =>
                entry.database === edited.file.database ? edited.file : entry,
              ),
            }
          : previous,
      )
      void queryClient.invalidateQueries({ queryKey: missingIndexesKey })
    },
    // Refused because the file changed: show it as it is now.
    onError: () => void queryClient.invalidateQueries({ queryKey: declaredIndexesKey }),
  })
  const blocked = !file
    ? `firebase.json does not name an index file for database ${database}`
    : file.problem
      ? `${fileName(file.path)} has an error. Fix it in your editor first.`
      : undefined
  return {
    blocked,
    pending: mutation.isPending ? mutation.variables?.key : undefined,
    error: mutation.error,
    errorKey: mutation.isError ? mutation.variables?.key : undefined,
    strict,
    run: (edit, then) => {
      mutation.reset()
      mutation.mutate(edit, { onSuccess: () => then?.() })
    },
  }
}

/** The file the database's indexes are declared in, and how the emulator holds them to it. */
function FileStatus({
  file,
  database,
  strict,
}: {
  file: DatabaseIndexes | undefined
  database: string
  strict: boolean
}) {
  const flag = <code className="font-mono text-[12px] whitespace-nowrap">--strict-indexes</code>
  const enforcement = strict ? (
    <>Started with {flag}: a query whose index is missing fails here, as it does in production.</>
  ) : (
    <>
      A query whose index is missing still runs in the emulator. Start the emulators with {flag} to
      make it fail, as it does in production.
    </>
  )
  if (!file)
    return (
      <div className="grid gap-1" data-testid="indexes-file">
        <Text as="p" data-testid="indexes-no-file">
          firebase.json does not name an index file for database {database}. Add{' '}
          <code className="font-mono text-[13px]">"indexes": "firestore.indexes.json"</code> under{' '}
          <code className="font-mono text-[13px]">"firestore"</code> and restart the emulators.
          Until then, Copy gives you each index as JSON to add yourself.
        </Text>
        <Text variant="secondary" size="sm" as="p">
          {enforcement}
        </Text>
      </div>
    )
  return (
    <div className="grid gap-1" data-testid="indexes-file">
      {/* The file name is the line's one strong word; the rest is said as
          every description on the page is. */}
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
        <FileTextIcon size={16} className="shrink-0 text-kumo-subtle" />
        <code className="font-mono text-[13px]" title={file.path} data-testid="indexes-file-name">
          {fileName(file.path)}
        </code>
        <Text variant="secondary" size="sm" as="span">
          Changes made here are saved to this file and apply right away. So do edits you save in
          your editor.
        </Text>
      </p>
      <Text variant="secondary" size="sm" as="p">
        {enforcement}
      </Text>
      {file.problem ? (
        <p
          className="m-0 flex items-start gap-2 text-[14px] text-kumo-danger"
          data-testid="indexes-file-problem"
        >
          <WarningCircleIcon size={16} className="mt-0.5 shrink-0" />
          <span>
            {fileName(file.path)} has an error: {file.problem}. Until you fix it, the emulator keeps
            using the indexes from the last version that worked.
          </span>
        </p>
      ) : null}
    </div>
  )
}

function EditError({ error }: { error: Error }) {
  const fix = error instanceof ApiError ? error.fix : undefined
  return (
    <p
      className="m-0 flex items-start gap-2 text-[14px] text-kumo-danger"
      role="alert"
      data-testid="indexes-edit-error"
    >
      <WarningCircleIcon size={16} className="mt-0.5 shrink-0" />
      <span>
        Not saved: {error.message}.{fix ? ` ${fix}` : ''}
      </span>
    </p>
  )
}

/** A section of the page: its heading with the count, a sentence on what it holds, the list. */
export function Card({
  id,
  title,
  count,
  countTone,
  note,
  action,
  framed = false,
  children,
}: {
  id: string
  title: string
  count?: number | undefined
  /** The count's colour when it is work to do: missing indexes, or refused queries. */
  countTone?: 'warning' | 'danger' | undefined
  note?: ReactNode
  action?: ReactNode
  /** In the card's frame: the tables have their own. */
  framed?: boolean
  children: ReactNode
}) {
  return (
    <section
      id={`firestore-indexes-${id}`}
      className="grid scroll-mt-4 gap-3"
      aria-label={title}
      data-testid={`indexes-${id}`}
    >
      <div className="grid gap-1">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Text variant="heading" as="h3">
            {title}
            {count !== undefined ? (
              <span
                className={`pl-2 tabular-nums ${
                  countTone === 'danger'
                    ? 'font-medium text-kumo-danger'
                    : countTone === 'warning'
                      ? 'font-medium text-kumo-warning'
                      : 'font-normal text-kumo-subtle'
                }`}
                data-testid={`indexes-${id}-count`}
              >
                {count}
              </span>
            ) : null}
          </Text>
          {action}
        </div>
        {note ? (
          <Text variant="secondary" size="sm" as="p">
            {note}
          </Text>
        ) : null}
      </div>
      {framed ? <LayerCard className="px-5 py-4">{children}</LayerCard> : children}
    </section>
  )
}
