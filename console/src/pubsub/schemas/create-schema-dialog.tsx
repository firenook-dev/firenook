// New schema (S18, PS-51, PS-56): the id checked as it is typed with the
// engine's own rule, the type (Avro; Protocol Buffer offered and disabled,
// with the reason), a template to start from, and the definition checked
// as it is typed by the engine's parser — its reason in the text where it
// can be placed — with a message of that shape beside it once it parses.

import { Button, Dialog, DropdownMenu, Input, Select, Text } from '@cloudflare/kumo'
import { CaretDownIcon, CheckCircleIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CodeEditor } from '@/components/code-editor'
import { errorText } from '@/messaging/confirm-popover'
import { createSchema } from '../api'
import { useGeneration } from '../components/create-topic-dialog'
import { fullName, idProblem } from '../names'
import { pubsubKeys, schemaExampleQuery } from '../queries'
import { useDefinitionCheck, useSettled } from './schema-editor'
import { SCHEMA_TEMPLATES, checkLine, checkMarks } from './schema-text'

/** Why the second type cannot be chosen, in the engine's terms. */
export const PROTOBUF_REASON =
  'The emulator does not run Protocol Buffer schemas (the official one does not either).'

/** JSON on one line, for a preview; the text as it is when it is not JSON. */
export function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text
  }
}

export function CreateSchemaDialog({
  open,
  project,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  project: string
  onOpenChange: (open: boolean) => void
  onCreated: (name: string) => void
}) {
  const generation = useGeneration(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <CreateSchemaForm
          key={generation}
          project={project}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateSchemaForm({
  project,
  onClose,
  onCreated,
}: {
  project: string
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const queryClient = useQueryClient()
  const [id, setId] = useState('')
  const [touched, setTouched] = useState(false)
  const [definition, setDefinition] = useState(SCHEMA_TEMPLATES[0]?.definition ?? '')
  const problem = idProblem(id)
  const { check } = useDefinitionCheck(project, 'AVRO', definition)
  const marks = checkMarks(definition, check)
  const reason = checkLine(check)
  // A message of the definition's shape, once it parses: what a publish would carry.
  const settled = useSettled(definition)
  const example = useQuery({
    ...schemaExampleQuery(project, { definition: settled }),
    enabled: check?.ok === true && settled === definition,
  })
  const valid = !problem && check?.ok === true

  const create = useMutation({
    mutationFn: () =>
      createSchema({ name: fullName(project, 'schemas', id), kind: 'AVRO', definition }),
    onSuccess: (detail) => {
      queryClient.setQueryData(pubsubKeys.schema(project, detail.name), detail)
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.schemas(project) })
      onClose()
      onCreated(detail.name)
    },
  })

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (valid) create.mutate()
      }}
      data-testid="create-schema"
    >
      <div className="flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">New schema</Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="-mt-2 text-kumo-subtle">
        A topic bound to a schema refuses every message that does not match it, as production does.
      </Dialog.Description>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
        <label className="grid gap-1">
          <Text variant="secondary" size="sm" as="span">
            Schema id
          </Text>
          <Input
            size="sm"
            value={id}
            onChange={(event) => {
              setId(event.target.value)
              setTouched(true)
            }}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="order-event"
            variant={touched && problem ? 'error' : 'default'}
            className="w-full font-mono"
            aria-invalid={touched && problem ? true : undefined}
            data-testid="create-schema-id"
          />
          {touched && problem ? (
            <span className="text-[12px] text-kumo-danger" data-testid="create-schema-id-error">
              {problem}
            </span>
          ) : (
            <span className="truncate font-mono text-[12px] text-kumo-subtle">
              {fullName(project, 'schemas', id || '…')}
            </span>
          )}
        </label>
        <div className="grid gap-1">
          <Text variant="secondary" size="sm" as="span">
            Type
          </Text>
          <Select
            size="sm"
            value="AVRO"
            onValueChange={() => {}}
            aria-label="Type"
            className="w-44"
            renderValue={() => 'Avro'}
            data-testid="create-schema-type"
          >
            <Select.Option value="AVRO">Avro</Select.Option>
            <Select.Option value="PROTOCOL_BUFFER" disabled>
              <span
                className="grid gap-0.5"
                title={PROTOBUF_REASON}
                data-testid="create-schema-protobuf"
              >
                <span>Protocol Buffer</span>
                <span className="text-[11px] text-kumo-subtle">{PROTOBUF_REASON}</span>
              </span>
            </Select.Option>
          </Select>
        </div>
      </div>
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <Text variant="secondary" size="sm" as="span">
            Definition
          </Text>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  data-testid="create-schema-template"
                >
                  <span className="flex items-center gap-1">
                    Template
                    <CaretDownIcon size={11} />
                  </span>
                </Button>
              }
            />
            <DropdownMenu.Content align="end">
              {SCHEMA_TEMPLATES.map((template) => (
                <DropdownMenu.Item
                  key={template.id}
                  onClick={() => setDefinition(template.definition)}
                  data-testid={`create-schema-template-${template.id}`}
                >
                  {template.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
        <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-md ring ring-kumo-line">
          <CodeEditor
            value={definition}
            onChange={setDefinition}
            language="json"
            marks={marks}
            ariaLabel="Schema definition"
            testId="create-schema-definition"
          />
        </div>
        <div className="min-h-5" role="status" data-testid="create-schema-check">
          {reason ? (
            <p className="m-0 flex items-start gap-1.5 font-mono text-[12px] text-kumo-danger">
              <WarningIcon size={13} className="mt-0.5 shrink-0" />
              {reason}
            </p>
          ) : check?.ok ? (
            <p className="m-0 flex min-w-0 items-center gap-1.5 text-[12px] text-kumo-subtle">
              <CheckCircleIcon size={13} className="shrink-0 text-kumo-success" />
              <span className="shrink-0">Valid Avro. A message of this shape:</span>
              <span
                className="min-w-0 truncate font-mono text-kumo-default"
                data-testid="create-schema-example"
              >
                {example.data?.json ? compactJson(example.data.json) : '…'}
              </span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          {create.isError && (
            <span className="text-[13px] text-kumo-danger" data-testid="create-schema-error">
              {errorText(create.error)}
            </span>
          )}
        </span>
        <Button variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={valid ? 'primary' : 'secondary'}
          type="submit"
          loading={create.isPending}
          data-testid="create-schema-submit"
        >
          Create
        </Button>
      </div>
    </form>
  )
}
