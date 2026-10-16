// The inspector footer's Code (TK-24): the task the console holds, as the
// Admin SDK's enqueue and as curl to the Tasks port, with its real body,
// headers and name. Not on a draft: code that prints back what was just
// typed earns nothing (SKILL "Copy as code earns its place").

import { useQuery } from '@tanstack/react-query'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksTaskDetail } from '@/api/generated/messaging/TasksTaskDetail'
import { statusQuery } from '@/api/queries'
import { CodePopover } from '@/components/console/code-popover'
import { useInspectorRoom } from '@/components/console/inspector'
import { describeAddress, serviceAddress } from '@/components/console/request/address'
import { codeTab } from '@/components/console/request/as-code'
import { TASK_CODE_DIALECTS, taskAsCode } from '../code'

export function TaskCode({ queue, detail }: { queue: TasksQueue; detail: TasksTaskDetail }) {
  const { labels } = useInspectorRoom()
  const status = useQuery(statusQuery)
  const address = serviceAddress('tasks', status.data)
  const origin = address?.origin ?? 'http://127.0.0.1:9499'
  const task = {
    queue,
    task: detail.task,
    headers: detail.headers,
    body: detail.body,
    data: detail.data,
  }
  return (
    <CodePopover
      title="This task as code"
      kind="tasks.task"
      tabs={TASK_CODE_DIALECTS.map((dialect) =>
        codeTab(dialect, taskAsCode(task, dialect, origin)),
      )}
      note={
        address
          ? `Sent to the Tasks port at ${describeAddress(address)}, not the console.`
          : undefined
      }
      label={labels}
      width={600}
      testId="task-code"
    />
  )
}
