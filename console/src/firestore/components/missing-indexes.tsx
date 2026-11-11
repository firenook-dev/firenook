// The indexes production would refuse the app's queries for, in the
// workbench: a toolbar button that appears once a query has needed one, and
// a panel under the toolbar that lists them.
//
// Each index is said the way the query plan says one — the collection and
// its fields — with the query that needed it, how many queries did, and the
// entry to copy. Saving firestore.indexes.json puts it in force at once: the
// row turns to "declared" while the page watches, which is the confirmation
// a person is after. The list is the app's queries only; the console's own
// are never counted.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import { CheckCircleIcon, TreeStructureIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { CopyGlyph, useCopied } from '@/components/kit'
import { RelativeTime } from '@/components/console/relative-time'
import { formatNumber } from '../value'
import {
  type MissingIndexItem,
  type MissingIndexList,
  describeQuery,
  describeTarget,
  formatEntry,
  missingFile,
  stillMissing,
  useMissingIndexes,
} from '../indexes'
import { modeMark } from './explain-panel'

/** How many rows the panel draws; the rest are counted, and copied with "Copy all". */
const ROWS = 100

/** Whether the panel is open: `?indexes=true`, so the view is a link. */
export function useIndexesPanel(): [boolean, (open: boolean) => void] {
  const open = useSearch({ from: '/firestore', select: (search) => Boolean(search.indexes) })
  const navigate = useNavigate({ from: '/firestore' })
  const setOpen = (next: boolean) =>
    void navigate({ search: (previous) => ({ ...previous, indexes: next || undefined }) })
  return [open, setOpen]
}

/**
 * The toolbar's word on missing indexes: absent until a query has needed
 * one, so a project with every index declared sees nothing here.
 */
export function MissingIndexesButton() {
  const { list } = useMissingIndexes()
  const [open, setOpen] = useIndexesPanel()
  const missing = stillMissing(list).length
  if (!open && missing === 0) return null
  const words =
    missing === 0
      ? 'Indexes declared'
      : `${formatNumber(missing)} ${missing === 1 ? 'index' : 'indexes'} missing`
  return (
    <Tooltip
      content="Indexes production would refuse the app's queries for, until firestore.indexes.json declares them (i)"
      render={
        <Button
          variant="ghost"
          size="sm"
          // Pressed while the panel is open, as a toggle shows it.
          className={`${missing > 0 ? 'text-kumo-warning' : ''} ${open ? 'bg-kumo-tint' : ''}`}
          icon={missing > 0 ? <WarningIcon /> : <CheckCircleIcon />}
          aria-pressed={open}
          aria-label={words}
          onClick={() => setOpen(!open)}
          data-testid="missing-indexes-button"
          data-missing={missing}
        >
          {/* The words give way first on a narrow window; the count stays. */}
          <span className="hidden xl:inline">{words}</span>
          <span className="xl:hidden">{missing > 0 ? formatNumber(missing) : null}</span>
        </Button>
      }
    />
  )
}

export function MissingIndexesPanel({ onClose }: { onClose: () => void }) {
  const { list, error } = useMissingIndexes()
  return (
    <section
      className="grid max-h-[45vh] shrink-0 grid-rows-[auto_minmax(0,1fr)] border-b border-kumo-line bg-kumo-base"
      data-testid="missing-indexes"
      aria-label="Missing indexes"
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
          <TreeStructureIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          {error ? (
            <Text variant="error" size="sm">
              {error.message}
            </Text>
          ) : list ? (
            <Headline list={list} />
          ) : (
            <Text variant="secondary" size="sm">
              Reading the indexes…
            </Text>
          )}
        </div>
        {list ? <CopyAll list={list} /> : null}
        <Button
          variant="ghost"
          size="sm"
          icon={<XIcon />}
          onClick={onClose}
          aria-label="Close the missing indexes"
        />
      </div>
      {list ? <Rows list={list} /> : null}
    </section>
  )
}

/** A file's name, which is how people know it; the whole path is a hover away. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function Headline({ list }: { list: MissingIndexList }) {
  const missing = stillMissing(list).length
  const file = list.files.length === 1 ? fileName(list.files[0]?.path ?? '') : 'the index file'
  // Once a saved file declares some, the sentence is about the rest, in
  // agreement with how many are left.
  const some = missing < list.indexes.length
  const one = missing === 1
  const queries = one ? 'the query still marked missing' : 'the queries still marked missing'
  const their = one ? 'its index' : 'their indexes'
  const said =
    list.indexes.length === 0
      ? 'No query has needed an index the index file does not declare.'
      : missing === 0
        ? `${file} declares every index the app's queries needed.`
        : list.strict
          ? some
            ? `--strict-indexes refuses ${queries}, as production does, until ${file} declares ${their}.`
            : `--strict-indexes refuses these queries, as production does, until ${file} declares their indexes.`
          : some
            ? `Production would refuse ${queries}: ${file} does not declare ${their} yet.`
            : `Production would refuse these queries: ${file} does not declare their indexes. The emulator answers them.`
  return (
    <div className="grid gap-1">
      <Text size="sm" as="p" data-testid="missing-indexes-headline">
        {said}
      </Text>
      {list.files.length === 0 ? (
        <Text variant="secondary" size="sm" as="p">
          firebase.json names no indexes file, so every composite index counts as missing.
        </Text>
      ) : (
        <Text variant="secondary" size="sm" as="p">
          Saving the file puts it in force at once, with no restart.
        </Text>
      )}
      {list.files
        .filter((entry) => entry.problem)
        .map((entry) => (
          <p key={entry.database} title={entry.path} data-testid="missing-indexes-file-problem">
            <Text variant="error" size="sm">
              {fileName(entry.path)} is not valid: {entry.problem}. The indexes it last declared
              stay in force.
            </Text>
          </p>
        ))}
    </div>
  )
}

/** One button per database with indexes missing: the entries as an index file. */
function CopyAll({ list }: { list: MissingIndexList }) {
  const databases = [...new Set(stillMissing(list).map((item) => item.database))]
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {databases.map((database) => (
        <CopyFile
          key={database}
          database={database}
          list={list}
          named={databases.length > 1}
        />
      ))}
    </div>
  )
}

