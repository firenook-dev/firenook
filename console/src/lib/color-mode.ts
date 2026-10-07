// The console follows the operating system. Kumo carries a full set of dark
// tokens and theme.css redefines the Firenook accent for them; all that was
// ever missing was the `data-mode` attribute they key on. `index.html`
// already declares `color-scheme: light dark`, so the browser paints its own
// scrollbars and form controls dark too — without this they disagreed with
// the page.

const QUERY = '(prefers-color-scheme: dark)'

function apply(dark: boolean): void {
  document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light')
}

/**
 * Matches the document to the OS colour scheme and keeps following it.
 * Called before the first render, so the page never flashes the wrong mode.
 */
export function followSystemColorMode(): void {
  const media = window.matchMedia(QUERY)
  apply(media.matches)
  media.addEventListener('change', (event) => apply(event.matches))
}
