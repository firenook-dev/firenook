// Storage's security rules, as a page of their own beside Files.
//
// The editor is the centre, and it knows Storage's rules: `match
// /b/{bucket}/o`, the file an upload proposes (`request.resource.size`,
// `contentType`, `metadata` with the keys the bucket's files carry),
// `firestore.get()`. Whatever is chosen on the right is drawn into it: a
// decision lights the lines that decided it and writes, after each
// expression, the value it had; a playground run does the same for a
// request that was never made.
//
// The scope is what `firebase.json` says: one file for every bucket (the
// toolbar says "All buckets", and an Apply governs each of them from the
// next request), a file per bucket (the bucket picker), or none at all in a
// demo project (the emulator's open default rules, said in a banner).
//
// The page is the rules kit's (`src/rules/`) — the draft, the check, the
// toolbar, the banners, the Problems strip, history, coverage, the tests
// panel and the decisions shell, shared with Firestore's rules page — with
// Storage's own pieces: the `storage.decisions` feed, the playground's file
// requests, the folders map and starter rules from the bucket's files.

import { Tabs, Text, Tooltip } from '@cloudflare/kumo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { statusQuery } from '@/api/queries'
import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import type { StorageRulesDocument } from '@/api/generated/storage/StorageRulesDocument'
import { CodeEditor } from '@/components/code-editor'
import { CopyButton } from '@/components/console/copy-button'
import { QueryError, useDelayedFlag } from '@/components/console/empty-state'
import { ScopeSelect } from '@/components/console/scope-select'
import { SectionBanner } from '@/components/console/section-banner'
import { Page } from '@/components/shell/page'
import { formatCount } from '@/lib/format'
import { identityUsersQuery } from '@/lib/identity'
import { useShortcuts } from '@/lib/shortcuts'
import {
  FileProblemsBanner,
  ImpactBanner,
  OvertakenBanner,
  TestsFailingBanner,
} from '@/rules/banners'
import { useRulesCheck } from '@/rules/check'
import { coverageView } from '@/rules/coverage'
import { type RulesDraft, useRulesDraft } from '@/rules/draft'
import { useEditorFocus } from '@/rules/focus'
import type { OriginLabels } from '@/rules/history'
import { Problems, nextProblem } from '@/rules/problems'
import { TestsPanel } from '@/rules/tests-panel'
import { RulesToolbar, fileName, useCoveragePreference } from '@/rules/toolbar'
import { useStorageRulesLive } from '../live'
import {
  bucketsQuery,
  profileQuery,
  rulesScope,
  scopeBucket,
  storageCoverageQuery,
  storageImpactQuery,
  storageRulesBackend,
  storageRulesCheckQuery,
  storageRulesHistoryQuery,
} from '../queries'
import { DecisionsPanel } from './decisions-panel'
import { decisionParams, useStorageDecisions } from './decisions'
import { FoldersPanel } from './folders-panel'
import { useStorageRulesPalette } from './palette'
import { Playground } from './playground'
import { usePlayground } from './playground-store'
import { describeForm } from './requests'
import { type StorageRulesPanel, useStorageRulesSearch } from './rules-search'
import { exportTests } from './tests-export'
import {
  type TestCase,
  isTestCase,
  runTests,
  testsStore,
  useTestRunner,
  useTestSummary,
  useTests,
} from './tests-store'

/** Where each version of a scope's rules came from. */
const ORIGINS: OriginLabels = {
  startup: 'Loaded at startup',
  console: 'Applied in the console',
  file: 'Changed on disk',
  reload: 'Reloaded through /internal/setRules',
}

/** What `firebase.json` needs for Storage to have rules of its own. */
const STORAGE_SNIPPET = '"storage": { "rules": "storage.rules" }'

export function StorageRulesPage() {
  const status = useQuery(statusQuery)
  const project = status.data?.projectId
  if (!project) {
    return (
      <Page className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h1">
          Storage rules
        </Text>
        <Text variant="secondary">
          {status.isError ? 'The engine is unreachable.' : 'Connecting to the engine…'}
        </Text>
      </Page>
    )
  }
  return (
    <StorageRulesScope project={project} diagnostics={status.data?.features.diagnostics ?? true} />
  )
}

/** The buckets decide the scope: a bucket in per-bucket mode, every bucket otherwise. */
function StorageRulesScope({ project, diagnostics }: { project: string; diagnostics: boolean }) {
  const { search } = useStorageRulesSearch()
  const buckets = useQuery(bucketsQuery(project))
  const slow = useDelayedFlag(buckets.isPending)
  if (buckets.isError)
    return (
      <QueryError error={buckets.error} onRetry={() => void buckets.refetch()} section="storage" />
    )
  if (!buckets.data)
    return (
      <div className="p-4" data-testid="rules-loading">
        {slow && (
          <Text size="sm" variant="secondary">
            Reading the buckets…
          </Text>
        )}
      </div>
    )
  if (buckets.data.rulesMode === null)
    return (
      <Page className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h1">
          Storage rules
        </Text>
        <Text variant="secondary">
          Storage runs without rules on this engine, so every request is allowed and there is
          nothing to edit.
        </Text>
      </Page>
    )
  const bucket = search.bucket ?? buckets.data.defaultBucket
  const scope = rulesScope(buckets.data, bucket)
  return (
    <StorageRulesBody
      // A scope is its own page: its draft, check, tests and decisions.
      key={scope}
      project={project}
      diagnostics={diagnostics}
      buckets={buckets.data}
      bucket={bucket}
      scope={scope}
    />
  )
}

