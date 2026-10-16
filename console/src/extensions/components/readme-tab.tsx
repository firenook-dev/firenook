// How the extension works, in its author's words: the POSTINSTALL notes
// with this instance's values filled in (what the Firebase console shows
// after an install) and the source's README when it has one. Links to the
// Firebase console were pointed at the console's own sections by the
// engine, so they open here.

import { BookOpenTextIcon } from '@phosphor-icons/react'
import type { ExtensionInstanceDetail } from '@/api/generated/compute/ExtensionInstanceDetail'
import { MarkdownView } from './markdown-view'

export function ReadmeTab({ detail }: { detail: ExtensionInstanceDetail }) {
  const { postinstall, readme } = detail
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-kumo-base" data-testid="instance-readme">
      <div className="grid max-w-3xl gap-8 px-6 py-5">
        {postinstall === null && readme === null && (
          <div className="flex items-start gap-3 py-2">
            <BookOpenTextIcon size={20} className="mt-0.5 shrink-0 text-kumo-inactive" />
            <p className="m-0 text-[14px] text-kumo-subtle">
              The extension ships no POSTINSTALL notes and no README. Its spec still says what it
              does on the Overview tab, and its parameters are on the Configuration tab.
            </p>
          </div>
        )}
        {postinstall !== null && (
          <section className="grid gap-2" aria-label="After installing">
            <MarkdownView text={postinstall} testId="readme-postinstall" />
          </section>
        )}
        {readme !== null && (
          <section
            className={
              postinstall !== null ? 'grid gap-2 border-t border-kumo-line pt-6' : 'grid gap-2'
            }
            aria-label="README"
          >
            <span className="font-mono text-[11px] text-kumo-subtle">README.md</span>
            <MarkdownView text={readme} testId="readme-readme" />
          </section>
        )}
      </div>
    </div>
  )
}
