// A rules page's toolbar, in one order on every page: the scope (a database
// picker, a bucket picker, or the chip that says one ruleset governs every
// bucket), the file the rules are saved to, the draft's state, and at the
// right end Coverage and History, then Revert, Apply (⌘↵) and Save (⌘S).

import { Badge, Button, Text, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ChartBarHorizontalIcon,
  FloppyDiskIcon,
  PlayIcon,
} from '@phosphor-icons/react'
import type { QueryKey } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { CoverageView } from './coverage'
import type { RulesDraft } from './draft'
import { HistoryButton, type HistoryQuery, type OriginLabels } from './history'

/** The file's last segment: what the toolbar names. */
export function fileName(path: string | null | undefined): string | undefined {
  return path ? path.slice(path.lastIndexOf('/') + 1) : undefined
}

/** "Draft · not applied", or "Applied · not saved" while what is in force is not on disk. */
export function DraftState({ draft }: { draft: RulesDraft }) {
  const file = draft.rules.data?.path
  const name = fileName(file)
  if (draft.edited)
    return (
      // Kumo's Badge does not pass a test id through; the span holds it.
      <span className="flex" data-testid="rules-draft-state">
        <Badge variant="outline">Draft · not applied</Badge>
      </span>
    )
  if (
    !file ||
    draft.fileSource === null ||
    draft.fileSource === draft.inForce ||
    draft.fileProblems.length > 0
  )
    return null
  return (
    <Tooltip
      content={`What is in force was applied here but not written to ${name}. Save writes it; History compares the two.`}
      render={
        <span className="flex" data-testid="rules-unsaved">
          <Badge variant="outline">Applied · not saved</Badge>
        </span>
      }
    />
  )
}

/** Coverage on or off; a mode that is on is the secondary button, as everywhere here. */
export function CoverageToggle({
  coverage,
  on,
  onChange,
}: {
  coverage: CoverageView | undefined
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <Tooltip
      content={
        on
          ? coverage
            ? `${coverage.ran} of ${coverage.of} conditions have run since these rules were loaded. Hide the counts.`
            : 'Counts appear once requests reach these rules. Hide the counts.'
          : 'Show how often each rule has run'
      }
      render={
        <Button
          variant={on ? 'secondary' : 'ghost'}
          size="sm"
          icon={<ChartBarHorizontalIcon />}
          aria-pressed={on}
          onClick={() => onChange(!on)}
          data-testid="rules-coverage"
        >
          {on && coverage ? `${coverage.ran}/${coverage.of} ran` : 'Coverage'}
        </Button>
      }
    />
  )
}

/** Revert, Apply and Save: the three things an edit ends in. */
export function DraftActions({
  draft,
  noFileTip,
  applyTip = 'In force from the next request, not written to disk',
}: {
  draft: RulesDraft
  /** Why Save is off without a file: "firebase.json names no rules file for this database". */
  noFileTip: string
  /** What Apply does, beside its key. */
  applyTip?: string | undefined
}) {
  const file = draft.rules.data?.path
  const name = fileName(file)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowCounterClockwiseIcon />}
        onClick={draft.revert}
        disabled={!draft.edited}
        data-testid="rules-revert"
      >
        Revert
      </Button>
      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            {applyTip}
            <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px] text-kumo-subtle">
              ⌘↵
            </kbd>
          </span>
        }
        render={
          <Button
            variant="secondary"
            size="sm"
            icon={<PlayIcon />}
            onClick={() => draft.apply(false)}
            loading={draft.applying === 'apply'}
            disabled={!draft.edited}
            data-testid="rules-apply"
          >
            Apply
          </Button>
        }
      />
      <Tooltip
        content={
          file ? (
            <span className="flex items-center gap-1.5">
              Apply and write {name}
              <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px] text-kumo-subtle">
                ⌘S
              </kbd>
            </span>
          ) : (
            noFileTip
          )
        }
        render={
          <span className="flex">
            <Button
              variant="primary"
              size="sm"
              icon={<FloppyDiskIcon />}
              onClick={() => draft.apply(true)}
              loading={draft.applying === 'save'}
              disabled={!file || (!draft.edited && draft.fileSource === draft.inForce)}
              data-testid="rules-save"
            >
              Save
            </Button>
          </span>
        }
      />
    </>
  )
}

export function RulesToolbar<K extends QueryKey>({
  scope,
  draft,
  coverage,
  coverageOn,
  onCoverage,
  history,
  origins,
  noFileText = 'No rules file in firebase.json',
  noFileTip,
  applyTip,
  historyOpen,
  onHistoryOpen,
}: {
  /** What leads the row: the scope picker, or a chip naming what the rules govern. */
  scope: ReactNode
  draft: RulesDraft
  coverage: CoverageView | undefined
  coverageOn: boolean
  onCoverage: (on: boolean) => void
  history: HistoryQuery<K>
  origins: OriginLabels
  /** In place of the file name when the scope has none. */
  noFileText?: string
  noFileTip: string
  applyTip?: string | undefined
  /** The history dialog, when the page opens it from elsewhere too (⌘K). */
  historyOpen?: boolean | undefined
  onHistoryOpen?: ((open: boolean) => void) | undefined
}) {
  const file = draft.rules.data?.path
  const name = fileName(file)
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-base pr-2 pl-3"
      data-testid="rules-toolbar"
    >
      {scope}
      <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
      {name ? (
        <Tooltip
          content={file}
          render={
            <span
              className="min-w-0 truncate font-mono text-[12px] text-kumo-subtle"
              data-testid="rules-file"
            >
              {name}
            </span>
          }
        />
      ) : (
        <Text as="span" variant="secondary" size="sm">
          {noFileText}
        </Text>
      )}
      <DraftState draft={draft} />
      <span className="ml-auto flex items-center gap-1.5">
        <CoverageToggle coverage={coverage} on={coverageOn} onChange={onCoverage} />
        <HistoryButton
          draft={draft}
          history={history}
          origins={origins}
          open={historyOpen}
          onOpenChange={onHistoryOpen}
        />
        <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
        <DraftActions draft={draft} noFileTip={noFileTip} applyTip={applyTip} />
      </span>
    </div>
  )
}

const COVERAGE_KEY = 'firenook.console.rules-coverage'

/** Whether coverage is drawn in the editor; remembered in this browser, for every rules page. */
export function useCoveragePreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(COVERAGE_KEY) !== 'off'
    } catch {
      return true
    }
  })
  return [
    on,
    (next) => {
      setOn(next)
      try {
        localStorage.setItem(COVERAGE_KEY, next ? 'on' : 'off')
      } catch {
        // A convenience; the toggle still works for this page.
      }
    },
  ]
}
