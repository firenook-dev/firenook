// The engine's configuration notices, below the suite banners: what the
// terminal prints once at startup and nobody reads — a project id that is
// not a demo one, a listen address other machines can reach, emulators
// missing while Functions run, diagnostics off. Each can be put away; the
// dismissal holds for this engine run in every tab of the browser, and a
// new run shows it again, since the configuration may have changed. They
// carry no action: the fix is a restart with other flags, which the
// sentence names.

import { Banner, Button } from '@cloudflare/kumo'
import { InfoIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import type { OverviewNotice } from '@/api/generated/observe/OverviewNotice'
import { noticeParts } from '../model'
import { useNotices } from '../notices'

export function Notices({
  notices,
  instance,
}: {
  notices: readonly OverviewNotice[]
  instance: string
}) {
  const { visible, dismiss } = useNotices(notices, instance)
  if (visible.length === 0) return null
  return (
    <div className="grid gap-2" data-testid="overview-notices">
      {visible.map((notice) => {
        const { title, description } = noticeParts(notice.message)
        const warn = notice.level === 'warn'
        return (
          <Banner
            key={notice.code}
            variant={warn ? 'alert' : 'default'}
            icon={warn ? <WarningIcon weight="fill" /> : <InfoIcon weight="fill" />}
            title={title}
            description={description}
            action={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<XIcon />}
                aria-label="Dismiss until the engine restarts"
                title="Dismiss until the engine restarts"
                onClick={() => dismiss(notice.code)}
                data-testid={`overview-notice-${notice.code}-dismiss`}
              />
            }
            data-testid={`overview-notice-${notice.code}`}
            data-level={notice.level}
          />
        )
      })}
    </div>
  )
}
