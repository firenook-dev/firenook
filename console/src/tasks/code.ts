// A task the console holds, as code (TK-24): the Admin SDK's
// `taskQueue().enqueue()` and curl to the Tasks port, with the task's real
// body, headers and name — what you would write to send it again from a
// script or a test. The address is the Tasks port's own (`serviceAddress`),
// never the console's, so a console opened from another machine prints that
// machine's name.

import type { TasksHeader } from '@/api/generated/messaging/TasksHeader'
import { DEFAULT_DEADLINE, base64Utf8, callerHeaders } from './payload'

/** What the code is written from: a task's detail and its queue. */
export interface TaskForCode {
  queue: { project: string; location: string; id: string; defaultUri: string | null }
  task: {
    name: string
    shortName: string
    generated: boolean
    deadlineSeconds: number
    scheduleTime: string | null
    url: string | null
  }
  headers: readonly TasksHeader[]
  /** The decoded body. */
  body: string
  /** The `data` member as JSON text, when the body is the Admin SDK's shape. */
  data: string | null
}

/** The dialects a task is written in, by the console's one list (`CODE_DIALECTS`). */
export type TaskCodeDialect = 'node' | 'curl'

export const TASK_CODE_DIALECTS: readonly TaskCodeDialect[] = ['node', 'curl']

/** A JavaScript string literal in single quotes. */
function quoteJs(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

/** A shell word in single quotes (a quote inside closes, escapes and reopens). */
export function quoteShell(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** A JSON value as a JavaScript expression, indented to sit at `indent`. */
function jsValue(json: string, indent: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2).replaceAll('\n', `\n${indent}`)
  } catch {
    return quoteJs(json)
  }
}

/**
 * The lines that point the Admin SDK at the Tasks port (`host`, `host:port`)
 * and start it: it sets the variable itself, since without it a copied
 * script enqueues into Cloud Tasks; `??=` keeps one already set.
 */
function adminSetup(host: string, project: string): string[] {
  return [
    "import { initializeApp } from 'firebase-admin/app'",
    "import { getFunctions } from 'firebase-admin/functions'",
    '',
    '// The Admin SDK enqueues into this emulator while CLOUD_TASKS_EMULATOR_HOST is set',
    '// (functions in it have it already), and into Cloud Tasks itself without it.',
    `process.env.CLOUD_TASKS_EMULATOR_HOST ??= ${quoteJs(host)}`,
    `initializeApp({ projectId: ${quoteJs(project)} })`,
  ]
}

/** The Admin SDK call that enqueues one task into `target`, for an empty Tasks page. */
export function enqueueSnippet(target: string, host: string, project: string): string {
  return [
    ...adminSetup(host, project),
    '',
    'await getFunctions()',
    `  .taskQueue(${quoteJs(target)})`,
    "  .enqueue({ orderId: 'o_1' })",
  ].join('\n')
}

/** The Admin SDK's `enqueue(data, options)` for the task (§1.4's options, only those it needs). */
function adminNode(task: TaskForCode, host: string): string {
  const { queue } = task
  const lines: string[] = adminSetup(host, queue.project)
  if (task.data === null)
    lines.push(
      '',
      "// This task's body is not the Admin SDK's { data } shape, and enqueue() always",
      '// wraps what it is given in one; use curl to send the body exactly as it is.',
    )
  const options: string[] = []
  if (!task.task.generated) options.push(`id: ${quoteJs(task.task.shortName)}`)
  if (task.task.scheduleTime !== null)
    options.push(`scheduleTime: new Date(${quoteJs(task.task.scheduleTime)})`)
  if (task.task.deadlineSeconds !== DEFAULT_DEADLINE)
    options.push(`dispatchDeadlineSeconds: ${task.task.deadlineSeconds}`)
  const headers = callerHeaders(task.headers)
  if (headers.length > 0)
    options.push(
      `headers: {\n${headers.map((header) => `      ${quoteJs(header.name)}: ${quoteJs(header.value)},`).join('\n')}\n    }`,
    )
  if (task.task.url !== null && task.task.url !== '' && task.task.url !== queue.defaultUri)
    options.push(`uri: ${quoteJs(task.task.url)}`)
  const data = task.data === null ? jsValue(task.body, '  ') : jsValue(task.data, '  ')
  lines.push(
    '',
    'await getFunctions()',
    `  .taskQueue(${quoteJs(`locations/${queue.location}/functions/${queue.id}`)})`,
    options.length === 0
      ? `  .enqueue(${data})`
      : `  .enqueue(${data}, {\n${options.map((option) => `    ${option},`).join('\n')}\n  })`,
  )
  if (!task.task.generated)
    lines.push(
      '',
      '// The emulator keeps every task name until it stops: leave id out, or change it,',
      '// to send this again in the same run.',
    )
  return lines.join('\n')
}

/** curl to the Tasks port: the request the Admin SDK sends, body base64 as it travels. */
function curl(task: TaskForCode, origin: string): string {
  const { queue } = task
  const path = `projects/${queue.project}/locations/${queue.location}/queues/${queue.id}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  for (const header of callerHeaders(task.headers)) headers[header.name] = header.value
  const object: Record<string, unknown> = {
    ...(task.task.generated ? {} : { name: `${path}/tasks/${task.task.shortName}` }),
    ...(task.task.scheduleTime === null ? {} : { scheduleTime: task.task.scheduleTime }),
    ...(task.task.deadlineSeconds === DEFAULT_DEADLINE
      ? {}
      : { dispatchDeadline: `${task.task.deadlineSeconds}s` }),
    httpRequest: {
      url: task.task.url !== null && task.task.url !== queue.defaultUri ? task.task.url : '',
      headers,
      body: base64Utf8(task.body),
    },
  }
  const lines = [
    `curl -X POST ${quoteShell(`${origin}/${path}/tasks`)} \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d ${quoteShell(JSON.stringify({ task: object }))}`,
  ]
  if (!task.task.generated)
    lines.push(
      '',
      '# The emulator keeps every task name until it stops: remove "name" to send this',
      '# again in the same run (the emulator then generates one).',
    )
  return lines.join('\n')
}

/** The task as code in one dialect, against the Tasks port at `origin` (`http://host:port`). */
export function taskAsCode(task: TaskForCode, dialect: TaskCodeDialect, origin: string): string {
  if (dialect === 'curl') return curl(task, origin)
  return adminNode(task, origin.replace(/^https?:\/\//, ''))
}
