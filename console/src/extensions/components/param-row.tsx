// One param of an instance's configuration: its label, its `PARAM` name
// and type, its value in a box set in the data face with the file that set
// it beside it, what is wrong with it, and its description behind a
// disclosure. Read and edit are one row, so switching to edit moves
// nothing: the box becomes an input of the param's type in the same place.
// A secret is never on screen until asked for (the engine reads it from
// `.secret.local` when the eye is pressed), and is typed fresh to change it.

import { Combobox, Input, Select, SensitiveInput, Tooltip, cn } from '@cloudflare/kumo'
import { CaretRightIcon, LockSimpleIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ExtensionParam } from '@/api/generated/compute/ExtensionParam'
import { MaskedValue } from '@/components/console/masked-value'
import { KIND_CHIP } from '@/compute/kind-badge'
import { multiValues, optionLabel, sourceWord } from '../params'
import { MarkdownView } from './markdown-view'

/** Why an immutable param is editable here anyway. */
export const IMMUTABLE_NOTE =
  'Immutable after install in production; editable here because nothing is installed.'

/** The read box: a value in the data face, on the control ground, wrapping rather than cut. */
const BOX =
  'flex min-h-7 min-w-0 flex-1 items-center rounded-md bg-kumo-control px-2 py-1 font-mono text-[12px] leading-5 break-all text-kumo-default ring ring-kumo-line'

function SourceChip({ param }: { param: ExtensionParam }) {
  const word = sourceWord(param)
  const missing = word === 'not set'
  const title =
    param.source === 'file' && param.file
      ? `Set in ${param.file}`
      : param.source === 'default'
        ? param.provided
          ? param.default !== null
            ? `No file sets it, so the extension's default (${param.default}) applies.`
            : 'The emulator sets it for every instance.'
          : 'No file sets it and it has no default.'
        : 'No file sets it and it has no default.'
  return (
    <Tooltip
      content={title}
      render={
        <span
          className={cn(
            'flex h-4.5 max-w-48 shrink-0 items-center truncate rounded px-1 font-mono text-[11px]',
            missing ? 'bg-kumo-warning-tint text-kumo-default' : 'bg-kumo-tint text-kumo-subtle',
          )}
          data-testid="param-source"
        >
          {word}
        </span>
      }
    />
  )
}

/** What the read box shows for a value. */
function ReadValue({
  param,
  reveal,
}: {
  param: ExtensionParam
  reveal: (signal: AbortSignal) => Promise<string>
}) {
  if (param.type === 'secret')
    return param.provided ? (
      <span className={BOX}>
        <MaskedValue
          reveal={reveal}
          label={`Show ${param.label ?? param.param}`}
          copyable
          testId="param-secret"
        />
      </span>
    ) : (
      <span className={cn(BOX, 'font-sans text-kumo-subtle')} data-testid="param-value">
        No value in .secret.local
      </span>
    )
  const value = param.value
  if (value === null || value === '')
    return (
      <span className={cn(BOX, 'font-sans text-kumo-subtle')} data-testid="param-value">
        Not set
      </span>
    )
  if (param.type === 'select' || param.type === 'multiSelect') {
    const values = param.type === 'multiSelect' ? multiValues(value) : [value]
    return (
      <span className={cn(BOX, 'flex-wrap gap-x-3 gap-y-0.5')} data-testid="param-value">
        {values.map((entry) => {
          const label = optionLabel(param, entry)
          return (
            <span key={entry} className="flex items-baseline gap-1.5">
              {label && <span className="font-sans text-kumo-default">{label}</span>}
              <span className={label ? 'text-kumo-subtle' : undefined}>{entry}</span>
            </span>
          )
        })}
      </span>
    )
  }
  return (
    <span className={BOX} data-testid="param-value">
      {value}
    </span>
  )
}

