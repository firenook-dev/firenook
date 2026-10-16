// The languages a preview reads text in, each loaded the first time a file
// in it is shown: a dynamic import inside the editor's own chunk, so a
// Storage preview of a Markdown file costs the Markdown grammar and nothing
// more, and the Firestore pages never load any of them.

import type { Extension } from '@codemirror/state'

/** A preview language: highlighted, read-only by default, no completion. */
export type PreviewLanguage = 'javascript' | 'xml' | 'yaml' | 'markdown' | 'css' | 'html' | 'text'

/** Whether a language is one of the preview languages loaded here. */
export function isPreviewLanguage(language: string | undefined): language is PreviewLanguage {
  return (
    language === 'javascript' ||
    language === 'xml' ||
    language === 'yaml' ||
    language === 'markdown' ||
    language === 'css' ||
    language === 'html' ||
    language === 'text'
  )
}

/** The grammar for a preview language; plain text has none. */
export async function loadPreviewLanguage(language: PreviewLanguage): Promise<Extension> {
  switch (language) {
    case 'javascript': {
      const { javascript } = await import('@codemirror/lang-javascript')
      return javascript({ jsx: true, typescript: true })
    }
    case 'xml': {
      const { xml } = await import('@codemirror/lang-xml')
      return xml()
    }
    case 'yaml': {
      const { yaml } = await import('@codemirror/lang-yaml')
      return yaml()
    }
    case 'markdown': {
      const { markdown } = await import('@codemirror/lang-markdown')
      return markdown()
    }
    case 'css': {
      const { css } = await import('@codemirror/lang-css')
      return css()
    }
    case 'html': {
      const { html } = await import('@codemirror/lang-html')
      return html()
    }
    case 'text':
      return []
  }
}
