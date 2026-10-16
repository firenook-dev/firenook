// An instance's configuration, read and changed in place: every param with
// the file that set it, and Edit, which turns the boxes into inputs, checks
// each value as it is typed (the engine's own rules), then Save lists the
// files it will write and reloads the instance once. A configuration that
// does not load never stays on disk: the engine puts the files back and
// the dialog says so. The values the emulator sets itself, and the system
// params, are folded underneath.

import { Button } from '@cloudflare/kumo'
import { CaretRightIcon, FloppyDiskIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import type { ExtensionInstanceDetail } from '@/api/generated/compute/ExtensionInstanceDetail'
import type { ExtensionNamedValue } from '@/api/generated/compute/ExtensionNamedValue'
import { KeyValueList } from '@/components/console/key-value-list'
import { EnvChangeDialog } from '@/compute/env-change-dialog'
import { describeKey, useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { ReconfigureRefused, extensionKeys, reconfigureInstance, revealParam } from '../api'
import {
  type ParamDraft,
  changedParams,
  draftProblems,
  initialDraft,
  plannedFiles,
  reconfigureRequest,
} from '../params'
import { ParamRow } from './param-row'

/** What a Save does to calls in flight, said before it does it. */
export const RELOAD_NOTE = 'The instance reloads; calls in flight to its worker are dropped.'

/** A folded list of name–value pairs under the params. */
function Folded({
  title,
  values,
  testId,
}: {
  title: string
  values: readonly ExtensionNamedValue[]
  testId: string
}) {
  const [open, setOpen] = useState(false)
  if (values.length === 0) return null
  return (
    <div className="grid gap-1.5" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
        className="-ml-1 flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-kumo-subtle hover:ink hover:text-kumo-default"
        data-testid={`${testId}-toggle`}
      >
        <CaretRightIcon size={11} className={open ? 'rotate-90' : undefined} />
        {title}
        <span className="font-mono text-[11px] tabular-nums">{values.length}</span>
      </button>
      {open && (
        <div className="pl-4">
          <KeyValueList
            items={values.map((entry) => ({
              label: entry.name,
              value: entry.value === '' ? '""' : entry.value,
              copy: entry.value,
              testId: `${testId}-${entry.name}`,
            }))}
          />
        </div>
      )}
    </div>
  )
}

export function ConfigurationTab({
  project,
  detail,
  editing,
  onEditingChange,
}: {
  project: string
  detail: ExtensionInstanceDetail
  editing: boolean
  onEditingChange: (editing: boolean) => void
}) {
  const client = useQueryClient()
  const instance = detail.summary.instanceId
  const params = detail.params
  const [draft, setDraft] = useState<ParamDraft>(() => initialDraft(params))
  // The values in force changed (a reload, an edit on disk) while nothing
  // was being edited: the draft follows them.
  const [seen, setSeen] = useState(params)
  if (seen !== params) {
    setSeen(params)
    if (!editing) setDraft(initialDraft(params))
  }
  const [refused, setRefused] = useState<{
    message: string
    problems: ReadonlyMap<string, string>
  } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const changed = changedParams(params, draft)
  const typed = draftProblems(params, draft)
  const problems = new Map([...(refused?.problems ?? []), ...typed])
  const files = plannedFiles(instance, params, draft)
  const canSave = changed.length > 0 && typed.size === 0

  const save = useMutation({
    mutationFn: () => reconfigureInstance(instance, reconfigureRequest(params, draft)),
    onSuccess: (result) => {
      client.setQueryData(extensionKeys.instance(project, instance), result.instance)
      void client.invalidateQueries({ queryKey: extensionKeys.instances(project) })
      setConfirming(false)
      setRefused(null)
      setDraft(initialDraft(result.instance.params))
      onEditingChange(false)
      toast({
        key: `extensions.reconfigure.${instance}`,
        title: `${instance} reloaded with the new values`,
        description: `Wrote ${result.written.join(', ')}.`,
        tone: 'success',
      })
    },
    onError: (error) => {
      if (error instanceof ReconfigureRefused) {
        setConfirming(false)
        setRefused({
          message: error.message,
          problems: new Map(
            error.problems
              .filter((problem) => problem.param !== '')
              .map((problem) => [problem.param, problem.message]),
          ),
        })
      }
    },
  })

  const startSave = () => {
    if (!canSave || save.isPending) return
    save.reset()
    setConfirming(true)
  }
  const cancel = () => {
    setDraft(initialDraft(params))
    setRefused(null)
    save.reset()
    onEditingChange(false)
  }

  useShortcuts({ id: 'extensions.configuration', label: 'Configuration' }, [
    {
      key: 'Mod+s',
      label: 'Save the configuration',
      allowInInputs: true,
      when: () => editing,
      run: startSave,
    },
  ])

  const dialogError =
    save.error && !(save.error instanceof ReconfigureRefused)
      ? save.error instanceof ApiError
        ? { message: save.error.message, fix: save.error.fix }
        : { message: save.error instanceof Error ? save.error.message : String(save.error) }
      : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-kumo-base" data-testid="instance-configuration">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid max-w-3xl gap-5 px-6 py-5">
          <div className="flex items-center gap-3">
            <h2 className="m-0 text-[16px] leading-6 font-semibold text-kumo-default">
              Parameters
            </h2>
            <span className="min-w-0 text-[13px] text-kumo-subtle" data-testid="configuration-from">
              {params.length === 0 ? (
                'This extension takes none.'
              ) : editing ? (
                'Each value goes back to the file that set it.'
              ) : detail.envFiles.length === 0 ? (
                'From the defaults only: no parameter file yet.'
              ) : (
                <>
                  From{' '}
                  {detail.envFiles.map((file, index) => (
                    <span key={file}>
                      {index > 0 && ', '}
                      <span className="font-mono text-[12px]">{file}</span>
                    </span>
                  ))}
                  .
                </>
              )}
            </span>
            {!editing && params.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                icon={<PencilSimpleIcon />}
                onClick={() => onEditingChange(true)}
                className="ml-auto shrink-0"
                data-testid="configuration-edit"
              >
                Edit
              </Button>
            )}
          </div>
          {refused && (
            <div
              className="rounded-md bg-kumo-danger-tint px-3 py-2 text-[13px] text-kumo-default"
              role="alert"
              data-testid="configuration-refused"
            >
              {refused.message}
            </div>
          )}
          {params.length > 0 && (
            <div className="grid" data-testid="param-list">
              {params.map((param) => (
                <ParamRow
                  key={param.param}
                  param={param}
                  editing={editing}
                  value={draft[param.param] ?? ''}
                  problem={problems.get(param.param)}
                  onChange={(value) => {
                    setDraft((current) => ({ ...current, [param.param]: value }))
                    if (refused?.problems.has(param.param))
                      setRefused((current) => {
                        if (!current) return current
                        const next = new Map(current.problems)
                        next.delete(param.param)
                        return { ...current, problems: next }
                      })
                  }}
                  reveal={(signal) => revealParam(instance, param.param, signal)}
                />
              ))}
            </div>
          )}
          <div className="grid gap-2">
            <Folded title="System parameters" values={detail.systemParams} testId="system-params" />
            <Folded
              title="Values the emulator sets"
              values={detail.autoParams}
              testId="auto-params"
            />
          </div>
        </div>
      </div>
      {editing && (
        <footer
          className="flex h-12 shrink-0 items-center gap-3 border-t border-kumo-line px-6"
          data-testid="configuration-footer"
        >
          <span className="min-w-0 truncate text-[12px] text-kumo-subtle">
            {changed.length === 0
              ? 'Nothing changed yet.'
              : typed.size > 0
                ? `${typed.size} ${typed.size === 1 ? 'value needs' : 'values need'} fixing before it can be saved.`
                : `${changed.length} ${changed.length === 1 ? 'change' : 'changes'}, written to ${files
                    .map((file) => file.file.replace(/^extensions\//, ''))
                    .join(', ')}.`}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} data-testid="configuration-cancel">
              Cancel
            </Button>
            <Button
              variant={canSave ? 'primary' : 'secondary'}
              size="sm"
              icon={<FloppyDiskIcon />}
              onClick={startSave}
              disabled={!canSave}
              data-testid="configuration-save"
            >
              <span className="flex items-center gap-1.5">
                Save
                <kbd className="font-sans text-[10px] opacity-70">{describeKey('Mod+s')}</kbd>
              </span>
            </Button>
          </span>
        </footer>
      )}
      <EnvChangeDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) save.reset()
        }}
        title={`Save ${instance}'s configuration`}
        files={files}
        note={RELOAD_NOTE}
        pending={save.isPending}
        error={dialogError}
        onConfirm={() => save.mutate()}
        testId="env-change-dialog"
      />
    </div>
  )
}
