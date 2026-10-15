// ⌘K, one surface for the whole console (foundation spec §4.9). In order:
// what the page on screen contributes (its providers, the cursor row's
// menu); what the engine's search finds across sections, one group per
// kind of thing, each opening through the target section's registry like
// any link; the sections, their pages and what their registries offer from
// anywhere; the suite-wide actions the shell owns; the layout.

import { CommandPalette as KumoCommandPalette } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  CpuIcon,
  FloppyDiskIcon,
  GaugeIcon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  ProhibitIcon,
} from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { ApiError, apiGet, apiSend } from '@/api/client'
import type { BackgroundTriggers } from '@/api/generated/BackgroundTriggers'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { SearchResults } from '@/api/generated/SearchResults'
import { statusQuery } from '@/api/queries'
import { Kbd, PanelIcon } from '@/components/kit'
import { describeTheme, useTheme } from '@/lib/color-mode'
import { panelShown, useLayout } from '@/lib/layout'
import { linkTo } from '@/lib/links'
import { SECTION_ACTIONS } from '@/lib/palette-actions'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { SECTIONS, type SectionLink, sectionById } from '@/lib/services'
import { describeKey } from '@/lib/shortcuts'
import { useConsoleUi } from '@/lib/store'
import { toast } from '@/lib/toasts'
import { openEngineDetails } from './engine-details'
import { THEME_CHOICES } from './theme-picker'

/** The shortest text the engine is asked to search, and how long typing settles first. */
const SEARCH_MIN = 2
const SEARCH_MAX = 200
const SEARCH_DEBOUNCE_MS = 120

/** `text` once it has stopped changing for `delayMs`. */
function useSettled(text: string, delayMs: number): string {
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), delayMs)
    return () => clearTimeout(timer)
  }, [text, delayMs])
  return settled
}

/**
 * The engine's search across sections for what is typed: 2 to 200
 * characters, after typing settles; the previous request is aborted when
 * the text moves on (its query loses its only observer). An engine without
 * the search route answers nothing rather than an error.
 */
function useEngineSearch(text: string, enabled: boolean) {
  const settled = useSettled(text.trim(), SEARCH_DEBOUNCE_MS)
  const wanted = enabled && settled.length >= SEARCH_MIN && settled.length <= SEARCH_MAX
  const query = useQuery({
    queryKey: ['search', settled],
    queryFn: async ({ signal }) => {
      try {
        return await apiGet<SearchResults>('/search', { q: settled, limit: 8 }, signal)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'not-found') return null
        throw error
      }
    },
    enabled: wanted,
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
  })
  return { text: settled, results: wanted ? query.data : undefined, error: query.error }
}

/** One identity for a thing, whichever source names it (`PaletteItem.ref`, a search hit). */
export function refId(ref: { kind: string; key: string }): string {
  return `${ref.kind} ${ref.key}`
}

/** The section a kind of thing belongs to (`extensions.instance` → Extensions). */
function ownerOf(kind: string) {
  const dot = kind.indexOf('.')
  return dot > 0 ? sectionById(kind.slice(0, dot)) : undefined
}

/**
 * ⌘K's engine groups: one per kind of hit, labelled by the target
 * section's `searchLabels`; hits that open nowhere (their section absent
 * from this engine) are dropped, and so are hits the page on screen already
 * offers (`offered`, by `refId`); each section's last group ends with
 * "Search <section> for “text”" where the section has a filter to search
 * with, even when the page offered every hit.
 */
