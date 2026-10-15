// The rules' saved tests: each a request and the verdict it should get,
// run against the editor's text as it changes. Red here is a draft that
// would break something before it is applied. The panel is every rules
// page's; a page hands it its store, how a case reads, how it opens in the
// playground and what the export file is.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import {
  CheckCircleIcon,
  CircleDashedIcon,
  DownloadSimpleIcon,
  FlaskIcon,
  PlayIcon,
  TrashIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import { useStore } from 'zustand'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { download } from '@/lib/download'
import { type TestCaseBase, type TestsStore, passes } from './tests-core'
import { Verdict } from './verdict'

export function TestsPanel<C extends TestCaseBase, R extends { outcome: RulesOutcome }>({
  store,
  source,
  onRun,
  describe,
  onOpen,
  exportFile,
}: {
  store: TestsStore<C, R>
  /** The rules text in the editor, which the cases run against. */
  source: string
  onRun: () => void
  /** A case as one line: its name, or its request. */
  describe: (test: C) => string
  /** Open the case's request in the playground. */
  onOpen: (test: C) => void
  /** The `@firebase/rules-unit-testing` file the cases export as. */
  exportFile: (cases: readonly C[]) => { name: string; text: string }
}) {
  const cases = useStore(store, (state) => state.cases)
  const outcomes = useStore(store, (state) => state.outcomes)
  const ranSource = useStore(store, (state) => state.ranSource)
  const running = useStore(store, (state) => state.running)
  const failure = useStore(store, (state) => state.failure)
  const updateTest = useStore(store, (state) => state.update)
  const remove = useStore(store, (state) => state.remove)
  const current = ranSource === source
  const failing = current
    ? cases.filter((test) => passes(test, outcomes[test.id]) === false).length
    : 0

  const saveFile = () => {
    const file = exportFile(cases)
    void download(new Blob([file.text], { type: 'text/typescript' }), file.name)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tests">
      <div className="flex shrink-0 items-center gap-2 border-b border-kumo-line px-3 py-2">
        <Text as="span" size="sm" data-testid="tests-summary">
          {cases.length === 0
            ? 'No tests'
            : running && !current
              ? `Running ${cases.length}…`
              : current
                ? failing > 0
                  ? `${cases.length} test${cases.length === 1 ? '' : 's'} · `
                  : `${cases.length} test${cases.length === 1 ? '' : 's'} · ${cases.length === 1 ? 'passes' : 'all pass'}`
                : `${cases.length} test${cases.length === 1 ? '' : 's'}`}
          {current && failing > 0 && <span className="text-kumo-danger">{failing} failing</span>}
        </Text>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={<PlayIcon />}
            onClick={onRun}
            loading={running}
            disabled={cases.length === 0}
            data-testid="tests-run"
          >
            Run
          </Button>
          <Tooltip
            content="Download the tests as a @firebase/rules-unit-testing file, for CI"
            render={
              // A disabled button takes no pointer: the tip hangs on the span.
              <span className="flex">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<DownloadSimpleIcon />}
                  onClick={saveFile}
                  disabled={cases.length === 0}
                  data-testid="tests-download"
                >
                  Export
                </Button>
              </span>
            }
          />
        </span>
      </div>
      {failure && (
        <div className="px-3 py-2">
          <Text size="sm" variant="error">
            {failure}
          </Text>
        </div>
      )}
      {cases.length === 0 ? (
        <div className="p-4" data-testid="tests-empty">
          <Text size="sm" variant="secondary">
            Run a request in the playground and save it as a test. Every test runs again each time
            the rules in the editor change, so a draft that breaks one shows before it is applied,
            and the set downloads as a @firebase/rules-unit-testing file for CI.
          </Text>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="test-list">
          {cases.map((test) => {
            const outcome = current ? outcomes[test.id] : undefined
            const pass = passes(test, outcome)
            return (
              <li
                key={test.id}
                className="group/test grid gap-1 border-b border-kumo-hairline px-3 py-2"
                data-testid="test-case"
                data-pass={pass === undefined ? undefined : String(pass)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {pass === undefined ? (
                    <CircleDashedIcon size={14} className="shrink-0 text-kumo-subtle" />
                  ) : pass ? (
                    <CheckCircleIcon
                      size={14}
                      weight="fill"
                      className="shrink-0 text-kumo-success"
                    />
                  ) : (
                    <XCircleIcon size={14} weight="fill" className="shrink-0 text-kumo-danger" />
                  )}
                  <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
                    {describe(test)}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center opacity-0 group-hover/test:opacity-100 focus-within:opacity-100">
                    <Tooltip
                      content="Open in the playground"
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          icon={<FlaskIcon />}
                          aria-label={`Open ${test.name} in the playground`}
                          onClick={() => onOpen(test)}
                        />
                      }
                    />
                    <Tooltip
                      content="Delete the test"
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          icon={<TrashIcon />}
                          aria-label={`Delete ${test.name}`}
                          onClick={() => remove(test.id)}
                        />
                      }
                    />
                  </span>
                </div>
                <div className="flex items-center gap-2 pl-5.5 text-[12px] text-kumo-subtle">
                  <Tooltip
                    content="Change what it should get"
                    render={
                      <button
                        type="button"
                        className="rounded px-1 hover:ink"
                        onClick={() =>
                          updateTest(test.id, {
                            expected: test.expected === 'allow' ? 'deny' : 'allow',
                          } as Partial<Omit<C, 'id'>>)
                        }
                        data-testid="test-expected"
                      >
                        should {test.expected === 'allow' ? 'allow' : 'deny'}
                      </button>
                    }
                  />
                  {outcome?.result && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="flex items-center gap-1">
                        got <Verdict outcome={outcome.result.outcome} />
                      </span>
                    </>
                  )}
                  {outcome?.problem && <span className="text-kumo-danger">{outcome.problem}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
