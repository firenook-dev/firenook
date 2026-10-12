// The Environment tab: what `process.env` holds for this function, without
// leaking the host. The env files the last load read, in precedence order;
// every variable with the file that set it (`.secret.local` values masked
// until revealed, read from the file when asked); the secrets the function
// declares, provided or missing; the params the manifest declares and where
// each value came from, unresolved ones flagged; the emulator's own
// variables; and only a count of what the worker inherits from the
// engine's environment.
//
// It writes too: edit a variable in the file that set it, add one, add a
// missing secret, set an unresolved param (in `.env.local`, what the
// official CLI's prompt writes). Every change goes through the same dialog
// and the same atomic write with restore as Extensions' reconfigure.

import { Button, Input, SensitiveInput, Select, Text } from '@cloudflare/kumo'
import { PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useState } from 'react'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionEnvFile } from '@/api/generated/compute/FunctionEnvFile'
import type { FunctionEnvVariable } from '@/api/generated/compute/FunctionEnvVariable'
import { EntityLink } from '@/components/console/entity-link'
import { InspectorSection } from '@/components/console/inspector'
import { KeyValueList } from '@/components/console/key-value-list'
import { MaskedValue } from '@/components/console/masked-value'
import { StatusDot } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { matchesKey } from '@/lib/shortcuts'
import { revealSecret } from '../api'
import { type EnvChangeLine, EnvChangeDialog, SECRET_KEPT, envFileName } from './env-change-dialog'

/** The dotenv dialect's key rule (the engine refuses the rest with its own words). */
export function envKeyProblem(key: string): string | undefined {
  if (key === '') return 'Name the variable.'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    return 'A name is letters, digits and _, not starting with a digit.'
  if (/^(FIREBASE_|X_GOOGLE_|EXT_)/.test(key) || key === 'GCLOUD_PROJECT')
    return `${key} is set by the emulator; the codebase cannot override it.`
  return undefined
}

/** The files a new variable can go to. */
const ADD_FILES: readonly FunctionEnvFile[] = ['env', 'envProject', 'envLocal', 'secretLocal']

type Editing =
  | { kind: 'edit'; variable: FunctionEnvVariable; value: string }
  | { kind: 'add'; key: string; value: string; file: FunctionEnvFile }
  | { kind: 'secret'; key: string; value: string }
  | { kind: 'param'; key: string; value: string; secret: boolean }

