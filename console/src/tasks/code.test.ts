import { describe, expect, it } from 'vitest'
import { type TaskForCode, quoteShell, taskAsCode } from './code'
import { testDetail, testQueue } from './fixtures.test-support'

const ORIGIN = 'http://127.0.0.1:9499'

/** Base64 of a string's UTF-8 bytes, written independently of the code under test. */
const b64 = (text: string) =>
  btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''))

function taskFor(detail = testDetail()): TaskForCode {
  return {
    queue: testQueue(),
    task: detail.task,
    headers: detail.headers,
    body: detail.body,
    data: detail.data,
  }
}

describe('a task as code (U-14)', () => {
  it('writes the Admin SDK enqueue with its id, headers and data', () => {
    expect(taskAsCode(taskFor(), 'admin-node', ORIGIN)).toBe(
      [
        "import { initializeApp } from 'firebase-admin/app'",
        "import { getFunctions } from 'firebase-admin/functions'",
        '',
        '// The Admin SDK enqueues into this emulator when run with',
        '// CLOUD_TASKS_EMULATOR_HOST=127.0.0.1:9499 (functions in it have it already).',
        "initializeApp({ projectId: 'demo-console' })",
        '',
        'await getFunctions()',
        "  .taskQueue('locations/us-central1/functions/processOrder')",
        '  .enqueue({',
        '    "orderId": "o_20251",',
        '    "fail": true',
        '  }, {',
        "    id: 'order-1',",
        '    headers: {',
        "      'x-synthetic-header': 'console',",
        '    },',
        '  })',
        '',
        '// The emulator keeps every task name until it stops: leave id out, or change it,',
        '// to send this again in the same run.',
      ].join('\n'),
    )
  })

  it('leaves out what the Admin SDK fills in, and adds a deadline, a schedule time and a URL that differ', () => {
    const detail = testDetail()
    const code = taskAsCode(
      {
        ...taskFor(detail),
        task: {
          ...detail.task,
          generated: true,
          shortName: '4503599627378812',
          deadlineSeconds: 120,
          scheduleTime: '2026-10-12T11:00:00.000Z',
          url: 'http://127.0.0.1:8080/hook',
        },
        headers: [{ name: 'Content-Type', value: 'application/json' }],
      },
      'admin-node',
      ORIGIN,
    )
    expect(code).not.toContain('id:')
    expect(code).not.toContain('headers:')
    expect(code).toContain("scheduleTime: new Date('2026-10-12T11:00:00.000Z'),")
    expect(code).toContain('dispatchDeadlineSeconds: 120,')
    expect(code).toContain("uri: 'http://127.0.0.1:8080/hook',")
    expect(code).not.toContain('keeps every task name')
  })

  it('says the Admin SDK cannot send a raw body as it is', () => {
    const code = taskAsCode(
      taskFor(testDetail({ data: null, body: '{"plain":true}' })),
      'admin-node',
      ORIGIN,
    )
    expect(code).toContain('use curl to send the body exactly as it is')
  })

  it('writes curl to the Tasks port with the body base64, as it travels', () => {
    const code = taskAsCode(taskFor(), 'curl', ORIGIN)
    const body = b64('{"data":{"orderId":"o_20251","fail":true}}')
    expect(code.split('\n').slice(0, 3)).toEqual([
      "curl -X POST 'http://127.0.0.1:9499/projects/demo-console/locations/us-central1/queues/processOrder/tasks' \\",
      "  -H 'Content-Type: application/json' \\",
      `  -d '{"task":{"name":"projects/demo-console/locations/us-central1/queues/processOrder/tasks/order-1","httpRequest":{"url":"","headers":{"Content-Type":"application/json","x-synthetic-header":"console"},"body":"${body}"}}}'`,
    ])
    expect(code).toContain('remove "name" to send this')
  })

  it('quotes for the shell and for JavaScript', () => {
    expect(quoteShell("it's")).toBe("'it'\\''s'")
    const detail = testDetail({
      headers: [{ name: 'x-note', value: "it's\nhere" }],
    })
    expect(taskAsCode(taskFor(detail), 'admin-node', ORIGIN)).toContain(
      "'x-note': 'it\\'s\\nhere',",
    )
  })
})