export function engineGroups(
  results: SearchResults | null | undefined,
  text: string,
  status: ConsoleStatus | undefined,
  go: (link: SectionLink) => () => void,
  offered: ReadonlySet<string> = new Set(),
): PaletteGroup[] {
  if (!results) return []
  const groups: PaletteGroup[] = []
  for (const group of results.groups) {
    const section = sectionById(group.section)
    if (!section) continue
    const byKind = new Map<string, PaletteItem[]>()
    let found = 0
    for (const hit of group.hits) {
      const link = linkTo(hit, status)
      if (!link) continue
      found += 1
      if (offered.has(refId(hit))) continue
      const items = byKind.get(hit.kind) ?? []
      // A source can answer for another section's things (compute's finds
      // Extensions instances): each hit wears the icon of the section it opens in.
      const owner = ownerOf(hit.kind) ?? section
      items.push({
        id: `hit:${hit.kind}:${hit.key}`,
        title: hit.title,
        ...(hit.detail ? { description: hit.detail } : {}),
        icon: <owner.icon size={16} />,
        run: go(link),
      })
      byKind.set(hit.kind, items)
    }
    if (found === 0) continue
    const searchLink =
      section.searchLink === null
        ? undefined
        : (section.searchLink?.(text) ?? { to: section.to, search: { q: text } })
    const searchRow: PaletteItem | undefined = searchLink && {
      id: `search:${section.id}`,
      title: `Search ${section.label} for “${text}”`,
      icon: <MagnifyingGlassIcon size={16} />,
      run: go(searchLink),
    }
    const kinds = [...byKind]
    // Every hit was on the page already: the search row still offers the rest.
    if (kinds.length === 0 && searchRow) groups.push({ label: section.label, items: [searchRow] })
    kinds.forEach(([kind, items], index) => {
      const last = index === kinds.length - 1
      const owner = ownerOf(kind) ?? section
      groups.push({
        label: owner.searchLabels?.[kind] ?? owner.label,
        items: last && searchRow ? [...items, searchRow] : items,
      })
    })
  }
  return groups
}

/**
 * One group per label, in the order labels first appear: the page's
 * "Collections" and the engine's are one list, and no two groups share a
 * name (or a React key).
 */
export function mergeGroups(groups: readonly PaletteGroup[]): PaletteGroup[] {
  const byLabel = new Map<string, PaletteGroup>()
  for (const group of groups) {
    const known = byLabel.get(group.label)
    if (known) known.items = [...known.items, ...group.items]
    else byLabel.set(group.label, { label: group.label, items: group.items })
  }
  return [...byLabel.values()].filter((group) => group.items.length > 0)
}

