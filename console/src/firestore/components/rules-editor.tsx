// The security rules, as text you can change.
//
// A plain textarea over a numbered gutter rather than a code editor: the
// console's whole first-route budget is 300 KB, and CodeMirror alone is
// several times the rules editor's worth of value here. What matters is
// that a change compiles, takes effect on the next request, and says
// exactly where it went wrong when it does not.

import { Badge, Button, Text, useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  FloppyDiskIcon,
  PlayIcon,
  ShieldCheckIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import {
  type RulesDiagnostic,
  RulesCompileError,
  describeDiagnostic,
  lineCount,
  offsetOf,
  putRules,
  rulesQuery,
} from '../rules'
import { useWorkbench } from './workbench-context'

export function RulesEditorPanel() {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const rules = useQuery(rulesQuery(workbench.database))
  const [draft, setDraft] = useState<string | undefined>()
  const [base, setBase] = useState<string | undefined>()
  const [diagnostics, setDiagnostics] = useState<RulesDiagnostic[]>([])
  const area = useRef<HTMLTextAreaElement>(null)

  // The rules that arrived replace the draft, unless it has been edited.
  if (rules.data && base !== rules.data.source) {
    setBase(rules.data.source)
    if (draft === undefined || draft === base) setDraft(rules.data.source)
  }
  const source = draft ?? rules.data?.source ?? ''
  const edited = base !== undefined && source !== base

  const apply = useMutation({
    mutationFn: ({ save }: { save: boolean }) => putRules(workbench.database, source, save),
    onSuccess: (result, variables) => {
      setDiagnostics([])
      setBase(source)
      toasts.add({
        title: variables.save ? 'Rules applied and saved' : 'Rules applied',
        description: result.saved
          ? (result.path ?? 'Written to the configured file')
          : 'In force from the next request. Not written to disk.',
        variant: 'success',
      })
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database, 'rules'] })
    },
    onError: (error) => {
      setDiagnostics(error instanceof RulesCompileError ? error.diagnostics : [])
      toasts.add({
        title: 'Nothing changed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      })
    },
  })

  const jumpTo = (diagnostic: RulesDiagnostic) => {
    const input = area.current
    if (!input) return
    const at = offsetOf(source, diagnostic)
    input.focus()
    input.setSelectionRange(at, at)
  }

  const unavailable = rules.error instanceof ApiError && rules.error.status === 404
  const lines = lineCount(source)

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="rules-editor"
      aria-label="Security rules"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-base pr-2 pl-3">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeftIcon />}
          onClick={() => workbench.navigate({ view: undefined })}
          data-testid="rules-close"
        >
          Data
        </Button>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
        <span className="flex items-center gap-2">
          <span className="text-kumo-subtle">
            <ShieldCheckIcon size={16} />
          </span>
          <Text as="span" size="sm" bold>
            Rules
          </Text>
          <Text as="span" variant="secondary" size="sm">
            {workbench.database}
          </Text>
        </span>
        {rules.data && !rules.data.enforced && (
          <Badge variant="warning" appearance="dot">
            Not enforced
          </Badge>
        )}
        {edited && <Badge variant="outline">Unsaved</Badge>}
        <span className="ml-auto flex items-center gap-2">
          {rules.data?.path && (
            <span className="hidden max-w-[32ch] truncate font-mono text-[11px] text-kumo-subtle lg:block">
              {rules.data.path}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowCounterClockwiseIcon />}
            onClick={() => {
              setDraft(base)
              setDiagnostics([])
            }}
            disabled={!edited}
          >
            Revert
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<PlayIcon />}
            onClick={() => apply.mutate({ save: false })}
            loading={apply.isPending && apply.variables?.save === false}
            data-testid="rules-apply"
          >
            Apply
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<FloppyDiskIcon />}
            onClick={() => apply.mutate({ save: true })}
            loading={apply.isPending && apply.variables?.save === true}
            disabled={!rules.data?.path}
            title={
              rules.data?.path
                ? `Apply and write ${rules.data.path}`
                : 'firebase.json declares no rules file for this database'
            }
            data-testid="rules-save"
          >
            Save
          </Button>
        </span>
      </div>

      {unavailable ? (
        <div className="p-6">
          <Text variant="secondary">This engine does not serve the rules editor.</Text>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-auto">
          {/* The gutter scrolls with the text because both live in one
              scroller and the numbers are a sibling column, not an overlay. */}
          <pre
            aria-hidden
            className="shrink-0 border-r border-kumo-hairline bg-kumo-base px-2 py-3 text-right font-mono text-[12px] leading-5 text-kumo-inactive tabular-nums select-none"
          >
            {Array.from({ length: lines }, (_, index) => index + 1).join('\n')}
          </pre>
          <textarea
            ref={area}
            value={source}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Security rules source"
            data-testid="rules-source"
            className="min-h-full w-full resize-none bg-kumo-canvas px-3 py-3 font-mono text-[12px] leading-5 text-kumo-default outline-none"
          />
        </div>
      )}

      {diagnostics.length > 0 && (
        <ul
          className="max-h-32 shrink-0 overflow-y-auto border-t border-kumo-danger bg-kumo-danger-tint"
          data-testid="rules-diagnostics"
        >
          {diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`}>
              <button
                type="button"
                onClick={() => jumpTo(diagnostic)}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-kumo-base/40"
              >
                <span className="flex h-lh shrink-0 items-center text-kumo-danger">
                  <WarningIcon size={14} />
                </span>
                <span className="font-mono text-[12px] text-kumo-default">
                  {describeDiagnostic(diagnostic)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-kumo-line px-3">
        <Text variant="secondary" size="sm" as="span">
          Apply puts these rules in force from the next request. Save also writes the file.
        </Text>
      </div>
    </section>
  )
}
