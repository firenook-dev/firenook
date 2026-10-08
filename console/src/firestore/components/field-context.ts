// What every row of the field tree shares. A map five levels down needs no
// props threaded down to it: what is wrong with the document, the fields the
// rest of the collection uses, where focus is headed next, and how to peek
// at a reference.

import { createContext, useContext, useEffect, useRef } from 'react'
import type { NodeProblem } from '../draft'
import type { FirestoreValueType } from '../value'

/** A field the loaded documents of this collection already use. */
export interface KnownField {
  field: string
  /** The type most of them give it. */
  type: FirestoreValueType
  /** How many of them carry it. */
  present: number
}

/**
 * A control that is not the value: present, keeping its place in the row,
 * but not drawn until the row is pointed at or something in it has focus.
 * A document of fourteen fields had eighty-six buttons on screen at once,
 * and the loudest repeated one was the delete nobody was reaching for.
 */
export const ACCESSORY =
  'shrink-0 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100'

export interface FieldEditing {
  problems: Map<string, NodeProblem>
  known: readonly KnownField[]
  /** Top-level fields the next Save will write, so the panel can say which. */
  changed: ReadonlySet<string>
  /** The node whose editor should take focus, once. */
  focus: string | undefined
  takeFocus: (id: string | undefined) => void
  /** Leave this value and start another field. */
  next: () => void
  onOpenReference: (path: string) => void
}

const FieldEditingContext = createContext<FieldEditing | null>(null)
export const FieldEditingProvider = FieldEditingContext.Provider

export function useFieldEditing(): FieldEditing {
  const value = useContext(FieldEditingContext)
  if (!value) throw new Error('A field row needs a FieldEditingProvider')
  return value
}

/**
 * The editor a newly added field hands focus to. Adding a field and typing
 * its value is one move, so the value is already waiting for the keyboard.
 */
export function useFocusTarget<T extends HTMLInputElement | HTMLTextAreaElement>(id: string) {
  const { focus, takeFocus } = useFieldEditing()
  const ref = useRef<T>(null)
  useEffect(() => {
    if (focus !== id) return
    ref.current?.focus()
    ref.current?.select()
    takeFocus(undefined)
  }, [focus, id, takeFocus])
  return ref
}
