// The indexes the app's queries needed that the file does not declare, as a
// table drawn like the two below it: the collection, the fields, the query
// that needed it (its fields and operators, never its values), when it last
// ran and how often, and Copy and Add. A row is the row Add puts in the
// table below, so the two read as one thing moving. The colour is one icon a
// row, not a box: the emulator answered these queries, so the list is work to
// do, not an error, except under --strict-indexes, where it refused them.
// Add writes the entry into the file; the row turns to "Added" once the
// engine has put the file in force, which is the confirmation a person is
// after. The list is the app's queries only; the console's own are never
// counted.

import { Button, Table, Text, Tooltip } from '@cloudflare/kumo'
import { CheckCircleIcon, PlusIcon, WarningIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { CopyGlyph, useCopied } from '@/components/kit'
import { RelativeTime } from '@/components/console/relative-time'
import {
  type DatabaseIndexes,
  type MissingIndexItem,
  type MissingIndexList,
  describeTarget,
  entryKey,
  entryOf,
  formatEntry,
  missingFile,
  queryClauses,
} from '../indexes'
import { formatNumber } from '../value'
import { FieldChips } from './field-chips'
import { fileName } from './file-name'
import { Card, type IndexEditing } from './indexes-page'

/** How many rows the table draws; the rest are counted, and copied or added with the card's buttons. */
const ROWS = 100

/** The edit key of Add all. */
const ADD_ALL = 'add-all'

export function NeededIndexes({
  list,
  items,
  database,
  file,
  editing,
}: {
  list: MissingIndexList
  /** This database's, the ones still missing first. */
  items: readonly MissingIndexItem[]
  database: string
  file: DatabaseIndexes | undefined
  editing: IndexEditing
}) {
  const missing = items.filter((item) => !item.declared)
  const name = file ? fileName(file.path) : 'the index file'
  const shown = items.slice(0, ROWS)
  const hidden = items.length - shown.length
  return (
    <Card
      id="needed"
      title="Missing indexes"
      count={missing.length}
      countTone={missing.length === 0 ? undefined : list.strict ? 'danger' : 'warning'}
      note={<Headline missing={missing.length} strict={list.strict} name={name} />}
      action={
        missing.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <CopyAll items={items} database={database} name={name} />
            <AddButton
              label="Add all"
              title={`Add every missing index to ${name}`}
              editing={editing}
              editKey={ADD_ALL}
              variant="primary"
              entries={missing}
              testId="add-missing-all"
            />
          </div>
        ) : null
      }
    >
      {/* The first two columns sit where the composite table's do, and the
          query keeps room for a clause a line: on a narrow window the table
          scrolls in its frame rather than squeeze it. */}
      <div
        className="overflow-x-auto rounded-lg bg-kumo-base ring ring-kumo-line"
        data-testid="missing-indexes-list"
      >
        <Table className="w-full min-w-[910px] table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: 180 }} />
            <col style={{ width: 240 }} />
            <col />
            <col style={{ width: 100 }} />
            <col style={{ width: 150 }} />
          </colgroup>
          <Table.Header variant="compact" className="bg-kumo-elevated">
            <Table.Row>
              <Head>Collection</Head>
              <Head>Fields</Head>
              <Head>Query</Head>
              <Head>Last run</Head>
              <Head>
                <span className="sr-only">Actions</span>
              </Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shown.map((item, index) => (
              <Row
                key={`${item.section}|${entryKey(item.entry)}`}
                item={item}
                editing={editing}
                name={name}
                zebra={index % 2 === 1}
              />
            ))}
          </Table.Body>
        </Table>
      </div>
      {hidden > 0 || list.unlisted > 0 ? (
        <Text variant="secondary" size="sm" as="p">
          {hidden > 0
            ? `${formatNumber(hidden)} more are not shown here; Copy all and Add all include them. `
            : ''}
          {list.unlisted > 0
            ? `${formatNumber(list.unlisted)} more queries needed an index after the first 1,000 were listed.`
            : ''}
        </Text>
      ) : null}
    </Card>
  )
}

/** A header cell, set as the console's tables set theirs. */
function Head({ children }: { children: ReactNode }) {
  return (
    <Table.Head className="border-b border-kumo-line">
      <span className="flex h-[18px] items-center text-[12px] font-medium text-kumo-strong">
        {children}
      </span>
    </Table.Head>
  )
}

/** What the list says, in agreement with how many are left. */
function Headline({ missing, strict, name }: { missing: number; strict: boolean; name: string }) {
  const one = missing === 1
  const file = <code className="font-mono text-[12px]">{name}</code>
  const said =
    missing === 0 ? (
      <>Every index your app's queries needed is in {file} now.</>
    ) : strict ? (
      one ? (
        <>
          Your app ran a query whose index is not in {file}, so it failed, as it would in
          production. Add the index to let it run.
        </>
      ) : (
        <>
          Your app ran queries whose indexes are not in {file}, so they failed, as they would in
          production. Add the indexes to let them run.
        </>
      )
    ) : one ? (
      <>
        Your app ran a query whose index is not in {file}. It works in the emulator, but production
        would reject it. Add the index before you deploy.
      </>
    ) : (
      <>
        Your app ran queries whose indexes are not in {file}. They work in the emulator, but
        production would reject them. Add the indexes before you deploy.
      </>
    )
  return <span data-testid="missing-indexes-headline">{said}</span>
}

