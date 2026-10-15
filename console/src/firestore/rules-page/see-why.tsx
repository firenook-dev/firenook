// "See why" on a read the rules denied, on the data page itself: the rules
// kit's refusal popover (`src/rules/refusal-detail.tsx`), as the Files page
// has it, rather than a jump to another page. Firestore's refusal is the
// protocol's plain 403 (an app gets exactly that), so the popover finds
// the decision behind it — the newest denial the console's own read made,
// on this path, as this identity, from the `firestore.decisions` topic —
// and asks the engine to run it again for every value. From there the
// request goes to the playground, or the decision opens on the Rules page.

import { Button } from '@cloudflare/kumo'
import { ShieldCheckIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { statusQuery } from '@/api/queries'
import type { FirestoreDecision } from '@/api/generated/FirestoreDecision'
import type { ViewAs } from '@/lib/identity'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { RefusalDetail } from '@/rules/refusal-detail'
import { decisionQuery } from './api'
import { decisionParams } from './decisions'
import { usePlayground } from './playground-store'
import { formFromRequest } from './requests'

/** How long the popover waits for the replay before it says nothing matched. */
const FIND_MS = 1_000

export function SeeWhy({
  database,
  path,
  viewAs,
  message,
}: {
  database: string
  /** The collection the denied read listed. */
  path: string
  viewAs: ViewAs
  /** The denial as the read met it. */
  message: string
}) {
  const navigate = useNavigate()
  const status = useQuery(statusQuery)
  const diagnostics = status.data?.features.diagnostics ?? true
  const loadPlayground = usePlayground((state) => state.load)
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<FirestoreDecision>()
  const [searched, setSearched] = useState(false)
  const uid = viewAs.kind === 'user' || viewAs.kind === 'custom' ? viewAs.uid : undefined

  // While open, the console's own denials on this path as this identity;
  // the newest is the read on screen.
  useLiveTopic(
    'firestore.decisions',
    open && diagnostics ? decisionParams(database, { path, uid, denied: true }) : null,
    {
      onDecisions: (batch) => {
        const mine = batch.items.filter(
          (decision) => decision.viaConsole && (uid !== undefined || decision.uid === null),
        )
        const newest = mine.at(-1)
        if (newest) setFound(newest)
      },
    },
  )
  useEffect(() => {
    if (!open) return
    const timer = globalThis.setTimeout(() => setSearched(true), FIND_MS)
    return () => globalThis.clearTimeout(timer)
  }, [open])
  const detail = useQuery({
    ...decisionQuery(database, found?.id ?? ''),
    enabled: found !== undefined,
  })
  const rerun = detail.data ?? undefined
  const db = database === '(default)' ? undefined : database

  return (
    <RefusalDetail
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setFound(undefined)
          setSearched(false)
        }
      }}
      trigger={
        <Button variant="primary" icon={<ShieldCheckIcon />} data-testid="see-why">
          See why
        </Button>
      }
      explanation={rerun ? { result: rerun.result, rules: rerun.rules } : undefined}
      pending={diagnostics && (found ? detail.isPending : !searched)}
      said={
        !diagnostics
          ? `${message} Rules decisions are off on this engine (--no-diagnostics), so there is no decision to explain.`
          : found
            ? `${message} The engine no longer keeps this decision’s request; it keeps the newest 2,000.`
            : `${message} The decision behind it is no longer held; the Rules page lists the ones that are.`
      }
      onTry={
        rerun && found
          ? () => {
              loadPlayground(formFromRequest(rerun.request, found.id), { run: true })
              void navigate({ to: '/firestore/rules', search: { db, panel: 'playground' } })
            }
          : undefined
      }
      onOpenRules={() =>
        void navigate({
          to: '/firestore/rules',
          search: found
            ? { db, decision: found.id }
            : { db, path: path || undefined, uid, denied: true, pick: true },
        })
      }
      openLabel="Open in Rules"
    />
  )
}