/** The input for a param's type, in edit mode. */
function EditValue({
  param,
  value,
  invalid,
  onChange,
}: {
  param: ExtensionParam
  value: string
  invalid: boolean
  onChange: (value: string) => void
}) {
  const name = param.label ?? param.param
  if (param.type === 'secret')
    return (
      <div className="min-w-0 flex-1">
        <SensitiveInput
          size="sm"
          value={value}
          onValueChange={onChange}
          placeholder={param.provided ? 'Leave empty to keep the current value' : 'Type the secret'}
          variant={invalid ? 'error' : 'default'}
          aria-label={name}
          className="w-full font-mono placeholder:font-sans"
          data-testid="param-input"
        />
      </div>
    )
  if (param.type === 'select' && param.options.length > 0) {
    // A value the options do not hold stays listed, so the box never shows
    // a value its own menu cannot pick.
    const options = param.options.some((option) => option.value === value)
      ? param.options
      : value === ''
        ? param.options
        : [...param.options, { value, label: null }]
    return (
      <div className="min-w-0 flex-1" data-testid="param-input">
        <Select
          size="sm"
          value={value}
          onValueChange={(next) => onChange(String(next ?? ''))}
          renderValue={() => {
            const label = optionLabel(param, value)
            return value === '' ? (
              <span className="text-kumo-subtle">Choose…</span>
            ) : (
              <span className="flex min-w-0 items-baseline gap-1.5">
                {label && <span className="truncate">{label}</span>}
                <span className="truncate font-mono text-[12px] text-kumo-subtle">{value}</span>
              </span>
            )
          }}
          aria-label={name}
          className={cn('w-full min-w-0', invalid && 'ring-kumo-danger')}
        >
          {options.map((option) => (
            <Select.Option key={option.value} value={option.value}>
              <span className="flex min-w-0 items-baseline gap-2">
                {option.label && <span className="truncate text-[13px]">{option.label}</span>}
                <span className="truncate font-mono text-[12px] text-kumo-subtle">
                  {option.value}
                </span>
              </span>
            </Select.Option>
          ))}
        </Select>
      </div>
    )
  }
  if (param.type === 'multiSelect' && param.options.length > 0) {
    const chosen = multiValues(value)
    return (
      <div className="min-w-0 flex-1" data-testid="param-input">
        <Combobox
          multiple
          size="sm"
          items={param.options.map((option) => option.value)}
          value={chosen}
          onValueChange={(next) => onChange((Array.isArray(next) ? next : []).join(','))}
        >
          <Combobox.TriggerMultipleWithInput
            placeholder="Add an option"
            value={chosen}
            renderItem={(item: string) => (
              <Combobox.Chip removeLabel={`Remove ${item}`}>
                <span className="font-mono text-[12px]">{item}</span>
              </Combobox.Chip>
            )}
          />
          <Combobox.Content>
            <Combobox.Empty />
            <Combobox.List>
              {(item: string) => (
                <Combobox.Item key={item} value={item}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    {optionLabel(param, item) && (
                      <span className="truncate text-[13px]">{optionLabel(param, item)}</span>
                    )}
                    <span className="truncate font-mono text-[12px] text-kumo-subtle">{item}</span>
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Content>
        </Combobox>
      </div>
    )
  }
  return (
    <div className="min-w-0 flex-1">
      <Input
        size="sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={param.example ?? param.default ?? undefined}
        variant={invalid ? 'error' : 'default'}
        aria-label={name}
        spellCheck={false}
        autoComplete="off"
        className="w-full font-mono"
        data-testid="param-input"
      />
    </div>
  )
}

export function ParamRow({
  param,
  editing,
  value,
  problem,
  onChange,
  reveal,
}: {
  param: ExtensionParam
  editing: boolean
  /** The drafted value, in edit mode. */
  value: string
  /** What is wrong with the drafted value (edit mode) — else the engine's word on the value in force. */
  problem: string | undefined
  onChange: (value: string) => void
  reveal: (signal: AbortSignal) => Promise<string>
}) {
  const [about, setAbout] = useState(false)
  const changed =
    editing && (param.type === 'secret' ? value !== '' : value !== (param.value ?? ''))
  // While editing, the drafted value's problem; an untouched value keeps
  // the engine's word on the value in force.
  const shownProblem = editing && changed ? problem : (problem ?? param.problem ?? undefined)
  const invalid = editing && changed && problem !== undefined
  return (
    <div
      className="grid gap-1.5 border-b border-kumo-hairline py-3 last:border-b-0"
      data-testid="param-row"
      data-param={param.param}
      data-changed={changed ? '' : undefined}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium text-kumo-default">
          {param.label ?? param.param}
        </span>
        {param.label && (
          <span className="font-mono text-[11px] text-kumo-subtle">{param.param}</span>
        )}
        <span className={cn(KIND_CHIP, 'self-center')}>{param.type}</span>
        {param.required && <span className="text-[11px] text-kumo-subtle">required</span>}
        {param.immutable && (
          <Tooltip
            content={IMMUTABLE_NOTE}
            render={
              <span
                className="flex cursor-default items-center gap-1 self-center text-[11px] text-kumo-subtle"
                data-testid="param-immutable"
              >
                <LockSimpleIcon size={11} />
                immutable
              </span>
            }
          />
        )}
        {changed && (
          <span className="text-[11px] font-medium text-kumo-default" data-testid="param-changed">
            changed
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-2">
        {editing ? (
          <EditValue param={param} value={value} invalid={invalid} onChange={onChange} />
        ) : (
          <ReadValue param={param} reveal={reveal} />
        )}
        <span className="flex h-7 w-40 shrink-0 items-center">
          <SourceChip param={param} />
        </span>
      </div>
      {shownProblem && (
        <span
          className={cn(
            'flex items-start gap-1.5 text-[12px]',
            invalid ? 'text-kumo-danger' : 'text-kumo-warning',
          )}
          role={invalid ? 'alert' : undefined}
          data-testid="param-problem"
        >
          <span
            className={cn(
              'mt-1.5 size-1.5 shrink-0 rounded-full',
              invalid ? 'bg-kumo-danger' : 'bg-kumo-warning',
            )}
            aria-hidden
          />
          {shownProblem}
        </span>
      )}
      {param.unchecked && (
        <span className="text-[12px] text-kumo-subtle" data-testid="param-unchecked">
          {param.unchecked}
          {param.validationRegex && (
            <>
              {' '}
              <span className="font-mono">{param.validationRegex}</span>
            </>
          )}
        </span>
      )}
      {param.description && (
        <div className="grid gap-1">
          <button
            type="button"
            onClick={() => setAbout((open) => !open)}
            aria-expanded={about}
            className="flex w-fit items-center gap-1 rounded-md px-1 py-0.5 -ml-1 text-[12px] text-kumo-subtle hover:ink hover:text-kumo-default"
            data-testid="param-about"
          >
            <CaretRightIcon
              size={10}
              className={cn('shrink-0 transition-transform', about && 'rotate-90')}
            />
            About this parameter
          </button>
          {about && (
            <div className="pl-4">
              <MarkdownView text={param.description} size="compact" testId="param-description" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
