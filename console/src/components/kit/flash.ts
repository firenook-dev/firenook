// How long a row or a figure that changed flashes: the length of the
// `row-flash` animation in styles.css. A grid that marks its own flashes
// (Firestore's, `useCursorRows`, Auth's users) clears them after this long,
// so the mark and the colour end together.

/** How long a changed row or figure flashes, ms (`row-flash` in styles.css). */
export const FLASH_MS = 1_600
