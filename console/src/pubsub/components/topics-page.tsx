// Pub/Sub's Topics page: the topics tree in the panel, row one with where
// you are (`project › topic › subscription`, a field you can type into) and
// what acts on the whole scope, then the scope itself — the landing at the
// root, a topic with its tabs, or a subscription with its own. Everything on
// it is live through the console's one channel: `pubsub.counters` keeps the
// tree's figures and the index current, and the open topic holds
// `pubsub.topic` for its messages.

import { Button, DropdownMenu, Tooltip } from '@cloudflare/kumo'
import {
  BracketsCurlyIcon,
  BroadcastIcon,
  CaretDownIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  TrayArrowDownIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { LiveNotice } from '@/components/console/live-notice'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { linkTo } from '@/lib/links'
import { type SubscriptionStatus, liveChannel } from '@/lib/live/channel'
import { type PaletteItem, matchesQuery, usePaletteProviders } from '@/lib/palette'
import { useConsoleProject } from '@/lib/project'
import { useRouteSearch } from '@/lib/search-params'
import { useShortcuts } from '@/lib/shortcuts'
import { resourceFromSearch } from '@/messaging/links'
import type { PubsubSearch } from '@/routes/pubsub'
import { usePubsubCounters } from '../live'
import { type TypedScope, findSubscription, searchValue, shortName } from '../names'
import { subscriptionQuery, topicIndexQuery } from '../queries'
import type { TreeTarget } from '../tree'
import { CreateSubscriptionDialog } from './create-subscription-dialog'
import { CreateTopicDialog } from './create-topic-dialog'
import { ScopeField } from './scope-field'
import { PurgeButton } from './purge'
import { type SetupTab, SetupDialog } from './setup-dialog'
import { SubscriptionPage } from './subscription-page'
import { LANDING_CARDS, TopicsLanding, landingTopics } from './topics-landing'
import { TopicsPanel } from './topics-panel'
import { TopicView } from './topic-view'

/** Every parameter that belongs to a scope: cleared when the scope changes. */
const SCOPED = {
  topic: undefined,
  subscription: undefined,
  view: undefined,
  message: undefined,
  tab: undefined,
  q: undefined,
  expr: undefined,
  state: undefined,
  paused: undefined,
  prefill: undefined,
  new: undefined,
  dialog: undefined,
} satisfies Partial<PubsubSearch>

/** The worst of a page's subscriptions, for the one notice row one has room for. */
function worstStatus(
  ...statuses: (SubscriptionStatus | undefined)[]
): SubscriptionStatus | undefined {
  return (
    statuses.find((status) => status === 'refused') ??
    statuses.find((status) => status === 'ended') ??
    statuses[0]
  )
}

export function TopicsPage() {
  const status = useQuery(statusQuery)
  const configured = status.data?.projectId
  const { project, foreign } = useConsoleProject()
  const { search, update } = useRouteSearch<PubsubSearch>('/pubsub', '/pubsub')
  const index = useQuery(topicIndexQuery(project))
  const navigate = useNavigate()

  // The scope from the parameters: an id under the page's project, or a whole name.
  const topic = resourceFromSearch(search.topic, 'topics', project)
  const subscription = resourceFromSearch(search.subscription, 'subscriptions', project)
  const subscriptionSummary = subscription ? findSubscription(index.data, subscription) : undefined
  const topicSummary = index.data?.items.find(
    (item) => item.name === (topic ?? subscriptionSummary?.topic),
  )
  const detached =
    subscription !== undefined &&
    subscriptionSummary !== undefined &&
    subscriptionSummary.topic === null

  // Links always name the project; the configured one need not show.
  useEffect(() => {
    if (configured !== undefined && search.project === configured)
      update({ project: undefined }, { replace: true })
  }, [configured, search.project, update])
  // A subscription link does not say its topic: the index does.
  useEffect(() => {
    if (search.subscription && !search.topic && subscriptionSummary?.topic)
      update(
        { topic: searchValue(subscriptionSummary.topic, 'topics', project) },
        { replace: true },
      )
  }, [search.subscription, search.topic, subscriptionSummary?.topic, project, update])

  // Throughput travels only for what is on screen: the topic in view, or the landing's cards.
  const followed = topic
    ? [topic]
    : subscription
      ? []
      : landingTopics(index.data)
          .slice(0, LANDING_CARDS)
          .map((item) => item.name)
  const counters = usePubsubCounters(project || undefined, followed)
  const [topicLive, setTopicLive] = useState<SubscriptionStatus | undefined>(undefined)
  const live = worstStatus(counters, topic || subscription ? topicLive : undefined)

  const goTo = (scope: TypedScope, extra: Partial<PubsubSearch> = {}) =>
    update({
      ...SCOPED,
      ...(scope.topic ? { topic: searchValue(scope.topic, 'topics', project) } : {}),
      ...(scope.subscription
        ? { subscription: searchValue(scope.subscription, 'subscriptions', project) }
        : {}),
      ...extra,
    })
  const openSubscription = (name: string) => {
    const found = findSubscription(index.data, name)
    goTo(found?.topic ? { topic: found.topic, subscription: name } : { subscription: name })
  }
  const openTarget = (target: TreeTarget) => {
    if (target.kind === 'project') {
      update({ ...SCOPED, project: target.project === configured ? undefined : target.project })
      return
    }
    if (target.kind === 'schedule') {
      const link = linkTo({ kind: 'pubsub.schedule', key: target.functionId })
      if (link) void navigate({ to: link.to as never, search: link.search as never })
      return
    }
    if (target.kind === 'topic') goTo({ topic: target.topic })
    else
      goTo(
        target.topic
          ? { topic: target.topic, subscription: target.subscription }
          : { subscription: target.subscription },
      )
  }
  const switchProject = (next: string) =>
    update({ ...SCOPED, project: next === configured ? undefined : next })
  const createTopic = (id?: string) => update({ new: 'topic', prefill: id || undefined })
  const createSubscription = () => update({ new: 'subscription' })
  // The composer is the Messages tab's inspector: it opens there.
  const compose = () =>
    update({
      new: 'message',
      prefill: undefined,
      message: undefined,
      tab: undefined,
      view: undefined,
    })
  const onTopic = topic !== undefined && subscription === undefined
  // A subscription the console can purge: not the functions' own, which is drained.
  const purgeable = subscription !== undefined && subscriptionSummary?.managed !== 'functions'
  const subscriptionDetail = useQuery({
    ...subscriptionQuery(project, subscription ?? ''),
    enabled: purgeable,
  })
  // The setup dialog's tab is the page's to choose: Import setup… opens on Import.
  const [setupTab, setSetupTab] = useState<SetupTab>('export')
  const openSetup = (tab: SetupTab) => {
    setSetupTab(tab)
    update({ dialog: 'setup', prefill: undefined })
  }

  useShortcuts({ id: 'pubsub-topics', label: 'Pub/Sub topics' }, [
    {
      key: 'n',
      label: 'New topic',
      when: () => !topic && !subscription,
      run: () => createTopic(),
    },
    {
      key: 'n',
      label: 'Publish a message',
      when: () => onTopic,
      run: compose,
    },
  ])
  usePubsubPalette({
    topic: subscription ? undefined : topic,
    onCreateTopic: () => createTopic(),
    onCreateSubscription: createSubscription,
    onPublish: compose,
    onSetup: openSetup,
  })

  // The tree's lit row: the subscription or topic in view; a function's row
  // for the subscription the emulator drains for it.
  const treeCurrent =
    subscriptionSummary?.managed === 'functions'
      ? topicSummary?.functions[0]?.functionId
      : (subscription ?? topic)
  const topics = index.data?.items.map((item) => item.name) ?? []

  return (
    <SectionPage section="pubsub" page="topics" title="Pub/Sub topics" testId="pubsub-page">
      <TopicsPanel
        index={index.data}
        project={project}
        current={treeCurrent}
        onOpen={openTarget}
        onProject={switchProject}
      />
      <SectionToolbar testId="pubsub-toolbar">
        <ToolbarRow testId="pubsub-row-one">
          <PanelToggle where="toolbar" />
          <ScopeField
            index={index.data}
            project={project}
            topic={topic ?? subscriptionSummary?.topic ?? undefined}
            subscription={subscription}
            detached={detached}
            onNavigate={(scope) => goTo(scope)}
            onCreateTopic={createTopic}
          />
          <ToolbarDivider />
          <LiveNotice
            status={live ?? counters}
            what="the messages and counts"
            onRetry={() => liveChannel.retry()}
            testId="pubsub-live"
          />
          <NewMenu
            primary={!topic && !subscription}
            topic={subscription ? undefined : topic}
            onTopic={() => createTopic()}
            onSubscription={createSubscription}
            onSchema={() =>
              void navigate({
                to: '/pubsub/schemas',
                search: { new: 'schema', ...(search.project ? { project: search.project } : {}) },
              })
            }
            onSetup={openSetup}
          />
          {purgeable && subscription && subscriptionDetail.data && (
            <PurgeButton
              project={project}
              subscription={subscription}
              retainAcked={subscriptionDetail.data.subscription.retainAcked}
              waiting={
                subscriptionSummary?.counters.backlog ??
                subscriptionDetail.data.subscription.summary.counters.backlog
              }
            />
          )}
          {onTopic && (
            <Tooltip
              content={
                <span className="flex items-center gap-1.5">
                  Publish a message to {shortName(topic)}
                  <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px] text-kumo-subtle">
                    n
                  </kbd>
                </span>
              }
              render={
                <Button
                  // Open, the composer has its own Publish: this one is then the pressed toggle.
                  variant={search.new === 'message' ? 'secondary' : 'primary'}
                  size="sm"
                  icon={<PaperPlaneTiltIcon />}
                  aria-pressed={search.new === 'message'}
                  onClick={compose}
                  data-testid="pubsub-publish"
                >
                  Publish
                </Button>
              }
            />
          )}
        </ToolbarRow>
      </SectionToolbar>
      <SectionBody testId="pubsub-body">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {subscription ? (
            <SubscriptionPage
              key={subscription}
              project={project}
              subscription={subscription}
              summary={subscriptionSummary}
              topic={topicSummary}
              topics={topics}
              search={search}
              update={update}
              onOpenTopic={(name) => goTo({ topic: name })}
              onOpenSubscription={openSubscription}
              onPublishTo={(name, prefill) => goTo({ topic: name }, { new: 'message', prefill })}
              onLiveStatus={setTopicLive}
              onDeleted={() => goTo(topicSummary ? { topic: topicSummary.name } : {})}
            />
          ) : topic ? (
            <TopicView
              key={topic}
              project={project}
              topic={topic}
              summary={topicSummary}
              search={search}
              update={update}
              onOpenSubscription={openSubscription}
              onCreateSubscription={createSubscription}
              onCreateTopic={(id) => createTopic(id)}
              onLiveStatus={setTopicLive}
              onDeleted={() => goTo({})}
            />
          ) : (
            <TopicsLanding
              index={index.data}
              project={project}
              foreign={foreign}
              onOpen={(name) => goTo({ topic: name })}
              onCreateTopic={createTopic}
              onImportSetup={() => openSetup('import')}
              onProject={switchProject}
            />
          )}
        </div>
      </SectionBody>
      <CreateTopicDialog
        open={search.new === 'topic'}
        project={project}
        initialId={search.new === 'topic' ? search.prefill : undefined}
        onOpenChange={(open) => {
          if (!open) update({ new: undefined, prefill: undefined }, { replace: true })
        }}
        onCreated={(name) => goTo({ topic: name })}
      />
      <SetupDialog
        open={search.dialog === 'setup'}
        onOpenChange={(open) => {
          if (!open) update({ dialog: undefined }, { replace: true })
        }}
        project={project}
        index={index.data}
        tab={setupTab}
        onTab={setSetupTab}
      />
      {topic && (
        <CreateSubscriptionDialog
          open={search.new === 'subscription'}
          project={project}
          topic={topic}
          topics={topics}
          initialFilter={search.expr}
          onOpenChange={(open) => {
            if (!open) update({ new: undefined }, { replace: true })
          }}
          onCreated={(name) => goTo({ topic, subscription: name })}
        />
      )}
    </SectionPage>
  )
}

