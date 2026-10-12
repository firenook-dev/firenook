// A retention duration as a number and a unit, the way the Cloud console
// asks for one: minutes, hours or days, held to the engine's bounds (10
// minutes to 7 days) with the engine's own words when it is outside them.

import { Input, Select } from '@cloudflare/kumo'

export type DurationUnit = 'minutes' | 'hours' | 'days'

const UNIT_SECONDS: Record<DurationUnit, number> = { minutes: 60, hours: 3600, days: 86_400 }

/** Ten minutes to seven days, as Pub/Sub takes a retention. */
export const RETENTION_MIN = 600
export const RETENTION_MAX = 7 * 86_400

/** A duration in seconds as the largest whole unit: 604800 → 7 days. */
export function splitDuration(seconds: number): { amount: string; unit: DurationUnit } {
  if (seconds % 86_400 === 0) return { amount: String(seconds / 86_400), unit: 'days' }
  if (seconds % 3600 === 0) return { amount: String(seconds / 3600), unit: 'hours' }
  return { amount: String(Math.round(seconds / 60)), unit: 'minutes' }
}

/** The seconds a typed amount and unit make, or undefined when the amount is not a positive number. */
export function durationSeconds(amount: string, unit: DurationUnit): number | undefined {
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * UNIT_SECONDS[unit])
}

/** Why a retention cannot be used, or undefined. */
export function retentionProblem(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return 'Enter a duration.'
  if (seconds < RETENTION_MIN) return 'A retention is at least 10 minutes.'
  if (seconds > RETENTION_MAX) return 'A retention is at most 7 days.'
  return undefined
}

export function RetentionField({
  amount,
  unit,
  onChange,
  disabled = false,
  label,
  testId,
}: {
  amount: string
  unit: DurationUnit
  onChange: (amount: string, unit: DurationUnit) => void
  disabled?: boolean
  /** The amount box's accessible name. */
  label: string
  testId?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={testId}>
      <Input
        size="sm"
        type="number"
        min={1}
        value={amount}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value, unit)}
        aria-label={label}
        className="w-20 font-mono"
        data-testid={testId && `${testId}-amount`}
      />
      <Select
        size="xs"
        value={unit}
        disabled={disabled}
        onValueChange={(next) => onChange(amount, next as DurationUnit)}
        aria-label={`${label}, unit`}
        className="h-6.5 w-24"
      >
        <Select.Option value="minutes">minutes</Select.Option>
        <Select.Option value="hours">hours</Select.Option>
        <Select.Option value="days">days</Select.Option>
      </Select>
    </span>
  )
}
