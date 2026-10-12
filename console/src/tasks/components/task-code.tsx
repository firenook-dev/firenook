// The inspector footer's Code (TK-24): the task the console holds, as the
// Admin SDK's enqueue and as curl to the Tasks port, with its real body,
// headers and name. Not on a draft: code that prints back what was just
// typed earns nothing (SKILL "Copy as code earns its place").

import { Button, Popover, Text } from '@cloudflare/kumo'
import { CodeIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksTaskDetail } from '@/api/generated/messaging/TasksTaskDetail'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { useInspectorRoom } from '@/components/console/inspector'
import { describeAddress, serviceAddress } from '@/components/console/request/address'
import { TASK_CODE_DIALECTS, type TaskCodeDialect, taskAsCode } from '../code'

export function TaskCode({ queue, detail }: { queue: TasksQueue; detail: TasksTaskDetail }) {
  const [open, setOpen] = useState(false)
  const [dialect, setDialect] = useState<TaskCodeDialect>('admin-node')
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
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          labels ? (
            <Button variant="ghost" size="sm" icon={<CodeIcon />} data-testid="task-code">
              Code
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CodeIcon />}
              aria-label="Code"
              data-testid="task-code"
            />
          )
        }
      />
      <Popover.Content className="w-[600px] max-w-[calc(100vw-2rem)]" side="top" align="start">
        <div className="grid gap-2" data-testid="task-code-popover">
          <CodeBlock
            label="This task as code"
            value={dialect}
            onValueChange={(id) => setDialect(id as TaskCodeDialect)}
            dialects={TASK_CODE_DIALECTS.map((item) => ({
              id: item.id,
              label: item.label,
              code: taskAsCode(task, item.id, origin),
            }))}
            testId="task-code-block"
          />
          {address && (
            <Text size="xs" variant="secondary">
              Sent to the Tasks port at {describeAddress(address)}, not the console.
            </Text>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}
