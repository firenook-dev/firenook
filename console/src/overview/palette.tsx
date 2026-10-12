// What the Overview adds to ⌘K while it is on screen: open "Connect your
// app" on any platform, copy a platform's snippet straight to the
// clipboard, save a snapshot on the engine's machine, and jump to the
// engine's details. The suite-wide "Download a snapshot…" and "Reset
// data…" are registered once, in Logs' registry entry, so they are not
// repeated here.

import { CopyIcon, CpuIcon, FloppyDiskIcon, PlugsConnectedIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { toast } from '@/lib/toasts'
import { CONNECT_TABS } from './connect-tabs'
import type { ConnectParam } from './search'

export const OVERVIEW_PALETTE = 'overview'

/** A row for one platform (connect with it, copy its snippet): offered once something is typed. */
function perPlatform(item: PaletteItem): boolean {
  return item.id.startsWith('overview:copy:') || item.id.startsWith('overview:connect:')
}

export function useOverviewPalette({
  connect,
  snippet,
  save,
  engine,
}: {
  /** Brings "Connect your app" into view, on a platform's tab when one is named. */
  connect: (param: ConnectParam | undefined) => void
  /** The snippet a platform's tab shows now (host and ports included). */
  snippet: (param: ConnectParam) => string
  /** Opens the save dialog. */
  save: () => void
  /** Brings the engine's details into view. */
  engine: () => void
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    const items: PaletteItem[] = [
      {
        id: 'overview:connect',
        title: 'Connect your app',
        description: 'The code that points an app at this engine, for every platform',
        keywords: 'connect snippet emulator sdk setup',
        icon: <PlugsConnectedIcon size={16} />,
        run: () => connect(undefined),
      },
      ...CONNECT_TABS.map<PaletteItem>((tab) => ({
        id: `overview:connect:${tab.param}`,
        title: `Connect with ${tab.label}`,
        description: tab.title,
        keywords: `connect snippet emulator sdk setup ${tab.param}`,
        icon: <PlugsConnectedIcon size={16} />,
        run: () => connect(tab.param),
      })),
      ...CONNECT_TABS.map<PaletteItem>((tab) => ({
        id: `overview:copy:${tab.param}`,
        title: `Copy the ${tab.label} snippet`,
        description: 'With this engine’s host, ports and project id',
        keywords: `copy clipboard connect snippet ${tab.param}`,
        icon: <CopyIcon size={16} />,
        run: () => {
          void navigator.clipboard.writeText(snippet(tab.param)).then(
            () =>
              toast({
                key: 'overview-copy',
                title: `Copied the ${tab.label} snippet`,
                tone: 'success',
              }),
            () =>
              toast({
                key: 'overview-copy',
                title: 'The snippet was not copied',
                description: 'The browser refused the clipboard; copy it from the page instead.',
                tone: 'warning',
              }),
          )
        },
      })),
      {
        id: 'overview:save',
        title: 'Save a snapshot on the engine’s machine…',
        description: 'A standard export in a folder the engine lists',
        keywords: 'snapshot export save folder disk',
        icon: <FloppyDiskIcon size={16} />,
        run: save,
      },
      {
        id: 'overview:engine',
        title: 'Engine details',
        description: 'Version, folders, switches and what the console’s buffers hold',
        keywords: 'engine version config debug log node memory buffers',
        icon: <CpuIcon size={16} />,
        run: engine,
      },
    ]
    const provider = (query: string): PaletteGroup[] => {
      // Each platform is offered once something is typed; the empty palette
      // has the one way in.
      const typed = query.trim() !== ''
      const shown = items.filter(
        (item) =>
          matchesQuery(item, query) &&
          (typed ? item.id !== 'overview:connect' : !perPlatform(item)),
      )
      return shown.length > 0 ? [{ label: 'Overview', items: shown }] : []
    }
    register(OVERVIEW_PALETTE, provider)
    return () => unregister(OVERVIEW_PALETTE)
  }, [register, unregister, connect, snippet, save, engine])
}
