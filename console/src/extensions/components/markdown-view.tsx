// An extension author's markdown on the page: rendered and sanitised by
// `../markdown.ts` (loaded on first use), set in the reading face, with
// console links followed in the app and the rest opening a new tab. Until
// the HTML is ready the text itself stands in, in the same place, so a
// reader never watches an empty box fill.

import { cn } from '@cloudflare/kumo'
import { useRouter } from '@tanstack/react-router'
import { type MouseEvent, useEffect, useState } from 'react'
import { renderMarkdown } from '../markdown'

/** Prose at two sizes: a page's reading column (14 px) and a row's note (13 px). */
const PROSE = {
  page: cn(
    'text-[14px] leading-6 text-kumo-default',
    '[&_h1]:mt-6 [&_h1]:mb-2 [&_h1]:text-[16px] [&_h1]:leading-6 [&_h1]:font-semibold [&_h1:first-child]:mt-0',
    '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:leading-6 [&_h2]:font-semibold [&_h2:first-child]:mt-0',
    '[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-[14px] [&_h3]:font-semibold',
    '[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:text-[14px] [&_h4]:font-medium',
    '[&_p]:my-2.5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
    '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-kumo-control [&_pre]:p-3 [&_pre]:ring [&_pre]:ring-kumo-line',
    '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px] [&_pre_code]:leading-5',
  ),
  compact: cn(
    'text-[13px] leading-5 text-kumo-subtle',
    '[&_h1]:my-1 [&_h1]:text-[13px] [&_h1]:font-semibold [&_h2]:my-1 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h3]:my-1 [&_h3]:text-[13px] [&_h3]:font-medium',
    '[&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4',
    '[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-kumo-control [&_pre]:p-2',
    '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px]',
  ),
} as const

const SHARED = cn(
  'min-w-0 break-words',
  '[&_a]:text-kumo-link [&_a]:underline-offset-2 [&_a:hover]:underline',
  '[&_code]:rounded [&_code]:bg-kumo-tint [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px]',
  '[&_strong]:font-medium [&_strong]:text-kumo-default [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3',
  '[&_table]:my-3 [&_table]:border-collapse [&_td]:border [&_td]:border-kumo-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-kumo-line [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium',
  '[&_hr]:my-4 [&_hr]:border-kumo-line [&_img]:max-w-full',
)

export function MarkdownView({
  text,
  size = 'page',
  testId,
}: {
  text: string
  size?: 'page' | 'compact'
  testId?: string | undefined
}) {
  const router = useRouter()
  const [html, setHtml] = useState<{ for: string; html: string } | undefined>(undefined)
  useEffect(() => {
    let current = true
    void renderMarkdown(text).then(
      (rendered) => {
        if (current) setHtml({ for: text, html: rendered })
      },
      () => {
        // A library that would not load leaves the text itself on screen.
      },
    )
    return () => {
      current = false
    }
  }, [text])

  // A console link moves within the app; any other link keeps its new tab.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element).closest('a[data-console-path]')
    const path = anchor?.getAttribute('data-console-path')
    if (!path) return
    event.preventDefault()
    void router.navigate({ href: path })
  }

  const ready = html?.for === text
  return ready ? (
    <div
      className={cn(SHARED, PROSE[size])}
      onClick={onClick}
      // The author's markdown, sanitised by DOMPurify in `renderMarkdown`.
      // oxlint-disable-next-line react/no-danger -- sanitised HTML is the point of this component
      dangerouslySetInnerHTML={{ __html: html.html }}
      data-testid={testId}
      data-rendered=""
    />
  ) : (
    <div className={cn(SHARED, PROSE[size], 'whitespace-pre-wrap')} data-testid={testId}>
      {text}
    </div>
  )
}
