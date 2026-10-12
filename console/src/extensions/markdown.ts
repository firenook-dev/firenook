// An extension's own markdown — its POSTINSTALL notes, its README, a
// param's description — as HTML that is safe to put on the console's
// origin. The text comes from the extension's author, so it is sanitised
// after rendering: no scripts, no event handlers, no `javascript:` links,
// no styles, no frames or forms. Links to the console (the engine already
// rewrote the Firebase console's to `/console/<section>`) are marked so the
// page can follow them without a reload; every other link opens in a new
// tab, without access to this one.
//
// `marked` and `DOMPurify` are loaded the first time something is rendered,
// so they stay out of every chunk that never shows an extension's notes.

import type { DOMPurify as Purifier } from 'dompurify'

/** The console's own address prefix: `/console/firestore` is the Firestore page. */
const CONSOLE_PREFIX = '/console/'

/**
 * The in-app path a link points at — `/firestore?path=x` for
 * `/console/firestore?path=x` or the same on this page's own origin — or
 * undefined for a link that leaves the console.
 */
export function consolePath(href: string, origin?: string | undefined): string | undefined {
  const base = origin ?? (typeof location === 'undefined' ? undefined : location.origin)
  let path = href
  if (base !== undefined && href.startsWith(base)) path = href.slice(base.length)
  if (!path.startsWith(CONSOLE_PREFIX)) return undefined
  const rest = path.slice(CONSOLE_PREFIX.length - 1)
  // `/console/api/…` is the engine's API, not a page.
  if (rest === '/api' || rest.startsWith('/api/')) return undefined
  return rest
}

/** Elements an author's markdown may never produce, whatever DOMPurify would allow. */
const FORBID_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object']
const FORBID_ATTR = ['style', 'class', 'id']

let loaded: Promise<{ parse: (text: string) => string; purify: Purifier }> | undefined

/** The two libraries, loaded once, with the link rule installed on the sanitiser. */
function libraries() {
  loaded ??= Promise.all([import('marked'), import('dompurify')]).then(([marked, dompurify]) => {
    const purify = dompurify.default
    purify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName !== 'A') return
      const href = node.getAttribute('href')
      if (href === null) return
      const path = consolePath(href)
      if (path !== undefined) {
        node.setAttribute('data-console-path', path)
        node.removeAttribute('target')
        node.removeAttribute('rel')
        return
      }
      if (href.startsWith('#')) return
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    })
    return {
      parse: (text: string) => marked.marked.parse(text, { async: false, gfm: true }) as string,
      purify,
    }
  })
  return loaded
}

/**
 * The markdown as sanitised HTML, links marked for the console or opened in
 * a new tab. Where the sanitiser cannot run (it returns its input unchanged
 * then), it refuses rather than hand back unsanitised HTML, and the page
 * shows the text as it is.
 */
export async function renderMarkdown(text: string): Promise<string> {
  const { parse, purify } = await libraries()
  if (!purify.isSupported) throw new Error('This browser cannot sanitise HTML.')
  return purify.sanitize(parse(text), {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_ATTR: ['target'],
  })
}
