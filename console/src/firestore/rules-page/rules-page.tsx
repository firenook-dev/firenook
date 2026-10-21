// The security rules of one database, as a page of their own: the rules
// kit's workbench (`src/rules/workbench.tsx`) — the same frame, keys and ⌘K
// as Storage's rules page — filled with Firestore's own pieces: the
// database picker, the `firestore.decisions` topic, the playground's
// document requests, the collections map, and completion that knows the
// fields documents carry.
//
// They were a mode of the data view once — a Rules button among View as and
// New that swapped the grid for a textarea. Writing who may do what is a
// different job from reading what there is, so it has its own page, its
// own address, and the things that job needs beside the text.

import { Text } from '@cloudflare/kumo'
import {
  FlaskIcon,
  ListChecksIcon,
  MagicWandIcon,
  ScalesIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useMemo } from 'react'
import { statusQuery } from '@/api/queries'
import { SectionBanner } from '@/components/console/section-banner'
import { Page } from '@/components/shell/page'
import { useClaimKeys } from '@/lib/claim-keys'
import { download } from '@/lib/download'
import { useRulesCheck } from '@/rules/check'
import { RulesDecisionsPanel } from '@/rules/decisions-panel'
import { useRulesDraft } from '@/rules/draft'
import { useEditorFocus } from '@/rules/focus'
import type { OriginLabels } from '@/rules/history'
import { TestsPanel } from '@/rules/tests-panel'
import { fileName } from '@/rules/toolbar'
import { type WorkbenchPanel, RulesWorkbench } from '@/rules/workbench'
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
import { DecisionDetail } from './decision-detail'
import { decisionParams, emptyText, useFirestoreDecisions } from './decisions'
import { usePlayground } from './playground-store'
import { describeForm } from './requests'
import { type RulesPanel, useRulesSearch } from './rules-search'
import { fieldsQuery } from './schema-fields'
import { exportTests } from './tests-export'
import { type TestCase, tests } from './tests-store'

// The playground (its request form, the identity picker and the result
// view) loads when its tab is first opened, not with the page.
const Playground = lazy(() =>
  import('./playground').then((module) => ({ default: module.Playground })),
)

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
  return <RulesBody project={project} diagnostics={status.data?.features.diagnostics ?? true} />
}

