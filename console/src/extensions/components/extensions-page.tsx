// The Extensions section: the instances in the panel, and either all of
// them in a table or one of them in full — its source and offline
// readiness, its configuration with the file each value comes from (and a
// Save that writes that file and reloads the instance once), the functions
// it adds, the events it publishes and its own notes. Everything follows
// the engine live through `extensions.changes`; nothing polls.

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { statusQuery } from '@/api/queries'
import { FilterField } from '@/components/console/filter-field'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { liveChannel } from '@/lib/live/channel'
import { useRouteSearch } from '@/lib/search-params'
import { useReloadInstance, useVendorInstance } from '../actions'
import { instancesQuery } from '../api'
import { useExtensionsChanges } from '../live'
import { useExtensionsPalette } from '../palette'
import { type ExtensionsSearch, type InstanceView as View, viewOf, viewPatch } from '../search'
import { InstanceView } from './instance-view'
import { InstancesPanel, instanceMatches } from './instances-panel'
import { InstancesTable } from './instances-table'
import { VendorDialog } from './vendor-dialog'

/** The overview filter takes words only: an instance's id, name, version, source. */
const OVERVIEW_FIELDS = [] as const

export function ExtensionsPage() {
  const { search, update } = useRouteSearch<ExtensionsSearch>('/extensions', '/extensions')
  const project = useQuery(statusQuery).data?.projectId ?? ''
  const live = useExtensionsChanges(true)
  const list = useQuery(instancesQuery(project))
  const instances = list.data?.instances ?? []
  const dropped = list.data?.dropped ?? []
  const current = search.instance
  const listed = instances.find((summary) => summary.instanceId === current)
  const reload = useReloadInstance(project)
  const vendor = useVendorInstance(project)
  // The instance the vendor dialog is about stays set after it closes, so
  // the dialog keeps its words while it animates away.
  const [vendoring, setVendoring] = useState<{ instance: string; open: boolean } | undefined>(
    undefined,
  )

  const open = (instance: string | undefined, view?: View) =>
    update({
      instance,
      q: undefined,
      ...viewPatch(view ?? 'overview'),
      ...(view === 'configuration' ? { edit: true } : {}),
    })
  const startVendor = (instance: string) => {
    vendor.reset()
    setVendoring({ instance, open: true })
  }

  useExtensionsPalette(instances, listed, {
    open: (instance) => open(instance),
    configure: (instance) => open(instance, 'configuration'),
    reload: (instance) => reload.mutate(instance),
    vendor: startVendor,
  })

  // Always mounted while there is an instance to vendor (dialogs open and
  // close by their `open`, never by being added and removed).
  const vendorTarget =
    instances.find((summary) => summary.instanceId === vendoring?.instance) ?? instances[0]
  return (
    <SectionPage section="extensions" title="Extensions" testId="extensions-page">
      <InstancesPanel
        instances={instances}
        dropped={dropped}
        current={current}
        onOpen={(instance) => open(instance)}
        loading={list.isPending}
      />
      {current ? (
        <InstanceView
          key={current}
          project={project}
          instance={current}
          listed={listed}
          view={viewOf(search)}
          editing={search.edit === true && viewOf(search) === 'configuration'}
          live={live}
          reloading={reload.isPending && reload.variables === current}
          onView={(view) => update(viewPatch(view), { replace: true })}
          onEditingChange={(editing) => update({ edit: editing || undefined }, { replace: true })}
          onReload={() => reload.mutate(current)}
          onVendor={() => startVendor(current)}
        />
      ) : (
        <>
          <ToolbarRow testId="extensions-toolbar">
            <PanelToggle where="toolbar" />
            <span className="min-w-0 truncate px-1 text-[12px] font-medium text-kumo-default">
              All instances
            </span>
            {(live === 'ended' || live === 'refused') && (
              <>
                <ToolbarDivider />
                <LiveNotice
                  status={live}
                  what="the instances"
                  onRetry={() => liveChannel.retry()}
                />
              </>
            )}
          </ToolbarRow>
          {/* Nothing to filter in a project with no instance: the empty state says how to add one. */}
          {(list.isPending || instances.length > 0 || search.q) && (
            <ToolbarRow variant="line" testId="extensions-filter-row">
              <FilterField
                value={search.q ?? ''}
                onChange={(text) => update({ q: text }, { replace: true })}
                fields={OVERVIEW_FIELDS}
                placeholder="Filter instances — words in an id, name, version or source"
                ariaLabel="Filter instances"
                testId="extensions-filter"
              />
              <MatchCount
                total={
                  list.data
                    ? {
                        count: instances.filter((summary) =>
                          instanceMatches(summary, search.q ?? ''),
                        ).length,
                        exact: true,
                      }
                    : undefined
                }
                loading={list.isPending}
                noun={{ one: 'instance', other: 'instances' }}
                widest="000"
                tooltip="Every instance in firebase.json whose words match."
              />
            </ToolbarRow>
          )}
          <SectionBody testId="extensions-body">
            <InstancesTable
              instances={instances}
              dropped={dropped}
              filter={search.q ?? ''}
              onClearFilter={() => update({ q: undefined }, { replace: true })}
              loading={list.isPending}
              onOpen={(instance, view) => open(instance, view)}
              onReload={(instance) => reload.mutate(instance)}
            />
          </SectionBody>
        </>
      )}
      {vendorTarget && (
        <VendorDialog
          open={vendoring?.open === true && vendoring.instance === vendorTarget.instanceId}
          onOpenChange={(next) => {
            if (!next) setVendoring((shown) => shown && { ...shown, open: false })
          }}
          summary={vendorTarget}
          pending={vendor.isPending}
          result={vendor.data}
          error={vendor.error}
          onConfirm={() => vendor.mutate(vendorTarget.instanceId)}
        />
      )}
    </SectionPage>
  )
}
