// Try a request against Storage's rules without the app: an operation, a
// bucket, a file or a folder, who is asking, and for an upload or a
// metadata change the file it proposes. It runs against the text in the
// editor — applied or not — through the engine's own request builder, the
// one a real client's request goes through, and runs again as the rules
// are edited, so a change is seen deciding the request before it is
// applied. Nothing is recorded and nothing is written.

import { Autocomplete, Button, Input, Select, Switch, Tabs, Text } from '@cloudflare/kumo'
import { ClockIcon, FlaskIcon, PlayIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { StorageBucket } from '@/api/generated/storage/StorageBucket'
import { IdentityPicker } from '@/components/console/identity-picker'
import { KeyValueEditor } from '@/components/console/key-value-editor'
import { formatBytes } from '@/lib/format'
import { inlineSteps } from '@/rules/explain'
import { ExplanationView } from '@/rules/explanation-view'
import { linesFromAllows, useOverlay } from '@/rules/overlay'
import { RULES_METHODS } from '@/rules/search'
import { RulesCompileError } from '@/rules/text'
import { useDebounced } from '@/rules/use-debounced'
import { Verdict } from '@/rules/verdict'
import { evaluateRules } from '../api'
import { objectQuery, profileQuery, scopeBucket } from '../queries'
import { STORAGE_READS } from './decision-detail'
import { FolderField } from './folder-field'
import { ObjectFacts } from './object-facts'
import { usePlayground } from './playground-store'
import {
  type PlaygroundForm,
  SIZE_UNITS,
  type SizeUnit,
  describeForm,
  describeWho,
  pathProblem,
  proposes,
  toEvaluateRequest,
} from './requests'
import { useTests } from './tests-store'

/** Types offered first in the content type field, after the ones the bucket holds. */
const COMMON_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'application/pdf',
  'application/json',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/octet-stream',
]

