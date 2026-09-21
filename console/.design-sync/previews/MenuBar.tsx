import { MenuBar } from '@firenook/kit'
import { DatabaseIcon, GaugeIcon, ScrollIcon, UsersIcon } from '@phosphor-icons/react'

/** An icon-only switcher with arrow-key navigation, for compact view toggles. */
export function Sections() {
  return (
    <MenuBar
      isActive={1}
      options={[
        { icon: <GaugeIcon />, tooltip: 'Overview', onClick: () => {} },
        { icon: <DatabaseIcon />, tooltip: 'Firestore', onClick: () => {} },
        { icon: <UsersIcon />, tooltip: 'Authentication', onClick: () => {} },
        { icon: <ScrollIcon />, tooltip: 'Logs', onClick: () => {} },
      ]}
    />
  )
}