/** The entries still missing as an index file, to merge by hand. */
function CopyAll({
  items,
  database,
  name,
}: {
  items: readonly MissingIndexItem[]
  database: string
  name: string
}) {
  const { copied, copy } = useCopied()
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<CopyGlyph copied={copied} />}
      onClick={() => void copy(missingFile(items, database))}
      title={`Copy every missing index as JSON, to paste into ${name} yourself`}
      data-testid="copy-missing-file"
    >
      {copied ? 'Copied' : 'Copy all'}
    </Button>
  )
}

function AddButton({
  label,
  title,
  editing,
  editKey,
  entries,
  variant = 'secondary',
  testId,
}: {
  label: string
  title: string
  editing: IndexEditing
  editKey: string
  entries: readonly MissingIndexItem[]
  variant?: 'primary' | 'secondary'
  testId: string
}) {
  const button = (
    <Button
      variant={variant}
      size="sm"
      icon={<PlusIcon />}
      disabled={
        editing.blocked !== undefined ||
        (editing.pending !== undefined && editing.pending !== editKey)
      }
      loading={editing.pending === editKey}
      onClick={() => editing.run({ key: editKey, add: entries.map(entryOf), remove: [] })}
      title={editing.blocked ? undefined : title}
      data-testid={testId}
    >
      {label}
    </Button>
  )
  // A disabled button takes no pointer, so the reason rides on a wrapper.
  return editing.blocked ? (
    <Tooltip content={editing.blocked} render={<span className="inline-flex">{button}</span>} />
  ) : (
    button
  )
}

function Row({
  item,
  editing,
  name,
  zebra,
}: {
  item: MissingIndexItem
  editing: IndexEditing
  name: string
  zebra: boolean
}) {
  const { copied, copy } = useCopied()
  const key = `add|${item.section}|${entryKey(item.entry)}`
  const override = item.section === 'fieldOverrides'
  const tone = item.declared
    ? 'text-kumo-success'
    : editing.strict
      ? 'text-kumo-danger'
      : 'text-kumo-warning'
  return (
    <Table.Row
      className={`[&>td]:py-2 [&>td]:align-top ${zebra ? 'bg-kumo-elevated' : ''} ${
        // Added: done, so it steps back, and stays until the page is left
        // as the word that it worked.
        item.declared ? '[&>td:not(:last-child)]:opacity-60' : ''
      }`}
      data-testid="missing-index"
      data-declared={item.declared}
    >
      <Table.Cell>
        <span className="flex items-start gap-2" title={`Ran on ${describeTarget(item.query)}`}>
          <span className={`flex h-5 shrink-0 items-center ${tone}`}>
            {item.declared ? <CheckCircleIcon size={15} /> : <WarningIcon size={15} />}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="flex h-5 items-center truncate font-mono text-[12px] text-kumo-default">
              {item.collectionGroup}
            </span>
            {item.scope === 'collectionGroup' ? (
              <span className="text-[12px] text-kumo-subtle">Collection group</span>
            ) : null}
          </span>
        </span>
      </Table.Cell>
      <Table.Cell>
        <span className="grid gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <FieldChips fields={item.fields} background={zebra ? 'base' : 'tint'} />
          </span>
          <span className="text-[12px] text-kumo-subtle">
            {override ? 'Single-field override' : 'Composite index'}
          </span>
        </span>
      </Table.Cell>
      <Table.Cell>
        <code
          className="block font-mono text-[12px] leading-5 text-kumo-default"
          data-testid="missing-index-query"
        >
          <QueryText clauses={queryClauses(item.query)} />
        </code>
      </Table.Cell>
      <Table.Cell>
        <span className="grid gap-0.5 text-[12px]" data-testid="missing-index-count">
          <RelativeTime iso={item.lastSeen} className="flex h-5 items-center text-kumo-default" />
          <span className="text-kumo-subtle">
            {item.queries === 1 ? '1 query' : `${formatNumber(item.queries)} queries`}
          </span>
        </span>
      </Table.Cell>
      <Table.Cell>
        {item.declared ? (
          <span className="flex h-6 items-center justify-end gap-1 text-[13px] text-kumo-success">
            Added
          </span>
        ) : (
          <span className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              icon={<CopyGlyph copied={copied} />}
              onClick={() => void copy(formatEntry(item))}
              title={`Copy the index as JSON, to paste under "${item.section}" in ${name}`}
              data-testid="copy-missing-entry"
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <AddButton
              label="Add"
              title={`Add it to ${name}, under "${item.section}"`}
              editing={editing}
              editKey={key}
              entries={[item]}
              testId="add-missing-entry"
            />
          </span>
        )}
      </Table.Cell>
    </Table.Row>
  )
}

/** The query a clause a line at most: a clause wraps inside only when it is wider than the column. */
function QueryText({ clauses }: { clauses: readonly string[] }) {
  if (clauses.length === 0) return <>every document</>
  // Each clause keyed by itself and which time it appears: a query may
  // repeat one.
  const seen = new Map<string, number>()
  const keyed = clauses.map((clause) => {
    const time = (seen.get(clause) ?? 0) + 1
    seen.set(clause, time)
    return { clause, key: `${clause}#${time}` }
  })
  return (
    <>
      {keyed.map(({ clause, key }, position) => (
        <span key={key} className="inline-block max-w-full [overflow-wrap:anywhere]">
          {position > 0 ? '.' : ''}
          {clause}
        </span>
      ))}
    </>
  )
}
