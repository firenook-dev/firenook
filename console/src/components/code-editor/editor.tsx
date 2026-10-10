// The code editor, on CodeMirror 6.
//
// This module is heavy — around 390 KB of JavaScript — and nothing imports
// it directly. It arrives through the `lazy()` in ./index, as its own
// chunk, the first time somebody opens a tab that writes code. Keep it
// that way: a static import from anywhere pulls CodeMirror into whatever
// chunk did the importing.
//
// The earlier answer here was a textarea, refused CodeMirror on the
// grounds that "the console's whole first-route budget is 300 KB". That
// budget counts the entry chunk and its static imports; the Firestore
// route is lazy and was never in it. The editor costs nothing the budget
// measures, and the console is served from the engine's own binary over
// the loopback, so the chunk is a memcpy rather than a download.

import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { type Diagnostic, lintGutter, linter } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import type { CodeEditorProps } from './props'

/**
 * The ink, from the syntax palette in `theme.css` — see the note there
 * for why three hues and which three.
 *
 * The rule this console holds everywhere else is that colour means
 * something or it is not spent, and the grid obeys it by refusing a
 * colour per type. Raw JSON is the exception that earns it: a field row
 * writes `string` beside the value, a line of JSON writes only `"269"`,
 * so here the ink is the only thing saying what a value is. The first
 * version of this file took the rule too far and left keys and strings
 * two shades of the same grey, which drew nothing at all.
 */
const INK = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--color-firenook-code-key)', fontWeight: '500' },
  { tag: tags.string, color: 'var(--color-firenook-code-string)' },
  { tag: tags.number, color: 'var(--color-firenook-code-literal)' },
  { tag: tags.bool, color: 'var(--color-firenook-code-literal)', fontWeight: '500' },
  {
    tag: tags.null,
    color: 'var(--color-firenook-code-literal)',
    fontStyle: 'italic',
    opacity: '0.75',
  },
  { tag: tags.separator, color: 'var(--color-firenook-code-punctuation)' },
  { tag: tags.squareBracket, color: 'var(--color-firenook-code-punctuation)' },
  { tag: tags.brace, color: 'var(--color-firenook-code-punctuation)' },
  { tag: tags.invalid, color: 'var(--text-color-kumo-danger)' },
])

/**
 * Every surface the editor paints, in Kumo's tokens rather than in
 * colours of its own, so it follows the console into dark mode without
 * a second palette to keep in step.
 */
const SKIN = EditorView.theme({
  // Fills by flexing, not by `height: 100%`. A percentage height
  // resolves against a parent whose own height is `auto` as `auto`, and
  // the create dialog's box is exactly that — a column that grows to its
  // content with a floor under it. Flex distribution reads the floor;
  // percentage resolution does not, and the editor came out three lines
  // tall inside a box with room for twelve.
  '&': {
    flex: '1',
    minHeight: '0',
    fontSize: '12px',
    backgroundColor: 'var(--color-kumo-control)',
    color: 'var(--text-color-kumo-default)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    // The console's `leading-5`, which is 17.5 px against its 14 px root
    // — the same line the field rows and every other code block here
    // are set on, so the JSON tab shows a document at the density the
    // rest of the panel reads at.
    lineHeight: '1.25rem',
    overflow: 'auto',
  },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--text-color-kumo-default)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-kumo-control)',
    color: 'var(--text-color-kumo-inactive)',
    border: 'none',
    borderRight: '1px solid var(--color-kumo-hairline)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '28px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 2px' },
  '.cm-activeLine': { backgroundColor: 'var(--color-kumo-tint)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--color-kumo-tint)',
    color: 'var(--text-color-kumo-subtle)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-color-kumo-default)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-kumo-info-tint)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--color-kumo-warning-tint)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--color-kumo-info-tint)',
    outline: 'none',
  },
  // The panel the search bar opens in, and the fields inside it, which
  // otherwise arrive in the browser's own grey.
  '.cm-panels': {
    backgroundColor: 'var(--color-kumo-base)',
    color: 'var(--text-color-kumo-default)',
    borderTop: '1px solid var(--color-kumo-line)',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-panel.cm-search input[type=text]': {
    backgroundColor: 'var(--color-kumo-control)',
    color: 'var(--text-color-kumo-default)',
    border: '1px solid var(--color-kumo-line)',
    borderRadius: '4px',
    padding: '2px 6px',
  },
  '.cm-tooltip': {
    // Wraps inside the panel rather than running the width of a
    // sentence: a mark is about one line of this document, and a
    // tooltip that reaches out across the grid behind it reads as
    // belonging to neither.
    maxWidth: '20rem',
    backgroundColor: 'var(--color-kumo-elevated)',
    color: 'var(--text-color-kumo-default)',
    border: '1px solid var(--color-kumo-line)',
    borderRadius: '6px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-diagnostic': { padding: '4px 8px', borderLeft: 'none' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--color-kumo-danger)' },
  '.cm-diagnostic-info': { borderLeft: '3px solid var(--color-kumo-info)' },
  // A mark paints in two places — the squiggle under the value and the
  // shape out in the gutter — and CodeMirror draws both in colours
  // written into the library: `#aaf` on `#77e` for the info square,
  // `#999` for its underline, with a dark theme that changes neither. A
  // pale lilac box on this console's dark ground was the one thing in
  // the editor still outside the palette, so both are taken over here.
  '.cm-lintRange': { backgroundImage: 'none', textDecorationSkipInk: 'none' },
  '.cm-lintRange-error': {
    textDecoration: 'underline wavy',
    textDecorationColor: 'var(--color-kumo-danger)',
  },
  '.cm-lintRange-warning': {
    textDecoration: 'underline wavy',
    textDecorationColor: 'var(--color-kumo-warning)',
  },
  '.cm-lintRange-info': {
    textDecoration: 'underline wavy',
    textDecorationColor: 'var(--color-kumo-info)',
  },
  '.cm-lintRange-hint': {
    textDecoration: 'underline wavy',
    textDecorationColor: 'var(--text-color-kumo-subtle)',
  },
  '.cm-lintRange-active': { backgroundColor: 'var(--color-kumo-warning-tint)' },
  // The gutter shapes are a CSS `content` holding an SVG with the colour
  // written into it, which no variable can reach. Handing `content` back
  // its normal value empties the element, and the shape is drawn instead
  // with a background and a border, which do take tokens — a tinted fill
  // inside a solid edge, the structure that makes the library's own
  // markers read as marks rather than blobs.
  // Centred by the gutter cell rather than by a margin tuned to one
  // line height, so the shape stays on the line's middle if the density
  // ever changes.
  '.cm-gutter-lint .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
  },
  '.cm-lint-marker': {
    content: 'normal',
    boxSizing: 'border-box',
    width: '0.75em',
    height: '0.75em',
    borderStyle: 'solid',
    borderWidth: '1px',
  },
  '.cm-lint-marker-info': {
    backgroundColor: 'var(--color-kumo-info-tint)',
    borderColor: 'var(--color-kumo-info)',
    borderRadius: '2px',
  },
  '.cm-lint-marker-warning': {
    backgroundColor: 'var(--color-kumo-warning-tint)',
    borderColor: 'var(--color-kumo-warning)',
    borderRadius: '2px',
  },
  '.cm-lint-marker-error': {
    backgroundColor: 'var(--color-kumo-danger-tint)',
    borderColor: 'var(--color-kumo-danger)',
    borderRadius: '50%',
  },
})

