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
//
// The page is the rules kit's (`src/rules/`) — the draft, the check, the
// toolbar, the banners, the Problems strip, history, coverage, the tests
// panel and the decisions shell, shared with Storage's rules page — with
// Firestore's own pieces: the database picker, the Requests feed, the
// playground's document requests and the collections map.

import { Tabs, Text } from '@cloudflare/kumo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { statusQuery } from '@/api/queries'
import { CodeEditor } from '@/components/code-editor'
import { SectionBanner } from '@/components/console/section-banner'
import { Page } from '@/components/shell/page'
import { useClaimKeys } from '@/lib/claim-keys'
import { useShortcuts } from '@/lib/shortcuts'
import {
  FileProblemsBanner,
  ImpactBanner,
  OvertakenBanner,
  TestsFailingBanner,
} from '@/rules/banners'
import { useRulesCheck } from '@/rules/check'
import { coverageView } from '@/rules/coverage'
import { useRulesDraft } from '@/rules/draft'
import { useEditorFocus } from '@/rules/focus'
import type { OriginLabels } from '@/rules/history'
import { Problems, nextProblem } from '@/rules/problems'
import { TestsPanel } from '@/rules/tests-panel'
import { RulesToolbar, fileName, useCoveragePreference } from '@/rules/toolbar'
import { DatabasePicker } from '../components/database-picker'
import { DEFAULT_DATABASE } from '../components/workbench-context'
import {
  checkQuery,
  coverageQuery,
  firestoreRulesBackend,
  historyQuery,
  impactQuery,
  useRulesLive,
} from './api'
import { CollectionsPanel } from './collections-panel'
import { DecisionsPanel } from './decisions-panel'
import { type RulesDecision, useDecisions, useDecisionsFeed } from './decisions'
import { Playground } from './playground'
import { usePlayground } from './playground-store'
import { describeForm } from './requests'
import { type RulesPanel, useRulesSearch } from './rules-search'
import { fieldsQuery } from './schema-fields'
import { exportTests } from './tests-export'
import { isTestCase, runTests, testsStore, useTestRunner, useTestSummary } from './tests-store'

/** Where each version of a database's rules came from. */
const ORIGINS: OriginLabels = {
  startup: 'Loaded at startup',
  console: 'Applied in the console',
  file: 'Changed on disk',
  reload: 'Hot-reloaded by a client',
}

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
  const draft = useRulesDraft(firestoreRulesBackend(project, database))
  const queryClient = useQueryClient()
  useDecisionsFeed()
  useRulesLive(database)
  const decisions = useDecisions((state) => state.decisions)
  const loadPlayground = usePlayground((state) => state.load)
  const panel: RulesPanel = search.panel ?? 'decisions'
  const selected = search.decision
    ? decisions.find((decision) => decision.requestId === search.decision)
    : undefined
  const focus = useEditorFocus({
    source: draft.source,
    loaded: draft.rules.isSuccess,
    line: search.line,
    onLineShown: () => update({ line: undefined }, { replace: true }),
  })
  const [coverageOn, setCoverageOn] = useCoveragePreference('firestore')

  // The draft, checked as it is typed: the compiler's errors and the
  // engine's warnings, where they are, before anything is applied.
  const { checked, problems, marks, warnings, compiles } = useRulesCheck(draft, database, (text) =>
    checkQuery(database, text),
  )

  // How often each rule has run, moving as the app makes requests: the
  // feed's arrivals are the signal to count again, not a timer. Read only
  // while coverage is shown; an invalidation while it is off fetches nothing.
  const coverage = useQuery({ ...coverageQuery(project, database), enabled: coverageOn })
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

  // The saved tests, run against the editor's text as it changes.
  useTestRunner(project, database, draft.source, draft.rules.isSuccess)
  const tests = useTestSummary(draft.source)

  // What applying the draft would turn around among the decisions the
  // engine still holds — asked once the draft compiles and settles.
  const impact = useQuery({ ...impactQuery(database, checked ?? ''), enabled: compiles })

  // Completion that knows the data: the fields documents of a collection
  // carry, and the custom claim keys the Auth emulator's users carry (the
  // engine's claim index, asked when completion opens — never every account).
  const claimKeys = useClaimKeys(project)
  const completion = useMemo(
    () => ({
      fields: async (pattern: string) =>
        (await queryClient.fetchQuery(fieldsQuery(project, database, pattern))).map(
          (sample) => sample.field,
        ),
      claims: claimKeys.fresh,
    }),
    [queryClient, project, database, claimKeys],
  )

  // ⌘↵ applies, ⌘S saves: the two things an edit ends in, from the keys,
  // and from inside the editor, which is where the keys are pressed. ⌘S is
  // always the page's here, so the browser never offers to save the page.
  // F8 and Shift+F8 walk the problems.
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

  const rulesFile = fileName(draft.rules.data?.path)
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="rules-page">
      <h1 className="sr-only">Security rules</h1>
      <RulesToolbar
        scope={
          <DatabasePicker
            value={database}
            onChange={(next) =>
              update({ db: next === DEFAULT_DATABASE ? undefined : next, decision: undefined })
            }
            className="w-60 shrink-0"
          />
        }
        draft={draft}
        coverage={covered}
        coverageOn={coverageOn}
        onCoverage={setCoverageOn}
        history={historyQuery(database)}
        origins={ORIGINS}
        noFileTip="firebase.json names no rules file for this database"
      />
      {draft.rules.data && !draft.rules.data.enforced && (
        <SectionBanner tone="warning" testId="rules-not-enforced">
          No rules are loaded for this database, so the emulator allows every request. Apply a
          ruleset to start checking them.
        </SectionBanner>
      )}
      <FileProblemsBanner draft={draft} onReveal={focus.setReveal} />
      <OvertakenBanner draft={draft} />
      <ImpactBanner
        impact={compiles ? impact.data : undefined}
        onShow={() => update({ panel: undefined, decision: undefined, flips: true })}
      />
      <TestsFailingBanner
        tests={draft.edited ? tests : undefined}
        onShow={() => update({ panel: 'tests' })}
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
              lineMarks={focus.lineMarks}
              inlineValues={focus.shown?.values ?? covered?.tallies}
              gutterNotes={covered?.notes}
              reveal={focus.reveal}
              ariaLabel="Security rules source"
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
                flips={compiles ? impact.data?.flips : undefined}
                selected={selected}
                onReveal={focus.setReveal}
              />
            )}
            {panel === 'playground' && (
              <Playground
                project={project}
                database={database}
                source={draft.source}
                onReveal={focus.setReveal}
              />
            )}
            {panel === 'tests' && (
              <TestsPanel
                store={testsStore}
                source={draft.source}
                onRun={() => void runTests(project, database, draft.source)}
                describe={(test) => test.name || describeForm(test.form)}
                onOpen={(test) => {
                  loadPlayground(test.form)
                  update({ panel: 'playground' })
                }}
                exportFile={(cases) => ({
                  name: 'firestore.rules.test.ts',
                  text: exportTests(cases, { project, rulesFile: rulesFile ?? 'firestore.rules' }),
                })}
                isCase={isTestCase}
              />
            )}
            {panel === 'collections' && (
              <CollectionsPanel
                project={project}
                database={database}
                draft={draft}
                checked={checked}
                onReveal={focus.setReveal}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

export type { RulesDecision }
