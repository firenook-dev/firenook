// The level of a line, as a word, wherever it stands outside a log row: the
// Logs inspector's header ("▏warn · 12:06:09.126") and the Overview's
// recent problems. It is the row's level column lifted out (`LogLine`):
// 11 px in the data face, `debug` faded, `warn` amber, `error` red, and the
// same 2 px rail before a warning or an error when the caller wants the
// row's mark. Unlike the row, it always says `info`: alone, a blank would
// read as a missing value.

import { cn } from '@cloudflare/kumo'
import type { LogLevel } from '@/api/generated/observe/LogLevel'

const TONE: Record<LogLevel, string> = {
  debug: 'text-kumo-inactive',
  info: 'text-kumo-subtle',
  warn: 'text-kumo-warning',
  error: 'text-kumo-danger',
}

const RAIL: Partial<Record<LogLevel, string>> = {
  warn: 'bg-kumo-warning',
  error: 'bg-kumo-danger',
}

export function LevelWord({
  level,
  rail = false,
  className,
  testId,
}: {
  level: LogLevel
  /** The row's 2 px mark before a warning or an error (nothing for the others). */
  rail?: boolean | undefined
  className?: string | undefined
  testId?: string | undefined
}) {
  const mark = rail ? RAIL[level] : undefined
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] leading-4',
        TONE[level],
        className,
      )}
      data-level={level}
      data-testid={testId}
    >
      {mark && <span aria-hidden="true" className={cn('h-3 w-0.5 shrink-0 rounded-full', mark)} />}
      {level}
    </span>
  )
}
