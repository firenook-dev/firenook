// Test a message against the schema (S17, PS-53): JSON or bytes, checked as
// it is typed against the latest revision or one chosen, with the path that
// fails and what a publish to a topic bound to it would answer — the
// engine's own checker, so the console and a publish cannot disagree. Fill
// example asks the engine for a message of the revision and checks it too.

import { Button, Select, Tabs, Text, Tooltip } from '@cloudflare/kumo'
import { CheckCircleIcon, MagicWandIcon, WarningIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { PubsubMessageCheckBody } from '@/api/generated/messaging/PubsubMessageCheckBody'
import type { PubsubSchemaDetail } from '@/api/generated/messaging/PubsubSchemaDetail'
import { CodeEditor } from '@/components/code-editor'
import { Inspector, InspectorFooter } from '@/components/console/inspector'
import { Kbd, PanelTitle } from '@/components/kit'
import { describeKey, useShortcuts } from '@/lib/shortcuts'
import { errorText } from '@/messaging/confirm-popover'
import { schemaExample } from '../api'
import { messageCheckQuery } from '../queries'
import { revisionLabel } from './schema-text'

type Encoding = 'JSON' | 'BINARY'

/** The check's request for what is typed, against the latest or a chosen revision. */
export function messageCheckBody(
  schema: string,
  revision: string | undefined,
  encoding: Encoding,
  text: string,
): PubsubMessageCheckBody {
  return {
    schema: revision ? `${schema}@${revision}` : schema,
    encoding,
    data: encoding === 'JSON' ? { json: text } : { base64: text.trim() },
  }
}

export function TestMessage({
  project,
  detail,
  onClose,
}: {
  project: string
  detail: PubsubSchemaDetail
  onClose: () => void
}) {
  const [encoding, setEncoding] = useState<Encoding>('JSON')
  const [text, setText] = useState('')
  const [revision, setRevision] = useState<string | undefined>(undefined)
  // Checked once the text settles, or at once on Check (⌘↵).
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text), 300)
    return () => window.clearTimeout(timer)
  }, [text])
  const known = revision !== undefined && detail.revisions.some((item) => item.id === revision)
  const chosen = known ? revision : undefined
  const body = messageCheckBody(detail.name, chosen, encoding, settled)
  const check = useQuery({
    ...messageCheckQuery(project, body),
    enabled: settled.trim() !== '',
  })
  const result = settled === text && settled.trim() !== '' ? check.data : undefined
  const example = useMutation({
    mutationFn: () => schemaExample({ schema: chosen ? `${detail.name}@${chosen}` : detail.name }),
    onSuccess: (answer) => {
      if (answer.json === null) return
      setEncoding('JSON')
      setText(answer.json)
      setSettled(answer.json)
    },
  })
  const checkNow = () => setSettled(text)
  useShortcuts({ id: 'pubsub-schema-test', label: 'Test message' }, [
    {
      key: 'Mod+Enter',
      label: 'Check the message',
      allowInInputs: true,
      run: checkNow,
    },
  ])

  return (
    <Inspector
      widthKey="pubsub.schema-test"
      title={<PanelTitle>Test message</PanelTitle>}
      onClose={onClose}
      closeLabel="Close the test"
      footer={
        <InspectorFooter
          tools={
            <Tooltip
              content="A message of this revision, built by the engine from its definition"
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<MagicWandIcon />}
                  loading={example.isPending}
                  onClick={() => example.mutate()}
                  data-testid="schema-test-example"
                >
                  Fill example
                </Button>
              }
            />
          }
          primary={
            <Tooltip
              content={
                <span className="flex items-center gap-1.5">
                  Check it now <Kbd>{describeKey('Mod+Enter')}</Kbd>
                </span>
              }
              render={
                <Button
                  variant={text.trim() === '' ? 'secondary' : 'primary'}
                  size="sm"
                  disabled={text.trim() === ''}
                  onClick={checkNow}
                  data-testid="schema-test-check"
                >
                  Check
                </Button>
              }
            />
          }
        />
      }
      testId="pubsub-schema-test"
    >
      <div className="grid gap-3 px-5 py-3">
        <div className="flex items-center gap-2">
          <Tabs
            variant="segmented"
            size="sm"
            value={encoding}
            onValueChange={(next) => setEncoding(next as Encoding)}
            tabs={[
              { value: 'JSON', label: 'JSON' },
              { value: 'BINARY', label: 'Binary (base64)' },
            ]}
          />
          <Select
            size="xs"
            value={chosen ?? 'latest'}
            onValueChange={(next) =>
              setRevision(String(next) === 'latest' ? undefined : String(next))
            }
            aria-label="Revision"
            className="ml-auto h-6.5 w-36"
            renderValue={() => (
              <span className="font-mono text-[12px]">
                {chosen ? revisionLabel(chosen) : 'latest'}
              </span>
            )}
          >
            <Select.Option value="latest">
              <span className="text-[12px]">latest</span>
            </Select.Option>
            {detail.revisions.toReversed().map((item) => (
              <Select.Option key={item.id} value={item.id}>
                <span className="font-mono text-[12px]">{revisionLabel(item.id)}</span>
              </Select.Option>
            ))}
          </Select>
        </div>
        {encoding === 'JSON' ? (
          <div className="flex h-56 min-h-0 flex-col overflow-hidden rounded-md ring ring-kumo-line">
            <CodeEditor
              value={text}
              onChange={setText}
              language="json"
              ariaLabel="Message to test"
              testId="schema-test-data"
            />
          </div>
        ) : (
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            placeholder="The message's bytes, in base64"
            aria-label="Message to test, base64"
            className="h-40 w-full resize-y rounded-md bg-kumo-control p-2 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line outline-none placeholder:text-kumo-inactive focus:ring-kumo-focus"
            data-testid="schema-test-base64"
          />
        )}
        <div className="grid gap-1" role="status" data-testid="schema-test-result">
          {example.isError && (
            <Text variant="error" size="sm">
              {errorText(example.error)}
            </Text>
          )}
          {example.data?.problem && (
            <Text variant="error" size="sm">
              {example.data.problem}
            </Text>
          )}
          {check.isError && settled === text ? (
            <Text variant="error" size="sm">
              {errorText(check.error)}
            </Text>
          ) : result === undefined ? (
            <p className="m-0 text-[13px] text-kumo-subtle">
              {text.trim() === ''
                ? `Write a message, or fill an example, to check it against ${chosen ? `revision ${revisionLabel(chosen)}` : 'the latest revision'}.`
                : 'Checking…'}
            </p>
          ) : result.ok ? (
            <p
              className="m-0 flex items-center gap-1.5 text-[13px] text-kumo-default"
              data-testid="schema-test-valid"
            >
              <CheckCircleIcon size={14} className="text-kumo-success" />
              Valid against {chosen ? `revision ${revisionLabel(chosen)}` : 'the latest revision'}
            </p>
          ) : (
            <>
              <p
                className="m-0 flex items-start gap-1.5 font-mono text-[12px] text-kumo-danger"
                data-testid="schema-test-problem"
              >
                <WarningIcon size={14} className="mt-0.5 shrink-0" />
                {result.problem
                  ? `${result.problem.path}: expected ${result.problem.expected}, found ${result.problem.found}`
                  : (result.engineMessage ?? 'The message does not match.')}
              </p>
              {result.engineMessage && (
                <p className="m-0 text-[12px] text-kumo-subtle" data-testid="schema-test-engine">
                  A publish would answer: {result.engineMessage}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Inspector>
  )
}
