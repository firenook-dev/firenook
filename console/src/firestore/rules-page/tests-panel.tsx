// The rules' saved tests: each a request and the verdict it should get,
// run against the editor's text as it changes. Red here is a draft that
// would break something before it is applied.

import { Button, DropdownMenu, Text, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
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
import { Verdict } from './decisions-panel'
import { usePlayground } from './playground-store'
import { describeForm } from './requests'
import { useRulesSearch } from './rules-search'
import { exportTests } from './tests-export'
import { type TestCase, passes, runTests, useTests } from './tests-store'

export function TestsPanel({
  project,
  database,
  source,
  rulesFile,
}: {
  project: string
  database: string
  source: string
  rulesFile: string | undefined
}) {
  const toasts = useKumoToastManager()
  const { update } = useRulesSearch()
  const cases = useTests((state) => state.cases)
  const outcomes = useTests((state) => state.outcomes)
  const ranSource = useTests((state) => state.ranSource)
  const running = useTests((state) => state.running)
  const failure = useTests((state) => state.failure)
  const updateTest = useTests((state) => state.update)
  const remove = useTests((state) => state.remove)
  const replaceAll = useTests((state) => state.replaceAll)
  const load = usePlayground((state) => state.load)
  const picker = useRef<HTMLInputElement>(null)
  const current = ranSource === source
  const failing = current
    ? cases.filter((test) => passes(test, outcomes[test.id]) === false).length
    : 0

  const download = () => {
    const text = exportTests(cases, { project, rulesFile: rulesFile ?? 'firestore.rules' })
    const url = URL.createObjectURL(new Blob([text], { type: 'text/typescript' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'firestore.rules.test.ts'
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
            onClick={() => void runTests(project, database, source)}
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
                  toasts.add({
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
                const added = (Array.isArray(parsed) ? parsed : []).filter(
                  (item): item is TestCase =>
                    Boolean(
                      item && typeof item === 'object' && 'form' in item && 'expected' in item,
                    ),
                )
                replaceAll([
                  ...cases,
                  ...added.map((test) => ({ ...test, id: crypto.randomUUID() })),
                ])
                toasts.add({ title: `Added ${added.length} test${added.length === 1 ? '' : 's'}` })
              } catch (error) {
                toasts.add({
                  title: 'Not added',
                  description: (error as Error).message,
                  variant: 'error',
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
                    {test.name || describeForm(test.form)}
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
                          onClick={() => {
                            load(test.form)
                            update({ panel: 'playground' })
                          }}
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
                          })
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
