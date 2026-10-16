// A wrapped line continues under its own text, one indent step in: the
// rules files' long `allow … if` conditions wrapped back to column 0, where
// a continuation reads as a new statement at the far left, and at 1024 px
// most long lines did. Each line's padding takes it to its own indent plus
// a step, and a negative text indent brings its first row back where it
// was, so only the rows a wrap makes move. The editor's own `.cm-line`
// padding (8 px) is kept under the indent.

import { RangeSetBuilder, type Text } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

/** The line padding the editor's skin sets, px. */
const LINE_PADDING = 8

/** A line's leading whitespace as columns, a tab to the next tab stop. */
export function leadingColumns(text: string, tabSize: number): number {
  let columns = 0
  for (const character of text) {
    if (character === ' ') columns += 1
    else if (character === '\t') columns += tabSize - (columns % tabSize)
    else break
  }
  return columns
}

/** The style that hangs a line's continuations `columns + step` characters in. */
export function hangingStyle(columns: number, step: number): string {
  const hang = columns + step
  return `padding-left: calc(${LINE_PADDING}px + ${hang}ch); text-indent: -${hang}ch`
}

const cache = new Map<string, Decoration>()

function lineDecoration(style: string): Decoration {
  let decoration = cache.get(style)
  if (!decoration) {
    decoration = Decoration.line({ attributes: { style } })
    cache.set(style, decoration)
  }
  return decoration
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc: Text = view.state.doc
  const tabSize = view.state.tabSize
  const step = view.state.facet(indentUnit).length
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = doc.lineAt(position)
      builder.add(
        line.from,
        line.from,
        lineDecoration(hangingStyle(leadingColumns(line.text, tabSize), step)),
      )
      position = line.to + 1
    }
  }
  return builder.finish()
}

export const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
