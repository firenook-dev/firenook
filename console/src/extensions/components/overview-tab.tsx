// An instance as a page to read: what the extension does, who made it,
// where its source is and whether it starts offline, the Google APIs it
// calls and which of them the emulator has, the roles and services it
// asks for, and the lifecycle hooks the emulator does not run, each with
// the reason.

import { Text, Tooltip } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import type { ExtensionInstanceDetail } from '@/api/generated/compute/ExtensionInstanceDetail'
import { KeyValueList, type KeyValueItem } from '@/components/console/key-value-list'
import { StatusDot } from '@/components/kit'
import { ORIGIN_HELP, originWord, readiness } from '../words'

/** What a call to an API the emulator lacks does, from the loader's own warning. */
export const NOT_EMULATED = 'Calls go to the production API; in a demo- project they fail.'

/** Why the emulator runs no lifecycle hook, as the official one does not. */
export const LIFECYCLE_NOTE =
  "Not run by the emulator: the hook's task queue function is not delivered here, as in the official emulator."

/** A band of the reading column with its 16 px heading. */
function Section({
  title,
  testId,
  children,
}: {
  title: string
  testId?: string
  children: ReactNode
}) {
  return (
    <section className="grid gap-2.5" aria-label={title} data-testid={testId}>
      <h2 className="m-0 text-[16px] leading-6 font-semibold text-kumo-default">{title}</h2>
      {children}
    </section>
  )
}

/** A link to somewhere outside the console: a new tab, without access to this one. */
function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-kumo-link underline-offset-2 hover:underline"
    >
      {children}
    </a>
  )
}

export function OverviewTab({ detail }: { detail: ExtensionInstanceDetail }) {
  const { summary } = detail
  const ready = readiness(summary)
  const about: KeyValueItem[] = [
    ...(detail.author
      ? [
          {
            label: 'Made by',
            value: detail.author.url ? (
              <External href={detail.author.url}>{detail.author.name}</External>
            ) : (
              detail.author.name
            ),
            mono: false,
            testId: 'about-author',
          },
        ]
      : []),
    ...(summary.reference
      ? [{ label: 'Reference', value: summary.reference, copy: summary.reference }]
      : []),
    { label: 'In firebase.json', value: summary.written, copy: summary.written },
    ...(summary.version ? [{ label: 'Version', value: summary.version }] : []),
    ...(detail.sourceUrl
      ? [
          {
            label: 'Source code',
            value: <External href={detail.sourceUrl}>{detail.sourceUrl}</External>,
            copy: detail.sourceUrl,
          },
        ]
      : []),
    ...(detail.license ? [{ label: 'License', value: detail.license }] : []),
    {
      label: 'Billing',
      value: detail.billingRequired
        ? 'Needs a billing account in production'
        : 'No billing account needed',
      mono: false,
    },
    ...(detail.specVersion ? [{ label: 'Spec version', value: detail.specVersion }] : []),
  ]
  const source: KeyValueItem[] = [
    {
      label: 'Origin',
      value: (
        <Tooltip
          content={
            summary.origin ? ORIGIN_HELP[summary.origin] : 'The instance has not loaded yet.'
          }
          render={<span className="cursor-default">{originWord(summary)}</span>}
        />
      ),
      mono: false,
      testId: 'source-origin',
    },
    ...(summary.sourceDir
      ? [{ label: 'Directory', value: summary.sourceDir, copy: summary.sourceDir }]
      : []),
    ...(summary.kind === 'registry'
      ? [
          {
            label: 'Registry sidecar',
            value: summary.sidecar
              ? 'Kept beside the source, so its metadata loads offline'
              : 'None',
            mono: false,
          },
        ]
      : []),
    {
      label: 'Offline',
      value: (
        <span className="grid gap-0.5">
          <StatusDot tone={ready.tone} label={ready.word} />
          <span className="text-[12px] text-kumo-subtle">{ready.note}</span>
        </span>
      ),
      mono: false,
      testId: 'source-offline',
    },
    {
      label: 'Parameter files',
      value:
        detail.envFiles.length === 0 ? (
          <span className="font-sans text-[13px] text-kumo-subtle">None yet</span>
        ) : (
          <span className="grid">
            {detail.envFiles.map((file) => (
              <span key={file}>{file}</span>
            ))}
          </span>
        ),
      testId: 'source-files',
    },
  ]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-kumo-base" data-testid="instance-overview">
      <div className="grid max-w-3xl gap-7 px-6 py-5">
        {summary.description && (
          <Text size="base" DANGEROUS_className="text-[14px] leading-6">
            {summary.description}
          </Text>
        )}
        <Section title="About" testId="overview-about">
          <KeyValueList items={about} />
        </Section>
        <Section title="Source" testId="overview-source">
          <KeyValueList items={source} />
        </Section>
        {detail.apis.length > 0 && (
          <Section title="APIs" testId="overview-apis">
            <ul className="m-0 grid list-none gap-2 p-0">
              {detail.apis.map((api) => (
                <li
                  key={api.apiName}
                  className="grid gap-0.5"
                  data-testid="overview-api"
                  data-api={api.apiName}
                  data-emulated={api.emulated ? '' : undefined}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[12px] text-kumo-default">
                      {api.apiName}
                    </span>
                    {api.emulated ? (
                      <StatusDot tone="success" label="Emulated" />
                    ) : (
                      <StatusDot tone="warning" label="Not emulated" />
                    )}
                  </span>
                  {api.reason && <span className="text-[13px] text-kumo-subtle">{api.reason}</span>}
                  {!api.emulated && (
                    <span className="text-[13px] text-kumo-warning">{NOT_EMULATED}</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {detail.roles.length > 0 && (
          <Section title="Roles" testId="overview-roles">
            <ul className="m-0 grid list-none gap-2 p-0">
              {detail.roles.map((role) => (
                <li key={role.role} className="grid gap-0.5" data-testid="overview-role">
                  <span className="font-mono text-[12px] text-kumo-default">{role.role}</span>
                  {role.reason && (
                    <span className="text-[13px] text-kumo-subtle">{role.reason}</span>
                  )}
                </li>
              ))}
            </ul>
            <span className="text-[12px] text-kumo-subtle">
              Roles are not enforced here: the emulators answer every call a function makes.
            </span>
          </Section>
        )}
        {detail.externalServices.length > 0 && (
          <Section title="External services" testId="overview-services">
            <KeyValueList
              items={detail.externalServices.map((service) => ({
                label: service.name,
                value: service.pricingUri ? (
                  <External href={service.pricingUri}>Pricing</External>
                ) : (
                  'Billed by its provider'
                ),
                mono: false,
              }))}
            />
          </Section>
        )}
        {detail.lifecycle.length > 0 && (
          <Section title="Lifecycle" testId="overview-lifecycle">
            <ul className="m-0 grid list-none gap-2.5 p-0">
              {detail.lifecycle.map((hook) => (
                <li key={hook.stage} className="grid gap-0.5" data-testid="lifecycle-hook">
                  <span className="flex min-w-0 items-center gap-2 text-[12px]">
                    <span className="font-mono text-kumo-default">{hook.stage}</span>
                    {hook.function && (
                      <>
                        <span className="text-kumo-subtle" aria-hidden>
                          →
                        </span>
                        <span className="truncate font-mono text-kumo-default">
                          {hook.function}
                        </span>
                      </>
                    )}
                  </span>
                  {hook.processingMessage && (
                    <span className="text-[13px] text-kumo-subtle">“{hook.processingMessage}”</span>
                  )}
                  <span className="text-[13px] text-kumo-subtle">{LIFECYCLE_NOTE}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  )
}
