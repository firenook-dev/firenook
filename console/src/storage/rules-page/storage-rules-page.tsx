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
// The page is the rules kit's workbench (`src/rules/workbench.tsx`) — the
// same frame, keys and ⌘K as Firestore's rules page — with Storage's own
// pieces: the scope, the `storage.decisions` feed, the playground's file
// requests, the folders map and starter rules from the bucket's files.

import { Text, Tooltip } from '@cloudflare/kumo'
import {
  FlaskIcon,
  FoldersIcon,
  ListChecksIcon,
  MagicWandIcon,
  ScalesIcon,
} from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { statusQuery } from '@/api/queries'
import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import type { StorageRulesDocument } from '@/api/generated/storage/StorageRulesDocument'
import { CopyButton } from '@/components/console/copy-button'
import { QueryError, useDelayedFlag } from '@/components/console/empty-state'
import { ScopeSelect } from '@/components/console/scope-select'
import { SectionBanner } from '@/components/console/section-banner'
import { Page } from '@/components/shell/page'
import { useClaimKeys } from '@/lib/claim-keys'
import { download } from '@/lib/download'
import { formatCount } from '@/lib/format'
import { useRulesCheck } from '@/rules/check'
import { RulesDecisionsPanel } from '@/rules/decisions-panel'
import { type RulesDraft, useRulesDraft } from '@/rules/draft'
import { useEditorFocus } from '@/rules/focus'
import type { OriginLabels } from '@/rules/history'
import { TestsPanel } from '@/rules/tests-panel'
import { fileName } from '@/rules/toolbar'
import { type WorkbenchPanel, RulesWorkbench } from '@/rules/workbench'
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
import { DecisionDetail } from './decision-detail'
import { decisionParams, emptyText, rowExtras, useStorageDecisions } from './decisions'
import { FoldersPanel } from './folders-panel'
import { Playground } from './playground'
import { usePlayground } from './playground-store'
import { describeForm } from './requests'
import { type StorageRulesPanel, useStorageRulesSearch } from './rules-search'
import { exportTests } from './tests-export'
import { type TestCase, tests } from './tests-store'

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
  const openPanel = (next: StorageRulesPanel) =>
    update({ panel: next === 'decisions' ? undefined : next })
  const loadPlayground = usePlayground((state) => state.load)

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

  // The draft, checked as it is typed: the compiler's errors and the
  // engine's warnings (Storage's own among them: uploads with no size
  // limit, list() below rules_version 2), where they are.
  const check = useRulesCheck(draft, scope, (text) => storageRulesCheckQuery(project, scope, text))

  // The saved tests, run against the editor's text as it changes.
  tests.useRunner({ project, scope, bucket }, draft.source, draft.rules.isSuccess)
  const summary = tests.useSummary(draft.source)
  const cases = tests.useTests((state) => state.cases)

  // What applying the draft would turn around among the decisions the
  // engine can still re-run — asked once the draft compiles and settles.
  const impact = useQuery({
    ...storageImpactQuery(project, scope, check.checked ?? ''),
    enabled: check.compiles && diagnostics,
  })
  const flips = check.compiles
    ? new Map((impact.data?.flips ?? []).map((flip) => [flip.id, flip.after]))
    : undefined

  // The text of the rules a decision was made by, while the page has it:
  // what is in force, or a version in the history.
  const history = useQuery(storageRulesHistoryQuery(project, scope))
  const rulesOf = (hash: string): string | undefined => {
    if (document && document.hash === hash) return document.source
    return history.data?.find((version) => version.hash === hash)?.source
  }

  // Completion that knows the bucket: custom metadata keys its files carry
  // under a folder, and the custom claim keys the Auth emulator's users
  // carry (the engine's claim index, asked when completion opens).
  const claimKeys = useClaimKeys(project)
  const completion = useMemo(
    () => ({
      dialect: 'storage' as const,
      metadataKeys: async (prefix: string) =>
        (await queryClient.fetchQuery(profileQuery(project, bucket, prefix))).metadataKeys,
      claims: claimKeys.fresh,
    }),
    [queryClient, project, bucket, claimKeys],
  )

  const rulesFile = fileName(document?.path) ?? 'storage.rules'
  const exportFile = (list: readonly TestCase[]) => ({
    name: `${rulesFile}.test.ts`,
    text: exportTests(list, { project, bucket, rulesFile }),
  })

  const panels: WorkbenchPanel<StorageRulesPanel>[] = [
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
      value: 'folders',
      label: 'Folders',
      palette: {
        title: 'Folders',
        description: 'Which rules govern which folders',
        keywords: 'map uncovered coverage',
        icon: <FoldersIcon size={16} />,
      },
    },
  ]

  const mode = document?.mode ?? buckets.rulesMode
  return (
    <RulesWorkbench
      page="storage"
      title="Storage rules"
      sourceLabel="Storage rules source"
      draft={draft}
      focus={focus}
      check={check}
      completion={completion}
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
      coverageQuery={storageCoverageQuery(project, scope)}
      coverageAvailable={diagnostics}
      banners={<ScopeBanners document={document} draft={draft} bucket={bucket} />}
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
          id: 'storage-rules:starter',
          title: 'Add starter rules',
          description: 'From a template or from the bucket’s files',
          keywords: 'template generate',
          icon: <MagicWandIcon size={16} />,
          run: () => openPanel('folders'),
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
          keepEnd
          extras={(decision) => rowExtras(decision, scope === '*' ? undefined : bucket)}
          renderDetail={(decision) => (
            <DecisionDetail
              key={decision.id}
              project={project}
              scope={scope}
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
          store={tests.store}
          source={draft.source}
          onRun={() => void tests.run({ project, scope, bucket }, draft.source)}
          describe={(test) => test.name || describeForm(test.form, bucket)}
          onOpen={(test) => {
            loadPlayground(test.form)
            update({ panel: 'playground' })
          }}
          exportFile={exportFile}
        />
      )}
      {panel === 'folders' && (
        <FoldersPanel
          project={project}
          scope={scope}
          bucket={bucket}
          draft={draft}
          checked={check.checked}
          onReveal={focus.setReveal}
        />
      )}
    </RulesWorkbench>
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