export function CommandPalette() {
  const open = useConsoleUi((state) => state.paletteOpen)
  const setOpen = useConsoleUi((state) => state.setPaletteOpen)
  const providers = usePaletteProviders((state) => state.providers)
  const navigate = useNavigate()
  const client = useQueryClient()
  const status = useQuery(statusQuery)
  const [search, setSearch] = useState('')
  const navOpen = useLayout((state) => state.navOpen)
  const toggleNav = useLayout((state) => state.toggleNav)
  const panel = useLayout((state) => state.panel)
  const panelOpen = useLayout(panelShown)
  const togglePanel = useLayout((state) => state.togglePanel)
  const theme = useTheme((state) => state.choice)
  const mode = useTheme((state) => state.mode)
  const setTheme = useTheme((state) => state.setChoice)
  const setShortcutsOpen = useConsoleUi((state) => state.setShortcutsOpen)
  const engine = useEngineSearch(search, open)

  const go = useMemo(
    () => (link: SectionLink) => () => void navigate({ to: link.to, search: link.search } as never),
    [navigate],
  )

  const sections = useMemo<PaletteItem[]>(() => {
    const entries = new Map(status.data?.sections.map((entry) => [entry.id, entry]))
    const items: PaletteItem[] = [
      {
        id: 'overview',
        title: 'Overview',
        keywords: 'home status services',
        icon: <GaugeIcon size={16} />,
        run: go({ to: '/' }),
      },
    ]
    for (const section of SECTIONS) {
      const state = entries.get(section.id)?.state
      items.push({
        id: section.to,
        title: section.label,
        ...(state === 'absent'
          ? { description: 'Not running' }
          : state === 'starting'
            ? { description: 'Starting' }
            : {}),
        keywords: [section.id, ...section.services].join(' '),
        icon: <section.icon size={16} />,
        run: go({ to: section.to }),
      })
      // A section's other pages, under its name: `Firestore › Rules`.
      for (const page of section.pages?.slice(1) ?? [])
        items.push({
          id: page.to,
          title: page.label,
          breadcrumbs: [section.label],
          keywords: [section.id, page.keywords ?? ''].join(' '),
          icon: <section.icon size={16} />,
          run: go({ to: page.to }),
        })
    }
    // What firebase.json configures that Firenook does not emulate: said
    // here so a search for it finds the reason rather than nothing.
    for (const service of status.data?.unsupported ?? [])
      items.push({
        id: `unsupported:${service.name}`,
        title: service.detail,
        keywords: `${service.name} unsupported not emulated`,
        icon: <ProhibitIcon size={16} />,
        run: () =>
          toast({ key: `unsupported:${service.name}`, title: service.detail, tone: 'info' }),
      })
    items.push({
      id: 'legacy-ui',
      title: 'Open the Google Emulator UI',
      keywords: 'legacy official firebase',
      icon: <ArrowSquareOutIcon size={16} />,
      run: () => window.open('/', '_blank', 'noopener'),
    })
    return items
  }, [go, status.data])

  // What each running section's registry offers from anywhere.
  const actions = useMemo<PaletteItem[]>(() => {
    const entries = new Map(status.data?.sections.map((entry) => [entry.id, entry]))
    return SECTIONS.filter((section) => entries.get(section.id)?.state !== 'absent').flatMap(
      (section) =>
        (SECTION_ACTIONS[section.id] ?? []).map<PaletteItem>((action) => ({
          id: `action:${action.id}`,
          title: action.title,
          description: action.description,
          keywords: [section.label, action.keywords ?? ''].join(' '),
          icon: <action.icon size={16} />,
          run: go(action.link),
        })),
    )
  }, [go, status.data])

  // The suite's own actions, registered once, here.
  const suite = useMemo<PaletteItem[]>(() => {
    const data = status.data
    if (!data) return []
    const items: PaletteItem[] = []
    if (data.services.some((service) => service.name === 'functions')) {
      const enabled = data.backgroundTriggers.enabled
      items.push({
        id: 'suite:background',
        title: enabled ? 'Pause background triggers' : 'Resume background triggers',
        description: enabled
          ? 'Events are dropped, not queued, until they are resumed'
          : 'Events reach the functions that listen for them again',
        keywords: 'background triggers functions pause resume events',
        icon: enabled ? <PauseIcon size={16} /> : <PlayIcon size={16} />,
        run: () =>
          void apiSend<BackgroundTriggers>('POST', '/suite/background', { enabled: !enabled })
            .then((triggers) =>
              client.setQueryData<ConsoleStatus>(statusQuery.queryKey, (current) =>
                current ? { ...current, backgroundTriggers: triggers } : current,
              ),
            )
            .catch((error: unknown) =>
              toast({
                key: 'suite-background',
                title: enabled
                  ? 'Background triggers were not paused'
                  : 'Background triggers were not resumed',
                description: error instanceof Error ? error.message : String(error),
                tone: 'danger',
              }),
            ),
      })
    }
    items.push(
      {
        id: 'suite:save',
        title: 'Save a snapshot on the engine’s machine…',
        description: 'A standard export in a folder the engine lists',
        keywords: 'snapshot export save folder disk backup data',
        icon: <FloppyDiskIcon size={16} />,
        run: go({ to: '/', search: { dialog: 'save' } }),
      },
      {
        id: 'suite:engine',
        title: 'Engine details',
        description: 'Version, where the data lives, folders and the switches it was started with',
        keywords: 'engine version config data disk memory state durability debug log node',
        icon: <CpuIcon size={16} />,
        run: () => openEngineDetails(navigate),
      },
    )
    return items
  }, [status.data, client, go, navigate])

  // How the shell is laid out: the navigation and the section panel.
  const layout = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: 'layout:nav',
        title: navOpen ? 'Collapse the sidebar' : 'Expand the sidebar',
        description: navOpen ? 'Icons only; hover to peek · [' : 'Icons and labels · [',
        keywords: 'navigation layout sidebar collapse expand',
        icon: <PanelIcon open={navOpen} size={16} />,
        run: toggleNav,
      },
    ]
    if (panel.present)
      items.push({
        id: 'layout:panel',
        title: `${panelOpen ? 'Hide' : 'Show'} the ${panel.label.toLowerCase()} panel`,
        description: 'The column beside the content · t',
        keywords: 'layout tree schema rail sidebar',
        icon: <PanelIcon open={panelOpen} size={16} />,
        run: togglePanel,
      })
    // Every theme is offered, the one in force included, so the list says
    // which it is instead of hiding it.
    for (const option of THEME_CHOICES)
      items.push({
        id: `layout:theme:${option.choice}`,
        title: `${option.label} theme`,
        description:
          option.choice === theme ? `In use · ${describeTheme(theme, mode)}` : 'Colour scheme',
        keywords: 'theme colour color scheme dark light appearance',
        icon: <option.icon size={16} />,
        run: () => setTheme(option.choice),
      })
    items.push({
      id: 'layout:shortcuts',
      title: 'Keyboard shortcuts',
      description: `Every key this page answers to · ${describeKey('?')}`,
      keywords: 'keys keyboard shortcuts hotkeys help',
      icon: <KeyboardIcon size={16} />,
      run: () => setShortcutsOpen(true),
    })
    return items
  }, [navOpen, toggleNav, panel, panelOpen, togglePanel, theme, mode, setTheme, setShortcutsOpen])

  // What the page on screen contributes comes first, then what the engine
  // found; the sections, actions, suite and layout always follow.
  const groups = useMemo<PaletteGroup[]>(() => {
    const contributed = Object.values(providers).flatMap((provider) => provider(search))
    const filter = (items: PaletteItem[]) => items.filter((item) => matchesQuery(item, search))
    const offered = new Set(
      contributed.flatMap((group) =>
        group.items.flatMap((item) => (item.ref ? [refId(item.ref)] : [])),
      ),
    )
    // What is typed has moved on since the engine answered: its hits wait.
    const found =
      engine.text === search.trim()
        ? engineGroups(engine.results, engine.text, status.data, go, offered)
        : []
    return mergeGroups([
      ...contributed,
      ...found,
      { label: 'Sections', items: filter(sections) },
      { label: 'Actions', items: filter(actions) },
      { label: 'Suite', items: filter(suite) },
      { label: 'Layout', items: filter(layout) },
    ])
  }, [
    providers,
    search,
    engine.text,
    engine.results,
    status.data,
    go,
    sections,
    actions,
    suite,
    layout,
  ])

  const choose = (item: PaletteItem) => {
    setOpen(false)
    setSearch('')
    item.run()
  }

  return (
    <KumoCommandPalette.Root<PaletteGroup, PaletteItem>
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
      items={groups}
      value={search}
      onValueChange={setSearch}
      itemToStringValue={(group) => group.label}
      onSelect={choose}
      getSelectableItems={(all) => all.flatMap((group) => group.items)}
    >
      <KumoCommandPalette.Input placeholder="Jump anywhere…" data-testid="palette-input" />
      <KumoCommandPalette.List>
        <KumoCommandPalette.Results>
          {(group: PaletteGroup) => (
            <KumoCommandPalette.Group key={group.label} items={group.items}>
              <KumoCommandPalette.GroupLabel>{group.label}</KumoCommandPalette.GroupLabel>
              <KumoCommandPalette.Items>
                {(item: PaletteItem) => (
                  <KumoCommandPalette.ResultItem
                    key={item.id}
                    title={item.title}
                    {...(item.breadcrumbs ? { breadcrumbs: item.breadcrumbs } : {})}
                    {...(item.description ? { description: item.description } : {})}
                    icon={item.icon}
                    value={item}
                    onClick={() => choose(item)}
                  />
                )}
              </KumoCommandPalette.Items>
            </KumoCommandPalette.Group>
          )}
        </KumoCommandPalette.Results>
        <KumoCommandPalette.Empty>Nothing matches</KumoCommandPalette.Empty>
      </KumoCommandPalette.List>
      <KumoCommandPalette.Footer>
        <span className="flex items-center gap-2">
          <Kbd className="px-1.5 py-0.5">↑↓</Kbd>
          <span>Navigate</span>
        </span>
        <span className="flex items-center gap-2">
          <Kbd className="px-1.5 py-0.5">↵</Kbd>
          <span>Open</span>
        </span>
        {engine.error ? (
          <span className="ml-auto truncate text-kumo-danger" data-testid="palette-search-error">
            Search failed: {engine.error.message}
          </span>
        ) : null}
      </KumoCommandPalette.Footer>
    </KumoCommandPalette.Root>
  )
}
