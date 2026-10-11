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
 * Every control of a row that is not its value, in one strip, drawn over the
 * end of the line when the line is pointed at. A document of fourteen fields
 * had eighty-six buttons on screen at once, and the loudest repeated one was
 * the delete nobody was reaching for.
 *
 * It overlays rather than reserves. Keeping its place cost ninety-three of a
 * line's four hundred and five pixels — a quarter of every row, held open at
 * rest for buttons that are not drawn at rest — and that was the width a
 * timestamp was being truncated by.
 *
 * It answers to the line, not the row, because a row contains its children:
 * pointing at an entry of a map used to arm the map's controls as well. And
 * it stays down while a value has focus, so it never lands on the text being
 * typed; `focus-within` is its own, so a Tab into the strip still shows it.
 *
 * It floats: its own ground, a hairline and a shadow, rather than the line's
 * ground borrowed. While values wore nothing, borrowing was invisible. Now
 * that one wears a box, a strip in the line's own tint cut a notch out of
 * the end of that box and read as damage rather than as something laid over
 * it. A thing that occludes has to look like a thing.
 *
 * It takes the height of one line and sits at the top of the row, so on a
 * value that wrapped to three it is still beside the first of them.
 */
export const ACCESSORY =
  'pointer-events-none absolute top-0.5 right-1 flex h-7 items-center gap-1 rounded-md bg-kumo-base px-1 opacity-0 shadow-sm ring ring-kumo-line group-hover/line:pointer-events-auto group-hover/line:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100'

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