/** Enter or ⌘S stages the edit; Escape gives it up. */
function editKeys(event: KeyboardEvent, stage: () => void, cancel: () => void) {
  if (event.key === 'Enter' || matchesKey(event.nativeEvent, 'Mod+s')) {
    event.preventDefault()
    event.stopPropagation()
    stage()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
}

export function EnvironmentTab({ detail, project }: { detail: FunctionDetail; project: string }) {
  const { summary, environment } = detail
  const codebase = summary.codebase
  const [editing, setEditing] = useState<Editing | null>(null)
  const [staged, setStaged] = useState<readonly EnvChangeLine[] | null>(null)
  const user = environment.variables.filter(
    (variable) => variable.source === 'dotEnv' || variable.source === 'secretLocal',
  )
  const emulator = environment.variables.filter((variable) => variable.source === 'emulator')
  const extension = environment.variables.filter((variable) => variable.source === 'extensionParam')
  const params = detail.params.filter((param) => !param.secret)
  const editable = environment.editable

  const stage = () => {
    if (!editing) return
    if (editing.kind === 'edit') {
      const variable = editing.variable
      if (!variable.file || !variable.fileName) return
      setStaged([
        {
          file: variable.file,
          fileName: variable.fileName,
          key: variable.key,
          before: variable.secret ? SECRET_KEPT : variable.value,
          after: editing.value,
          secret: variable.secret,
        },
      ])
    } else if (editing.kind === 'add') {
      if (envKeyProblem(editing.key.trim())) return
      const existing = user.find(
        (variable) => variable.key === editing.key.trim() && variable.file === editing.file,
      )
      setStaged([
        {
          file: editing.file,
          fileName: existing?.fileName ?? envFileName(editing.file, project),
          key: editing.key.trim(),
          before: existing ? (existing.secret ? SECRET_KEPT : existing.value) : null,
          after: editing.value,
          secret: editing.file === 'secretLocal',
        },
      ])
    } else if (editing.kind === 'secret') {
      setStaged([
        {
          file: 'secretLocal',
          fileName: '.secret.local',
          key: editing.key,
          before: null,
          after: editing.value,
          secret: true,
        },
      ])
    } else {
      setStaged([
        {
          file: editing.secret ? 'secretLocal' : 'envLocal',
          fileName: editing.secret ? '.secret.local' : '.env.local',
          key: editing.key,
          before: null,
          after: editing.value,
          secret: editing.secret,
        },
      ])
    }
  }
  const cancel = () => setEditing(null)

  return (
    <div className="flex flex-col" data-testid="environment-tab">
      {!editable && summary.extension && (
        <InspectorSection title="Parameters">
          <p className="text-[13px] text-kumo-default">
            This function belongs to an extension instance. Change its parameters in Extensions ›
            Configuration: <EntityLink entity={summary.extension} />
          </p>
        </InspectorSection>
      )}
      <InspectorSection title="Env files" count={environment.files.length} testId="env-files">
        <p className="font-mono text-[12px] text-kumo-default" data-testid="env-files-list">
          {environment.files.join(' · ')}
          <span className="font-sans text-[11px] text-kumo-subtle"> (later files win)</span>
        </p>
      </InspectorSection>
      <InspectorSection
        title="Variables"
        count={editing?.kind === 'add' && user.length === 0 ? undefined : user.length}
        testId="env-variables"
        action={
          editable ? (
            <Button
              variant="ghost"
              size="xs"
              icon={<PlusIcon />}
              onClick={() => setEditing({ kind: 'add', key: '', value: '', file: 'env' })}
              data-testid="env-add"
            >
              Add
            </Button>
          ) : undefined
        }
      >
        <ul className="grid gap-0.5">
          {user.map((variable) =>
            editing?.kind === 'edit' &&
            editing.variable.key === variable.key &&
            editing.variable.file === variable.file ? (
              <li
                key={`${variable.fileName}:${variable.key}`}
                className="grid gap-1.5 py-1"
                data-testid="env-editing"
              >
                <span className="flex items-baseline gap-2 font-mono text-[12px]">
                  <span className="text-kumo-default">{variable.key}</span>
                  <span className="text-[11px] text-kumo-subtle">{variable.fileName}</span>
                </span>
                <EditBox
                  secret={variable.secret}
                  value={editing.value}
                  onChange={(value) => setEditing({ ...editing, value })}
                  onStage={stage}
                  onCancel={cancel}
                  label={`New value of ${variable.key}`}
                />
              </li>
            ) : (
              <li
                key={`${variable.fileName}:${variable.key}`}
                className="group/env -mx-2 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto_auto] items-start gap-x-3 rounded-md px-2 py-1 hover:ink"
                data-testid="env-variable"
                data-key={variable.key}
              >
                <span className="font-mono text-[12px] leading-5 text-kumo-default">
                  {variable.key}
                </span>
                <span className="min-w-0 font-mono text-[12px] leading-5 [overflow-wrap:anywhere] text-kumo-default">
                  {variable.secret ? (
                    <MaskedValue
                      label={`Show ${variable.key}`}
                      reveal={(signal) => revealSecret(codebase, variable.key, signal)}
                      copyable
                      testId={`env-secret-${variable.key}`}
                    />
                  ) : (
                    variable.value
                  )}
                </span>
                <span className="font-mono text-[11px] leading-5 text-kumo-subtle">
                  {variable.fileName}
                </span>
                {editable && variable.file ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    shape="square"
                    icon={<PencilSimpleIcon />}
                    aria-label={`Edit ${variable.key}`}
                    className="opacity-0 group-hover/env:opacity-100 focus-visible:opacity-100"
                    onClick={() =>
                      setEditing({
                        kind: 'edit',
                        variable,
                        value: variable.secret ? '' : (variable.value ?? ''),
                      })
                    }
                    data-testid={`env-edit-${variable.key}`}
                  />
                ) : (
                  <span />
                )}
              </li>
            ),
          )}
          {editing?.kind === 'add' && (
            <li className="grid gap-1.5 py-1" data-testid="env-adding">
              <div className="flex min-w-0 gap-1.5">
                <Input
                  size="sm"
                  className="min-w-0 flex-1 font-mono"
                  value={editing.key}
                  onChange={(event) => setEditing({ ...editing, key: event.target.value })}
                  onKeyDown={(event) => editKeys(event, stage, cancel)}
                  placeholder="NAME"
                  aria-label="Variable name"
                  spellCheck={false}
                  autoFocus
                  data-testid="env-add-key"
                />
                <Select
                  size="sm"
                  aria-label="File"
                  value={editing.file}
                  onValueChange={(next) =>
                    setEditing({ ...editing, file: next as FunctionEnvFile })
                  }
                  items={ADD_FILES.map((file) => ({
                    value: file,
                    label: envFileName(file, project),
                  }))}
                  className="w-40 shrink-0 font-mono"
                />
              </div>
              <EditBox
                secret={editing.file === 'secretLocal'}
                value={editing.value}
                onChange={(value) => setEditing({ ...editing, value })}
                onStage={stage}
                onCancel={cancel}
                label="Value"
                problem={editing.key.trim() === '' ? undefined : envKeyProblem(editing.key.trim())}
              />
            </li>
          )}
        </ul>
      </InspectorSection>
      <InspectorSection
        title="Declared secrets"
        count={summary.secrets.length}
        testId="env-declared-secrets"
      >
        <ul className="grid gap-1">
          {summary.secrets.map((secret) =>
            editing?.kind === 'secret' && editing.key === secret.key ? (
              <li key={secret.key} className="grid gap-1.5 py-1">
                <span className="font-mono text-[12px] text-kumo-default">{secret.key}</span>
                <EditBox
                  secret
                  value={editing.value}
                  onChange={(value) => setEditing({ ...editing, value })}
                  onStage={stage}
                  onCancel={cancel}
                  label={`Value of ${secret.key}`}
                />
              </li>
            ) : (
              <li
                key={secret.key}
                className="flex min-w-0 items-center gap-3"
                data-testid="env-secret"
                data-key={secret.key}
              >
                <span className="font-mono text-[12px] text-kumo-default">{secret.key}</span>
                {secret.provided ? (
                  <StatusDot tone="success" label="provided" />
                ) : (
                  <>
                    <StatusDot tone="warning" label="missing from .secret.local" />
                    {editable && (
                      <Button
                        variant="secondary"
                        size="xs"
                        className="ml-auto"
                        onClick={() => setEditing({ kind: 'secret', key: secret.key, value: '' })}
                        data-testid={`env-add-secret-${secret.key}`}
                      >
                        Add secret
                      </Button>
                    )}
                  </>
                )}
              </li>
            ),
          )}
        </ul>
        {summary.secrets.some((secret) => !secret.provided) && (
          <Text variant="secondary" size="xs" DANGEROUS_className="mt-1.5">
            A missing secret leaves{' '}
            <span className="font-mono">
              process.env.{summary.secrets.find((secret) => !secret.provided)?.key}
            </span>{' '}
            undefined here.
          </Text>
        )}
      </InspectorSection>
      <InspectorSection title="Declared params" count={params.length} testId="env-params">
        <ul className="grid gap-1.5">
          {params.map((param) =>
            editing?.kind === 'param' && editing.key === param.name ? (
              <li key={param.name} className="grid gap-1.5 py-1">
                <span className="font-mono text-[12px] text-kumo-default">{param.name}</span>
                <EditBox
                  secret={false}
                  value={editing.value}
                  onChange={(value) => setEditing({ ...editing, value })}
                  onStage={stage}
                  onCancel={cancel}
                  label={`Value of ${param.name}`}
                />
                <Text variant="secondary" size="xs">
                  Written to .env.local, as the official CLI's prompt does for the emulator.
                </Text>
              </li>
            ) : (
              <li
                key={param.name}
                className="grid gap-0.5"
                data-testid="env-param"
                data-key={param.name}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="font-mono text-[12px] text-kumo-default">{param.name}</span>
                  <span className="font-mono text-[11px] text-kumo-subtle">{param.type}</span>
                  {param.default !== null && (
                    <span className="font-mono text-[11px] text-kumo-subtle">
                      default {param.default}
                    </span>
                  )}
                  {param.unresolved ? (
                    <>
                      <StatusDot tone="warning" label="unresolved" />
                      {editable && (
                        <Button
                          variant="secondary"
                          size="xs"
                          className="ml-auto"
                          onClick={() =>
                            setEditing({
                              kind: 'param',
                              key: param.name,
                              value: param.default ?? '',
                              secret: false,
                            })
                          }
                          data-testid={`env-set-param-${param.name}`}
                        >
                          Set value
                        </Button>
                      )}
                    </>
                  ) : (
                    <span className="font-mono text-[12px] text-kumo-default">
                      {param.value}
                      {param.file && (
                        <span className="text-[11px] text-kumo-subtle"> · {param.file}</span>
                      )}
                    </span>
                  )}
                </span>
                {param.unresolved && (
                  <span className="text-[12px] text-kumo-subtle">
                    No env file sets it; the official emulator would ask for it and write
                    .env.local.
                  </span>
                )}
                {param.description && (
                  <span className="text-[12px] text-kumo-subtle">{param.description}</span>
                )}
              </li>
            ),
          )}
        </ul>
      </InspectorSection>
      {extension.length > 0 && (
        <InspectorSection title="Extension parameters" count={extension.length}>
          <KeyValueList
            items={extension.map((variable) =>
              variable.secret
                ? {
                    label: variable.key,
                    value: '',
                    masked: true,
                    reveal: (signal: AbortSignal) => revealSecret(codebase, variable.key, signal),
                  }
                : { label: variable.key, value: variable.value ?? '', copy: variable.value ?? '' },
            )}
          />
        </InspectorSection>
      )}
      <EmulatorVariables variables={emulator} inherited={environment.inherited} />
      <EnvChangeDialog
        open={staged !== null}
        onOpenChange={(open) => {
          if (!open) setStaged(null)
        }}
        codebase={codebase}
        lines={staged ?? []}
        onSaved={() => setEditing(null)}
      />
    </div>
  )
}

