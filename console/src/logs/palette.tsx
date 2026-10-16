// What Logs adds to ⌘K while the page is on screen: level views, problems,
// engine internals, following, clearing, windows, downloads, a link to the
// view, how rows are drawn, and a "Filter by" row for every function and
// service the engine has counted. The cursor row's own menu is offered by
// `useRowMenuPalette` beside it.

import {
  ArrowsInLineVerticalIcon,
  BroomIcon,
  ClipboardTextIcon,
  ClockIcon,
  DownloadSimpleIcon,
  EyeIcon,
  FunnelIcon,
  LinkSimpleIcon,
  PauseIcon,
  PlayIcon,
  TextAlignLeftIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { useEffect } from 'react'
import type { LogFacets } from '@/api/generated/observe/LogFacets'
import { filterValueText } from '@/lib/filter'
import { type ClockFormat, useClockFormat } from '@/lib/format'
import { type PaletteItem, matchesQuery, usePaletteProviders } from '@/lib/palette'

export interface LogsPaletteActions {
  setQ: (q: string) => void
  toggleInternals: () => void
  setPaused: (paused: boolean) => void
  clearView: () => void
  showCleared: () => void
  setWindow: (from: string | undefined) => void
  downloadNdjson: () => void
  downloadText: () => void
  copyVisible: () => void
  copyLink: () => void
  setWrap: (wrap: boolean) => void
  setKeep: (keep: boolean) => void
  addTerm: (term: string) => void
}

export interface LogsPaletteFacts {
  internals: boolean
  paused: boolean
  cleared: boolean
  canClear: boolean
  reloaded: boolean
  wrap: boolean
  keep: boolean
  facets: LogFacets | undefined
}

const CLOCK_NAMES: Record<ClockFormat, string> = { time: 'clock', relative: 'relative', utc: 'UTC' }

export function useLogsPalette(facts: LogsPaletteFacts, actions: LogsPaletteActions): void {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const { format, setFormat } = useClockFormat()
  useEffect(() => {
    const icon = (Glyph: typeof FunnelIcon) => <Glyph size={16} />
    const items: PaletteItem[] = [
      {
        id: 'logs:all-levels',
        title: 'All levels',
        keywords: 'logs level debug info clear',
        icon: icon(TextAlignLeftIcon),
        run: () => actions.setQ(''),
      },
      {
        id: 'logs:warnings',
        title: 'Warnings and errors',
        keywords: 'logs level warn error w',
        icon: icon(WarningIcon),
        run: () => actions.setQ('level:warn level:error'),
      },
      {
        id: 'logs:errors',
        title: 'Errors only',
        keywords: 'logs level error e',
        icon: icon(WarningCircleIcon),
        run: () => actions.setQ('level:error'),
      },
      {
        id: 'logs:problems',
        title: 'Problems only',
        description: 'Errors, function failures and rules denials',
        keywords: 'logs is:problem failures denials',
        icon: icon(WarningCircleIcon),
        run: () => actions.setQ('is:problem'),
      },
      {
        id: 'logs:internals',
        title: facts.internals ? 'Engine internals: hide' : 'Engine internals: show',
        description: 'The engine’s own bookkeeping the default view leaves out',
        keywords: 'logs is:internal engine receipt configuration',
        icon: icon(EyeIcon),
        run: actions.toggleInternals,
      },
      facts.paused
        ? {
            id: 'logs:follow',
            title: 'Follow the latest',
            keywords: 'logs live resume end',
            icon: icon(PlayIcon),
            run: () => actions.setPaused(false),
          }
        : {
            id: 'logs:pause',
            title: 'Pause',
            keywords: 'logs freeze hold p',
            icon: icon(PauseIcon),
            run: () => actions.setPaused(true),
          },
    ]
    if (facts.canClear)
      items.push({
        id: 'logs:clear',
        title: 'Clear view',
        description: 'Start reading from now; nothing is removed from the engine',
        keywords: 'logs clear x',
        icon: icon(BroomIcon),
        run: actions.clearView,
      })
    if (facts.cleared)
      items.push({
        id: 'logs:show-cleared',
        title: 'Show cleared lines',
        keywords: 'logs restore cleared',
        icon: icon(BroomIcon),
        run: actions.showCleared,
      })
    if (facts.reloaded)
      items.push({
        id: 'logs:since-reload',
        title: 'Lines since the last Functions reload',
        keywords: 'logs time range reload deploy',
        icon: icon(ClockIcon),
        run: () => actions.setWindow('reload'),
      })
    items.push(
      {
        id: 'logs:last-5',
        title: 'Last 5 minutes',
        keywords: 'logs time range recent',
        icon: icon(ClockIcon),
        run: () => actions.setWindow('-5m'),
      },
      {
        id: 'logs:ndjson',
        title: 'Download as NDJSON',
        description: 'Every line this filter matches, as the engine keeps them',
        keywords: 'logs export download json',
        icon: icon(DownloadSimpleIcon),
        run: actions.downloadNdjson,
      },
      {
        id: 'logs:text',
        title: 'Download as text',
        keywords: 'logs export download txt',
        icon: icon(DownloadSimpleIcon),
        run: actions.downloadText,
      },
      {
        id: 'logs:copy',
        title: 'Copy visible lines',
        description: 'The lines loaded in the list, as text',
        keywords: 'logs clipboard copy',
        icon: icon(ClipboardTextIcon),
        run: actions.copyVisible,
      },
      {
        id: 'logs:copy-link',
        title: 'Copy link to this view',
        description: 'The filter and the window, as an address to keep or share',
        keywords: 'logs link url share bookmark save filter view',
        icon: icon(LinkSimpleIcon),
        run: actions.copyLink,
      },
      {
        id: 'logs:wrap',
        title: facts.wrap ? 'Wrap lines: off' : 'Wrap lines: on',
        keywords: 'logs wrap long lines',
        icon: icon(ArrowsInLineVerticalIcon),
        run: () => actions.setWrap(!facts.wrap),
      },
      ...(['time', 'relative', 'utc'] as const)
        .filter((clock) => clock !== format)
        .map((clock) => ({
          id: `logs:clock-${clock}`,
          title: `Timestamps: ${CLOCK_NAMES[clock]}`,
          description: 'Every feed in the console',
          keywords: 'logs time clock relative utc timestamps',
          icon: icon(ClockIcon),
          run: () => setFormat(clock),
        })),
      {
        id: 'logs:keep',
        title: facts.keep
          ? 'Keep lines across engine restarts: off'
          : 'Keep lines across engine restarts: on',
        keywords: 'logs restart keep preserve',
        icon: icon(TextAlignLeftIcon),
        run: () => actions.setKeep(!facts.keep),
      },
      ...(facts.facets?.functions ?? [])
        .filter((count) => count.value !== 'Other')
        .map((count) => ({
          id: `logs:function:${count.value}`,
          title: `Filter by function ${count.value}`,
          keywords: `logs function ${count.value}`,
          icon: icon(FunnelIcon),
          run: () => actions.addTerm(`function:${filterValueText(count.value)}`),
        })),
      ...(facts.facets?.services ?? []).map((count) => ({
        id: `logs:service:${count.value}`,
        title: `Filter by service ${count.value}`,
        keywords: `logs service emulator ${count.value}`,
        icon: icon(FunnelIcon),
        run: () => actions.addTerm(`service:${filterValueText(count.value)}`),
      })),
    )
    register('logs', (query) => {
      const found = items.filter((item) => matchesQuery(item, query))
      return found.length > 0 ? [{ label: 'Logs', items: found }] : []
    })
    return () => unregister('logs')
  }, [facts, actions, format, setFormat, register, unregister])
}
