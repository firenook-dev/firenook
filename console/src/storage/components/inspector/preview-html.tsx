// HTML drawn with scripts off: a frame with an empty `sandbox` and the text
// as its `srcdoc`, never the object's URL — an HTML object loaded by URL
// would be a page on the console's own origin.

export function PreviewHtml({ text, large = false }: { text: string; large?: boolean }) {
  return (
    <iframe
      sandbox=""
      srcDoc={text}
      title="Rendered HTML, scripts off"
      className={`w-full rounded-md bg-kumo-base ring ring-kumo-line ${large ? 'h-full' : 'h-80'}`}
      data-testid="preview-html"
    />
  )
}
