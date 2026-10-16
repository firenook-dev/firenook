// The database a Firestore page looks at: every one the project declares
// or a client has written to. The data page shows it at the head of the
// schema panel and the rules page at the head of its toolbar — rules are
// per database, so both pages need it, and both name it the same way.

import { Select } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { databaseItems, databasesQuery } from '../databases'
import { DEFAULT_DATABASE } from './workbench-context'

export function DatabasePicker({
  value,
  onChange,
  className = '',
}: {
  value: string
  onChange: (database: string) => void
  className?: string
}) {
  const databases = useQuery(databasesQuery)
  return (
    <div className={`min-w-0 ${className}`} data-testid="database-select">
      {/* `xs`, so its text is set like the filter directly under it:
          Kumo's `sm` Select is 14 px while its `sm` Input is 12. And
          the filter's height and corners, which `xs` leaves at 17.5 px
          against the filter's 22.75 — two boxes stacked, one a size
          smaller.
          The box says what it holds, the way the top bar says
          "Project": an id such as `(default)` alone does not. Inside
          the box, because Kumo's `label` is a form label stacked over
          it — a second row, with the panel toggle left between the
          two. And `min-w-0`, because Kumo wraps the box in a grid
          whose column grows to its text: a long id pushed the box
          past the panel's edge and its caret out of sight. */}
      <Select
        size="xs"
        value={value}
        onValueChange={(next) => onChange(String(next))}
        // Opening the picker asks again, so a database a client created
        // since the page mounted is in the list.
        onOpenChange={(open) => {
          if (open) void databases.refetch()
        }}
        items={databaseItems(databases.data, value, DEFAULT_DATABASE)}
        renderValue={(current) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-kumo-subtle">Database</span>
            <span className="truncate font-mono">{String(current)}</span>
          </span>
        )}
        aria-label="Database"
        className="h-6.5 w-full min-w-0 rounded-md"
      />
    </div>
  )
}
