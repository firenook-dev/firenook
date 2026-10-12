// Try a request against the rules without the app: an operation, a path,
// who is asking, the data a write would carry. It runs against the text
// in the editor — applied or not — through the same request building a
// real client's request goes through, and runs again as the rules are
// edited, so a change is seen deciding the request before it is applied.

import { Button, Checkbox, InputGroup, Select, Tabs, Text } from '@cloudflare/kumo'
import { FlaskIcon, PlayIcon, UserIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { CodeEditor } from '@/components/code-editor'
import { identityUsersQuery } from '@/lib/identity'
import { RulesCompileError } from '../rules'
import { decodeFields } from '../value'
import { evaluateRules } from './api'
import { Verdict } from './decisions-panel'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import { inlineSteps } from './explain'
import { ExplanationView } from './explanation-view'
import { FieldList } from './field-list'
import { linesFromAllows, useOverlay } from './overlay'
import { usePlayground } from './playground-store'
import { type PlaygroundForm, describeForm, pathProblem, toEvaluateRequest } from './requests'
import { useTests } from './tests-store'

const OPERATIONS: RulesMethod[] = ['get', 'list', 'create', 'update', 'delete']

/** Who-is-asking choices: a sentinel for each kind, a uid for each Auth user. */
const ANONYMOUS = '__anonymous__'
const SOMEONE = '__someone__'
const RECORDED = '__recorded__'

export function Playground({
  project,
  database,
  source,
  onReveal,
}: {
  project: string
  database: string
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
  // The project's own users (a tenant's are another namespace of uids),
  // the first page of the engine's bounded identity search; anyone else is
  // "Someone else…" with a uid typed in.
  const users = useQuery(identityUsersQuery(project, '', ''))
  const [running, setRunning] = useState(false)
  const problem = pathProblem(form.method, form.path, form.group)

  const execute = async (target: PlaygroundForm, text: string) => {
    const built = toEvaluateRequest(target, project, database)
    if ('error' in built) {
      setRun(undefined, built.error)
      return
    }
    setRunning(true)
    try {
      const evaluation = await evaluateRules(database, [built.request], text)
      const result = evaluation.results[0]
      if (result) setRun({ form: target, request: built.request, source: text, result })
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
  // deciding it. Only once a request has been run, and only when the
  // request on screen is the one that ran.
  const latest = useRef({ form, run })
  latest.current = { form, run }
  useEffect(() => {
    const current = latest.current
    if (!current.run || current.run.source === source || current.run.form !== current.form) return
    const timer = window.setTimeout(() => void execute(current.form, source), 500)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const whoValue =
    who.kind === 'anonymous'
      ? ANONYMOUS
      : who.kind === 'recorded'
        ? RECORDED
        : (users.data ?? []).some((user) => user.uid === who.uid)
          ? who.uid
          : SOMEONE
  const whoItems: Record<string, string> = {
    [ANONYMOUS]: 'Not signed in',
    ...(who.kind === 'recorded'
      ? { [RECORDED]: `As recorded: ${who.auth ? who.auth.uid : 'not signed in'}` }
      : {}),
    ...Object.fromEntries((users.data ?? []).map((user) => [user.uid, user.email ?? user.uid])),
    [SOMEONE]: 'Someone else…',
  }
  const writing = form.method === 'create' || form.method === 'update'

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="playground">
      <form
        className="grid gap-3 border-b border-kumo-line px-3 py-3"
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
          tabs={OPERATIONS.map((operation) => ({ value: operation, label: operation }))}
        />
        <Field label={form.method === 'list' ? 'Collection' : 'Document'}>
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
        </Field>
        <Field label="Who is asking">
          <Select
            size="sm"
            value={whoValue}
            onValueChange={(next) => {
              const value = String(next)
              if (value === ANONYMOUS) setForm({ who: { kind: 'anonymous' } })
              else if (value === RECORDED) return
              else if (value === SOMEONE) setForm({ who: { kind: 'user', uid: '', claims: '' } })
              else {
                const user = users.data?.find((item) => item.uid === value)
                setForm({
                  who: {
                    kind: 'user',
                    uid: value,
                    email: user?.email ?? undefined,
                    claims: user?.claims ? JSON.stringify(user.claims) : '',
                  },
                })
              }
            }}
            items={whoItems}
            aria-label="Who is asking"
            className="w-full"
            data-testid="playground-who"
          />
          {who.kind === 'user' && (
            <div className="grid gap-1.5">
              {whoValue === SOMEONE && (
                <InputGroup size="sm">
                  <InputGroup.Addon>
                    <UserIcon size={14} />
                  </InputGroup.Addon>
                  <InputGroup.Input
                    value={who.uid}
                    onChange={(event) => setForm({ who: { ...who, uid: event.target.value } })}
                    placeholder="uid"
                    aria-label="uid"
                    spellCheck={false}
                    className="font-mono"
                    data-testid="playground-uid"
                  />
                </InputGroup>
              )}
              <InputGroup size="sm">
                <InputGroup.Input
                  value={who.claims}
                  onChange={(event) => setForm({ who: { ...who, claims: event.target.value } })}
                  placeholder='Custom claims, such as {"admin": true}'
                  aria-label="Custom claims"
                  spellCheck={false}
                  className="font-mono"
                  data-testid="playground-claims"
                />
              </InputGroup>
            </div>
          )}
        </Field>
        {writing && (
          <Field
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
          </Field>
        )}
        {form.method === 'list' && (
          <Field label="Filters (optional)">
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
          </Field>
        )}
        {form.replay && (
          <Text size="xs" variant="secondary">
            Replaying a recorded request with the document as it was then. Change the path or the
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
        <div className="grid gap-3 px-3 py-3" data-testid="playground-result">
          <div className="flex items-center gap-2">
            <Verdict outcome={run.result.outcome} />
            <span className="min-w-0 truncate font-mono text-[12px] text-kumo-subtle">
              {describeForm(run.form)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={<FlaskIcon />}
              className="ml-auto shrink-0"
              onClick={() =>
                addTest({
                  name: describeForm(run.form),
                  form: run.form,
                  expected: run.result.outcome === 'allow' ? 'allow' : 'deny',
                  seed: run.result.resource,
                })
              }
              data-testid="playground-save-test"
            >
              Save as a test
            </Button>
          </div>
          <ExplanationView
            result={run.result}
            rules={run.source}
            onReveal={run.source === source ? onReveal : undefined}
          />
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
        </div>
      )}
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
