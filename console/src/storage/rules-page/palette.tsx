// What ⌘K offers on the Storage rules page: the things an edit ends in
// (Apply, Save, Revert), History, coverage on or off, each panel beside the
// editor, starter rules, and the saved tests as a rules-unit-testing file.

import {
  ArrowCounterClockwiseIcon,
  ChartBarHorizontalIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  FloppyDiskIcon,
  FlaskIcon,
  FoldersIcon,
  ListChecksIcon,
  MagicWandIcon,
  PlayIcon,
  ScalesIcon,
} from '@phosphor-icons/react'
import { useEffect, useMemo } from 'react'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import type { RulesDraft } from '@/rules/draft'
import type { StorageRulesPanel } from './rules-search'
import type { TestCase } from './tests-store'

/** A text file the browser saves, made here. */
function saveText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export function useStorageRulesPalette({
  draft,
  coverageOn,
  setCoverageOn,
  openHistory,
  openPanel,
  cases,
  exportFile,
}: {
  draft: RulesDraft
  coverageOn: boolean
  setCoverageOn: (on: boolean) => void
  openHistory: () => void
  openPanel: (panel: StorageRulesPanel) => void
  cases: readonly TestCase[]
  exportFile: (cases: readonly TestCase[]) => { name: string; text: string }
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const file = draft.rules.data?.path
  const edited = draft.edited

  const provider = useMemo(() => {
    const items: PaletteItem[] = []
    if (edited)
      items.push(
        {
          id: 'storage-rules:apply',
          title: 'Apply the draft',
          description: 'In force from the next request',
          keywords: 'rules install',
          icon: <PlayIcon size={16} />,
          run: () => draft.apply(false),
        },
        {
          id: 'storage-rules:revert',
          title: 'Revert the draft',
          description: 'Back to the rules in force',
          keywords: 'rules discard undo',
          icon: <ArrowCounterClockwiseIcon size={16} />,
          run: draft.revert,
        },
      )
    if (file && (edited || draft.fileSource !== draft.inForce))
      items.push({
        id: 'storage-rules:save',
        title: 'Save the rules',
        description: `Apply and write ${file.slice(file.lastIndexOf('/') + 1)}`,
        keywords: 'rules write file disk',
        icon: <FloppyDiskIcon size={16} />,
        run: () => draft.apply(true),
      })
    items.push(
      {
        id: 'storage-rules:history',
        title: 'Rules history',
        description: 'Every version, and the file on disk',
        keywords: 'versions diff restore',
        icon: <ClockCounterClockwiseIcon size={16} />,
        run: openHistory,
      },
      {
        id: 'storage-rules:coverage',
        title: coverageOn ? 'Hide coverage' : 'Show coverage',
        description: 'How often each rule has run',
        keywords: 'rules counts gutter',
        icon: <ChartBarHorizontalIcon size={16} />,
        run: () => setCoverageOn(!coverageOn),
      },
      {
        id: 'storage-rules:decisions',
        title: 'Decisions',
        description: 'Every request the rules judged',
        keywords: 'requests denied allowed why',
        icon: <ScalesIcon size={16} />,
        run: () => openPanel('decisions'),
      },
      {
        id: 'storage-rules:playground',
        title: 'Playground',
        description: 'Try a request against the draft',
        keywords: 'simulate test request',
        icon: <FlaskIcon size={16} />,
        run: () => openPanel('playground'),
      },
      {
        id: 'storage-rules:tests',
        title: 'Tests',
        description: 'Saved requests and the verdict each should get',
        keywords: 'saved cases',
        icon: <ListChecksIcon size={16} />,
        run: () => openPanel('tests'),
      },
      {
        id: 'storage-rules:folders',
        title: 'Folders',
        description: 'Which rules govern which folders',
        keywords: 'map uncovered coverage',
        icon: <FoldersIcon size={16} />,
        run: () => openPanel('folders'),
      },
      {
        id: 'storage-rules:starter',
        title: 'Add starter rules',
        description: 'From a template or from the bucket’s files',
        keywords: 'template generate',
        icon: <MagicWandIcon size={16} />,
        run: () => openPanel('folders'),
      },
    )
    if (cases.length > 0)
      items.push({
        id: 'storage-rules:export-tests',
        title: 'Export tests as a rules-unit-testing file',
        description: `${cases.length} test${cases.length === 1 ? '' : 's'}`,
        keywords: 'download ci',
        icon: <DownloadSimpleIcon size={16} />,
        run: () => {
          const exported = exportFile(cases)
          saveText(exported.name, exported.text, 'text/typescript')
        },
      })
    return (query: string): PaletteGroup[] => {
      const shown = items.filter((item) => matchesQuery(item, query))
      return shown.length > 0 ? [{ label: 'Storage rules', items: shown }] : []
    }
  }, [draft, edited, file, coverageOn, setCoverageOn, openHistory, openPanel, cases, exportFile])

  useEffect(() => {
    register('storage-rules', provider)
    return () => unregister('storage-rules')
  }, [register, unregister, provider])
}
