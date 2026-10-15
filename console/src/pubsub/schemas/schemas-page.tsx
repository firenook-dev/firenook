// Pub/Sub's Schemas page (S17, PS-50…PS-56): every schema of the project in
// the panel; row one with the schema's name and what acts on all of it
// (delete, a new one); row two with its tabs — Definition, Revisions, Used
// by — and the test panel's toggle and Commit; then the definition in an
// editor the engine's own parser checks as it is typed, an older revision
// read-only in its place or diffed against it, and the test panel beside.
// The counters topic's `resources` events keep the list current when a
// schema is made or changed anywhere.

import { Button, Tabs, Tooltip } from '@cloudflare/kumo'
import {
  BracketsCurlyIcon,
  FloppyDiskIcon,
  FlaskIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { PubsubSchemaRevision } from '@/api/generated/messaging/PubsubSchemaRevision'
import type { PubsubSchemaSummary } from '@/api/generated/messaging/PubsubSchemaSummary'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState, QueryError } from '@/components/console/empty-state'
import { LiveNotice } from '@/components/console/live-notice'
import { RelativeTime } from '@/components/console/relative-time'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import {
  SectionToolbar,
  ToolbarDivider,
  ToolbarField,
  ToolbarRow,
} from '@/components/console/toolbar'
import { CopyGlyph, Kbd, useCopied } from '@/components/kit'
import { PanelToggle } from '@/components/shell/section-panel'
import { formatNumber } from '@/lib/format'
import { liveChannel } from '@/lib/live/channel'
import { useLayout } from '@/lib/layout'
import { type PaletteItem, matchesQuery, usePaletteProviders } from '@/lib/palette'
import { useConsoleProject } from '@/lib/project'
import { useRouteSearch } from '@/lib/search-params'
import { describeKey, useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { errorText } from '@/lib/error-text'
import { resourceFromSearch } from '@/messaging/links'
import type { SchemasSearch } from '@/routes/pubsub_.schemas'
import { commitSchema, deleteSchema, rollbackSchema } from '../api'
import { usePubsubCounters } from '../live'
import { searchValue, shortName } from '../names'
import { pubsubKeys, schemaQuery, schemasQuery } from '../queries'
import { CreateSchemaDialog } from './create-schema-dialog'
import { RevisionsList, UsedByList } from './revisions-list'
import { SchemaEditor, useDefinitionCheck } from './schema-editor'
import { SCHEMA_FILTER_ID, SchemasPanel } from './schemas-panel'
import { prettyDefinition, revisionLabel, sameDefinition } from './schema-text'
import { TestMessage } from './test-message'

type SchemaView = 'definition' | 'revisions' | 'used-by'

/** Every parameter that belongs to one schema: cleared when the schema changes. */
const SCOPED = {
  schema: undefined,
  revision: undefined,
  diff: undefined,
  view: undefined,
  panel: undefined,
} satisfies Partial<SchemasSearch>

/** `/` and `f`: the panel's filter, the panel shown first if it was hidden. */
function focusFilter() {
  useLayout.getState().setPanelOpen(true)
  requestAnimationFrame(() =>
    document.querySelector<HTMLInputElement>(`[data-testid="${SCHEMA_FILTER_ID}"]`)?.focus(),
  )
}

export function SchemasPage() {
  const status = useQuery(statusQuery)
  const configured = status.data?.projectId
  const { project } = useConsoleProject()
  const { search, update } = useRouteSearch<SchemasSearch>('/pubsub_/schemas', '/pubsub/schemas')
  const queryClient = useQueryClient()
  const schemas = useQuery(schemasQuery(project))
  const schema = resourceFromSearch(search.schema, 'schemas', project)
  const summary = schemas.data?.items.find((item) => item.name === schema)
  // The schemas list and its details follow the counters topic's `resources` events.
  const live = usePubsubCounters(project || undefined)

  // Links always name the project; the configured one need not show.
  useEffect(() => {
    if (configured !== undefined && search.project === configured)
      update({ project: undefined }, { replace: true })
  }, [configured, search.project, update])

  const open = (name: string | undefined) =>
    update({
      ...SCOPED,
      ...(name ? { schema: searchValue(name, 'schemas', project) } : {}),
    })
  const create = () => update({ new: 'schema' })

  // Deleting the schema in view: the topics bound to it are named first.
  const [deleting, setDeleting] = useState(false)
  const remove = useMutation({
    mutationFn: (name: string) => deleteSchema({ name }),
    onSuccess: (_answer, name) => {
      setDeleting(false)
      queryClient.removeQueries({ queryKey: pubsubKeys.schema(project, name) })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.schemas(project) })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topicDetails(project) })
      toast({ key: `pubsub-schema-${name}`, title: `Deleted ${shortName(name)}` })
      open(undefined)
    },
  })

  useShortcuts({ id: 'pubsub-schemas', label: 'Pub/Sub schemas' }, [
    { key: 'n', label: 'New schema', run: create },
    { key: '/', label: 'Filter the schemas', run: focusFilter },
    { key: 'f', label: 'Filter the schemas', run: focusFilter },
  ])
  useSchemasPalette({
    schema: summary ? schema : undefined,
    onCreate: create,
    onTest: () => update({ panel: 'test' }),
  })

  return (
    <SectionPage
      section="pubsub"
      page="schemas"
      title="Pub/Sub schemas"
      testId="pubsub-schemas-page"
    >
      <SchemasPanel
        schemas={schemas.data?.items ?? []}
        project={project}
        current={schema}
        onOpen={open}
        onProject={(next) => update({ ...SCOPED, project: next === configured ? undefined : next })}
      />
      <SectionToolbar testId="pubsub-schemas-toolbar">
        <ToolbarRow testId="pubsub-schemas-row-one">
          <PanelToggle where="toolbar" />
          <SchemaPath project={project} schema={schema} onRoot={() => open(undefined)} />
          <ToolbarDivider />
          <LiveNotice
            status={live}
            what="the schemas"
            onRetry={() => liveChannel.retry()}
            testId="pubsub-schemas-live"
          />
          {schema && summary && (
            <Tooltip
              content={
                summary.usedBy.length > 0
                  ? `Delete ${summary.id}: the ${summary.usedBy.length === 1 ? 'topic' : `${summary.usedBy.length} topics`} bound to it refuse every publish after`
                  : `Delete ${summary.id} and every revision`
              }
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<TrashIcon className="text-kumo-danger" />}
                  onClick={() => {
                    remove.reset()
                    setDeleting(true)
                  }}
                  data-testid="pubsub-schema-delete"
                >
                  <span className="text-kumo-danger">Delete…</span>
                </Button>
              }
            />
          )}
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                New schema <Kbd>n</Kbd>
              </span>
            }
            render={
              <Button
                variant={schema ? 'secondary' : 'primary'}
                size="sm"
                icon={<PlusIcon />}
                onClick={create}
                data-testid="pubsub-new-schema"
              >
                New schema
              </Button>
            }
          />
        </ToolbarRow>
      </SectionToolbar>
      {schema ? (
        <SchemaView
          key={schema}
          project={project}
          schema={schema}
          search={search}
          update={update}
          onCreate={create}
        />
      ) : (
        <SectionBody testId="pubsub-schemas-body">
          <SchemasLanding
            schemas={schemas.data?.items}
            error={schemas.error}
            onRetry={() => void schemas.refetch()}
            loading={schemas.isPending}
            onOpen={open}
            onCreate={create}
          />
        </SectionBody>
      )}
      <CreateSchemaDialog
        open={search.new === 'schema'}
        project={project}
        onOpenChange={(next) => {
          if (!next) update({ new: undefined }, { replace: true })
        }}
        onCreated={(name) => open(name)}
      />
      <DangerConfirm
        open={deleting}
        onOpenChange={(next) => !next && setDeleting(false)}
        title={`Delete ${summary?.id ?? ''}`}
        description="The schema and every one of its revisions go."
        consequences={
          summary && summary.usedBy.length > 0
            ? [
                <span key="bound">
                  {summary.usedBy.map((topic) => shortName(topic)).join(', ')}{' '}
                  {summary.usedBy.length === 1 ? 'shows' : 'show'}{' '}
                  <span className="font-mono text-[0.9em]">_deleted-schema_</span> and{' '}
                  {summary.usedBy.length === 1 ? 'refuses' : 'refuse'} every publish until{' '}
                  {summary.usedBy.length === 1 ? 'it is' : 'they are'} created again, as production
                  does.
                </span>,
              ]
            : ['No topic uses it.']
        }
        {...(remove.isError ? { error: errorText(remove.error) } : {})}
        pending={remove.isPending}
        onConfirm={() => schema && remove.mutate(schema)}
        testId="pubsub-schema-delete-confirm"
      />
    </SectionPage>
  )
}

