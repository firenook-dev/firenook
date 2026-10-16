// The function page's first row: where you are, what is wrong, and the one
// thing to do. The identity is a field the way Firestore's path is — flat at
// rest, a ground under the pointer — holding the name, the region, the kind
// and the generation, with copy against its right edge (the URL for kinds
// that answer on one, the id for the rest). Problem chips only when true.
// Logs and ⋯ keep their places; the primary action (the kind's verb) is
// alone at the end and only while the Run tab is closed — it opens the tab
// and focuses its first field, it never sends — and its slot keeps its
// width while it is away, so nothing beside it moves.

import { Button, Tooltip, cn } from '@cloudflare/kumo'
import { PlayIcon, ScrollIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import { CopyButton } from '@/components/console/copy-button'
import { type RowMenuItem, RowMenuButton } from '@/components/console/row-menu'
import { ToolbarDivider, ToolbarField, ToolbarRow } from '@/components/console/toolbar'
import { Kbd, StatusDot, type StatusTone } from '@/components/kit'
import { PanelToggle } from '@/components/shell/section-panel'
import { KindBadge } from '@/compute/kind-badge'
import type { SectionLink } from '@/lib/services'
import { generationText, kindVerb } from '../kinds'
import { statusReasonText } from '../trigger-text'
import { workerDown } from './codebase-banners'

/** A problem worth a chip in the toolbar: a word, a tone and the sentence behind it. */
export interface ProblemChip {
  id: string
  word: string
  tone: StatusTone
  detail: string
}

/** The chips a function's toolbar shows, only for what is true (§5.2). */
export function problemChips(
  summary: FunctionSummary,
  codebase: FunctionCodebaseEntry | undefined,
): ProblemChip[] {
  const chips: ProblemChip[] = []
  const missing = summary.secrets.filter((secret) => !secret.provided)
  if (missing.length > 0)
    chips.push({
      id: 'secrets',
      word: missing.length === 1 ? '1 secret missing' : `${missing.length} secrets missing`,
      tone: 'warning',
      detail: `${missing.map((secret) => secret.key).join(', ')} ${missing.length === 1 ? 'is' : 'are'} declared but not in .secret.local, so process.env leaves ${missing.length === 1 ? 'it' : 'them'} undefined here.`,
    })
  if (summary.status === 'ignored')
    chips.push({
      id: 'ignored',
      word: 'Ignored',
      tone: 'warning',
      detail: summary.statusReason
        ? statusReasonText(summary.statusReason)
        : 'The emulator ignores this function.',
    })
  if (summary.status === 'noService')
    chips.push({
      id: 'no-service',
      word: 'No service',
      tone: 'warning',
      detail: summary.statusReason
        ? statusReasonText(summary.statusReason)
        : 'The service that sends its events is not running.',
    })
  if (summary.status === 'removed')
    chips.push({
      id: 'removed',
      word: 'Removed',
      tone: 'neutral',
      detail: summary.statusReason
        ? statusReasonText(summary.statusReason)
        : 'The last reload removed this function.',
    })
  const state = codebase?.codebase
  if (state?.state === 'failed')
    chips.push({
      id: 'codebase-failed',
      word: state.servingPrevious ? 'Codebase failed · previous load' : 'Codebase failed',
      tone: 'danger',
      detail: state.error?.message ?? 'Its codebase failed to load.',
    })
  if (state?.stale)
    chips.push({
      id: 'stale',
      word: 'Stale code',
      tone: 'warning',
      detail:
        state.stale.reason === 'sourcesNewer'
          ? 'src/ changed after the last build, so the code running may not be the code on disk.'
          : `${state.stale.file} changed after the last load, so the old values are still in force.`,
    })
  if (codebase && workerDown(codebase))
    chips.push({
      id: 'worker',
      word: 'Worker exited',
      tone: 'warning',
      detail: 'The worker for its codebase exited; the next call starts a new one.',
    })
  return chips
}

export function FunctionToolbar({
  summary,
  codebase,
  url,
  logs,
  menu,
  runOpen,
  onRun,
}: {
  summary: FunctionSummary
  codebase: FunctionCodebaseEntry | undefined
  /** The URL as apps reach it, for kinds that answer on one. */
  url: string | undefined
  /** Open in Logs, while the engine runs Logs. */
  logs: SectionLink | null
  menu: readonly RowMenuItem[]
  /** The Run tab is open: the primary steps aside. */
  runOpen: boolean
  /** Opens the Run tab and focuses its first field. */
  onRun?: (() => void) | undefined
}) {
  const chips = problemChips(summary, codebase)
  const verb = kindVerb(summary.kind)
  return (
    <ToolbarRow testId="function-toolbar">
      <PanelToggle where="toolbar" />
      <ToolbarField
        testId="function-identity"
        trailing={
          url ? (
            <CopyButton value={url} label="Copy the URL" testId="function-copy-url" />
          ) : (
            <CopyButton value={summary.id} label="Copy the id" testId="function-copy-id" />
          )
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="truncate font-mono text-[13px] text-kumo-default"
            data-testid="function-name"
          >
            {summary.name}
          </span>
          <span className="shrink-0 font-mono text-[12px] text-kumo-subtle">{summary.region}</span>
          <KindBadge kind={summary.kind} />
          <span className="hidden shrink-0 text-[12px] text-kumo-subtle lg:inline">
            {generationText(summary.platform)}
          </span>
        </span>
      </ToolbarField>
      {chips.length > 0 && (
        <>
          <ToolbarDivider />
          <span
            className="flex min-w-0 shrink items-center gap-3 overflow-hidden"
            data-testid="function-problems"
          >
            {chips.map((chip) => (
              <Tooltip
                key={chip.id}
                content={chip.detail}
                render={
                  <span className="flex shrink-0 cursor-default" data-testid={`problem-${chip.id}`}>
                    <StatusDot tone={chip.tone} label={chip.word} />
                  </span>
                }
              />
            ))}
          </span>
        </>
      )}
      <ToolbarDivider />
      {logs && (
        <ToolbarLink link={logs} label="Open in Logs" shortcut="l">
          Logs
        </ToolbarLink>
      )}
      <RowMenuButton items={menu} label={`Actions for ${summary.name}`} testId="function-menu" />
      {onRun && (
        <>
          <ToolbarDivider />
          {/* The slot keeps the primary's width while the Run tab is open, so
              Logs and ⋯ never move as it opens and closes. */}
          <span className="grid shrink-0">
            <Tooltip
              content={
                <span className="flex items-center gap-1.5">
                  Open the {verb.toLowerCase()} form <Kbd>i</Kbd>
                </span>
              }
              render={
                <Button
                  variant="primary"
                  size="sm"
                  icon={<PlayIcon weight="fill" />}
                  onClick={onRun}
                  className={cn('col-start-1 row-start-1', runOpen && 'invisible')}
                  aria-hidden={runOpen}
                  tabIndex={runOpen ? -1 : 0}
                  data-testid="function-primary"
                >
                  {verb}
                </Button>
              }
            />
          </span>
        </>
      )}
    </ToolbarRow>
  )
}

/** A ghost toolbar button that is a link (Logs). */
function ToolbarLink({
  link,
  label,
  shortcut,
  children,
}: {
  link: SectionLink
  label: string
  shortcut: string
  children: ReactNode
}) {
  return (
    <Tooltip
      content={
        <span className="flex items-center gap-1.5">
          {label} <Kbd>{shortcut}</Kbd>
        </span>
      }
      render={
        <Link
          to={link.to as never}
          search={link.search as never}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-kumo-default hover:ink focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
          data-testid="function-logs"
        >
          <ScrollIcon size={14} className="text-kumo-subtle" />
          {children}
        </Link>
      }
    />
  )
}
