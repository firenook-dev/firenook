// The code editor, as everything else sees it.
//
// The real thing is ./editor, which is CodeMirror and around 390 KB. It
// is reached only through the `lazy()` below, so it compiles to its own
// chunk and arrives the first time somebody opens a tab that writes
// code — not on the way to the grid. Import from here, never from
// ./editor, or that chunk stops being its own.

import { Suspense, lazy } from 'react'
import type { CodeEditorProps } from './props'

export type { CodeEditorProps, CodeMark } from './props'

const Editor = lazy(() => import('./editor'))

/**
 * What stands in while the chunk arrives: the same text, in the same
 * face, at the same size, on the same ground. Over the loopback this is
 * a frame or two, and a reader who blinks sees the gutter appear beside
 * text that never moved — rather than a box that was empty and filled.
 */
function Waiting({ value }: { value: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md bg-kumo-control">
      <pre className="min-h-0 flex-1 overflow-hidden px-2 py-2 font-mono text-[12px] leading-5 text-kumo-default">
        {value}
      </pre>
    </div>
  )
}

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<Waiting value={props.value} />}>
      <Editor {...props} />
    </Suspense>
  )
}
