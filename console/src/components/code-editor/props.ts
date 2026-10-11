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

/** A whole line lit for a reason: the rule that decided a request, or the line being shown. */
export interface CodeLineMark {
  /** One-based. */
  line: number
  tone: 'allow' | 'deny' | 'error' | 'focus'
}

/**
 * A value an expression had, written after it the way a debugger does —
 * `request.auth.uid ⟨null⟩ == uid ⟨"u_k65eq"⟩`. Offsets are into the
 * document as it is now.
 */
export interface CodeInlineValue {
  from: number
  to: number
  value: string
  /** The expression raised rather than produced a value. */
  error?: boolean | undefined
}

/** A note in the gutter beside a line: how often a rule ran, or that it never did. */
export interface CodeGutterNote {
  line: number
  text: string
  tone: 'hit' | 'miss'
  title?: string | undefined
}

export interface CodeEditorProps {
  value: string
  onChange: (next: string) => void
  /** The language the text is written in. JSON unless told otherwise. */
  language?: 'json' | 'rules' | undefined
  /**
   * For rules: what completion can offer beyond the language itself —
   * the fields documents of a collection carry, the custom claims users
   * have.
   */
  rulesCompletion?:
    | {
        fields?: (pattern: string) => readonly string[] | Promise<readonly string[]>
        claims?: () => readonly string[]
      }
    | undefined
  /**
   * Marks found outside the editor — the engine's compiler and its
   * checks — for the text as it is now. Shown like the editor's own.
   */
  marks?: readonly CodeMark[] | undefined
  lineMarks?: readonly CodeLineMark[] | undefined
  inlineValues?: readonly CodeInlineValue[] | undefined
  gutterNotes?: readonly CodeGutterNote[] | undefined
  /**
   * Bring a line into view and put the caret on it. A new object each
   * time, so asking for the same line twice moves there twice.
   */
  reveal?: { line: number } | undefined
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
  /**
   * Take the keyboard on arrival. For an editor that was opened to type
   * in, like the grid's own, where the alternative is a click to start.
   */
  autoFocus?: boolean | undefined
  ariaLabel?: string | undefined
  /** Put on the element that holds the text, which is what a test types into. */
  testId?: string | undefined
}
