// What "Connect your app" adds to ⌘K once something is typed: each
// platform's snippet, copied straight to the clipboard with this engine's
// host, ports and project id (its tab is one click away in the dialog).
// The empty palette has the one way in, the Suite group's "Connect your
// app", so these rows wait for a query.

import { CopyIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { copyToClipboard } from '@/lib/copy'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { CONNECT_TABS, type ConnectParam } from '@/lib/connect-tabs'

export const CONNECT_PALETTE = 'connect'

export function useConnectPalette({
  snippet,
}: {
  /** The snippet a platform's tab shows now (host and ports included). */
  snippet: (param: ConnectParam) => string
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    const items = CONNECT_TABS.map<PaletteItem>((tab) => ({
      id: `connect:copy:${tab.param}`,
      title: `Copy the ${tab.label} snippet`,
      description: 'With this engine’s host, ports and project id',
      keywords: `copy clipboard connect snippet ${tab.param}`,
      icon: <CopyIcon size={16} />,
      run: () => {
        void copyToClipboard(snippet(tab.param), {
          what: `the ${tab.label} snippet`,
          refused: 'Copy it from Connect in the top bar instead.',
        })
      },
    }))
    const provider = (query: string): PaletteGroup[] => {
      if (query.trim() === '') return []
      const shown = items.filter((item) => matchesQuery(item, query))
      return shown.length > 0 ? [{ label: 'Connect', items: shown }] : []
    }
    register(CONNECT_PALETTE, provider)
    return () => unregister(CONNECT_PALETTE)
  }, [register, unregister, snippet])
}