export function Playground({
  project,
  scope,
  bucket,
  buckets,
  source,
  onReveal,
}: {
  project: string
  scope: string
  /** The page's bucket, which a request names unless it picks another. */
  bucket: string
  /** Every bucket the console knows, for the bucket menu. */
  buckets: readonly StorageBucket[]
  /** The rules text in the editor, which every run is against. */
  source: string
  onReveal: (line: number) => void
}) {
  const form = usePlayground((state) => state.form)
  const setForm = usePlayground((state) => state.setForm)
  const run = usePlayground((state) => state.run)
  const failure = usePlayground((state) => state.failure)
  const setRun = usePlayground((state) => state.setRun)
  const show = useOverlay((state) => state.show)
  const clear = useOverlay((state) => state.clear)
  const addTest = useTests((state) => state.add)
  const [running, setRunning] = useState(false)
  const target = form.bucket || bucket
  const problem = pathProblem(form.method, form.path)
  const writing = proposes(form.method)

  // The file as it is in the bucket now, for get, update and delete (and an
  // upload over a file that is there): what `resource` will be. Read once
  // the name stops changing, not for every letter of it.
  const settled = useDebounced(form.path, 300)
  const existing = useQuery({
    ...objectQuery(project, target, settled, { kind: 'owner' }),
    enabled:
      form.method !== 'list' &&
      settled !== '' &&
      !pathProblem(form.method, settled) &&
      !form.replay,
  })
  // Types the folder already holds, offered first.
  const profile = useQuery({
    ...profileQuery(project, target, form.path.slice(0, form.path.lastIndexOf('/') + 1)),
    enabled: writing,
  })
  const types = [
    ...new Set([
      ...(profile.data?.contentTypes ?? []).map((entry) => entry.contentType),
      ...COMMON_TYPES,
    ]),
  ]

  const execute = async (request: PlaygroundForm, text: string) => {
    const built = toEvaluateRequest(request, project, bucket)
    if ('error' in built) {
      setRun(undefined, built.error)
      return
    }
    setRunning(true)
    try {
      const named = scopeBucket(scope)
      const evaluation = await evaluateRules({
        ...(named === undefined ? {} : { bucket: named }),
        source: text,
        requests: [built.request],
      })
      const result = evaluation.results[0]
      if (result) setRun({ form: request, request: built.request, source: text, result })
    } catch (error) {
      setRun(
        undefined,
        error instanceof RulesCompileError
          ? `The rules in the editor do not compile: ${error.message}`
          : (error as Error).message,
      )
    } finally {
      setRunning(false)
    }
  }

  // Edited rules, same request: run it again, so the change is seen
  // deciding it. Only once a request has been run, and only while the
  // request on screen is the one that ran.
  const latest = useRef({ form, run, execute })
  useLayoutEffect(() => {
    latest.current = { form, run, execute }
  })
  useEffect(() => {
    const current = latest.current
    if (!current.run || current.run.source === source || current.run.form !== current.form) return
    const timer = globalThis.setTimeout(
      () => void latest.current.execute(current.form, source),
      400,
    )
    return () => globalThis.clearTimeout(timer)
  }, [source])

  // The last run, drawn into the editor over the text it ran against.
  useEffect(() => {
    if (!run) {
      clear('playground')
      return
    }
    show({
      owner: 'playground',
      source: run.source,
      lineMarks: linesFromAllows(run.result.allows, run.result.outcome),
      values: inlineSteps(run.result.explanation, run.source),
      reveal: run.result.allows.find((allow) =>
        run.result.outcome === 'allow' ? allow.outcome === 'allow' : allow.outcome !== 'allow',
      )?.line,
    })
  }, [run, show, clear])
  useEffect(() => () => clear('playground'), [clear])

  const who = form.who
  const viewAs = who.kind === 'as' ? who.viewAs : { kind: 'anonymous' as const }
  const bucketItems = Object.fromEntries(
    [...new Set([bucket, target, ...buckets.map((item) => item.name)])].map((name) => [name, name]),
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="playground">
      <form
        className="grid grid-cols-[minmax(0,1fr)] gap-3 border-b border-kumo-line px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          void execute(form, source)
        }}
      >
        <Tabs
          variant="segmented"
          size="sm"
          value={form.method}
          onValueChange={(next) => setForm({ method: next as RulesMethod })}
          tabs={RULES_METHODS.map((method) => ({ value: method, label: method }))}
        />
        {Object.keys(bucketItems).length > 1 && (
          <Field label="Bucket">
            <Select
              size="sm"
              value={target}
              onValueChange={(next) =>
                setForm({ bucket: String(next) === bucket ? '' : String(next) })
              }
              items={bucketItems}
              aria-label="Bucket"
              className="w-full font-mono"
            />
          </Field>
        )}
        <Field label={form.method === 'list' ? 'Folder' : 'File'}>
          <FolderField
            project={project}
            bucket={target}
            value={form.path}
            onChange={(path) => setForm({ path })}
            placeholder={
              form.method === 'list' ? 'users/u1/ (empty: the root)' : 'users/u1/avatar.png'
            }
            ariaLabel={form.method === 'list' ? 'Folder' : 'File'}
            testId="playground-path"
          />
          {form.path !== '' && problem && (
            <Text size="xs" variant="secondary">
              {problem}
            </Text>
          )}
        </Field>
        <Field label="Who is asking">
          {who.kind === 'recorded' ? (
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 truncate font-mono text-[12px]"
                data-testid="playground-recorded"
              >
                As recorded: {describeWho(who)}
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => setForm({ who: { kind: 'as', viewAs: { kind: 'anonymous' } } })}
              >
                Ask as someone else
              </Button>
            </div>
          ) : (
            <IdentityPicker
              project={project}
              value={viewAs}
              onChange={(next) => setForm({ who: { kind: 'as', viewAs: next } })}
              modes={['anonymous', 'user', 'custom']}
              testId="playground-who"
            />
          )}
        </Field>
        {form.method === 'create' && (
          <Field label="Size">
            <div className="flex gap-2">
              <Input
                size="sm"
                value={form.size}
                onChange={(event) => setForm({ size: event.target.value })}
                inputMode="decimal"
                aria-label="Size"
                className="w-28 font-mono"
                data-testid="playground-size"
              />
              <Select
                size="sm"
                value={form.unit}
                onValueChange={(next) => setForm({ unit: next as SizeUnit })}
                items={Object.fromEntries(SIZE_UNITS.map((unit) => [unit, unit]))}
                aria-label="Size unit"
                className="w-20"
              />
            </div>
          </Field>
        )}
        {writing && (
          <Field
            label={
              form.method === 'create' ? 'Content type' : 'Content type it sets (empty: unchanged)'
            }
          >
            <div data-testid="playground-type">
              <Autocomplete
                items={types}
                value={form.contentType}
                onValueChange={(next) => setForm({ contentType: String(next ?? '') })}
              >
                <Autocomplete.InputGroup size="sm" placeholder="image/png" className="font-mono" />
                <Autocomplete.Content>
                  <Autocomplete.List>
                    {(item: string) => (
                      <Autocomplete.Item key={item} value={item}>
                        <span className="font-mono text-[12px]">{item}</span>
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.List>
                </Autocomplete.Content>
              </Autocomplete>
            </div>
          </Field>
        )}
        {writing && (
          <KeyValueEditor
            label={form.method === 'create' ? 'Custom metadata' : 'Custom metadata it sets'}
            rows={form.metadata}
            onChange={(metadata) => setForm({ metadata })}
            keyPlaceholder="key"
            valuePlaceholder={form.method === 'update' ? 'value (empty removes it)' : 'value'}
            suggestKeys={profile.data?.metadataKeys}
            validateKey={(key) =>
              key === 'firebaseStorageDownloadTokens'
                ? 'The download tokens are not custom metadata.'
                : undefined
            }
            testId="playground-metadata"
          />
        )}
        {form.method !== 'list' && (
          <Field label="The file before the request">
            {form.replay && form.replay.resource !== undefined ? (
              <Text size="xs" variant="secondary">
                {form.replay.resource
                  ? `As recorded: ${formatBytes(form.replay.resource.size)} ${form.replay.resource.contentType ?? ''}`
                  : 'As recorded: it did not exist.'}
              </Text>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate text-[12px] text-kumo-default"
                  data-testid="playground-existing"
                >
                  {form.existing === 'missing' ? (
                    <>
                      Taken as not there: <span className="font-mono">resource</span> is null
                    </>
                  ) : form.path === '' || problem ? (
                    <span className="text-kumo-subtle">Name a file to read it from the bucket</span>
                  ) : settled !== form.path || existing.isPending ? (
                    <span className="text-kumo-subtle">Reading it…</span>
                  ) : existing.data ? (
                    <>
                      Exists ·{' '}
                      <span className="font-mono">
                        {formatBytes(existing.data.size)} {existing.data.contentType ?? 'no type'}
                      </span>
                    </>
                  ) : (
                    'Does not exist'
                  )}
                </span>
                <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-kumo-subtle">
                  <Switch
                    variant="neutral"
                    size="sm"
                    checked={form.existing === 'missing'}
                    onCheckedChange={(missing) =>
                      setForm({ existing: missing ? 'missing' : 'store' })
                    }
                    aria-label="Take the file as not there"
                    data-testid="playground-missing"
                  />
                  As if not there
                </label>
              </div>
            )}
          </Field>
        )}
        <Field label="Time (empty: now)">
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              type="datetime-local"
              step={1}
              value={form.time}
              onChange={(event) => setForm({ time: event.target.value })}
              aria-label="Request time"
              className="w-56 font-mono"
              data-testid="playground-time"
            />
            {form.time === '' && form.replay?.time && (
              <Text as="span" size="xs" variant="secondary">
                <ClockIcon size={12} className="mr-1 inline" />
                As recorded
              </Text>
            )}
          </div>
        </Field>
        {form.replay && (
          <Text size="xs" variant="secondary">
            Replaying a recorded request with the file as it was then. Change the path or the
            operation to try something new.
          </Text>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<PlayIcon />}
            loading={running}
            disabled={Boolean(problem)}
            data-testid="playground-run"
          >
            Run
          </Button>
          <Text size="xs" variant="secondary">
            Against the rules in the editor; runs again as you edit them.
          </Text>
        </div>
      </form>

      {failure && (
        <div className="px-3 py-3" data-testid="playground-failure">
          <Text size="sm" variant="error">
            {failure}
          </Text>
        </div>
      )}
      {run && !failure && (
        <div
          className="grid grid-cols-[minmax(0,1fr)] gap-3 px-3 py-3"
          data-testid="playground-result"
        >
          <div className="flex items-center gap-2">
            <Verdict outcome={run.result.outcome} />
            <span className="min-w-0 truncate font-mono text-[12px] text-kumo-subtle">
              {describeForm(run.form, bucket)}
            </span>
          </div>
          <SaveAsTest
            name={describeForm(run.form, bucket)}
            outcome={run.result.outcome === 'allow' ? 'allow' : 'deny'}
            onSave={(name, expected) =>
              addTest({
                name,
                form: { ...run.form, bucket: run.form.bucket || bucket },
                expected,
                seed: run.result.resource,
              })
            }
          />
          <ExplanationView
            result={run.result}
            rules={run.source}
            onReveal={run.source === source ? onReveal : undefined}
            readFunctions={STORAGE_READS}
          />
          {run.form.method !== 'list' && (
            <div className="grid gap-1.5">
              <Text size="xs" bold>
                {proposes(run.form.method) ? 'The file before' : 'The file'}
              </Text>
              <ObjectFacts
                object={run.result.resource}
                changed={run.result.changedKeys}
                absent="It does not exist."
              />
            </div>
          )}
          {run.result.requestResource && (
            <div className="grid gap-1.5">
              <Text size="xs" bold>
                {run.form.method === 'create' ? 'The upload' : 'The file the change would leave'}
              </Text>
              <ObjectFacts
                object={run.result.requestResource}
                changed={run.result.changedKeys}
                absent="Nothing."
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** "Save as a test": a name, the verdict it should get (the one it got, to start with). */
function SaveAsTest({
  name: suggested,
  outcome,
  onSave,
}: {
  name: string
  outcome: 'allow' | 'deny'
  onSave: (name: string, expected: 'allow' | 'deny') => void
}) {
  const [name, setName] = useState(suggested)
  const [expected, setExpected] = useState(outcome)
  const [seen, setSeen] = useState({ suggested, outcome })
  // A new run: start from what it was and what it got.
  if (seen.suggested !== suggested || seen.outcome !== outcome) {
    setSeen({ suggested, outcome })
    setName(suggested)
    setExpected(outcome)
  }
  return (
    <div className="flex items-center gap-2" data-testid="playground-save">
      <Input
        size="sm"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Test name"
        className="min-w-0 flex-1 font-mono"
        data-testid="playground-test-name"
      />
      <Select
        size="sm"
        value={expected}
        onValueChange={(next) => setExpected(next as 'allow' | 'deny')}
        items={{ allow: 'should allow', deny: 'should deny' }}
        aria-label="Expected verdict"
        className="w-32"
      />
      <Button
        variant="secondary"
        size="sm"
        icon={<FlaskIcon />}
        onClick={() => onSave(name.trim() || suggested, expected)}
        data-testid="playground-save-test"
      >
        Save as a test
      </Button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Text as="span" size="xs" variant="secondary">
        {label}
      </Text>
      {children}
    </div>
  )
}
