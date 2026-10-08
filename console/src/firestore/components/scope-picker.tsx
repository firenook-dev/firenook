// Which collections a query reads: the one this path names, or every
// collection that shares its id — what Firestore calls a collection group.
//
// It was a toggle labelled `group`, which failed twice. A toggle can only
// show the state you are in, so the alternative was never on screen; and
// `group` in a grid reads as group-by, which is a different feature
// entirely. A menu names both scopes, keeps the canonical term in the line
// that explains it, and matches `View as` beside it: here is the mode every
// read runs in, click to change it.

import { Button, DropdownMenu, Text } from '@cloudflare/kumo'
import { CaretDownIcon, StackIcon, TableIcon } from '@phosphor-icons/react'
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
  // costs no request; the one collection is a single count, and nobody is
  // reading it while the menu is shut.
  const schema = useQuery(schemaQuery(workbench.database))
  const here = useQuery({
    ...countQueryOptions(workbench.ownerScope, workbench.collectionPath, false, EMPTY_QUERY),
    enabled: open && !workbench.isPattern,
  })
  const patterns = patternsById(schema.data, collectionId)
  const everywhere = patterns.reduce((total, node) => total + node.documents, 0)
  // How many collections the group actually reads. One pattern is not one
  // collection: `users/*\/orders` is a separate orders collection under every
  // user that has one, which is what `parents` counts. Only a lone root
  // collection makes the group and the collection the same documents.
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
              <span className="truncate">
                {workbench.group ? `all ${collectionId}` : 'this collection'}
              </span>
              <CaretDownIcon size={12} className="shrink-0 text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content className="max-w-88">
        {/* Base UI throws unless a Label and its items share a Group. */}
        <DropdownMenu.Group>
          <DropdownMenu.Label>Query scope</DropdownMenu.Label>
          <DropdownMenu.Item
            icon={TableIcon}
            selected={!workbench.group}
            // A pattern stands for the group and nothing else, so there is no
            // single collection to go back to; the one it starts from is the
            // nearest thing, and the only way back from a keyboard.
            onClick={() =>
              workbench.isPattern ? workbench.setPath(rootId) : workbench.setGroup(false)
            }
            data-testid="scope-one"
          >
            <Option
              label={workbench.isPattern ? `Back to ${rootId}` : 'This collection'}
              count={here.data?.count}
            >
              {workbench.isPattern
                ? 'a pattern stands for the group, so it names no one collection'
                : parent
                  ? `the ${collectionId} under ${parent}`
                  : `the ${collectionId} at the root of the database`}
            </Option>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={StackIcon}
            selected={workbench.group}
            onClick={() => workbench.setGroup(true)}
            data-testid="scope-all"
          >
            <Option
              label={`All ${collectionId}`}
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

/** One scope: what it is called, how much of the database it reads, why. */
function Option({
  label,
  count,
  children,
}: {
  label: string
  count: number | undefined
  children: React.ReactNode
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-baseline gap-2">
        {label}
        {count !== undefined && (
          <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
            {formatNumber(count)}
          </span>
        )}
      </span>
      <Text variant="secondary" size="sm" as="span">
        {children}
      </Text>
    </span>
  )
}
