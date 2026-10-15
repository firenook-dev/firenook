// Storage's playground: the rules kit's (`src/rules/playground.tsx`) with
// this page's request — a bucket, a file or a folder, and for an upload or a
// metadata change the file it proposes (a size with its unit, a content
// type, custom metadata), the file before the request (read from the
// bucket, as recorded, or taken as not there) and the time — and the files
// the result read and would leave.

import { Autocomplete, Input, Select, Switch, Text } from '@cloudflare/kumo'
import { ClockIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { StorageBucket } from '@/api/generated/storage/StorageBucket'
import { KeyValueEditor } from '@/components/console/key-value-editor'
import { formatBytes } from '@/lib/format'
import { STORAGE_READS } from '@/rules/explanation-view'
import { PlaygroundField, RulesPlayground } from '@/rules/playground'
import { useDebounced } from '@/rules/use-debounced'
import { evaluateRules } from '../api'
import { objectQuery, profileQuery, scopeBucket } from '../queries'
import { FolderField } from './folder-field'
import { ObjectFacts } from './object-facts'
import { usePlayground } from './playground-store'
import {
  SIZE_UNITS,
  type SizeUnit,
  describeForm,
  pathProblem,
  proposes,
  toEvaluateRequest,
} from './requests'
import { tests } from './tests-store'

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
  ready,
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
  /** The editor holds the rules (in force, or the draft kept for them): a run can start. */
  ready: boolean
  onReveal: (line: number) => void
}) {
  const playground = usePlayground()
  const { form, setForm } = playground
  const addTest = tests.useTests((state) => state.add)
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
      form.replay?.resource === undefined,
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
  const bucketItems = Object.fromEntries(
    [...new Set([bucket, target, ...buckets.map((item) => item.name)])].map((name) => [name, name]),
  )
  const named = scopeBucket(scope)

  return (
    <RulesPlayground
      project={project}
      playground={playground}
      source={source}
      ready={ready}
      onReveal={onReveal}
      build={(request) => toEvaluateRequest(request, project, bucket)}
      evaluate={async (request, text) =>
        (
          await evaluateRules({
            ...(named === undefined ? {} : { bucket: named }),
            source: text,
            requests: [request],
          })
        ).results[0]
      }
      problem={problem}
      describe={(request) => describeForm(request, bucket)}
      replayNote="Replaying a recorded request with the file as it was then. Change the path or the operation to try something new."
      readFunctions={STORAGE_READS}
      fields={
        <>
          {Object.keys(bucketItems).length > 1 && (
            <PlaygroundField label="Bucket">
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
            </PlaygroundField>
          )}
          <PlaygroundField label={form.method === 'list' ? 'Folder' : 'File'}>
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
          </PlaygroundField>
        </>
      }
      details={
        <>
          {form.method === 'create' && (
            <PlaygroundField label="Size">
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
            </PlaygroundField>
          )}
          {writing && (
            <PlaygroundField
              label={
                form.method === 'create'
                  ? 'Content type'
                  : 'Content type it sets (empty: unchanged)'
              }
            >
              <div data-testid="playground-type">
                <Autocomplete
                  items={types}
                  value={form.contentType}
                  onValueChange={(next) => setForm({ contentType: String(next ?? '') })}
                >
                  <Autocomplete.InputGroup
                    size="sm"
                    placeholder="image/png"
                    className="font-mono"
                  />
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
            </PlaygroundField>
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
            <PlaygroundField label="The file before the request">
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
                      <span className="text-kumo-subtle">
                        Name a file to read it from the bucket
                      </span>
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
            </PlaygroundField>
          )}
          <PlaygroundField label="Time (empty: now)">
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
          </PlaygroundField>
        </>
      }
      renderFacts={(run) => (
        <>
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
        </>
      )}
      onSave={(run, name, expected) =>
        addTest({
          name,
          form: { ...run.form, bucket: run.form.bucket || bucket },
          expected,
          seed: run.result.resource,
        })
      }
    />
  )
}