/** Row one's path: `project › schema`, the copy of the full name at its right edge. */
function SchemaPath({
  project,
  schema,
  onRoot,
}: {
  project: string
  schema: string | undefined
  onRoot: () => void
}) {
  const { copied, copy } = useCopied()
  const full = schema ?? `projects/${project}`
  return (
    <ToolbarField
      testId="pubsub-schema-path"
      trailing={
        <Tooltip
          content={copied ? 'Copied' : `Copy ${full}`}
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CopyGlyph copied={copied} />}
              aria-label="Copy the full name"
              className="h-7 w-7 shrink-0"
              onClick={() => void copy(full)}
              data-testid="pubsub-schema-copy"
            />
          }
        />
      }
    >
      <span className="flex min-w-0 items-center">
        {schema ? (
          <button
            type="button"
            onClick={onRoot}
            className="flex h-7 shrink-0 items-center rounded-md px-1.5 font-mono text-[12px] text-kumo-subtle hover:ink hover:text-kumo-default"
          >
            {project === '' ? '(empty project)' : project}
          </button>
        ) : (
          <span className="flex h-7 items-center px-1.5 font-mono text-[12px] text-kumo-default">
            {project === '' ? '(empty project)' : project}
          </span>
        )}
        {schema && (
          <>
            <span className="px-0.5 text-[12px] text-kumo-inactive" aria-hidden>
              ›
            </span>
            <span
              className="flex h-7 min-w-0 items-center truncate px-1.5 font-mono text-[12px] text-kumo-default"
              aria-current="location"
              data-testid="pubsub-schema-name"
            >
              {shortName(schema)}
            </span>
          </>
        )}
      </span>
    </ToolbarField>
  )
}