function CopyFile({
  database,
  list,
  named,
}: {
  database: string
  list: MissingIndexList
  named: boolean
}) {
  const { copied, copy } = useCopied()
  const path = list.files.find((file) => file.database === database)?.path
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<CopyGlyph copied={copied} />}
      onClick={() => void copy(missingFile(list.indexes, database))}
      title={`Copy every missing index of database ${database} as an index file${path ? `, to merge into ${path}` : ''}`}
      data-testid="copy-missing-file"
    >
      {copied ? 'Copied' : named ? `Copy all (${database})` : 'Copy all'}
    </Button>
  )
}

function Rows({ list }: { list: MissingIndexList }) {
  const databases = new Set(list.indexes.map((item) => item.database))
  const shown = list.indexes.slice(0, ROWS)
  const hidden = list.indexes.length - shown.length
  if (shown.length === 0) return null
  return (
    <div className="min-h-0 overflow-y-auto px-3 pb-2.5">
      <ul className="grid gap-1.5" data-testid="missing-indexes-list">
        {shown.map((item) => (
          <Row
            key={`${item.database}|${item.section}|${JSON.stringify(item.entry)}`}
            item={item}
            showDatabase={databases.size > 1 || item.database !== '(default)'}
          />
        ))}
      </ul>
      {hidden > 0 || list.unlisted > 0 ? (
        <Text variant="secondary" size="sm" as="p">
          {hidden > 0 ? `${formatNumber(hidden)} more not drawn here; Copy all copies them. ` : ''}
          {list.unlisted > 0
            ? `${formatNumber(list.unlisted)} more queries needed indexes past the first 1,000 listed.`
            : ''}
        </Text>
      ) : null}
    </div>
  )
}

function Row({ item, showDatabase }: { item: MissingIndexItem; showDatabase: boolean }) {
  const { copied, copy } = useCopied()
  return (
    <li
      className={`grid gap-1 rounded-md p-2.5 ring ${
        item.declared ? 'ring-kumo-hairline' : 'bg-kumo-warning-tint ring-kumo-warning'
      }`}
      data-testid="missing-index"
      data-declared={item.declared}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`flex shrink-0 items-center ${item.declared ? 'text-kumo-success' : 'text-kumo-warning'}`}
        >
          {item.declared ? <CheckCircleIcon size={16} /> : <WarningIcon size={16} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="font-mono text-[12px] text-kumo-subtle">{item.collectionGroup}</span>
          {item.fields.map((field) => (
            <span
              key={field.fieldPath}
              className={`flex h-5 items-center rounded px-1.5 font-mono text-[11px] text-kumo-default ${
                item.declared ? 'bg-kumo-tint' : 'bg-kumo-base'
              }`}
            >
              {field.fieldPath}
              <span className="pl-1 text-kumo-subtle">{modeMark(field)}</span>
            </span>
          ))}
          {item.scope === 'collectionGroup' ? (
            <span className="text-[12px] text-kumo-subtle">collection group</span>
          ) : null}
          {showDatabase ? (
            <span className="text-[12px] text-kumo-subtle">database {item.database}</span>
          ) : null}
        </div>
        {item.declared ? (
          <Text variant="secondary" size="sm">
            Declared now
          </Text>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<CopyGlyph copied={copied} />}
            onClick={() => void copy(formatEntry(item))}
            title={`Copy the entry to add under "${item.section}" in the index file`}
            data-testid="copy-missing-entry"
          >
            {copied ? 'Copied' : 'Copy entry'}
          </Button>
        )}
      </div>
      <p className="grid gap-0.5 pl-7 text-[12px]">
        <code
          className="font-mono break-all text-kumo-default"
          data-testid="missing-index-query"
        >
          {describeQuery(item.query) || 'every document'}
        </code>
        <span className="text-kumo-subtle" data-testid="missing-index-count">
          on {describeTarget(item.query)},{' '}
          {item.queries === 1 ? '1 query' : `${formatNumber(item.queries)} queries, the latest`}{' '}
          <RelativeTime iso={item.lastSeen} className="text-kumo-subtle" />
          {item.section === 'fieldOverrides' ? ', under fieldOverrides' : ''}
        </span>
      </p>
    </li>
  )
}
