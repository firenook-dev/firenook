// How tasks come to be, for an empty Cloud Tasks page, with this engine's
// own Tasks address (`lib/connect.ts` and `serviceAddress`, never typed by
// hand). With no queue at all: the function export that registers one, the
// Admin SDK call that enqueues into it, and the environment a client
// outside the emulator needs. For a queue with nothing in it yet: the Admin
// SDK call and curl that enqueue into that queue, and the environment.

import { useQuery } from '@tanstack/react-query'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { serviceAddress } from '@/components/console/request/address'
import { connectSnippet } from '@/lib/connect'
import { quoteShell } from '../code'
import { base64Utf8 } from '../payload'

export function TasksConnect({ queue }: { queue?: TasksQueue | undefined }) {
  const status = useQuery(statusQuery)
  if (!status.data) return null
  const env = connectSnippet('env', { services: ['tasks'], status: status.data })
  const address = serviceAddress('tasks', status.data)
  const host = address?.origin.replace(/^https?:\/\//, '') ?? '<host:port>'
  const target = queue ? `locations/${queue.location}/functions/${queue.id}` : 'processOrder'
  const admin = {
    id: 'admin-node',
    label: 'Admin SDK',
    code: [
      "import { getFunctions } from 'firebase-admin/functions'",
      '',
      '// Functions running in this emulator reach it already; a script outside it',
      `// needs CLOUD_TASKS_EMULATOR_HOST=${host}.`,
      'await getFunctions()',
      `  .taskQueue('${target}')`,
      "  .enqueue({ orderId: 'o_1' })",
    ].join('\n'),
  }
  const environment = { id: 'env', label: 'Environment', code: env }
  if (queue) {
    const path = `projects/${queue.project}/locations/${queue.location}/queues/${queue.id}`
    const body = base64Utf8(JSON.stringify({ data: { orderId: 'o_1' } }))
    const curl = {
      id: 'curl',
      label: 'curl',
      code: [
        `curl -X POST ${quoteShell(`${address?.origin ?? `http://${host}`}/${path}/tasks`)} \\`,
        "  -H 'Content-Type: application/json' \\",
        `  -d '{"task":{"httpRequest":{"body":"${body}"}}}'`,
      ].join('\n'),
    }
    return (
      <div className="w-full text-left">
        <CodeBlock
          label={`Enqueue into ${queue.id}`}
          dialects={[admin, curl, environment]}
          testId="tasks-connect"
        />
      </div>
    )
  }
  return (
    <div className="w-full text-left">
      <CodeBlock
        label="From your code"
        dialects={[
          {
            id: 'function',
            label: 'onTaskDispatched',
            code: [
              "const { onTaskDispatched } = require('firebase-functions/v2/tasks')",
              '',
              '// Each export registers a queue named after it when the emulator loads it.',
              'exports.processOrder = onTaskDispatched(',
              '  { retryConfig: { maxAttempts: 3 }, rateLimits: { maxConcurrentDispatches: 2 } },',
              '  async (req) => {',
              '    console.log(req.data)',
              '  },',
              ')',
            ].join('\n'),
          },
          admin,
          environment,
        ]}
        testId="tasks-connect"
      />
    </div>
  )
}