const SCHEMA_COLUMNS: readonly DataTableColumn<PubsubSchemaSummary>[] = [
  { id: 'id', header: 'Schema', width: 240, cell: (row) => row.id, copy: (row) => row.name },
  {
    id: 'kind',
    header: 'Type',
    width: 80,
    cell: (row) => <span className="font-sans">{row.kind === 'AVRO' ? 'Avro' : row.kind}</span>,
  },
  {
    id: 'revisions',
    header: 'Revisions',
    width: 96,
    align: 'end',
    cell: (row) => formatNumber(row.revisions),
  },
  {
    id: 'latest',
    header: 'Latest revision',
    width: 200,
    cell: (row) => (
      <span className="inline-flex items-center gap-2 align-middle">
        {revisionLabel(row.latestRevisionId)}
        <RelativeTime iso={row.latestCreatedAt} className="text-kumo-subtle" />
      </span>
    ),
    copy: (row) => row.latestRevisionId,
  },
  {
    id: 'used-by',
    header: 'Used by',
    width: 280,
    cell: (row) =>
      row.usedBy.length === 0 ? (
        <span className="text-kumo-inactive">—</span>
      ) : (
        row.usedBy.map((topic) => shortName(topic)).join(', ')
      ),
    copy: (row) => row.usedBy.join('\n'),
  },
]

function SchemasLanding({
  schemas,
  error,
  onRetry,
  loading,
  onOpen,
  onCreate,
}: {
  schemas: readonly PubsubSchemaSummary[] | undefined
  error: unknown
  onRetry: () => void
  loading: boolean
  onOpen: (name: string) => void
  onCreate: () => void
}) {
  if (error) return <QueryError error={error} onRetry={onRetry} section="pubsub" />
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-schemas-landing">
      <DataTable
        ariaLabel="Schemas"
        rows={schemas ?? []}
        rowKey={(row) => row.name}
        columns={SCHEMA_COLUMNS}
        memoryKey="pubsub.schemas"
        onOpen={(row) => onOpen(row.name)}
        rowClick="open"
        loading={loading}
        empty={
          <EmptyState
            icon={BracketsCurlyIcon}
            title="No schemas"
            description="A schema makes a topic refuse messages that do not match it, as production does. Create one from your app, or here."
            actions={
              <div className="grid w-[min(560px,100%)] justify-items-center gap-4">
                <div className="w-full text-left">
                  <CodeBlock
                    label="From your app"
                    code={CREATE_SCHEMA_SNIPPET}
                    language="js"
                    testId="pubsub-schemas-snippet"
                  />
                </div>
                <Button
                  variant="primary"
                  icon={<PlusIcon />}
                  onClick={onCreate}
                  data-testid="pubsub-schemas-empty-new"
                >
                  New schema
                </Button>
              </div>
            }
            testId="pubsub-schemas-empty"
          />
        }
        testId="pubsub-schemas-table"
      />
    </div>
  )
}

/** How an app creates a schema, for the empty state. */
export const CREATE_SCHEMA_SNIPPET = `import { PubSub, SchemaTypes } from '@google-cloud/pubsub'

await new PubSub().createSchema(
  'order',
  SchemaTypes.Avro,
  JSON.stringify({
    type: 'record',
    name: 'Order',
    fields: [{ name: 'id', type: 'string' }],
  }),
)`

