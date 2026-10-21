// The Environment tab: what `process.env` holds for this function, without
// leaking the host. The env files the last load read, in precedence order;
// every variable with the file that set it (`.secret.local` values masked
// until revealed, read from the file when asked), and the defaults the
// params no file sets take, marked as defaults; the secrets the function
// declares, provided or missing; the params the manifest declares and where
// each value came from; the emulator's own variables; and only a count of
// what the worker inherits from the engine's environment.
//
// It writes what the official CLI would ask for: a missing secret (in
// `.secret.local`) and an unresolved param (in `.env.local`, what its
// prompt writes), through the same dialog and the same atomic write with
// restore as Extensions' reconfigure. Any other value is changed in its
// file, in the developer's editor: the codebase says the file changed, and
// Reload loads it.

import { Button, Input, Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { type KeyboardEvent, useState } from 'react'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionEnvironment } from '@/api/generated/compute/FunctionEnvironment'
import type { FunctionEnvVariable } from '@/api/generated/compute/FunctionEnvVariable'
import type { FunctionParam } from '@/api/generated/compute/FunctionParam'
import { EntityLink } from '@/components/console/entity-link'
import { InspectorSection } from '@/components/console/inspector'
import { KeyValueList } from '@/components/console/key-value-list'
import { MaskedValue } from '@/components/console/masked-value'
import { StatusDot } from '@/components/kit'
import { SecretInput } from '@/compute/secret-input'
import { formatNumber } from '@/lib/format'
import { matchesKey } from '@/lib/shortcuts'
import { functionsSnapshotQuery, revealSecret } from '../api'
import { type EnvChangeLine, EnvChangeDialog } from './env-change-dialog'

type Editing =
  | { kind: 'secret'; key: string; value: string }
  | { kind: 'param'; key: string; value: string; secret: boolean }

/**
 * What the codebase's own files and declared params put in `process.env`:
 * env file and `.secret.local` values, and the defaults of the params no
 * file sets.
 */
export function userVariables(environment: FunctionEnvironment): FunctionEnvVariable[] {
  return environment.variables.filter(
    (variable) =>
      variable.source === 'dotEnv' ||
      variable.source === 'secretLocal' ||
      variable.source === 'paramDefault',
  )
}

/** Where a listed variable's value comes from: its file, or `default`. */
export function variableOrigin(variable: FunctionEnvVariable): string {
  return variable.source === 'paramDefault' ? 'default' : (variable.fileName ?? '')
}

/**
 * A param's value and where it comes from (its file, or `default` when no
 * file sets it), or null when nothing gives it one (a secret is shown in
 * Declared secrets).
 */
export function paramValue(param: FunctionParam): { value: string; from: string } | null {
  if (param.secret || param.value === null) return null
  return { value: param.value, from: param.file ?? 'default' }
}

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
  const user = userVariables(environment)
  const emulator = environment.variables.filter((variable) => variable.source === 'emulator')
  const extension = environment.variables.filter((variable) => variable.source === 'extensionParam')
  const params = detail.params.filter((param) => !param.secret)
  const editable = environment.editable
  // Where the codebase lives, so the save names the files it writes in full.
  const snapshot = useQuery({ ...functionsSnapshotQuery(project), enabled: project !== '' })
  const directory = snapshot.data?.codebases.find((entry) => entry.codebase.id === codebase)
    ?.codebase.directory

  const stage = () => {
    if (!editing) return
    if (editing.kind === 'secret') {
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
      <InspectorSection title="Variables" count={user.length} testId="env-variables">
        <ul className="grid gap-0.5">
          {user.map((variable) => (
            <li
              key={`${variable.fileName}:${variable.key}`}
              className="-mx-2 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-1 hover:ink"
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
                {variableOrigin(variable)}
              </span>
            </li>
          ))}
        </ul>
        {editable && (
          <p className="m-0 mt-1.5 text-[12px] text-kumo-subtle" data-testid="env-edit-hint">
            {user.length === 0
              ? 'To add a variable, write it to an env file'
              : 'To change a value, edit its file'}
            {directory && (
              <>
                {' '}
                in <span className="font-mono">{directory}/</span>
              </>
            )}
            ; the codebase then says a file changed, and Reload loads it.
          </p>
        )}
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
                  {paramValue(param) && (
                    <span className="font-mono text-[12px] text-kumo-default">
                      {paramValue(param)?.value}
                      <span className="text-[11px] text-kumo-subtle">
                        {' '}
                        · {paramValue(param)?.from}
                      </span>
                    </span>
                  )}
                  {param.unresolved && (
                    <>
                      {!paramValue(param) && <StatusDot tone="warning" label="unresolved" />}
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
                  )}
                </span>
                {param.unresolved && (
                  <span className="text-[12px] text-kumo-subtle">
                    {paramValue(param)
                      ? 'No env file sets it, so it takes its default; the official emulator would ask for it, with the default filled in, and write .env.local.'
                      : 'No env file sets it; the official emulator would ask for it and write .env.local.'}
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
        directory={directory}
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
          <SecretInput
            className="flex-1"
            value={value}
            onChange={onChange}
            onKeyDown={(event) => editKeys(event, onStage, onCancel)}
            label={label}
            autoFocus
            testId="env-edit-value"
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
