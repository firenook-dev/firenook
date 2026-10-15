// A rules page, Firestore's or Storage's: one frame, filled by each
// service's adapter. The editor is the centre, and whatever is chosen on
// the right is drawn into it: a decision lights the lines that decided it
// and writes, after each expression, the value it had; a playground run
// does the same for a request that was never made.
//
// The frame is the same on both pages: the toolbar (the scope, the file,
// the draft's state, Coverage, History, Revert, Apply, Save), the banners
// (each only while it is true), the editor with its Problems strip, the
// 440 px side panel with its tabs (Decisions, Playground, Tests and the
// page's map of the data), the keys (⌘↵ applies, ⌘S saves, F8 and Shift+F8
// walk the problems) and ⌘K (every action and panel of the page). Coverage
// is drawn only while it is asked for, and read only then; the choice is
// remembered per page.

import { Tabs } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ChartBarHorizontalIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  FloppyDiskIcon,
  PlayIcon,
} from '@phosphor-icons/react'
import { type QueryKey, type UseQueryOptions, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { CodeEditor, type CodeEditorProps } from '@/components/code-editor'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { useShortcuts } from '@/lib/shortcuts'
import { FileProblemsBanner, ImpactBanner, OvertakenBanner, TestsFailingBanner } from './banners'
import type { RulesCheckLike, RulesCheckState } from './check'
import { type CoverageReport, coverageView } from './coverage'
import type { RulesDraft } from './draft'
import type { EditorFocus } from './focus'
import type { HistoryQuery, OriginLabels } from './history'
import { Problems, nextProblem } from './problems'
import { RulesToolbar, useCoveragePreference } from './toolbar'

const NO_ACTIONS: readonly PaletteItem[] = []

/** One panel beside the editor: its tab, and how ⌘K offers it. */
export interface WorkbenchPanel<P extends string> {
  value: P
  label: string
  /** A count on the tab, in the danger tone (failing tests). */
  alarm?: number | undefined
  /** The tab's test id, when a journey reads its count. */
  testId?: string | undefined
  palette: { title: string; description: string; keywords: string; icon: ReactNode }
}

export function RulesWorkbench<P extends string, C extends RulesCheckLike, K extends QueryKey>({
  page,
  title,
  sourceLabel,
  draft,
  focus,
  check,
  completion,
  scope,
  history,
  origins,
  noFileText,
  noFileTip,
  applyTip,
  coverageQuery,
  coverageAvailable = true,
  banners,
  impact,
  onShowFlips,
  tests,
  onShowTests,
  exportTests,
  panels,
  panel,
  onPanel,
  actions = NO_ACTIONS,
  children,
}: {
  /** The page, for its keys, its ⌘K group and its coverage choice: `firestore`, `storage`. */
  page: string
  /** "Security rules", "Storage rules". */
  title: string
  /** The editor's name: "Security rules source". */
  sourceLabel: string
  draft: RulesDraft
  focus: EditorFocus
  check: RulesCheckState<C>
  completion: CodeEditorProps['rulesCompletion']
  /** What leads the toolbar: the scope picker, or a chip naming what the rules govern. */
  scope: ReactNode
  history: HistoryQuery<K>
  origins: OriginLabels
  noFileText?: string | undefined
  noFileTip: string
  applyTip?: string | undefined
  /** The engine's coverage report for the scope; read only while coverage is shown. */
  coverageQuery: UseQueryOptions<CoverageReport | null, Error, CoverageReport | null, QueryKey>
  /** The engine counts at all (diagnostics on). */
  coverageAvailable?: boolean
  /** The scope's own banners: no rules loaded, the open defaults, a bucket nobody serves. */
  banners?: ReactNode
  /** What applying the draft would turn around, while there is a draft that compiles. */
  impact:
    | { considered: number; flips: ReadonlyArray<{ after: 'allow' | 'deny' | 'error' }> }
    | undefined
  onShowFlips: () => void
  tests: { total: number; failing: number } | undefined
  onShowTests: () => void
  /** Download the saved tests as a rules-unit-testing file; absent while there are none. */
  exportTests?: { count: number; run: () => void } | undefined
  panels: readonly WorkbenchPanel<P>[]
  panel: P
  onPanel: (panel: P) => void
  /** The page's own ⌘K actions (starter rules). */
  actions?: readonly PaletteItem[]
  /** The open panel. */
  children: ReactNode
}) {
  const [coverageOn, setCoverageOn] = useCoveragePreference(page)
  const [historyOpen, setHistoryOpen] = useState(false)
  const coverage = useQuery({ ...coverageQuery, enabled: coverageAvailable && coverageOn })
  const covered = useMemo(
    () => (coverageOn ? coverageView(coverage.data, draft.source) : undefined),
    [coverageOn, coverage.data, draft.source],
  )
  const { problems, marks } = check

  // ⌘↵ applies, ⌘S saves: the two things an edit ends in, from the keys,
  // and from inside the editor, which is where the keys are pressed. ⌘S is
  // always the page's here, so the browser never offers to save the page.
  // F8 and Shift+F8 walk the problems.
  useShortcuts({ id: `${page}.rules`, label: title }, [
    {
      key: 'Mod+Enter',
      label: 'Apply the draft',
      allowInInputs: true,
      run: () => {
        if (draft.edited) draft.apply(false)
      },
    },
    {
      key: 'Mod+s',
      label: 'Save to the rules file',
      allowInInputs: true,
      run: () => {
        if (draft.rules.data?.path) draft.apply(true)
      },
    },
    {
      key: 'F8',
      label: 'Next problem',
      allowInInputs: true,
      when: () => problems.length > 0,
      run: () => {
        const next = nextProblem(problems, focus.at)
        if (next) focus.setReveal(next.line)
      },
    },
    {
      key: 'Shift+F8',
      label: 'Previous problem',
      allowInInputs: true,
      when: () => problems.length > 0,
      run: () => {
        const previous = nextProblem(problems, focus.at, true)
        if (previous) focus.setReveal(previous.line)
      },
    },
  ])

  useWorkbenchPalette({
    page,
    title,
    draft,
    coverageOn,
    setCoverageOn,
    openHistory: () => setHistoryOpen(true),
    panels,
    onPanel,
    actions,
    exportTests,
  })

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="rules-page">
      <h1 className="sr-only">{title}</h1>
      <RulesToolbar
        scope={scope}
        draft={draft}
        coverage={covered}
        coverageOn={coverageOn}
        onCoverage={setCoverageOn}
        history={history}
        origins={origins}
        noFileText={noFileText}
        noFileTip={noFileTip}
        applyTip={applyTip}
        historyOpen={historyOpen}
        onHistoryOpen={setHistoryOpen}
      />
      {banners}
      <FileProblemsBanner draft={draft} onReveal={focus.setReveal} />
      <OvertakenBanner draft={draft} />
      <ImpactBanner impact={impact} onShow={onShowFlips} />
      <TestsFailingBanner tests={draft.edited ? tests : undefined} onShow={onShowTests} />
      <div className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          aria-label={sourceLabel}
          data-testid="rules-editor"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <CodeEditor
              value={draft.source}
              onChange={draft.setSource}
              language="rules"
              rulesCompletion={completion}
              marks={marks}
              lineMarks={focus.lineMarks}
              inlineValues={focus.shown?.values ?? covered?.tallies}
              gutterNotes={covered?.notes}
              reveal={focus.reveal}
              ariaLabel={sourceLabel}
              testId="rules-source"
            />
          </div>
          <Problems problems={problems} onJump={focus.setReveal} />
        </section>
        <aside
          className="flex w-[440px] shrink-0 flex-col border-l border-kumo-line bg-kumo-base max-xl:w-[380px]"
          aria-label="What the rules do"
          data-testid="rules-side"
        >
          <div className="flex h-11 shrink-0 items-center border-b border-kumo-line px-3">
            <Tabs
              variant="underline"
              size="sm"
              value={panel}
              onValueChange={(next) => onPanel(next as P)}
              tabs={panels.map((item) => ({
                value: item.value,
                label:
                  item.alarm === undefined && item.testId === undefined ? (
                    item.label
                  ) : (
                    <span className="flex items-center gap-1.5" data-testid={item.testId}>
                      {item.label}
                      {item.alarm !== undefined && item.alarm > 0 && (
                        <span className="rounded-full bg-kumo-danger px-1.5 text-[10px] leading-4 text-kumo-inverse tabular-nums">
                          {item.alarm}
                        </span>
                      )}
                    </span>
                  ),
              }))}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </aside>
      </div>
    </div>
  )
}

