import { describe, expect, it, vi } from 'vitest'
import { type ToastSink, TOAST_LIMIT, createToastPolicy } from './toasts'

/** A toast manager that remembers what is on screen, as Kumo's does. */
function fakeSink() {
  const shown = new Map<string, Parameters<ToastSink['add']>[0]>()
  const sink: ToastSink = {
    add: vi.fn((options) => {
      shown.set(options.id, options)
    }),
    close: vi.fn((id: string) => {
      const toast = shown.get(id)
      shown.delete(id)
      toast?.onClose?.()
    }),
  }
  return { sink, shown, titles: () => [...shown.values()].map((toast) => toast.title) }
}

describe('the toast policy', () => {
  it('stacks at most three, and the oldest goes', () => {
    const { sink, titles } = fakeSink()
    const toast = createToastPolicy(sink)
    for (const n of [1, 2, 3, 4]) toast({ key: `job-${n}`, title: `Job ${n} done` })
    expect(TOAST_LIMIT).toBe(3)
    expect(titles()).toEqual(['Job 2 done', 'Job 3 done', 'Job 4 done'])
    expect(sink.close).toHaveBeenCalledTimes(1)
  })

  it('replaces a toast with the same key in place instead of stacking a copy', () => {
    const { sink, shown, titles } = fakeSink()
    const toast = createToastPolicy(sink)
    toast({ key: 'export', title: 'Exporting… 10%' })
    toast({ key: 'other', title: 'Something else' })
    toast({ key: 'export', title: 'Exporting… 80%' })
    expect(titles()).toEqual(['Exporting… 80%', 'Something else'])
    expect(shown.size).toBe(2)
    expect(sink.close).not.toHaveBeenCalled()
    // Refreshed, it is now the newest: two more push out "Something else" first.
    toast({ key: 'a', title: 'A' })
    toast({ key: 'b', title: 'B' })
    expect(titles()).toEqual(['Exporting… 80%', 'A', 'B'])
  })

  it('rewrites a replaced toast, since Kumo only bumps one whose id is still showing', () => {
    // Kumo's own `add` with an id on screen restarts its timer and keeps
    // everything it said: a job's "done" would go on reading "0 of 1" with
    // Cancel. The replacement's words, tone and actions go through `update`.
    const update = vi.fn()
    const sink: ToastSink = { add: vi.fn(), close: vi.fn(), update }
    const toast = createToastPolicy(sink)
    const cancel = vi.fn()
    toast({
      key: 'job:j1',
      title: 'Prepare a snapshot',
      description: '0 of 1',
      tone: 'info',
      action: { label: 'Cancel', run: cancel },
    })
    expect(update).not.toHaveBeenCalled()
    toast({
      key: 'job:j1',
      title: 'Prepare a snapshot: done',
      description: '1 of 1',
      tone: 'success',
    })
    expect(update).toHaveBeenCalledTimes(1)
    const [id, content] = update.mock.calls[0] ?? []
    expect(id).toBe(vi.mocked(sink.add).mock.calls[0]?.[0].id)
    expect(content).toEqual({
      title: 'Prepare a snapshot: done',
      description: '1 of 1',
      variant: 'success',
      actions: undefined,
    })
    // And still bumped through `add`, under the same id.
    expect(vi.mocked(sink.add).mock.calls[1]?.[0].id).toBe(id)
  })

  it('never shows a replayed event or the console echoing its own change', () => {
    const { sink } = fakeSink()
    const toast = createToastPolicy(sink)
    toast({ key: 'code', title: 'New sign-in code', replayed: true })
    toast({ key: 'user', title: 'User created', echo: true })
    expect(sink.add).not.toHaveBeenCalled()
  })

  it('forgets a toast the person closed, so it does not count against the stack', () => {
    const { sink, shown, titles } = fakeSink()
    const toast = createToastPolicy(sink)
    toast({ key: 'a', title: 'A' })
    toast({ key: 'b', title: 'B' })
    const [first] = shown.values()
    first?.onClose?.()
    shown.delete(first?.id ?? '')
    toast({ key: 'c', title: 'C' })
    toast({ key: 'd', title: 'D' })
    expect(titles()).toEqual(['B', 'C', 'D'])
    expect(sink.close).not.toHaveBeenCalled()
  })

  it('maps the tone and the action onto the toast', () => {
    const { sink, shown } = fakeSink()
    const toast = createToastPolicy(sink)
    const run = vi.fn()
    toast({
      key: 'restart',
      title: 'The engine restarted.',
      description: 'Everything on screen was reloaded.',
      tone: 'danger',
      action: { label: 'Reload', run },
    })
    const [shownToast] = shown.values()
    expect(shownToast).toMatchObject({
      title: 'The engine restarted.',
      description: 'Everything on screen was reloaded.',
      variant: 'error',
      actions: [{ children: 'Reload', variant: 'secondary', size: 'sm' }],
    })
    shownToast?.actions?.[0]?.onClick()
    expect(run).toHaveBeenCalledTimes(1)
    toast({ key: 'plain', title: 'Saved' })
    expect([...shown.values()].at(-1)?.variant).toBe('default')
  })
})
