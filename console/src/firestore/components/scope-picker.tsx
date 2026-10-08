// Which collections a query reads: the one this path names, or every
// collection that shares its id — what Firestore calls a collection group.
//
// It was a toggle labelled `group`, which failed twice. A toggle can only
// show the state you are in, so the alternative was never on screen; and
// `group` in a grid reads as group-by, a different feature entirely. A menu
// names both scopes, keeps the canonical term in the line that explains it,
// and matches `View as` beside it: here is the mode every read runs in,
// click to change it.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import { CaretDownIcon, CheckIcon, StackIcon, TableIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { EMPTY_QUERY } from '../query'
import { countQueryOptions } from '../queries'
import { patternsById, schemaQuery } from '../schema'
import { formatNumber } from '../value'
import { useWorkbench } from './workbench-context'

export function ScopePicker() {
  const workbench = useWorkbench()
  const [open, setOpen] = useState(false)
  const segments = workbench.collectionPath.split('/')
  const collectionId = segments.at(-1) ?? ''
  const rootId = segments[0] ?? ''
  const parent = segments.slice(0, -1).join('/')

  // The group's size is a fact the schema index already holds, so the menu
  // costs no request for it; the one collection is a single count, and
  // nobody is reading it while the menu is shut.
  const schema = useQuery(schemaQuery(workbench.database))
  const here = useQuery({
    ...countQueryOptions(workbench.ownerScope, workbench.collectionPath, false, EMPTY_QUERY),
    enabled: open && !workbench.isPattern,
  })
  const patterns = patternsById(schema.data, collectionId)
  const everywhere = patterns.reduce((total, node) => total + node.documents, 0)
  // How many collections the group actually reads. One pattern is not one
  // collection: `users/*\/orders` is a separate orders under every user that
  // has one, which is what `parents` counts. Only a lone root collection
  // makes the group and the collection the same documents.
  const places = patterns.reduce((total, node) => total + (node.parents ?? 1), 0)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        render={
          <Button
            variant={workbench.group ? 'secondary' : 'ghost'}
            size="sm"
            icon={workbench.group ? <StackIcon /> : <TableIcon />}
            className="max-w-56"
            aria-label="Query scope"
            data-testid="scope-picker"
          >
            <span className="flex min-w-0 items-center gap-1">
              {workbench.group ? (
                <span className="flex min-w-0 items-center gap-1">
                  all <Id>{collectionId}</Id>
                </span>
              ) : (
                'this collection'
              )}
              <CaretDownIcon size={12} className="shrink-0 text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content className="max-w-88">
        {/* Base UI throws unless a Label and its items share a Group. */}
        <DropdownMenu.Group>
          <DropdownMenu.Label className="px-2 pt-0.5 pb-1 text-[11px] font-medium tracking-wide text-kumo-subtle">
            Query scope
          </DropdownMenu.Label>
          <DropdownMenu.Item
            // Kumo centres an item's parts; a description under the name
            // wants them on the first line instead.
            className="items-start py-2"
            // A pattern stands for the group and nothing else, so there is no
            // single collection to go back to; the one it starts from is the
            // nearest thing, and the only way back from a keyboard.
            onClick={() =>
              workbench.isPattern ? workbench.setPath(rootId) : workbench.setGroup(false)
            }
            data-testid="scope-one"
          >
            <Option
              icon={TableIcon}
              selected={!workbench.group}
              name={workbench.isPattern ? <>Back to {rootId}</> : 'This collection'}
              count={here.data?.count}
            >
              {workbench.isPattern
                ? 'a pattern stands for the group, so it names no one collection'
                : parent
                  ? `only the one under ${parent}`
                  : 'only the one at the root of the database'}
            </Option>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="items-start py-2"
            onClick={() => workbench.setGroup(true)}
            data-testid="scope-all"
          >
            <Option
              icon={StackIcon}
              selected={workbench.group}
              name={
                <>
                  All <Id>{collectionId}</Id>
                </>
              }
              count={patterns.length > 0 ? everywhere : undefined}
            >
              {places > 1
                ? `every collection called ${collectionId}, whatever its parent — ${formatNumber(places)} of them. A collection group.`
                : `the only ${collectionId} in the database, so the same documents. A collection group.`}
            </Option>
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** The collection id wherever it is read as a name: data, not chrome. */
function Id({ children }: { children: string }) {
  return (
    <span className="truncate rounded bg-kumo-tint px-1 font-mono text-[0.92em] text-kumo-default">
      {children}
    </span>
  )
}

/** One scope: what it is called, how much of the database it reads, why. */
function Option({
  icon: Icon,
  selected,
  name,
  count,
  children,
}: {
  icon: typeof TableIcon
  selected: boolean
  name: React.ReactNode
  count: number | undefined
  children: React.ReactNode
}) {
  return (
    <span className="flex w-full items-start gap-2">
      <Icon size={14} className="mt-0.5 shrink-0 text-kumo-subtle" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-kumo-default">
          {name}
          {count !== undefined && (
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {formatNumber(count)}
            </span>
          )}
        </span>
        <span className="text-[12px] leading-[1.45] text-kumo-subtle">{children}</span>
      </span>
      {selected && <CheckIcon size={13} className="mt-0.5 ml-auto shrink-0 text-kumo-brand" />}
    </span>
  )
}
