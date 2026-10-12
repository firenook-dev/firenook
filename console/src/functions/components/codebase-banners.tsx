// What is wrong with a codebase right now, one strip each, in the order the
// spec sets (§5.10): the load failed (and whether the previous load still
// serves), the worker exited, the code on disk is newer than the code
// running. The function page, the codebase view and the Invocations page
// draw the same strips, so the stale-code trap is visible wherever the
// developer is looking.
//
// A worker stopped by a reload is the normal state between calls and gets
// no strip.

import { Button } from '@cloudflare/kumo'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import { CopyButton } from '@/components/console/copy-button'
import { EntityLink } from '@/components/console/entity-link'
import { RelativeTime } from '@/components/console/relative-time'
import { SectionBanner } from '@/components/console/section-banner'
import { formatClock } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { reloadCodebase, restartWorker } from '../api'

/** "exited with code 1" → "exited (code 1)"; anything else as the runtime wrote it. */
export function exitWords(lastExit: string | null): string {
  if (!lastExit) return 'exited'
  const code = /^exited with code (-?\d+)/.exec(lastExit)
  if (code) return `exited (code ${code[1]})`
  const signal = /signal (\w+)/.exec(lastExit)
  if (signal) return `exited (${signal[1]})`
  return lastExit
}

/** Whether the worker stopped on its own, which is worth a strip (a reload's stop is not). */
export function workerDown(entry: FunctionCodebaseEntry): boolean {
  const state = entry.codebase.worker.state
  return state === 'exited' || state === 'failed'
}

function Code({ children }: { children: string }) {
  return <span className="font-mono text-[12px]">{children}</span>
}

/** Reload a codebase, saying how it went in a toast (the reload's own toast follows on the topic). */
export function useReloadCodebase(codebase: string) {
  return useMutation({
    mutationFn: () => reloadCodebase(codebase),
    onError: (error) =>
      toast({
        key: `functions.reload-failed.${codebase}`,
        title: `Could not reload ${codebase}`,
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      }),
  })
}

export function CodebaseBanners({ entry }: { entry: FunctionCodebaseEntry }) {
  const codebase = entry.codebase
  const [showError, setShowError] = useState(false)
  const reload = useReloadCodebase(codebase.id)
  const restart = useMutation({
    mutationFn: () => restartWorker(codebase.id),
    onError: (error) =>
      toast({
        key: `functions.restart.${codebase.id}`,
        title: `Could not restart the ${codebase.id} worker`,
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      }),
  })
  const extension = codebase.kind === 'extension'
  const reloadAction = extension ? (
    entry.instance ? (
      <EntityLink entity={{ ...entry.instance, label: 'Open in Extensions' }} />
    ) : null
  ) : (
    <Button
      variant="secondary"
      size="xs"
      loading={reload.isPending}
      onClick={() => reload.mutate()}
      data-testid="codebase-reload"
    >
      Reload
    </Button>
  )

  const strips = []
  if (codebase.state === 'failed') {
    const error = codebase.error
    const errorText = [error?.message, error?.detail].filter(Boolean).join('\n')
    strips.push(
      <div key="failed" className="grid shrink-0">
        <SectionBanner
          tone="danger"
          testId="codebase-failed"
          action={
            <>
              {error?.detail && (
                <Button
                  variant="ghost"
                  size="xs"
                  aria-expanded={showError}
                  onClick={() => setShowError((shown) => !shown)}
                  data-testid="codebase-failed-toggle"
                >
                  {showError ? 'Hide the error' : 'Show the error'}
                </Button>
              )}
              {errorText !== '' && (
                <CopyButton value={errorText} label="Copy the error" size="xs" />
              )}
              {reloadAction}
            </>
          }
        >
          {codebase.servingPrevious ? (
            <>
              <Code>{codebase.id}</Code> failed to reload
              {error ? ` at ${formatClock(error.at, 'time').slice(0, 8)}` : ''}. The functions below
              are from the previous load.
            </>
          ) : (
            <>
              <Code>{codebase.id}</Code> did not load. None of its functions are running.
            </>
          )}
          {error?.message ? <span className="text-kumo-subtle"> {error.message}</span> : null}
        </SectionBanner>
        {showError && error?.detail && (
          <pre
            className="max-h-72 shrink-0 overflow-auto border-b border-kumo-line bg-kumo-elevated px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap text-kumo-default"
            data-testid="codebase-failed-detail"
          >
            {error.detail}
          </pre>
        )}
      </div>,
    )
  }
  if (workerDown(entry)) {
    const worker = codebase.worker
    strips.push(
      <SectionBanner
        key="worker"
        tone="warning"
        testId="codebase-worker-exited"
        action={
          <Button
            variant="secondary"
            size="xs"
            loading={restart.isPending}
            onClick={() => restart.mutate()}
            data-testid="codebase-restart-now"
          >
            Restart now
          </Button>
        }
      >
        The worker for <Code>{codebase.id}</Code>{' '}
        {worker.state === 'failed' ? 'failed to start' : exitWords(worker.lastExit)}
        {worker.exitedAt ? (
          <>
            {' '}
            <RelativeTime iso={worker.exitedAt} />
          </>
        ) : null}
        . The next call starts a new one.
      </SectionBanner>,
    )
  }
  const stale = codebase.stale
  if (stale?.reason === 'sourcesNewer')
    strips.push(
      <SectionBanner key="sources" tone="info" testId="codebase-sources-newer">
        <Code>src/</Code> changed <RelativeTime iso={stale.changedAt} /> but <Code>lib/</Code>{' '}
        didn't — is <Code>npm run build:watch</Code> running?
      </SectionBanner>,
    )
  if (stale?.reason === 'envChanged')
    strips.push(
      <SectionBanner key="env" tone="info" testId="codebase-env-changed" action={reloadAction}>
        <Code>{stale.file}</Code> changed after the last load, so <Code>{codebase.id}</Code> still
        runs with the old values.
      </SectionBanner>,
    )
  if (strips.length === 0) return null
  return <>{strips}</>
}
