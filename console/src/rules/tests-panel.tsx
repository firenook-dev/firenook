// The rules' saved tests: each a request and the verdict it should get,
// run against the editor's text as it changes. Red here is a draft that
// would break something before it is applied. The panel is every rules
// page's; a page hands it its store, how a case reads, how it opens in the
// playground and what the export file is.

import { Button, DropdownMenu, Text, Tooltip } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  ExportIcon,
  FlaskIcon,
  PlayIcon,
  TrashIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import { useRef } from 'react'
import { useStore } from 'zustand'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { toast } from '@/lib/toasts'
import { type TestCaseBase, type TestsStore, passes } from './tests-core'
import { Verdict } from './verdict'

export function TestsPanel<C extends TestCaseBase, R extends { outcome: RulesOutcome }>({
  store,
  source,
  onRun,
  describe,
  onOpen,
  exportFile,
  isCase,
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
  /** Whether an item of an imported JSON file is a case this page can run. */
  isCase: (item: unknown) => item is C
}) {
  const cases = useStore(store, (state) => state.cases)
  const outcomes = useStore(store, (state) => state.outcomes)
  const ranSource = useStore(store, (state) => state.ranSource)
  const running = useStore(store, (state) => state.running)
  const failure = useStore(store, (state) => state.failure)
  const updateTest = useStore(store, (state) => state.update)
  const remove = useStore(store, (state) => state.remove)
  const replaceAll = useStore(store, (state) => state.replaceAll)
  const picker = useRef<HTMLInputElement>(null)
  const current = ranSource === source
  const failing = current
    ? cases.filter((test) => passes(test, outcomes[test.id]) === false).length
    : 0

  const download = () => {
    const file = exportFile(cases)
    const url = URL.createObjectURL(new Blob([file.text], { type: 'text/typescript' }))
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.click()
    URL.revokeObjectURL(url)
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
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="ghost" size="sm" icon={<ExportIcon />} data-testid="tests-share">
                  Share
                  <CaretDownIcon size={12} className="text-kumo-subtle" />
                </Button>
              }
            />
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item
                onClick={download}
                disabled={cases.length === 0}
                data-testid="tests-download"
              >
                Download as a rules-unit-testing file
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={cases.length === 0}
                onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify(cases, null, 2))
                  toast({
                    key: 'rules-tests',
                    title: `Copied ${cases.length} test${cases.length === 1 ? '' : 's'} as JSON`,
                  })
                }}
              >
                Copy as JSON
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => picker.current?.click()}>
                Add tests from a JSON file…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
          <input
            ref={picker}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              try {
                const parsed: unknown = JSON.parse(await file.text())
                const added = (Array.isArray(parsed) ? parsed : []).filter(isCase)
                replaceAll([
                  ...cases,
                  ...added.map((test) => ({ ...test, id: crypto.randomUUID() })),
                ])
                toast({
                  key: 'rules-tests',
                  title: `Added ${added.length} test${added.length === 1 ? '' : 's'}`,
                })
              } catch (error) {
                toast({
                  key: 'rules-tests',
                  title: 'Not added',
                  description: (error as Error).message,
                  tone: 'danger',
                })
              }
            }}
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
