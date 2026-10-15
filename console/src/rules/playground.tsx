// Try a request against the rules without the app, on either rules page:
// an operation, what it is about (a page's own fields), who is asking, and
// for a write what it proposes. It runs against the text in the editor —
// applied or not — through the engine's own request builder, the one a real
// client's request goes through, and runs again as the rules are edited, so
// a change is seen deciding the request before it is applied. Nothing is
// recorded and nothing is written.
//
// Who is asking is the console's one IdentityPicker (an anonymous client,
// any Auth user found by search, a custom identity), or, for a request
// handed over from a decision or a refusal, exactly what it carried ("As
// recorded"), until it is asked as someone else.

import { Button, Input, Select, Tabs, Text } from '@cloudflare/kumo'
import { FlaskIcon, PlayIcon } from '@phosphor-icons/react'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import { IdentityPicker } from '@/components/console/identity-picker'
import { inlineSteps } from './explain'
import { type ExplainedResult, ExplanationView } from './explanation-view'
import { linesFromAllows, useOverlay } from './overlay'
import type { PlaygroundRun, PlaygroundState } from './playground-store'
import { RULES_METHODS } from './search'
import { RulesCompileError } from './text'
import { VerdictLine } from './verdict'
import { ANONYMOUS, type Who, describeWho } from './who'

/** What every playground form has; a page adds what its requests are about. */
export interface PlaygroundFormBase {
  method: RulesMethod
  who: Who
  /** From a recorded request: what it was decided with, replayed until the request changes. */
  replay?: unknown
}

export function RulesPlayground<
  F extends PlaygroundFormBase,
  Q,
  R extends ExplainedResult & { outcome: ExplainedResult['outcome'] },
>({
  project,
  playground,
  source,
  ready,
  onReveal,
  build,
  evaluate,
  problem,
  describe,
  fields,
  details,
  replayNote,
  readFunctions,
  renderFacts,
  onSave,
}: {
  project: string
  /** The page's playground store's state (`usePlayground()`). */
  playground: PlaygroundState<F, Q, R>
  /** The rules text in the editor, which every run is against. */
  source: string
  /** The editor holds the rules (in force, or the draft kept for them): a run can start. */
  ready: boolean
  onReveal: (line: number) => void
  /** The form as the request the engine evaluates, or what is wrong with it. */
  build: (form: F) => { request: Q } | { error: string }
  /** Runs one request against `text`. */
  evaluate: (request: Q, text: string) => Promise<R | undefined>
  /** What is wrong with the form's path for its method, said under the path. */
  problem: string | undefined
  /** A request in a line: the verdict's caption and a saved test's name. */
  describe: (form: F) => string
  /** What the request is about, under the operation: a document, a file. */
  fields: ReactNode
  /** What a write proposes and when it runs, under who is asking. */
  details?: ReactNode
  /** Said while a recorded request is replayed. */
  replayNote: string
  /** How the rules language spells its two document reads. */
  readFunctions?: readonly [string, string] | undefined
  /** The result's facts under the explanation: the document or the file, before and after. */
  renderFacts: (run: PlaygroundRun<F, Q, R>) => ReactNode
  /** Save the run as a test that should get `expected`. */
  onSave: (run: PlaygroundRun<F, Q, R>, name: string, expected: 'allow' | 'deny') => void
}) {
  const { form, setForm, run, failure, setRun, pending, takePending } = playground
  const show = useOverlay((state) => state.show)
  const clear = useOverlay((state) => state.clear)
  const [running, setRunning] = useState(false)

  const execute = async (request: F, text: string) => {
    const built = build(request)
    if ('error' in built) {
      setRun(undefined, built.error)
      return
    }
    setRunning(true)
    try {
      const result = await evaluate(built.request, text)
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

  // A request handed over to be tried ("Try in the playground" on a
  // decision, or on a refusal met elsewhere): run it once the editor holds
  // the rules, so its verdict and why are there on arrival.
  useEffect(() => {
    if (!pending || !ready) return
    takePending()
    void latest.current.execute(latest.current.form, source)
  }, [pending, ready, source, takePending])

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
          onValueChange={(next) => setForm({ method: next as RulesMethod } as Partial<F>)}
          tabs={RULES_METHODS.map((method) => ({ value: method, label: method }))}
        />
        {fields}
        <PlaygroundField label="Who is asking">
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
                onClick={() => setForm({ who: ANONYMOUS } as Partial<F>)}
              >
                Ask as someone else
              </Button>
            </div>
          ) : (
            <IdentityPicker
              project={project}
              value={viewAs}
              onChange={(next) => setForm({ who: { kind: 'as', viewAs: next } } as Partial<F>)}
              modes={['anonymous', 'user', 'custom']}
              testId="playground-who"
            />
          )}
        </PlaygroundField>
        {details}
        {form.replay !== undefined && (
          <Text size="xs" variant="secondary">
            {replayNote}
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
          <VerdictLine outcome={run.result.outcome} request={describe(run.form)} />
          <SaveAsTest
            name={describe(run.form)}
            outcome={run.result.outcome === 'allow' ? 'allow' : 'deny'}
            onSave={(name, expected) => onSave(run, name, expected)}
          />
          <ExplanationView
            result={run.result}
            rules={run.source}
            onReveal={run.source === source ? onReveal : undefined}
            readFunctions={readFunctions}
          />
          {renderFacts(run)}
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
    // The name has the panel's width to itself (it is the whole request, and
    // the panel is 440 px, 380 below 1280); the verdict and the button follow.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2" data-testid="playground-save">
      <Input
        size="sm"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Test name"
        className="w-full font-mono"
        data-testid="playground-test-name"
      />
      <div className="flex items-center gap-2">
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
    </div>
  )
}

/** A labelled field of the playground's form. */
export function PlaygroundField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Text as="span" size="xs" variant="secondary">
        {label}
      </Text>
      {children}
    </div>
  )
}
