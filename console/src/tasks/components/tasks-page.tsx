// The Cloud Tasks page (messaging spec §3.12, S20…S23): the project's
// queues in the panel, the queue picked on the right — or every queue in
// one table when none is — and the Enqueue dialog over both. The queue list
// is the page's source for every queue's configuration and figures, kept
// current by `tasks.counters`; a link's queue id is resolved against it,
// and a link that says more than it needs is tidied in place.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { statusQuery } from '@/api/queries'
import { QueryError, TableSkeleton } from '@/components/console/empty-state'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { SectionToolbar, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { useConsoleProject } from '@/lib/project'
import { useShortcuts } from '@/lib/shortcuts'
import { useTasksCounters } from '../live'
import { useTasksPalette } from '../palette'
import { queuesQuery } from '../queries'
import { queueAddress, resolveQueue, tidyAddress } from '../queue-address'
import { useTasksSearch } from '../search'
import { EnqueueDialog } from './enqueue-dialog'
import { QueueView } from './queue-view'
import { QueuesLanding } from './queues-landing'
import { QueuesPanel } from './queues-panel'

const EMPTY: readonly TasksQueue[] = []

function Loading() {
  return (
    <>
      <SectionToolbar>
        <ToolbarRow testId="tasks-toolbar">
          <PanelToggle where="toolbar" />
        </ToolbarRow>
      </SectionToolbar>
      <SectionBody>
        <TableSkeleton
          columns={[{ width: 200 }, { width: 110 }, { width: 84 }, { width: 84 }, { width: 200 }]}
        />
      </SectionBody>
    </>
  )
}

export function TasksPage() {
  const { search, update } = useTasksSearch()
  const { project } = useConsoleProject()
  const status = useQuery(statusQuery)
  const configured = status.data?.projectId
  useTasksCounters(project === '' ? undefined : project)
  const queues = useQuery(queuesQuery(project))
  const list = queues.data
  const items = list?.items ?? EMPTY
  const resolved = resolveQueue(items, search)
  const queue = resolved.queue

  // A link names its location and project in full (a registry cannot know
  // either); once the list is known, the address is cut to what it needs.
  const latest = useRef(update)
  useEffect(() => {
    latest.current = update
  })
  useEffect(() => {
    if (!list) return
    const patch = tidyAddress({
      queues: list.items,
      search: { project: search.project, queue: search.queue, location: search.location },
      configured,
    })
    if (patch) latest.current(patch, { replace: true })
  }, [list, search.project, search.queue, search.location, configured])

  const openQueue = (next: TasksQueue) =>
    update({
      ...queueAddress(items, next),
      task: undefined,
      tab: undefined,
      state: undefined,
      outcome: undefined,
      q: undefined,
      prefill: undefined,
    })

  // Every queue to open from ⌘K; the queue in view adds its own commands.
  useTasksPalette({ queues: items, queue, commands: undefined, open: openQueue, key: 'tasks' })

  useShortcuts({ id: 'tasks', label: 'Cloud Tasks' }, [
    {
      key: 'n',
      label: 'Enqueue a task',
      when: () => queue === undefined && items.length > 0,
      run: () => update({ new: 'task' }),
    },
  ])

  return (
    <SectionPage section="tasks" title="Cloud Tasks" testId="tasks-page">
      <QueuesPanel
        list={list}
        current={queue?.key}
        project={project}
        configured={configured}
        onOpen={openQueue}
        onOpenRoot={() =>
          update({
            queue: undefined,
            location: undefined,
            task: undefined,
            view: undefined,
            tab: undefined,
          })
        }
        onProject={(next) =>
          update({
            project: next === configured ? undefined : next,
            queue: undefined,
            location: undefined,
            task: undefined,
            tab: undefined,
            view: undefined,
          })
        }
      />
      {queues.isError ? (
        <>
          <SectionToolbar>
            <ToolbarRow testId="tasks-toolbar">
              <PanelToggle where="toolbar" />
            </ToolbarRow>
          </SectionToolbar>
          <SectionBody>
            <QueryError
              error={queues.error}
              onRetry={() => void queues.refetch()}
              section="tasks"
            />
          </SectionBody>
        </>
      ) : !list ? (
        <Loading />
      ) : queue ? (
        <QueueView
          key={queue.key}
          queue={queue}
          list={list}
          project={project}
          onOpenQueue={openQueue}
        />
      ) : (
        <QueuesLanding
          list={list}
          missing={resolved.missing ? search.queue : undefined}
          onOpen={openQueue}
          onEnqueue={() => update({ new: 'task' })}
          project={project}
        />
      )}
      <EnqueueDialog
        open={search.new === 'task' && list !== undefined}
        onOpenChange={(open) => {
          if (!open) update({ new: undefined, prefill: undefined }, { replace: true })
        }}
        queues={items}
        queue={queue}
        project={project}
        prefill={search.prefill}
        onEnqueued={(row, into) =>
          update({
            ...queueAddress(items, into),
            new: undefined,
            prefill: undefined,
            task: row.id,
            tab: undefined,
            ...(search.view === 'config' || into.key !== queue?.key ? { view: undefined } : {}),
            state: undefined,
          })
        }
        onShowConfig={(into) =>
          update({
            ...queueAddress(items, into),
            new: undefined,
            prefill: undefined,
            view: 'config',
            task: undefined,
          })
        }
      />
    </SectionPage>
  )
}