function EditBox({
  secret,
  value,
  onChange,
  onStage,
  onCancel,
  label,
  problem,
}: {
  secret: boolean
  value: string
  onChange: (value: string) => void
  onStage: () => void
  onCancel: () => void
  label: string
  problem?: string | undefined
}) {
  return (
    <div className="grid gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        {secret ? (
          <SensitiveInput
            size="sm"
            className="min-w-0 flex-1 font-mono"
            value={value}
            onValueChange={onChange}
            onKeyDown={(event) => editKeys(event, onStage, onCancel)}
            aria-label={label}
            autoFocus
            data-testid="env-edit-value"
          />
        ) : (
          <Input
            size="sm"
            className="min-w-0 flex-1 font-mono"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => editKeys(event, onStage, onCancel)}
            aria-label={label}
            spellCheck={false}
            autoFocus
            data-testid="env-edit-value"
          />
        )}
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onStage}
          disabled={problem !== undefined}
          data-testid="env-edit-review"
        >
          Review
        </Button>
      </div>
      {problem && (
        <Text variant="error" size="xs">
          {problem}
        </Text>
      )}
    </div>
  )
}

function EmulatorVariables({
  variables,
  inherited,
}: {
  variables: readonly FunctionEnvVariable[]
  inherited: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <InspectorSection
      title="Emulator"
      count={variables.length}
      testId="env-emulator"
      action={
        variables.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
            data-testid="env-emulator-toggle"
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-1.5">
        {open && (
          <KeyValueList
            items={variables.map((variable) => ({
              label: variable.key,
              value: variable.value ?? '',
              copy: variable.value ?? '',
            }))}
            testId="env-emulator-list"
          />
        )}
        <p className="text-[12px] text-kumo-subtle" data-testid="env-inherited">
          + {formatNumber(inherited)} {inherited === 1 ? 'variable' : 'variables'} from the engine's
          own environment; their values are never sent to the console.
        </p>
      </div>
    </InspectorSection>
  )
}