/** The editor's text and the revision it started from. */
interface Draft {
  text: string
  base: string | undefined
}

function SchemaView({
  project,
  schema,
  search,
  update,
  onCreate,
}: {
  project: string
  schema: string
  search: SchemasSearch
  update: (patch: Partial<SchemasSearch>, options?: { replace?: boolean }) => void
  onCreate: () => void
}) {
  const queryClient = useQueryClient()
  const query = useQuery(schemaQuery(project, schema))
  const detail = query.data
  const latest = detail?.revisions.at(-1)
  const view: SchemaView = search.view ?? 'definition'

  // The editor's text follows the latest revision until it is edited; an
  // edit is kept when a new revision arrives (from here or elsewhere).
  const [draft, setDraft] = useState<Draft>({ text: '', base: undefined })
  if (latest && draft.base !== latest.id) {
    const before = detail?.revisions.find((revision) => revision.id === draft.base)
    const untouched =
      draft.base === undefined || !before || sameDefinition(draft.text, before.definition)
    setDraft({
      text: untouched ? prettyDefinition(latest.definition) : draft.text,
      base: latest.id,
    })
  }
  const edited = latest !== undefined && !sameDefinition(draft.text, latest.definition)
  const { check } = useDefinitionCheck(project, detail?.kind ?? 'AVRO', draft.text)
  const committable = edited && check?.ok === true

  const commit = useMutation({
    mutationFn: (definition: string) => commitSchema({ name: schema, definition }),
    onSuccess: (answer) => {
      queryClient.setQueryData(pubsubKeys.schema(project, schema), answer)
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.schemas(project) })
      const made = answer.revisions.at(-1)
      toast({
        key: `pubsub-schema-${schema}`,
        title: `Committed revision ${made ? revisionLabel(made.id) : ''} of ${shortName(schema)}`,
        tone: 'success',
      })
    },
    onError: (error) =>
      toast({
        key: `pubsub-schema-${schema}`,
        title: `Could not commit ${shortName(schema)}`,
        description: errorText(error),
        tone: 'danger',
      }),
  })
  const rollback = useMutation({
    mutationFn: (revision: PubsubSchemaRevision) =>
      rollbackSchema({ name: schema, revisionId: revision.id }),
    onSuccess: (answer, revision) => {
      queryClient.setQueryData(pubsubKeys.schema(project, schema), answer)
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.schemas(project) })
      const made = answer.revisions.at(-1)
      update({ revision: undefined, diff: undefined, view: undefined }, { replace: true })
      toast({
        key: `pubsub-schema-${schema}`,
        title: `Rolled back ${shortName(schema)}`,
        description: `Revision ${made ? revisionLabel(made.id) : ''} has the definition of ${revisionLabel(revision.id)}.`,
        tone: 'success',
      })
    },
    onError: (error) =>
      toast({
        key: `pubsub-schema-${schema}`,
        title: `Could not roll back ${shortName(schema)}`,
        description: errorText(error),
        tone: 'danger',
      }),
  })

  const shown = search.revision
    ? detail?.revisions.find((revision) => revision.id === search.revision)
    : undefined
  const diffed = search.diff
    ? detail?.revisions.find((revision) => revision.id === search.diff)
    : undefined
  const closeRevision = () => update({ revision: undefined, diff: undefined }, { replace: true })
  const testing = search.panel === 'test'

  useShortcuts({ id: 'pubsub-schema', label: 'Schema' }, [
    {
      key: 'Mod+s',
      label: 'Commit the definition as a new revision',
      allowInInputs: true,
      run: () => {
        if (committable && !commit.isPending) commit.mutate(draft.text)
      },
    },
    {
      key: 'Escape',
      label: 'Close the test panel, then the revision',
      when: () => testing || shown !== undefined || diffed !== undefined,
      run: () => {
        if (testing) update({ panel: undefined }, { replace: true })
        else closeRevision()
      },
    },
  ])

  if (query.error instanceof ApiError && query.error.code === 'not-found')
    return (
      <SectionBody testId="pubsub-schemas-body">
        <EmptyState
          icon={BracketsCurlyIcon}
          title={`${shortName(schema)} does not exist`}
          description="It was deleted, or the link names a schema this run of the emulator never had."
          actions={
            <Button variant="primary" icon={<PlusIcon />} onClick={onCreate}>
              New schema
            </Button>
          }
          testId="pubsub-schema-missing"
        />
      </SectionBody>
    )

  return (
    <>
      <ToolbarRow variant="line" testId="pubsub-schema-tabs">
        <Tabs
          variant="underline"
          size="sm"
          value={view}
          onValueChange={(next) =>
            update({ view: next === 'definition' ? undefined : (next as SchemaView) })
          }
          tabs={[
            { value: 'definition', label: 'Definition' },
            {
              value: 'revisions',
              label: (
                <span>
                  Revisions{' '}
                  <span className="font-mono text-[11px] text-kumo-subtle">
                    {formatNumber(detail?.revisions.length ?? 0)}
                  </span>
                </span>
              ),
            },
            {
              value: 'used-by',
              label: (
                <span>
                  Used by{' '}
                  <span className="font-mono text-[11px] text-kumo-subtle">
                    {formatNumber(detail?.usedBy.length ?? 0)}
                  </span>
                </span>
              ),
            },
          ]}
        />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Tooltip
            content="Check a message against this schema, or one of its revisions"
            render={
              <Button
                variant={testing ? 'secondary' : 'ghost'}
                size="sm"
                icon={<FlaskIcon />}
                aria-pressed={testing}
                onClick={() => update({ panel: testing ? undefined : 'test' }, { replace: true })}
                data-testid="pubsub-schema-test-toggle"
              >
                Test message
              </Button>
            }
          />
          {view === 'definition' && !shown && !diffed && (
            <Tooltip
              content={
                <span className="flex items-center gap-1.5">
                  {committable
                    ? 'Commit the editor as a new revision'
                    : edited
                      ? 'Fix the definition first'
                      : 'Edit the definition to commit a new revision'}
                  <Kbd>{describeKey('Mod+s')}</Kbd>
                </span>
              }
              render={
                <span className="flex">
                  <Button
                    variant={committable ? 'primary' : 'secondary'}
                    size="sm"
                    icon={<FloppyDiskIcon />}
                    disabled={!committable}
                    loading={commit.isPending}
                    onClick={() => commit.mutate(draft.text)}
                    data-testid="pubsub-schema-commit"
                  >
                    Commit
                  </Button>
                </span>
              }
            />
          )}
        </span>
      </ToolbarRow>
      <SectionBody testId="pubsub-schemas-body">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {query.isError ? (
            <QueryError error={query.error} onRetry={() => void query.refetch()} section="pubsub" />
          ) : !detail ? null : view === 'revisions' ? (
            <RevisionsList
              project={project}
              detail={detail}
              current={search.revision}
              onView={(revision) =>
                update({
                  view: undefined,
                  revision: revision === latest?.id ? undefined : revision,
                  diff: undefined,
                })
              }
              onDiff={(revision) =>
                update({ view: undefined, diff: revision, revision: undefined })
              }
              onRollback={(revision) => rollback.mutate(revision)}
            />
          ) : view === 'used-by' ? (
            <UsedByList detail={detail} />
          ) : (
            <SchemaEditor
              project={project}
              detail={detail}
              draft={draft.text}
              onDraft={(text) => setDraft({ text, base: draft.base })}
              revision={shown}
              diff={diffed}
              onCloseRevision={closeRevision}
              onRollback={(revision) => rollback.mutate(revision)}
              rolling={rollback.isPending}
            />
          )}
        </div>
        {testing && detail && (
          <TestMessage
            project={project}
            detail={detail}
            onClose={() => update({ panel: undefined }, { replace: true })}
          />
        )}
      </SectionBody>
    </>
  )
}

/** What the page offers ⌘K while it is on screen. */
function useSchemasPalette({
  schema,
  onCreate,
  onTest,
}: {
  schema: string | undefined
  onCreate: () => void
  onTest: () => void
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const actions = useRef({ schema, onCreate, onTest })
  useLayoutEffect(() => {
    actions.current = { schema, onCreate, onTest }
  })
  useEffect(() => {
    register('pubsub-schemas', (query) => {
      const { schema: current, onCreate: create, onTest: test } = actions.current
      const items: PaletteItem[] = [
        {
          id: 'pubsub.schemas.new',
          title: 'New schema',
          keywords: 'create avro pubsub',
          icon: <PlusIcon size={16} />,
          run: create,
        },
        ...(current
          ? [
              {
                id: 'pubsub.schemas.test',
                title: `Test a message against ${shortName(current)}`,
                keywords: 'check validate avro',
                icon: <FlaskIcon size={16} />,
                run: test,
              },
            ]
          : []),
      ].filter((item) => matchesQuery(item, query))
      return items.length > 0 ? [{ label: 'Pub/Sub schemas', items }] : []
    })
    return () => unregister('pubsub-schemas')
  }, [register, unregister, actions])
}