/**
 * What ⌘K offers on a rules page: the things an edit ends in (Apply, Save,
 * Revert), History, coverage on or off, each panel beside the editor, the
 * page's own actions, and the saved tests as a file.
 */
function useWorkbenchPalette<P extends string>({
  page,
  title,
  draft,
  coverageOn,
  setCoverageOn,
  openHistory,
  panels,
  onPanel,
  actions,
  exportTests,
}: {
  page: string
  title: string
  draft: RulesDraft
  coverageOn: boolean
  setCoverageOn: (on: boolean) => void
  openHistory: () => void
  panels: readonly WorkbenchPanel<P>[]
  onPanel: (panel: P) => void
  actions: readonly PaletteItem[]
  exportTests: { count: number; run: () => void } | undefined
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const file = draft.rules.data?.path
  const edited = draft.edited
  const key = `${page}-rules`

  const provider = useMemo(() => {
    const items: PaletteItem[] = []
    if (edited)
      items.push(
        {
          id: `${key}:apply`,
          title: 'Apply the draft',
          description: 'In force from the next request',
          keywords: 'rules install',
          icon: <PlayIcon size={16} />,
          run: () => draft.apply(false),
        },
        {
          id: `${key}:revert`,
          title: 'Revert the draft',
          description: 'Back to the rules in force',
          keywords: 'rules discard undo',
          icon: <ArrowCounterClockwiseIcon size={16} />,
          run: draft.revert,
        },
      )
    if (file && (edited || draft.fileSource !== draft.inForce))
      items.push({
        id: `${key}:save`,
        title: 'Save the rules',
        description: `Apply and write ${file.slice(file.lastIndexOf('/') + 1)}`,
        keywords: 'rules write file disk',
        icon: <FloppyDiskIcon size={16} />,
        run: () => draft.apply(true),
      })
    items.push(
      {
        id: `${key}:history`,
        title: 'Rules history',
        description: 'Every version, and the file on disk',
        keywords: 'versions diff restore',
        icon: <ClockCounterClockwiseIcon size={16} />,
        run: openHistory,
      },
      {
        id: `${key}:coverage`,
        title: coverageOn ? 'Hide coverage' : 'Show coverage',
        description: 'How often each rule has run',
        keywords: 'rules counts gutter',
        icon: <ChartBarHorizontalIcon size={16} />,
        run: () => setCoverageOn(!coverageOn),
      },
      ...panels.map<PaletteItem>((item) => ({
        id: `${key}:${item.value}`,
        title: item.palette.title,
        description: item.palette.description,
        keywords: item.palette.keywords,
        icon: item.palette.icon,
        run: () => onPanel(item.value),
      })),
      ...actions,
    )
    if (exportTests && exportTests.count > 0)
      items.push({
        id: `${key}:export-tests`,
        title: 'Export tests as a rules-unit-testing file',
        description: `${exportTests.count} test${exportTests.count === 1 ? '' : 's'}`,
        keywords: 'download ci',
        icon: <DownloadSimpleIcon size={16} />,
        run: exportTests.run,
      })
    return (query: string): PaletteGroup[] => {
      const shown = items.filter((item) => matchesQuery(item, query))
      return shown.length > 0 ? [{ label: title, items: shown }] : []
    }
  }, [
    key,
    title,
    draft,
    edited,
    file,
    coverageOn,
    setCoverageOn,
    openHistory,
    panels,
    onPanel,
    actions,
    exportTests,
  ])

  useEffect(() => {
    register(key, provider)
    return () => unregister(key)
  }, [register, unregister, key, provider])
}