function RulesBody({ project, diagnostics }: { project: string; diagnostics: boolean }) {
  const { search, update } = useRulesSearch()
  const database = search.db ?? DEFAULT_DATABASE
  const draft = useRulesDraft(firestoreRulesBackend(project, database))
  const queryClient = useQueryClient()
  useRulesLive(database)
  const panel: RulesPanel = search.panel ?? 'decisions'
  const openPanel = (next: RulesPanel) => update({ panel: next === 'decisions' ? undefined : next })
  const loadPlayground = usePlayground((state) => state.load)

  const params = diagnostics
    ? decisionParams(database, {
        path: search.path,
        uid: search.uid,
        denied: search.denied,
        method: search.method,
      })
    : null
  const decisions = useFirestoreDecisions(database, params)

  const focus = useEditorFocus({
    source: draft.source,
    loaded: draft.rules.isSuccess,
    line: search.line,
    onLineShown: () => update({ line: undefined }, { replace: true }),
  })

  // The draft, checked as it is typed: the compiler's errors and the
  // engine's warnings, where they are, before anything is applied.
  const check = useRulesCheck(draft, database, (text) => checkQuery(database, text))

  // The saved tests, run against the editor's text as it changes.
  tests.useRunner({ project, database }, draft.source, draft.rules.isSuccess)
  const summary = tests.useSummary(draft.source)
  const cases = tests.useTests((state) => state.cases)

  // What applying the draft would turn around among the decisions the
  // engine can still re-run — asked once the draft compiles and settles.
  const impact = useQuery({
    ...impactQuery(database, check.checked ?? ''),
    enabled: check.compiles && diagnostics,
  })
  const flips = check.compiles
    ? new Map((impact.data?.flips ?? []).map((flip) => [flip.requestId, flip.after]))
    : undefined

  // The text of the rules a decision was made by, while the page has it:
  // what is in force, or a version in the history.
  const history = useQuery(historyQuery(database))
  const document = draft.rules.data
  const rulesOf = (hash: string): string | undefined => {
    if (document && document.hash === hash) return document.source
    return history.data?.find((version) => version.hash === hash)?.source
  }

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

  const rulesFile = fileName(document?.path ?? document?.governedBy?.path) ?? 'firestore.rules'
  const exportFile = (list: readonly TestCase[]) => ({
    name: 'firestore.rules.test.ts',
    text: exportTests(list, { project, rulesFile }),
  })

  const panels: WorkbenchPanel<RulesPanel>[] = [
    {
      value: 'decisions',
      label: 'Decisions',
      palette: {
        title: 'Decisions',
        description: 'Every request the rules judged',
        keywords: 'requests denied allowed why',
        icon: <ScalesIcon size={16} />,
      },
    },
    {
      value: 'playground',
      label: 'Playground',
      palette: {
        title: 'Playground',
        description: 'Try a request against the draft',
        keywords: 'simulate test request',
        icon: <FlaskIcon size={16} />,
      },
    },
    {
      value: 'tests',
      label: 'Tests',
      alarm: summary?.failing,
      testId: 'tab-tests',
      palette: {
        title: 'Tests',
        description: 'Saved requests and the verdict each should get',
        keywords: 'saved cases',
        icon: <ListChecksIcon size={16} />,
      },
    },
    {
      value: 'collections',
      label: 'Collections',
      palette: {
        title: 'Collections',
        description: 'Which rules govern which collections',
        keywords: 'map uncovered coverage',
        icon: <TreeStructureIcon size={16} />,
      },
    },
  ]

  return (
    <RulesWorkbench
      page="firestore"
      title="Security rules"
      sourceLabel="Security rules source"
      draft={draft}
      focus={focus}
      check={check}
      completion={completion}
      scope={
        <DatabasePicker
          value={database}
          onChange={(next) =>
            update({ db: next === DEFAULT_DATABASE ? undefined : next, decision: undefined })
          }
          className="w-60 shrink-0"
        />
      }
      history={historyQuery(database)}
      origins={ORIGINS}
      noFileTip="firebase.json names no rules file for this database"
      coverageQuery={coverageQuery(project, database)}
      coverageAvailable={diagnostics}
      banners={
        document && !document.enforced ? (
          <SectionBanner tone="warning" testId="rules-not-enforced">
            No rules are loaded for this database, so the emulator allows every request. Apply a
            ruleset to start checking them.
          </SectionBanner>
        ) : document?.governedBy ? (
          <SectionBanner tone="info" testId="rules-governed-by">
            firebase.json does not list this database, so the rules of{' '}
            <span className="font-mono">{document.governedBy.database}</span>
            {document.governedBy.path && (
              <>
                {' '}
                (<span className="font-mono">{fileName(document.governedBy.path)}</span>)
              </>
            )}{' '}
            govern it, as the official emulator applies its one rules file to every database.
            Applying rules here gives this database its own.
          </SectionBanner>
        ) : undefined
      }
      impact={check.compiles ? impact.data : undefined}
      onShowFlips={() => update({ panel: undefined, decision: undefined, flips: true })}
      tests={summary}
      onShowTests={() => update({ panel: 'tests' })}
      exportTests={{
        count: cases.length,
        run: () => {
          const file = exportFile(cases)
          void download(new Blob([file.text], { type: 'text/typescript' }), file.name)
        },
      }}
      panels={panels}
      panel={panel}
      onPanel={openPanel}
      actions={[
        {
          id: 'firestore-rules:starter',
          title: 'Add starter rules',
          description: 'For a collection no rule covers, from its documents',
          keywords: 'template generate',
          icon: <MagicWandIcon size={16} />,
          run: () => openPanel('collections'),
        },
      ]}
    >
      {panel === 'decisions' && (
        <RulesDecisionsPanel
          search={search}
          update={update}
          diagnostics={diagnostics}
          log={decisions.log}
          status={decisions.status}
          flips={flips}
          placeholder="Filter by path, uid:<uid> or method"
          empty={emptyText(document?.enforced ?? true)}
          renderDetail={(decision) => (
            <DecisionDetail
              key={decision.id}
              decision={decision}
              rulesOf={rulesOf}
              editorSource={draft.source}
              onReveal={focus.setReveal}
              onTry={() => update({ panel: 'playground' })}
            />
          )}
        />
      )}
      {panel === 'playground' && (
        <Suspense fallback={null}>
          <Playground
            project={project}
            database={database}
            source={draft.source}
            ready={draft.rules.isSuccess}
            onReveal={focus.setReveal}
          />
        </Suspense>
      )}
      {panel === 'tests' && (
        <TestsPanel
          store={tests.store}
          source={draft.source}
          onRun={() => void tests.run({ project, database }, draft.source)}
          describe={(test) => test.name || describeForm(test.form)}
          onOpen={(test) => {
            loadPlayground(test.form)
            update({ panel: 'playground' })
          }}
          exportFile={exportFile}
        />
      )}
      {panel === 'collections' && (
        <CollectionsPanel
          project={project}
          database={database}
          draft={draft}
          checked={check.checked}
          onReveal={focus.setReveal}
        />
      )}
    </RulesWorkbench>
  )
}
