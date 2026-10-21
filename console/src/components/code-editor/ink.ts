// The console's ink for code: one highlight style for the editor and for
// code shown as text (a snippet, a document as code, a request as code), so
// a keyword or a string reads the same wherever it is written. Like the
// editor, it is only ever imported from lazily loaded chunks.

import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

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
export const INK = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--color-firenook-code-key)', fontWeight: '500' },
  { tag: tags.string, color: 'var(--color-firenook-code-string)' },
  { tag: [tags.number, tags.atom], color: 'var(--color-firenook-code-literal)' },
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
  // Markup (Markdown, HTML, XML, previews of stored files): structure in the
  // key's hue, the way JSON's keys and the rules' words take it; text keeps
  // the text colour.
  { tag: [tags.heading, tags.tagName], color: 'var(--color-firenook-code-key)', fontWeight: '500' },
  { tag: tags.attributeName, color: 'var(--color-firenook-code-key)' },
  { tag: [tags.url, tags.link], color: 'var(--color-firenook-code-literal)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  // Rules. The words of the language take the key's hue, as JSON's keys
  // do — the structure — and the wildcards in a path the literal's, since
  // they are the values a path binds. Operators and punctuation recede.
  // Names keep the text colour: a condition is mostly names, and colour on
  // every one of them would mean nothing.
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.operatorKeyword,
      tags.special(tags.keyword),
    ],
    color: 'var(--color-firenook-code-key)',
    fontWeight: '500',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    // Recedes like the console's secondary text, and stays as readable:
    // the inactive grey was too faint to read a comment by.
    color: 'var(--text-color-kumo-subtle)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.special(tags.variableName), tags.typeName, tags.escape],
    color: 'var(--color-firenook-code-literal)',
  },
  { tag: tags.standard(tags.variableName), fontWeight: '500' },
  {
    tag: [
      tags.logicOperator,
      tags.compareOperator,
      tags.arithmeticOperator,
      tags.operator,
      tags.definitionOperator,
      tags.derefOperator,
      tags.paren,
      tags.punctuation,
    ],
    color: 'var(--color-firenook-code-punctuation)',
  },
])