/**
 * The marks the caller contributes, kept in a compartment so a changed
 * document reconfigures them rather than rebuilding the editor — which
 * would cost the cursor, the selection and the fold state.
 */
const EXTRA = new Compartment()
const EDITABLE = new Compartment()

/**
 * A document pasted over the top of this one arrives tidied.
 *
 * It rewrites the paste transaction rather than following it with a
 * second one, so the undo that takes the paste back takes the
 * re-indenting with it instead of leaving half of it behind.
 *
 * Only a paste over the whole document. Formatting as you type fights
 * the cursor, and formatting around a fragment dropped into the middle
 * moves lines nobody touched — but a minified blob pasted into an empty
 * box is the one case anybody ever reached for a Format button for.
 */
function tidyOnPaste(tidy: () => CodeEditorProps['tidyPaste']): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    const clean = tidy()
    if (!clean || !transaction.docChanged || !transaction.isUserEvent('input.paste'))
      return transaction
    const was = transaction.startState.doc.length
    let whole = 0
    let all = 0
    transaction.changes.iterChanges((fromA, toA) => {
      all += 1
      if (fromA === 0 && toA === was) whole += 1
    })
    if (all !== 1 || whole !== 1) return transaction
    const pasted = transaction.newDoc.toString()
    const tidied = clean(pasted)
    if (tidied === undefined || tidied === pasted) return transaction
    return { changes: { from: 0, to: was, insert: tidied }, userEvent: 'input.paste' }
  })
}

function extraLinter(find: CodeEditorProps['annotate']): Extension {
  if (!find) return []
  return linter((view) => find(view.state.doc.toString()) as Diagnostic[], { delay: 150 })
}

export default function CodeEditor({
  value,
  onChange,
  annotate,
  tidyPaste,
  readOnly = false,
  ariaLabel,
  testId,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // What the live editor reaches for. Everything the editor is built
  // from goes through here rather than being closed over, so changing
  // any of it never means tearing the editor down — and the editor is
  // built once, which is what keeps the cursor, the selection, the undo
  // history and every fold across a re-render.
  const latest = useRef({ value, readOnly, onChange, annotate, tidyPaste })
  useEffect(() => {
    latest.current = { value, readOnly, onChange, annotate, tidyPaste }
  })

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          foldGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          search({ top: false }),
          highlightSelectionMatches(),
          lintGutter(),
          EditorView.lineWrapping,
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          json(),
          tidyOnPaste(() => latest.current.tidyPaste),
          linter(jsonParseLinter(), { delay: 150 }),
          syntaxHighlighting(INK),
          SKIN,
          EXTRA.of(extraLinter(latest.current.annotate)),
          EDITABLE.of(EditorState.readOnly.of(latest.current.readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // Mounted once, deliberately, which is why nothing reactive is read
    // here directly: the seed comes out of the ref, and the effects
    // below keep the live editor in step with every prop.
  }, [])

  // Text that arrived from outside — the tab reopening on a different
  // document, Format rewriting it — replaces the document. Text the
  // editor itself produced is already there, and writing it back would
  // put the cursor at the end of every keystroke.
  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: EXTRA.reconfigure(extraLinter(annotate)) })
  }, [annotate])

  useEffect(() => {
    view.current?.dispatch({
      effects: EDITABLE.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  // The label and the handle go on the element that actually holds the
  // text and the focus, not on the wrapper: a test that types into this
  // editor is typing into `.cm-content`, and a screen reader lands there.
  useEffect(() => {
    const content = view.current?.contentDOM
    if (!content) return
    if (ariaLabel) content.setAttribute('aria-label', ariaLabel)
    if (testId) content.setAttribute('data-testid', testId)
  }, [ariaLabel, testId])

  return <div ref={host} className="flex min-h-0 flex-1 flex-col overflow-hidden" />
}
