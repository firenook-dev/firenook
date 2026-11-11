// The Data page's word on missing indexes: a toolbar button that appears
// once an app query has needed an index the file does not declare, and
// opens the Indexes page on the database that needs it. The list itself,
// with Add, is that page's; here is only the count, where the queries are.

import { Button, Tooltip } from '@cloudflare/kumo'
import { WarningIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { stillMissing, useMissingIndexes } from '../indexes'
import { formatNumber } from '../value'
import { DEFAULT_DATABASE, useWorkbench } from './workbench-context'

export function MissingIndexesLink() {
  const { list } = useMissingIndexes()
  const workbench = useWorkbench()
  const navigate = useNavigate()
  const missing = stillMissing(list)
  if (missing.length === 0) return null
  // The database the page shows when it needs one, else the first that does.
  const database = missing.some((item) => item.database === workbench.database)
    ? workbench.database
    : (missing[0]?.database ?? DEFAULT_DATABASE)
  const words = `${formatNumber(missing.length)} ${missing.length === 1 ? 'index' : 'indexes'} missing`
  return (
    <Tooltip
      content="Your app ran queries whose indexes are not in firestore.indexes.json. Production would reject them. Open Indexes to add them."
      render={
        <Button
          variant="ghost"
          size="sm"
          className="text-kumo-warning"
          icon={<WarningIcon />}
          aria-label={`${words}: open Indexes`}
          onClick={() =>
            void navigate({
              to: '/firestore/indexes',
              search: database === DEFAULT_DATABASE ? {} : { db: database },
            })
          }
          data-testid="missing-indexes-button"
          data-missing={missing.length}
        >
          {/* The words give way first on a narrow window; the count stays. */}
          <span className="hidden xl:inline">{words}</span>
          <span className="xl:hidden">{formatNumber(missing.length)}</span>
        </Button>
      }
    />
  )
}
