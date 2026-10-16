import { Banner } from '@firenook/kit'
import { InfoIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react'

/** Page-level messages. Default informs; alert warns; error blocks; secondary is neutral. */
export function Variants() {
  return (
    <div className="grid gap-3">
      <Banner
        icon={<InfoIcon weight="fill" />}
        title="Demo project"
        description="No cloud service is contacted. Functions can still reach external providers."
      />
      <Banner
        icon={<WarningIcon weight="fill" />}
        variant="alert"
        title="Listening on 0.0.0.0"
        description="Every service is reachable from any device on this network."
      />
      <Banner
        icon={<WarningCircleIcon weight="fill" />}
        variant="error"
        title="Import rejected"
        description="The seed identity changed; the working state was preserved."
      />
      <Banner
        icon={<InfoIcon weight="fill" />}
        variant="secondary"
        title="Requests diagnostics"
        description="Retained history may be incomplete: 12 events omitted while busy."
      />
    </div>
  )
}
