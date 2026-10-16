// The top bar's help menu: the keyboard shortcuts (the `?` dialog), then
// the ways out of the console — the documentation, this engine's release
// notes, and a new issue with its version already filled in
// (`lib/project-links.ts`). The links open in a new tab, so the console
// keeps its place.
//
// Kumo's `DropdownMenu` is not in the first route's chunk, so this file
// loads after the first paint (`help-button.tsx` draws the same button
// until it has).

import { DropdownMenu } from '@cloudflare/kumo'
import {
  ArrowUpRightIcon,
  BookOpenTextIcon,
  BugIcon,
  KeyboardIcon,
  ScrollIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { statusQuery } from '@/api/queries'
import { Kbd } from '@/components/kit'
import { DOCUMENTATION_URL, newIssueUrl, releaseNotesUrl } from '@/lib/project-links'
import { describeKey } from '@/lib/shortcuts'
import { useConsoleUi } from '@/lib/store'
import { HelpButton } from './help-button'

export function HelpMenu() {
  const status = useQuery(statusQuery)
  const setShortcutsOpen = useConsoleUi((state) => state.setShortcutsOpen)
  const engine = status.data?.engine
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<HelpButton />} />
      <DropdownMenu.Content align="end" className="min-w-60" data-testid="help-menu">
        <DropdownMenu.Item
          icon={KeyboardIcon}
          onClick={() => setShortcutsOpen(true)}
          data-testid="help-shortcuts"
        >
          <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
            Keyboard shortcuts
            <Kbd>{describeKey('?')}</Kbd>
          </span>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <OutLink href={DOCUMENTATION_URL} icon={BookOpenTextIcon} testId="help-docs">
          Documentation
        </OutLink>
        <OutLink href={releaseNotesUrl(engine)} icon={ScrollIcon} testId="help-releases">
          Release notes
        </OutLink>
        <OutLink href={newIssueUrl(engine)} icon={BugIcon} testId="help-issue">
          Report an issue
        </OutLink>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** A link out of the console, in a new tab, marked as one. */
function OutLink({
  href,
  icon,
  testId,
  children,
}: {
  href: string
  icon: typeof KeyboardIcon
  testId: string
  children: ReactNode
}) {
  return (
    <DropdownMenu.LinkItem
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      icon={icon}
      data-testid={testId}
    >
      <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
        {children}
        <ArrowUpRightIcon size={12} className="text-kumo-subtle" aria-hidden />
      </span>
    </DropdownMenu.LinkItem>
  )
}
