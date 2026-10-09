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
  readOnly?: boolean | undefined
  ariaLabel?: string | undefined
  /** Put on the element that holds the text, which is what a test types into. */
  testId?: string | undefined
}
