// What can be done to an invocation, the same from a row's menu, the
// detail's footer and the keys: open it, replay it (`r`, always through
// ReplayConfirm — a replay re-runs side effects), edit and replay it
// (`Shift+R`: its request or event into the Run tab), open what caused it
// (`o`: the document, object, user, message, task or event, through its
// EntityRef), open it in Logs (`l`), copy its id (`c`) or the row as JSON
// (`Shift+C`).

import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  BracketsCurlyIcon,
  CopyIcon,
  PencilSimpleIcon,
  ScrollIcon,
} from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import type { EntityRef } from '@/api/generated/EntityRef'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { statusQuery } from '@/api/queries'
import type { RowMenuItem } from '@/components/console/row-menu'
import { linkTo } from '@/lib/links'
import { linkToLogs } from '@/lib/sections/logs'
import { sectionById } from '@/lib/services'
import { toast } from '@/lib/toasts'
import { getInvocation } from '../api'
import { replayInvocation } from '../invoke-stream'
import { copyText } from '../use-functions'
import { ReplayConfirm } from './replay-confirm'

/**
 * A ref as words when the engine gave it no label: `orders/o1` for a
 * document, `gs://b/a.png` for an object, `message 7 on emails`.
 */
function last(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

export function refLabel(ref: EntityRef): string {
  if (ref.label) return ref.label
  const parts = ref.key.split('|')
  switch (ref.kind) {
    case 'firestore.document':
      return parts[1] ?? ref.key
    case 'storage.object':
      return parts.length === 2 ? `gs://${parts[0]}/${parts[1]}` : ref.key
    case 'auth.user':
      return parts[1] ?? ref.key
    case 'auth.call':
      return `Auth call ${ref.key}`
    case 'pubsub.message':
      return parts.length === 2 ? `message ${parts[1]} on ${last(parts[0] ?? '')}` : ref.key
    case 'pubsub.topic':
      return `topic ${last(ref.key)}`
    case 'pubsub.schedule':
      return `schedule of ${ref.key.replace(/^[a-z]+-[a-z]+\d+-/, '')}`
    case 'tasks.task':
      return `task ${parts[3] ?? ref.key}`
    case 'tasks.queue':
      return `queue ${parts[2] ?? ref.key}`
    case 'eventarc.event':
      return `event ${ref.key}`
    case 'functions.invocation':
      return `#${ref.key.split('-').pop() ?? ref.key}`
    default:
      return ref.key
  }
}

/** The refs that are an invocation's cause (not its function or itself). */
export function causeRefs(refs: readonly EntityRef[]): EntityRef[] {
  return refs.filter((ref) => ref.kind !== 'functions.function')
}

/** `c`: the invocation's id. */
function copyId(invocation: InvocationSummary) {
  void copyText(invocation.id, 'the invocation id')
}

/** `Shift+C`: the row as JSON. */
function copyJson(invocation: InvocationSummary) {
  void copyText(JSON.stringify(invocation, null, 2), 'the invocation as JSON')
}

export interface InvocationActions {
  menu: (invocation: InvocationSummary) => RowMenuItem[]
  /** `r`: asks first. */
  askReplay: (invocation: InvocationSummary) => void
  /** The detail's Replay: the click is the confirmation. */
  replay: (invocation: InvocationSummary) => void
  editAndReplay: (invocation: InvocationSummary) => void
  openCause: (invocation: InvocationSummary) => void
  openLogs?: ((invocation: InvocationSummary) => void) | undefined
  copyId: (invocation: InvocationSummary) => void
  copyJson: (invocation: InvocationSummary) => void
  replaying: boolean
  /** The confirmation dialog: render it once on the page. */
  dialog: React.ReactNode
}

export function useInvocationActions({
  onOpen,
}: {
  onOpen: (id: string) => void
}): InvocationActions {
  const navigate = useNavigate()
  const status = useQuery(statusQuery)
  const logsBuilt =
    sectionById('logs')?.built === true &&
    status.data?.sections.find((entry) => entry.id === 'logs')?.state !== 'absent'
  const [asking, setAsking] = useState<InvocationSummary | null>(null)
  const [replaying, setReplaying] = useState(false)

  const replay = (invocation: InvocationSummary) => {
    setReplaying(true)
    let opened = false
    replayInvocation(invocation.id, {
      onFrame: (frame) => {
        if (frame.frame === 'started' && !opened) {
          opened = true
          onOpen(frame.invocation.id)
        }
      },
    })
      .then((outcome) => {
        if (outcome.failed)
          toast({
            key: 'functions.replay',
            title: `Could not replay #${invocation.seq}`,
            description: outcome.failed,
            tone: 'danger',
          })
      })
      .catch((error: unknown) =>
        toast({
          key: 'functions.replay',
          title: `Could not replay #${invocation.seq}`,
          description: error instanceof ApiError ? error.message : String(error),
          tone: 'danger',
        }),
      )
      .finally(() => {
        setReplaying(false)
        setAsking(null)
      })
  }

  const editAndReplay = (invocation: InvocationSummary) =>
    void navigate({
      to: '/functions',
      search: { function: invocation.functionId, tab: 'run', prefill: invocation.id } as never,
    })

  const openCause = (invocation: InvocationSummary) => {
    void getInvocation(invocation.id)
      .then((view) => {
        for (const ref of causeRefs(view.refs)) {
          const link = linkTo(ref, status.data)
          if (link) {
            void navigate({ to: link.to as never, search: link.search as never })
            return
          }
        }
        toast({
          key: 'functions.cause',
          title: 'Nothing to open',
          description:
            causeRefs(view.refs).length === 0
              ? 'This invocation was called directly; nothing in another section caused it.'
              : 'What caused it lives in a section that is not built yet.',
          tone: 'info',
        })
      })
      .catch((error: unknown) =>
        toast({
          key: 'functions.cause',
          title: 'Could not read the invocation',
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        }),
      )
  }

  const openLogs = logsBuilt
    ? (invocation: InvocationSummary) => {
        const link = linkToLogs({ function: invocation.functionId, execution: invocation.id })
        void navigate({ to: link.to as never, search: link.search as never })
      }
    : undefined

  const menu = (invocation: InvocationSummary): RowMenuItem[] => [
    {
      id: 'open',
      label: 'Open',
      icon: ArrowSquareOutIcon,
      shortcut: 'Enter',
      run: () => onOpen(invocation.id),
    },
    {
      id: 'replay',
      label: 'Replay…',
      icon: ArrowCounterClockwiseIcon,
      shortcut: 'r',
      run: () => setAsking(invocation),
    },
    {
      id: 'edit-replay',
      label: 'Edit and replay',
      icon: PencilSimpleIcon,
      shortcut: 'Shift+R',
      run: () => editAndReplay(invocation),
    },
    {
      id: 'cause',
      label: 'Open the cause',
      icon: ArrowSquareOutIcon,
      shortcut: 'o',
      run: () => openCause(invocation),
    },
    ...(openLogs
      ? [
          {
            id: 'logs',
            label: 'Open in Logs',
            icon: ScrollIcon,
            shortcut: 'l',
            run: () => openLogs(invocation),
          },
        ]
      : []),
    {
      id: 'copy-id',
      label: 'Copy id',
      icon: CopyIcon,
      shortcut: 'c',
      run: () => copyId(invocation),
    },
    {
      id: 'copy-json',
      label: 'Copy as JSON',
      icon: BracketsCurlyIcon,
      shortcut: 'Shift+C',
      run: () => copyJson(invocation),
    },
  ]

  return {
    menu,
    askReplay: setAsking,
    replay,
    editAndReplay,
    openCause,
    openLogs,
    copyId,
    copyJson,
    replaying,
    dialog: (
      <ReplayConfirm
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null)
        }}
        seq={asking?.seq ?? 0}
        pending={replaying}
        onReplay={() => asking && replay(asking)}
      />
    ),
  }
}