/** Row one's one place to make something; the scope's primary when there is no other. */
function NewMenu({
  primary,
  topic,
  onTopic,
  onSubscription,
  onSchema,
  onSetup,
}: {
  primary: boolean
  topic: string | undefined
  onTopic: () => void
  onSubscription: () => void
  /** A new schema, on the Schemas page. */
  onSchema: () => void
  onSetup: (tab: SetupTab) => void
}) {
  return (
    <DropdownMenu>
      <Tooltip
        content={
          primary
            ? 'New topic (n) or schema, or the setup from a file'
            : 'New topic, subscription or schema, or the setup as a file'
        }
        render={
          <DropdownMenu.Trigger
            render={
              <Button
                variant={primary ? 'primary' : 'secondary'}
                size="sm"
                icon={<PlusIcon />}
                data-testid="pubsub-new-menu"
              >
                <span className="flex items-center gap-1">
                  New
                  <CaretDownIcon size={12} />
                </span>
              </Button>
            }
          />
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item icon={BroadcastIcon} onClick={onTopic} data-testid="pubsub-new-topic">
          <span className="flex flex-1 items-center gap-3">
            Topic
            {primary && <DropdownMenu.Shortcut>n</DropdownMenu.Shortcut>}
          </span>
        </DropdownMenu.Item>
        {topic && (
          <DropdownMenu.Item
            icon={TrayArrowDownIcon}
            onClick={onSubscription}
            data-testid="pubsub-new-subscription-item"
          >
            Subscription on <span className="font-mono text-[12px]">{shortName(topic)}</span>
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Item
          icon={BracketsCurlyIcon}
          onClick={onSchema}
          data-testid="pubsub-new-schema-item"
        >
          Schema…
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          icon={UploadSimpleIcon}
          onClick={() => onSetup('import')}
          data-testid="pubsub-import-setup"
        >
          Import setup…
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={DownloadSimpleIcon}
          onClick={() => onSetup('export')}
          data-testid="pubsub-export-setup"
        >
          Export setup…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** What the page offers ⌘K while it is on screen. */
function usePubsubPalette({
  topic,
  onCreateTopic,
  onCreateSubscription,
  onPublish,
  onSetup,
}: {
  topic: string | undefined
  onCreateTopic: () => void
  onCreateSubscription: () => void
  onPublish: () => void
  onSetup: (tab: SetupTab) => void
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  // The provider reads the page as it is when ⌘K asks, not as it was when registered.
  const actions = useRef({ topic, onCreateTopic, onCreateSubscription, onPublish, onSetup })
  useLayoutEffect(() => {
    actions.current = { topic, onCreateTopic, onCreateSubscription, onPublish, onSetup }
  })
  useEffect(() => {
    register('pubsub-topics', (query) => {
      const {
        topic: current,
        onCreateTopic: newTopic,
        onCreateSubscription: newSubscription,
        onPublish: publish,
        onSetup: setup,
      } = actions.current
      const items: PaletteItem[] = [
        {
          id: 'pubsub.page.new-topic',
          title: 'New topic',
          keywords: 'create pubsub',
          icon: <BroadcastIcon size={16} />,
          run: newTopic,
        },
        ...(current
          ? [
              {
                id: 'pubsub.page.publish',
                title: `Publish to ${shortName(current)}`,
                keywords: 'message send pubsub',
                icon: <PaperPlaneTiltIcon size={16} />,
                run: publish,
              },
              {
                id: 'pubsub.page.new-subscription',
                title: `New subscription on ${shortName(current)}`,
                keywords: 'create pubsub',
                icon: <TrayArrowDownIcon size={16} />,
                run: newSubscription,
              },
            ]
          : []),
        {
          id: 'pubsub.page.export-setup',
          title: 'Export Pub/Sub setup',
          keywords: 'topics subscriptions schemas file download',
          icon: <DownloadSimpleIcon size={16} />,
          run: () => setup('export'),
        },
        {
          id: 'pubsub.page.import-setup',
          title: 'Import Pub/Sub setup',
          keywords: 'topics subscriptions schemas file restore',
          icon: <UploadSimpleIcon size={16} />,
          run: () => setup('import'),
        },
      ].filter((item) => matchesQuery(item, query))
      return items.length > 0 ? [{ label: 'Pub/Sub', items }] : []
    })
    return () => unregister('pubsub-topics')
  }, [register, unregister, actions])
}
