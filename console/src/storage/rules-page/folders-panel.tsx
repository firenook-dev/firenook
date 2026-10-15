// The rules against the bucket's files: every folder shape that holds files
// directly, with the match blocks that govern it and what they allow; the
// folders no rule covers, where every client request is denied; folders too
// deep to analyse; the match blocks that reach no file at all (usually a
// typo in a path). Only an emulator can draw this: it holds both the rules
// and the files. The engine's warnings about the rules are the Problems
// strip's.
//
// It follows the files: an upload into a folder no rule covers shows up
// here as it lands (the `storage.objects` topic asks the map again, at most
// once a second), and the map arrives by itself once the folder index is
// built.

import { Button, DropdownMenu, Text, Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, MagicWandIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { RulesOperation } from '@/api/generated/RulesOperation'
import type { StorageFolderRules } from '@/api/generated/storage/StorageFolderRules'
import { RequiresNotice } from '@/components/console/requires-notice'
import { formatNumber } from '@/lib/format'
import { searchIdentityUsers } from '@/lib/identity'
import { createInvalidator } from '@/lib/live/use-live-topic'
import { toast } from '@/lib/toasts'
import type { RulesDraft } from '@/rules/draft'
import { RulesMapPanel } from '@/rules/map-panel'
import { STORAGE_ROOT, insertStarter } from '@/rules/starter'
import { useStorageObjectsLive } from '../live'
import { profileQuery, storageKeys, storageRulesCheckQuery } from '../queries'
import { TEMPLATES, starterFromData, uncoveredRoots } from './starter'

/** How often file changes may ask the map again, ms. */
const MAP_REFRESH_MS = 1_000

/** Whether a ruleset reads Firestore, which then has to run for it to mean anything. */
export function readsFirestore(source: string): boolean {
  return /\bfirestore\s*\.\s*(get|exists)\s*\(/.test(source)
}

/** What an allow grants, the way people say it: `read, write`, `read, create`, `get`. */
export function operationsText(operations: readonly RulesOperation[]): string {
  const has = new Set(operations)
  const words: string[] = []
  if (has.has('get') && has.has('list')) words.push('read')
  else for (const op of ['get', 'list'] as const) if (has.has(op)) words.push(op)
  if (has.has('create') && has.has('update') && has.has('delete')) words.push('write')
  else for (const op of ['create', 'update', 'delete'] as const) if (has.has(op)) words.push(op)
  return words.join(', ')
}

/** A folder shape as the panel writes it. */
export function patternText(pattern: string): string {
  return pattern === '' ? '(bucket root)' : pattern
}

export function FoldersPanel({
  project,
  scope,
  bucket,
  draft,
  checked,
  onReveal,
}: {
  project: string
  scope: string
  /** The bucket the map is drawn for (the page's). */
  bucket: string
  draft: RulesDraft
  /** The text the page last checked, which the map describes; none before the rules load. */
  checked: string | undefined
  onReveal: (line: number) => void
}) {
  const queryClient = useQueryClient()
  const check = useQuery({
    ...storageRulesCheckQuery(project, scope, checked ?? ''),
    enabled: checked !== undefined,
  })
  const map = check.data?.map ?? null
  const [writing, setWriting] = useState(false)

  // File changes and the index's arrival ask the map again.
  const [refresh] = useState(() =>
    createInvalidator(
      (key) => void queryClient.invalidateQueries({ queryKey: key }),
      MAP_REFRESH_MS,
    ),
  )
  useEffect(() => () => refresh.dispose(), [refresh])
  useStorageObjectsLive(project, bucket, {
    onChanged: (batch) => {
      if (batch.indexReady || batch.truncated || batch.changes.length > 0)
        refresh.push([[...storageKeys.rules(project, scope).slice(0, 3), 'rules-check']])
    },
  })

  const insert = (blocks: readonly string[], title: string) =>
    insertStarter(draft, blocks, STORAGE_ROOT, title, onReveal)

  const fromData = async (patterns: readonly string[]) => {
    if (patterns.length === 0) return
    setWriting(true)
    try {
      // The project's users, by uid, to tell whose folder a folder is
      // (the engine's bounded identity search; no Auth, no owners).
      let uids = new Set<string>()
      try {
        uids = new Set(
          (await searchIdentityUsers(project, '', { limit: 50 })).map((user) => user.uid),
        )
      } catch {
        uids = new Set()
      }
      const blocks = await Promise.all(
        patterns.map(async (pattern) => {
          const star = pattern.indexOf('*')
          const prefix =
            star === -1 ? pattern : pattern.slice(0, pattern.lastIndexOf('/', star) + 1)
          const profile = await queryClient.fetchQuery(profileQuery(project, bucket, prefix))
          return starterFromData(pattern, profile, star === -1 ? uids : new Set())
        }),
      )
      insert(
        blocks,
        patterns.length === 1
          ? `Starter rules for ${patternText(patterns[0] ?? '')} are in the editor`
          : `Starter rules for ${patterns.length} folders are in the editor`,
      )
    } catch (error) {
      toast({
        key: 'rules-starter',
        title: 'No starter rules',
        description: (error as Error).message,
        tone: 'danger',
      })
    } finally {
      setWriting(false)
    }
  }

  const roots = map ? uncoveredRoots(map.folders) : []

  return (
    <RulesMapPanel
      testId="folders"
      check={check}
      checked={checked}
      notice={
        readsFirestore(draft.source) && (
          <RequiresNotice section="firestore" for="firestore.get() in these rules" />
        )
      }
      header={
        <div className="flex shrink-0 items-center gap-2 border-b border-kumo-line px-3 py-2">
          <span
            className="min-w-0 truncate font-mono text-[12px] text-kumo-subtle"
            title={`gs://${bucket}`}
          >
            gs://{bucket}
          </span>
          <span className="ml-auto shrink-0">
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<MagicWandIcon />}
                    loading={writing}
                    data-testid="rules-starter-menu"
                  >
                    Add starter rules
                    <CaretDownIcon size={12} className="text-kumo-subtle" />
                  </Button>
                }
              />
              <DropdownMenu.Content align="end" className="w-80">
                <DropdownMenu.Item
                  disabled={roots.length === 0}
                  onClick={() => void fromData(roots)}
                  data-testid="rules-starter-data"
                >
                  <span className="grid gap-0.5">
                    <span>From this bucket’s data</span>
                    <span className="text-[12px] text-kumo-subtle">
                      {roots.length === 0 ? (
                        'Every folder with files is governed already.'
                      ) : roots.length === 1 ? (
                        <>
                          A block for{' '}
                          <span className="font-mono">{patternText(roots[0] ?? '')}</span>, which no
                          rule covers, from what it holds.
                        </>
                      ) : (
                        `A block for each of the ${roots.length} folders no rule covers, from what each holds.`
                      )}
                    </span>
                  </span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                {TEMPLATES.map((template) => (
                  <DropdownMenu.Item
                    key={template.id}
                    onClick={() => insert([template.block], `${template.title} is in the editor`)}
                    data-testid={`rules-starter-${template.id}`}
                  >
                    <span className="grid gap-0.5">
                      <span className="flex items-baseline gap-2">
                        {template.title}
                        <span className="font-mono text-[11px] text-kumo-subtle">
                          {template.path}
                        </span>
                      </span>
                      <span className="text-[12px] text-kumo-subtle">{template.description}</span>
                    </span>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu>
          </span>
        </div>
      }
      map={map ? { rows: map.folders.length, unused: map.unusedMatches } : map}
      title="Folders that hold files"
      aside={
        map?.grouped && (
          <Text as="span" size="xs" variant="secondary">
            Levels with more than 20 folders are grouped as *.
          </Text>
        )
      }
      holds="files"
      unused={{
        title: 'Rules that reach no files',
        note: `No file in gs://${bucket} matches these. A typo in a path, or a folder that is not there yet.`,
      }}
      emptyText={`gs://${bucket} holds no files yet.`}
      countingText="Counting what is under each folder. The map appears as soon as the folder index is built; listing does not wait for it."
      onReveal={onReveal}
      rows={map?.folders.map((folder) => (
        <FolderRow
          key={folder.pattern}
          folder={folder}
          writing={writing}
          onStarter={() => void fromData([folder.pattern])}
          onReveal={onReveal}
        />
      ))}
    />
  )
}

function FolderRow({
  folder,
  writing,
  onStarter,
  onReveal,
}: {
  folder: StorageFolderRules
  writing: boolean
  onStarter: () => void
  onReveal: (line: number) => void
}) {
  return (
    <li
      className="grid gap-1 rounded-md px-2 py-1.5 hover:ink"
      data-testid="rules-folder"
      data-pattern={folder.pattern}
      data-uncovered={folder.uncovered || undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
          {patternText(folder.pattern)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-kumo-subtle tabular-nums">
          {formatNumber(folder.files)} {folder.files === 1 ? 'file' : 'files'}
        </span>
      </div>
      {folder.uncovered ? (
        <div className="flex items-center gap-2">
          <Text size="xs" variant="error">
            Uncovered — every client request is denied.
          </Text>
          <Button
            variant="ghost"
            size="xs"
            icon={<MagicWandIcon />}
            className="ml-auto"
            loading={writing}
            onClick={onStarter}
            data-testid="rules-folder-starter"
          >
            Add starter rules
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          {folder.governedBy.map((block) => (
            <Tooltip
              key={`${block.line}:${block.path}`}
              content={`match ${block.path}`}
              render={
                <button
                  type="button"
                  onClick={() => onReveal(block.line)}
                  className="min-w-0 truncate rounded bg-kumo-tint px-1.5 text-left font-mono text-[11px] text-kumo-default hover:ink"
                  data-testid="rules-folder-block"
                >
                  line {block.line}: {operationsText(block.operations) || 'nothing'}
                </button>
              }
            />
          ))}
        </div>
      )}
      {folder.deeper && (
        <Text size="xs" variant="secondary">
          Deeper levels not analysed: folders below hold files past the analysis depth.
        </Text>
      )}
    </li>
  )
}
