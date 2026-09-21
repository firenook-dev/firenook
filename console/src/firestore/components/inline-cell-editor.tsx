// Double-click a scalar cell and type: Enter writes just that field with a
// mask, Escape gives up, leaving commits. The stored type is kept (a string
// that looks like a number stays a string); a field with no type yet takes
// the type its text implies.

import { useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { commit, documentRoot, quoteFieldSegment } from '../rest'
import {
  type FirestoreValueType,
  type FsDocument,
  type FsValue,
  editorText,
  encodeValue,
  parseEditorText,
} from '../value'
import { useWorkbench } from './workbench-context'

/** The types a grid cell edits in place; the rest need the inspector. */
export const INLINE_TYPES: ReadonlySet<FirestoreValueType> = new Set([
  'string',
  'number',
  'boolean',
  'timestamp',
  'null',
])

export function inlineEditable(value: FsValue | undefined): boolean {
  return value === undefined || INLINE_TYPES.has(value.type)
}

/** What plain text most plausibly is when no type is stored yet. */
export function inferScalar(text: string): FsValue {
  const trimmed = text.trim()
  if (trimmed === 'null') return { type: 'null' }
  if (trimmed === 'true' || trimmed === 'false')
    return { type: 'boolean', value: trimmed === 'true' }
  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed))
    return { type: 'number', value: Number(trimmed), integer: /^-?\d+$/.test(trimmed) }
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && !Number.isNaN(Date.parse(trimmed)))
    return { type: 'timestamp', value: new Date(trimmed).toISOString() }
  return { type: 'string', value: text }
}

export function InlineCellEditor({
  document,
  field,
  value,
  onDone,
}: {
  document: FsDocument
  field: string
  value: FsValue | undefined
  onDone: () => void
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const initial = value ? editorText(value) : ''
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | undefined>()
  const inputRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const save = useMutation({
    mutationFn: async () => {
      // An untyped (unset or null) field takes the type its text implies.
      const parsed =
        value && value.type !== 'null'
          ? parseEditorText(value.type, text)
          : { ok: true as const, value: inferScalar(text) }
      if (!parsed.ok) throw new Error(parsed.error)
      await commit(workbench.scope, [
        {
          update: {
            path: document.path,
            fields: { [field]: encodeValue(parsed.value, documentRoot(workbench.scope)) },
            mask: [quoteFieldSegment(field)],
            exists: true,
          },
        },
      ])
    },
    onSuccess: () => {
      finished.current = true
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
      onDone()
    },
    onError: (failure) => {
      setError(failure.message)
      toasts.add({ title: 'Not saved', description: failure.message, variant: 'error' })
      inputRef.current?.focus()
    },
  })

  const finish = () => {
    if (finished.current || save.isPending) return
    if (text === initial) {
      finished.current = true
      onDone()
      return
    }
    save.mutate()
  }
  const cancel = () => {
    finished.current = true
    onDone()
  }

  const mono = !value || value.type !== 'string'
  return (
    <input
      ref={inputRef}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        setError(undefined)
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          finish()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
      onBlur={finish}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      spellCheck={false}
      title={error}
      className={`h-7 w-full rounded-md bg-kumo-control px-1.5 text-kumo-default ring outline-none ${
        mono ? 'font-mono text-[12px]' : ''
      } ${error ? 'ring-kumo-danger' : 'ring-kumo-focus'}`}
      aria-label={`${field} of ${document.id}`}
      data-testid="inline-cell-editor"
    />
  )
}
