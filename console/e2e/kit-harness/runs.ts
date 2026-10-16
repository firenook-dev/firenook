// What the kit harness answers its journeys: shared by the page (checked
// with the app) and the journeys (checked for Node), so it holds types only.

/** What a feed run did. */
export interface FeedRun {
  pushed: number
  /** Rows the ring holds at the end, and how many it let go. */
  size: number
  dropped: number
  /** Rows in the DOM at the end. */
  drawn: number
  /** Whether the newest line is on screen (the list followed). */
  newestShown: boolean
  /** Windows that started more than one window late. */
  late: number
}

/** What a JSON run measured. */
export interface JsonRun {
  /** The text's length in characters (ASCII here, so bytes too). */
  bytes: number
  /** Values in it: containers and leaves. */
  nodes: number
  /** `JSON.parse` of the text, ms: the network's side of "data". */
  parseMs: number
  /** From the parsed value handed over to the first frame painted with tree rows, ms. */
  paintMs: number
  /** Tree rows in the DOM at that frame. */
  drawn: number
}

/** What the theme view measured: each contrast a reader meets, and the two colour choices. */
export interface ThemeRun {
  /** WCAG 2 contrast ratios, rounded to hundredths, with the minimum each needs. */
  checks: Array<{ what: string; ratio: number; need: number }>
  /** The primary button's fill in OKLCH: a blue, nowhere near the danger red. */
  primary: { chroma: number; hue: number }
  /** Whether the active tab's underline is drawn in the logo's flame. */
  underlineIsFlame: boolean
}

/** `window.__kit`. */
export interface KitHarness {
  ready: boolean
  /** Feeds the list `perSecond` lines a second for `seconds`, in 100 ms windows. */
  feed(perSecond: number, seconds: number): Promise<FeedRun>
  /** Builds a JSON text of about `megabytes`, parses it, hands it over and times the first paint. */
  json(megabytes: number): Promise<JsonRun>
  /** Measures the theme view's contrast as the browser paints it. */
  theme(): ThemeRun
}
