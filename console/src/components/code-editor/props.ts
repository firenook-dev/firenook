// What the editor takes, apart from CodeMirror.
//
// Its own file so the lazy wrapper, and anything that writes an
// annotator, can name these types without importing the module that
// would pull CodeMirror into the importing chunk.

/**
 * A mark on a range of the text. The shape is CodeMirror's `Diagnostic`
 * narrowed to the fields we set, written here rather than imported so
 * that an annotator is a plain function over strings and numbers — one
 * that can be unit-tested without an editor or a DOM.
 */
export interface CodeMark {
  from: number
  to: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
}

export interface CodeEditorProps {
  value: string
  onChange: (next: string) => void
  /**
   * Marks beyond "this is not valid JSON", which the editor finds for
   * itself.
   */
  annotate?: ((text: string) => CodeMark[]) | undefined
  /**
   * Given text that was pasted over the whole document, the tidied
   * version of it, or `undefined` to leave it as pasted. Only a paste
   * that replaces everything is offered: re-indenting the document
   * around a fragment somebody dropped into the middle of it would
   * move text they did not touch.
   */
  tidyPaste?: ((text: string) => string | undefined) | undefined
  readOnly?: boolean | undefined
  ariaLabel?: string | undefined
  /** Put on the element that holds the text, which is what a test types into. */
  testId?: string | undefined
}