function StorageRulesBody({
  project,
  diagnostics,
  buckets,
  bucket,
  scope,
}: {
  project: string
  diagnostics: boolean
  buckets: StorageBuckets
  bucket: string
  scope: string
}) {
  const { search, update } = useStorageRulesSearch()
  const queryClient = useQueryClient()
  const draft = useRulesDraft(storageRulesBackend(project, scope))
  const document = draft.rules.data as StorageRulesDocument | undefined
  useStorageRulesLive(project, scope)
  const panel: StorageRulesPanel = search.panel ?? 'decisions'
  const [historyOpen, setHistoryOpen] = useState(false)

  const params = diagnostics
    ? decisionParams(scopeBucket(scope), {
        path: search.path,
        uid: search.uid,
        denied: search.denied,
        method: search.method,
      })
    : null
  const decisions = useStorageDecisions(project, scope, params)

  const focus = useEditorFocus({
    source: draft.source,
    loaded: draft.rules.isSuccess,
    line: search.line,
    onLineShown: () => update({ line: undefined }, { replace: true }),
  })
  const [coverageOn, setCoverageOn] = useCoveragePreference()

  // The draft, checked as it is typed: the compiler's errors and the
  // engine's warnings (Storage's own among them: uploads with no size
  // limit, list() below rules_version 2), where they are.
  const { checked, problems, marks, warnings, compiles } = useRulesCheck(draft, scope, (text) =>
    storageRulesCheckQuery(project, scope, text),
  )

  // How often each expression has run, moving as the app makes requests:
  // the decisions feed asks for the report again (at most once a second).
  const coverage = useQuery({ ...storageCoverageQuery(project, scope), enabled: diagnostics })
  const covered = useMemo(
    () => (coverageOn ? coverageView(coverage.data, draft.source) : undefined),
    [coverageOn, coverage.data, draft.source],
  )

  // The saved tests, run against the editor's text as it changes.
  useTestRunner(project, scope, bucket, draft.source, draft.rules.isSuccess)
  const tests = useTestSummary(draft.source)
  const cases = useTests((state) => state.cases)
  const loadPlayground = usePlayground((state) => state.load)

  // What applying the draft would turn around among the decisions the
  // engine can still re-run — asked once the draft compiles and settles.
  const impact = useQuery({
    ...storageImpactQuery(project, scope, checked ?? ''),
    enabled: compiles && diagnostics,
  })

  // The text of the rules a decision was made by, while the page has it:
  // what is in force, or a version in the history.
  const history = useQuery(storageRulesHistoryQuery(project, scope))
  const rulesOf = (hash: string): string | undefined => {
    if (document && document.hash === hash) return document.source
    return history.data?.find((version) => version.hash === hash)?.source
  }

  // Completion that knows the bucket: custom metadata keys its files carry
  // under a folder, and the custom claims the Auth emulator's users have
  // (the first page of the engine's bounded identity search).
  const users = useQuery(identityUsersQuery(project, ''))
  const completion = useMemo(
    () => ({
      dialect: 'storage' as const,
      metadataKeys: async (prefix: string) =>
        (await queryClient.fetchQuery(profileQuery(project, bucket, prefix))).metadataKeys,
      claims: () => [
        ...new Set((users.data ?? []).flatMap((user) => Object.keys(user.claims ?? {}))),
      ],
    }),
    [queryClient, project, bucket, users.data],
  )

  const rulesFile = fileName(document?.path) ?? 'storage.rules'
  const exportFile = (list: readonly TestCase[]) => ({
    name: `${rulesFile}.test.ts`,
    text: exportTests(list, { project, bucket, rulesFile }),
  })
  const openPanel = (next: StorageRulesPanel) =>
    update({ panel: next === 'decisions' ? undefined : next })

  useStorageRulesPalette({
    draft,
    coverageOn,
    setCoverageOn,
    openHistory: () => setHistoryOpen(true),
    openPanel,
    cases,
    exportFile,
  })

  // ⌘↵ applies, ⌘S saves, from the keys and from inside the editor, which
  // is where they are pressed; F8 and Shift+F8 walk the problems.
  useShortcuts({ id: 'storage.rules', label: 'Storage rules' }, [
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
        if (document?.path) draft.apply(true)
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

  const mode = document?.mode ?? buckets.rulesMode
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="rules-page">
      <h1 className="sr-only">Storage rules</h1>
      <RulesToolbar
        scope={
          mode === 'perBucket' ? (
            <ScopeSelect
              label="Bucket"
              value={bucket}
              items={buckets.buckets.map((item) => ({
                value: item.name,
                detail: item.isDefault ? 'default' : item.served ? undefined : 'no rules',
              }))}
              onChange={(next) =>
                update({
                  bucket: next === buckets.defaultBucket ? undefined : next,
                  decision: undefined,
                  path: undefined,
                })
              }
              onOpen={() =>
                void queryClient.invalidateQueries({ queryKey: bucketsQuery(project).queryKey })
              }
              testId="rules-bucket"
              className="w-80 shrink"
            />
          ) : (
            <AllBuckets governs={document?.governs ?? buckets.buckets.map((item) => item.name)} />
          )
        }
        draft={draft}
        coverage={covered}
        coverageOn={coverageOn}
        onCoverage={setCoverageOn}
        history={storageRulesHistoryQuery(project, scope)}
        origins={ORIGINS}
        noFileText={
          mode === 'openDefault'
            ? 'Open default rules · no storage section in firebase.json'
            : 'No rules file in firebase.json'
        }
        noFileTip={
          mode === 'openDefault'
            ? 'firebase.json has no storage section, so there is no file to save to'
            : `firebase.json names no rules file for gs://${bucket}; Apply keeps rules in memory`
        }
        applyTip={
          mode === 'single' || mode === 'openDefault'
            ? 'In force for every bucket from the next request'
            : `In force for gs://${bucket} from the next request, not written to disk`
        }
        historyOpen={historyOpen}
        onHistoryOpen={setHistoryOpen}
      />
      <ScopeBanners document={document} draft={draft} bucket={bucket} />
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
          aria-label="Storage rules source"
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
              ariaLabel="Storage rules source"
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
              onValueChange={(next) => openPanel(next as StorageRulesPanel)}
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
                  value: 'folders',
                  label: (
                    <span className="flex items-center gap-1.5" data-testid="tab-folders">
                      Folders
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
                project={project}
                scope={scope}
                bucket={bucket}
                diagnostics={diagnostics}
                enforced={document?.enforced ?? true}
                log={decisions.log}
                status={decisions.status}
                flips={compiles ? impact.data?.flips : undefined}
                rulesOf={rulesOf}
                editorSource={draft.source}
                onReveal={focus.setReveal}
              />
            )}
            {panel === 'playground' && (
              <Playground
                project={project}
                scope={scope}
                bucket={bucket}
                buckets={buckets.buckets}
                source={draft.source}
                ready={draft.rules.isSuccess}
                onReveal={focus.setReveal}
              />
            )}
            {panel === 'tests' && (
              <TestsPanel
                store={testsStore}
                source={draft.source}
                onRun={() => void runTests(project, scope, bucket, draft.source)}
                describe={(test) => test.name || describeForm(test.form, bucket)}
                onOpen={(test) => {
                  loadPlayground(test.form)
                  update({ panel: 'playground' })
                }}
                exportFile={exportFile}
                isCase={isTestCase}
              />
            )}
            {panel === 'folders' && (
              <FoldersPanel
                project={project}
                scope={scope}
                bucket={bucket}
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

/** Single-file mode: one ruleset governs every bucket, and the chip says which ones. */
function AllBuckets({ governs }: { governs: readonly string[] }) {
  return (
    <Tooltip
      content={
        <span className="grid gap-1">
          <span>One rules file governs every bucket:</span>
          {governs.map((name) => (
            <span key={name} className="font-mono text-[12px]">
              gs://{name}
            </span>
          ))}
        </span>
      }
      render={
        <span
          className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-md bg-kumo-tint px-2 text-[12px]"
          data-testid="rules-all-buckets"
        >
          <span className="text-kumo-default">All buckets</span>
          <span className="text-kumo-subtle tabular-nums">
            {formatCount(governs.length, { one: 'bucket', other: 'buckets' })}
          </span>
        </span>
      }
    />
  )
}

/**
 * What the scope itself is, when it is not the ordinary case: the
 * emulator's open default rules, a bucket no rules serve, and rules a failed
 * reload dropped.
 */
function ScopeBanners({
  document,
  draft,
  bucket,
}: {
  document: StorageRulesDocument | undefined
  draft: RulesDraft
  bucket: string
}) {
  if (!document) return null
  if (document.openDefault)
    return (
      <SectionBanner
        tone="warning"
        testId="rules-open-default"
        action={
          <CopyButton value={STORAGE_SNIPPET} label="Copy the firebase.json lines" size="xs" />
        }
      >
        These are the emulator’s open default rules: anyone can read and write every file, because
        firebase.json has no storage section. Give Storage your rules with{' '}
        <code className="font-mono text-[12px]">{STORAGE_SNIPPET}</code>.
      </SectionBanner>
    )
  if (document.enforced || draft.edited) return null
  if (document.mode === 'perBucket' && document.path === null)
    return (
      <SectionBanner tone="warning" testId="rules-not-served">
        No rules govern gs://{bucket}, so the emulator refuses every client request to it — the
        Admin SDK included. Add it to the storage targets in firebase.json, or write rules here and
        Apply them to try them (they stay in memory).
      </SectionBanner>
    )
  return (
    <SectionBanner tone="danger" testId="rules-dropped">
      The last rules reload did not compile, so the emulator has no Storage rules loaded and refuses
      every request. Apply rules here to load them again.
    </SectionBanner>
  )
}
