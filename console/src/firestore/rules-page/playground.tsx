// Firestore's playground: the rules kit's (`src/rules/playground.tsx`)
// with this page's request — a document (or for a list, a collection or a
// collection group, with the SDK chain's filters), and for a write the
// fields it carries — and the documents the result read and would leave.

import { Checkbox, InputGroup, Text } from '@cloudflare/kumo'
import { CodeEditor } from '@/components/code-editor'
import { PlaygroundField, RulesPlayground } from '@/rules/playground'
import { decodeFields } from '../value'
import { evaluateRules } from './api'
import { FieldList } from './field-list'
import { usePlayground } from './playground-store'
import { describeForm, pathProblem, toEvaluateRequest } from './requests'
import { tests } from './tests-store'

export function Playground({
  project,
  database,
  source,
  ready,
  onReveal,
}: {
  project: string
  database: string
  /** The rules text in the editor, which every run is against. */
  source: string
  /** The editor holds the rules: a run can start. */
  ready: boolean
  onReveal: (line: number) => void
}) {
  const playground = usePlayground()
  const { form, setForm } = playground
  const addTest = tests.useTests((state) => state.add)
  const problem = pathProblem(form.method, form.path, form.group)
  const writing = form.method === 'create' || form.method === 'update'

  return (
    <RulesPlayground
      project={project}
      playground={playground}
      source={source}
      ready={ready}
      onReveal={onReveal}
      build={(request) => toEvaluateRequest(request, project, database)}
      evaluate={async (request, text) =>
        (await evaluateRules(database, [request], text)).results[0]
      }
      problem={problem}
      describe={describeForm}
      replayNote="Replaying a recorded request with the document as it was then. Change the path or the operation to try something new."
      fields={
        <PlaygroundField label={form.method === 'list' ? 'Collection' : 'Document'}>
          <InputGroup size="sm">
            <InputGroup.Input
              value={form.path}
              onChange={(event) => setForm({ path: event.target.value })}
              placeholder={
                form.method === 'list' ? (form.group ? 'orders' : 'users/u1/orders') : 'users/u1'
              }
              aria-label="Path"
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              data-testid="playground-path"
            />
          </InputGroup>
          {form.method === 'list' && (
            <Checkbox
              checked={form.group}
              onCheckedChange={(checked) => setForm({ group: Boolean(checked) })}
              label="Every collection with this id (a collection group)"
            />
          )}
          {form.path.trim() !== '' && problem && (
            <Text size="xs" variant="secondary">
              {problem}
            </Text>
          )}
        </PlaygroundField>
      }
      details={
        <>
          {writing && (
            <PlaygroundField
              label={form.method === 'create' ? 'The new document' : 'The fields the update sets'}
            >
              <div className="flex h-36 flex-col overflow-hidden rounded-md ring ring-kumo-line focus-within:ring-kumo-focus">
                <CodeEditor
                  value={form.data}
                  onChange={(data) => setForm({ data })}
                  ariaLabel="Data"
                  testId="playground-data"
                />
              </div>
            </PlaygroundField>
          )}
          {form.method === 'list' && (
            <PlaygroundField label="Filters (optional)">
              <InputGroup size="sm">
                <InputGroup.Input
                  value={form.query}
                  onChange={(event) => setForm({ query: event.target.value })}
                  placeholder={'where("owner", "==", "u1").limit(10)'}
                  aria-label="Filters"
                  spellCheck={false}
                  className="font-mono"
                  data-testid="playground-query"
                />
              </InputGroup>
            </PlaygroundField>
          )}
        </>
      }
      renderFacts={(run) => (
        <>
          {run.result.resource !== null || run.form.method !== 'list' ? (
            <div className="grid gap-1.5">
              <Text size="xs" bold>
                {run.form.method === 'create' || run.form.method === 'update'
                  ? 'The document before'
                  : 'The document'}
              </Text>
              <FieldList
                fields={run.result.resource ? decodeFields(run.result.resource as never) : null}
                changed={run.result.changedKeys ?? undefined}
                absent="It does not exist."
              />
            </div>
          ) : null}
          {run.result.requestResource && (
            <div className="grid gap-1.5">
              <Text size="xs" bold>
                The document the write would leave
              </Text>
              <FieldList
                fields={decodeFields(run.result.requestResource as never)}
                changed={run.result.changedKeys ?? undefined}
                absent="Nothing."
              />
            </div>
          )}
        </>
      )}
      onSave={(run, name, expected) =>
        addTest({ name, form: run.form, expected, seed: run.result.resource })
      }
    />
  )
}
