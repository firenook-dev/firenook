// The security rules of one database, as a page of their own.
//
// They were a mode of the data view — a Rules button among View as and
// New that swapped the grid for a textarea and left the collection tree
// beside it, meaning nothing there. Writing who may do what is a different
// job from reading what there is, so it has its own page, its own address,
// and the things that job needs beside the text: what the rules decided
// and why, a playground, saved tests, and which collections they govern.
//
// The editor is the centre. Whatever is chosen on the right is drawn into
// it: a decision lights the lines that decided it and writes, after each
// expression, the value it had.

import { Badge, Button, Tabs, Text, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ChartBarHorizontalIcon,
  FloppyDiskIcon,
  PlayIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { CodeEditor, type CodeMark } from '@/components/code-editor'
import { Page } from '@/components/shell/page'
import { identityUsersQuery } from '@/lib/identity'
import { useShortcuts } from '@/lib/shortcuts'
import { DatabasePicker } from '../components/database-picker'
import { DEFAULT_DATABASE } from '../components/workbench-context'
import { describeDiagnostic, offsetOf } from '../rules'
import { type RulesImpact, checkQuery, impactQuery, useRulesLive } from './api'
import { CollectionsPanel } from './collections-panel'
import { Playground } from './playground'
import { fieldsQuery } from './schema-fields'
import { TestsPanel } from './tests-panel'
import { useTestRunner, useTestSummary } from './tests-store'
import { type CoverageView, coverageQuery, coverageView } from './coverage'
import { DecisionsPanel } from './decisions-panel'
import { type RulesDecision, useDecisions, useDecisionsFeed } from './decisions'
import { HistoryButton } from './history'
import { useOverlay } from './overlay'
import { type RulesPanel, useRulesSearch } from './rules-search'
import { type RulesDraft, useRulesDraft } from './use-rules-draft'

export function RulesPage() {
  const status = useQuery(statusQuery)
  const project = status.data?.projectId
  if (!project) {
    return (
      <Page className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h1">
          Security rules
        </Text>
        <Text variant="secondary">
          {status.isError ? 'The engine is unreachable.' : 'Connecting to the engine…'}
        </Text>
      </Page>
    )
  }
  return <RulesBody project={project} />
}

function RulesBody({ project }: { project: string }) {
  const { search, update } = useRulesSearch()
  const database = search.db ?? DEFAULT_DATABASE
  const draft = useRulesDraft(project, database)
  const queryClient = useQueryClient()
  useDecisionsFeed()
  useRulesLive(database)
  const decisions = useDecisions((state) => state.decisions)
  const panel: RulesPanel = search.panel ?? 'decisions'
  const selected = search.decision
    ? decisions.find((decision) => decision.requestId === search.decision)
    : undefined
  const [reveal, setRevealState] = useState<{ line: number; at: number } | undefined>()
  const setReveal = (next: { line: number }) => setRevealState({ ...next, at: Date.now() })
  const [coverageOn, setCoverageOn] = useCoveragePreference()

  // The draft, checked as it is typed: the compiler's errors and the
  // engine's warnings, where they are, before anything is applied.
  const checked = useDebounced(draft.source, 300)
  const check = useQuery({ ...checkQuery(database, checked), enabled: draft.rules.isSuccess })
  const problems = useMemo(
    () => problemsOf(check.data?.diagnostics ?? [], draft.rejected),
    [check.data, draft.rejected],
  )
  const warnings = (check.data?.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.severity === 'warning',
  ).length
  const marks = useMemo<CodeMark[]>(
    () =>
      checked === draft.source
        ? problems.map((problem) => {
            const from = problem.from ?? offsetOf(draft.source, problem)
            return {
              from,
              to: problem.to ?? from,
              severity: problem.severity === 'warning' ? 'warning' : 'error',
              message: problem.message,
            }
          })
        : [],
    [problems, checked, draft.source],
  )

  // How often each rule has run, moving as the app makes requests: the
  // feed's arrivals are the signal to count again, not a timer.
  const coverage = useQuery(coverageQuery(project, database))
  useEffect(() => {
    let timer: number | undefined
    const unsubscribe = useDecisions.subscribe((state, previous) => {
      if (state.decisions.length === previous.decisions.length) return
      window.clearTimeout(timer)
      timer = window.setTimeout(
        () =>
          void queryClient.invalidateQueries({
            queryKey: coverageQuery(project, database).queryKey,
          }),
        400,
      )
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [project, database, queryClient])
  const covered = useMemo(
    () => (coverageOn ? coverageView(coverage.data, draft.source) : undefined),
    [coverageOn, coverage.data, draft.source],
  )

  // What a panel draws into the editor, over the text it is about. A
  // reveal is asked for by a click here or by a panel's overlay arriving;
  // whichever came last is the one the editor follows.
  const overlay = useOverlay((state) => state.overlay)
  const shown = overlay && overlay.source === draft.source ? overlay : undefined
  const overlayReveal = useMemo(
    () => (shown?.reveal ? { line: shown.reveal, at: shown.at ?? 0 } : undefined),
    [shown],
  )
  const revealing =
    overlayReveal && (!reveal || overlayReveal.at > reveal.at) ? overlayReveal : reveal

  // The saved tests, run against the editor's text as it changes.
  useTestRunner(project, database, draft.source, draft.rules.isSuccess)
  const tests = useTestSummary(draft.source)

  // What applying the draft would turn around among the decisions the
  // engine still holds — asked once the draft compiles and settles.
  const draftCompiles =
    draft.edited &&
    checked === draft.source &&
    check.data !== undefined &&
    !check.data.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  const impact = useQuery({ ...impactQuery(database, checked), enabled: draftCompiles })

  // Completion that knows the data: the fields documents of a collection
  // carry, and the custom claims the Auth emulator's users have (the first
  // page of them, from the engine's bounded identity search — never every
  // account).
  const users = useQuery(identityUsersQuery(project, ''))
  const completion = useMemo(
    () => ({
      fields: async (pattern: string) =>
        (await queryClient.fetchQuery(fieldsQuery(project, database, pattern))).map(
          (sample) => sample.field,
        ),
      claims: () => [
        ...new Set((users.data ?? []).flatMap((user) => Object.keys(user.claims ?? {}))),
      ],
    }),
    [queryClient, project, database, users.data],
  )

  // ⌘↵ applies, ⌘S saves: the two things an edit ends in, from the keys,
  // and from inside the editor, which is where the keys are pressed. ⌘S is
  // always the page's here, so the browser never offers to save the page.
  useShortcuts({ id: 'firestore.rules', label: 'Security rules' }, [
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
  ])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="rules-page">
      <h1 className="sr-only">Security rules</h1>
      <RulesToolbar
        database={database}
        onDatabase={(next) =>
          update({ db: next === DEFAULT_DATABASE ? undefined : next, decision: undefined })
        }
        draft={draft}
        coverage={covered}
        coverageOn={coverageOn}
        onCoverage={setCoverageOn}
      />
      <RulesBanners
        draft={draft}
        impact={draftCompiles ? impact.data : undefined}
        tests={draft.edited ? tests : undefined}
        onShowTests={() => update({ panel: 'tests' })}
        onReveal={(line) => setReveal({ line })}
      />
      <div className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          aria-label="Security rules source"
          data-testid="rules-editor"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <CodeEditor
              value={draft.source}
              onChange={draft.setSource}
              language="rules"
              rulesCompletion={completion}
              marks={marks}
              lineMarks={shown?.lineMarks}
              inlineValues={shown?.values ?? covered?.tallies}
              gutterNotes={covered?.notes}
              reveal={revealing}
              ariaLabel="Security rules source"
              testId="rules-source"
            />
          </div>
          <Problems problems={problems} onJump={(line) => setReveal({ line })} />
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
              onValueChange={(next) =>
                update({ panel: next === 'decisions' ? undefined : (next as RulesPanel) })
              }
              tabs={[
                { value: 'decisions', label: 'Decisions' },
                { value: 'playground', label: 'Playground' },
                {
                  value: 'tests',
                  label: (
                    <span className="flex items-center gap-1.5" data-testid="tab-tests">
                      Tests
                      {tests && tests.failing > 0 && (
                        <span className="rounded-full bg-kumo-danger px-1.5 text-[10px] leading-4 text-kumo-inverse tabular-nums">
                          {tests.failing}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  value: 'collections',
                  label: (
                    <span className="flex items-center gap-1.5">
                      Collections
                      {warnings > 0 && (
                        <span className="rounded-full bg-kumo-warning-tint px-1.5 text-[10px] leading-4 text-kumo-default tabular-nums ring ring-kumo-warning">
                          {warnings}
                        </span>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {panel === 'decisions' && (
              <DecisionsPanel
                database={database}
                source={draft.source}
                flips={draftCompiles ? impact.data?.flips : undefined}
                selected={selected}
                onReveal={(line) => setReveal({ line })}
              />
            )}
            {panel === 'playground' && (
              <Playground
                project={project}
                database={database}
                source={draft.source}
                onReveal={(line) => setReveal({ line })}
              />
            )}
            {panel === 'tests' && (
              <TestsPanel
                project={project}
                database={database}
                source={draft.source}
                rulesFile={draft.rules.data?.path?.split('/').pop()}
              />
            )}
            {panel === 'collections' && (
              <CollectionsPanel
                project={project}
                database={database}
                draft={draft}
                checked={checked}
                onReveal={(line) => setReveal({ line })}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

function RulesToolbar({
  database,
  onDatabase,
  draft,
  coverage,
  coverageOn,
  onCoverage,
}: {
  database: string
  onDatabase: (database: string) => void
  draft: RulesDraft
  coverage: CoverageView | undefined
  coverageOn: boolean
  onCoverage: (on: boolean) => void
}) {
  const document = draft.rules.data
  const file = document?.path
  const name = file ? file.slice(file.lastIndexOf('/') + 1) : undefined
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-base pr-2 pl-3"
      data-testid="rules-toolbar"
    >
      <DatabasePicker value={database} onChange={onDatabase} className="w-60 shrink-0" />
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
          No rules file in firebase.json
        </Text>
      )}
      {draft.edited ? (
        // Kumo's Badge does not pass a test id through; the span holds it.
        <span className="flex" data-testid="rules-draft-state">
          <Badge variant="outline">Draft · not applied</Badge>
        </span>
      ) : (
        file &&
        draft.fileSource !== null &&
        draft.fileSource !== draft.inForce &&
        draft.fileProblems.length === 0 && (
          <Tooltip
            content={`What is in force was applied here but not written to ${name}. Save writes it; History compares the two.`}
            render={
              <span className="flex" data-testid="rules-unsaved">
                <Badge variant="outline">Applied · not saved</Badge>
              </span>
            }
          />
        )
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {/* A mode that is on is the secondary button, as everywhere here. */}
        <Tooltip
          content={
            coverageOn
              ? coverage
                ? `${coverage.ran} of ${coverage.of} conditions have run since these rules were loaded. Hide the counts.`
                : 'Counts appear once requests reach these rules. Hide the counts.'
              : 'Show how often each rule has run'
          }
          render={
            <Button
              variant={coverageOn ? 'secondary' : 'ghost'}
              size="sm"
              icon={<ChartBarHorizontalIcon />}
              aria-pressed={coverageOn}
              onClick={() => onCoverage(!coverageOn)}
              data-testid="rules-coverage"
            >
              {coverageOn && coverage ? `${coverage.ran}/${coverage.of} ran` : 'Coverage'}
            </Button>
          }
        />
        <HistoryButton database={database} draft={draft} />
        <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
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
              In force from the next request, not written to disk
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
              'firebase.json names no rules file for this database'
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
      </span>
    </div>
  )
}

/** Things about the rules in force that change what the text on screen means. */
function RulesBanners({
  draft,
  impact,
  tests,
  onShowTests,
  onReveal,
}: {
  draft: RulesDraft
  impact: RulesImpact | undefined
  tests: { total: number; failing: number } | undefined
  onShowTests: () => void
  onReveal: (line: number) => void
}) {
  const { update } = useRulesSearch()
  const document = draft.rules.data
  if (!document) return null
  const denies = impact?.flips.filter((flip) => flip.after !== 'allow').length ?? 0
  const allows = (impact?.flips.length ?? 0) - denies
  const name = document.path?.split('/').pop() ?? 'the rules file'
  return (
    <>
      {!document.enforced && (
        <Banner tone="warning" testId="rules-not-enforced">
          No rules are loaded for this database, so the emulator allows every request. Apply a
          ruleset to start checking them.
        </Banner>
      )}
      {draft.fileProblems.length > 0 && (
        <Banner
          tone="danger"
          testId="rules-file-problems"
          action={
            draft.fileSource !== null && (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => {
                  if (draft.fileSource !== null) draft.setSource(draft.fileSource)
                  const first = draft.fileProblems[0]
                  if (first) onReveal(first.line)
                }}
              >
                Open the file to fix it
              </Button>
            )
          }
        >
          {name} changed on disk and does not compile, so the rules in force are the previous ones:{' '}
          {draft.fileProblems
            .map((problem) => `${problem.line}:${problem.column} ${problem.message}`)
            .join('; ')}
        </Banner>
      )}
      {draft.overtaken && (
        <Banner
          tone="warning"
          testId="rules-overtaken"
          action={
            <span className="flex gap-1.5">
              <Button variant="ghost" size="xs" onClick={draft.revert}>
                Discard my draft
              </Button>
              <Button variant="secondary" size="xs" onClick={draft.rebase}>
                Keep editing mine
              </Button>
            </span>
          }
        >
          The rules in force changed while you were editing — saved from somewhere else, or the file
          changed on disk.
        </Banner>
      )}
      {impact && impact.flips.length > 0 && (
        <Banner
          tone="warning"
          testId="rules-impact"
          action={
            <Button
              variant="secondary"
              size="xs"
              onClick={() => update({ panel: undefined, decision: undefined, flips: true })}
            >
              Show them
            </Button>
          }
        >
          Applying this draft would{' '}
          {denies > 0 &&
            `deny ${denies} request${denies === 1 ? '' : 's'} that ${denies === 1 ? 'was' : 'were'} allowed`}
          {denies > 0 && allows > 0 && ' and '}
          {allows > 0 &&
            `allow ${allows} request${allows === 1 ? '' : 's'} that ${allows === 1 ? 'was' : 'were'} denied`}
          , of the {impact.considered} recent requests the engine still holds.
        </Banner>
      )}
      {tests && tests.failing > 0 && (
        <Banner
          tone="warning"
          testId="rules-tests-failing"
          action={
            <Button variant="secondary" size="xs" onClick={onShowTests}>
              Show the tests
            </Button>
          }
        >
          {tests.failing} of {tests.total} saved test{tests.total === 1 ? '' : 's'}{' '}
          {tests.failing === 1 ? 'fails' : 'fail'} against this draft.
        </Banner>
      )}
    </>
  )
}

function Banner({
  tone,
  testId,
  action,
  children,
}: {
  tone: 'warning' | 'danger'
  testId: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[13px] ${
        tone === 'danger'
          ? 'border-kumo-danger bg-kumo-danger-tint'
          : 'border-kumo-line bg-kumo-warning-tint'
      }`}
      role="status"
      data-testid={testId}
    >
      <WarningIcon
        size={14}
        className={`shrink-0 ${tone === 'danger' ? 'text-kumo-danger' : 'text-kumo-warning'}`}
      />
      <span className="min-w-0 flex-1 text-kumo-default">{children}</span>
      {action}
    </div>
  )
}

interface Problem {
  severity: string
  message: string
  line: number
  column: number
  from?: number | undefined
  to?: number | undefined
  code?: string | null | undefined
}

/**
 * Everything wrong with the text, once: what the engine's check finds as
 * it is typed, and what the last Apply refused (the same errors, usually,
 * but an Apply can be refused for reasons a check does not see).
 */
function problemsOf(checked: readonly Problem[], rejected: readonly Problem[]): Problem[] {
  const seen = new Set<string>()
  const out: Problem[] = []
  for (const problem of [...checked, ...rejected]) {
    const key = `${problem.line}:${problem.column}:${problem.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(problem)
  }
  return out.toSorted((left, right) =>
    left.severity === right.severity ? left.line - right.line : left.severity === 'error' ? -1 : 1,
  )
}

/** Every problem in the text, each a way to its place. */
function Problems({ problems, onJump }: { problems: Problem[]; onJump: (line: number) => void }) {
  if (problems.length === 0) return null
  const errors = problems.some((problem) => problem.severity === 'error')
  return (
    <ul
      className={`max-h-36 shrink-0 overflow-y-auto border-t ${
        errors ? 'border-kumo-danger bg-kumo-danger-tint' : 'border-kumo-line bg-kumo-warning-tint'
      }`}
      data-testid="rules-diagnostics"
    >
      {problems.map((problem) => (
        <li key={`${problem.line}:${problem.column}:${problem.message}`}>
          <button
            type="button"
            onClick={() => onJump(problem.line)}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:ink"
            data-severity={problem.severity}
          >
            <span
              className={`flex h-lh shrink-0 items-center ${
                problem.severity === 'error' ? 'text-kumo-danger' : 'text-kumo-warning'
              }`}
            >
              <WarningIcon size={14} />
            </span>
            <span className="font-mono text-[12px] text-kumo-default">
              {describeDiagnostic(problem)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A value that settles: the latest after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return settled
}

const COVERAGE_KEY = 'firenook.console.rules-coverage'

/** Whether coverage is drawn in the editor; remembered in this browser. */
function useCoveragePreference(): [boolean, (on: boolean) => void] {
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

export type { RulesDecision }
