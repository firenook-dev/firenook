// Authentication's patterns (auth.md §11.3): the users grid's rows, the
// provider glyphs, the claims meter, the Inbox and Activity rows, a pasted
// token's verdicts, the tenant picker and the users' facets. Every card
// renders the section's own components under the console's providers — a
// query client already holding what they would read, and a router — so a
// card shows what the Authentication pages draw. Nothing is fetched.

import { Text, TooltipProvider, cn } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ReactNode, createContext, use, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import type { AuthTenantList } from '@/api/generated/auth/AuthTenantList'
import type { AuthTokenInspection } from '@/api/generated/auth/AuthTokenInspection'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import { statusQuery } from '@/api/queries'
import { ActivityRow } from '@/auth/components/activity-row'
import { ClaimsMeter } from '@/auth/components/claims-editor'
import type { FeedMenuHandle } from '@/auth/components/feed-menu'
import { MintedNoteView, TokenVerdict, kindLine } from '@/auth/components/inspect-token'
import { MessageRow } from '@/auth/components/message-row'
import { ProviderGlyphs } from '@/auth/components/provider-glyphs'
import { TenantPicker } from '@/auth/components/tenant-picker'
import { userColumns } from '@/auth/components/user-cells'
import { userFacetGroups } from '@/auth/fields'
import { glyphsTooltip, providerGlyph, providerLabel, rowGlyphs } from '@/auth/providers'
import { tenantPickerQuery } from '@/auth/queries'
import type { TenantScope } from '@/auth/tenant-scope'
import { DataTable } from '@/components/console/data-table'
import { FacetList } from '@/components/console/facet-list'
import { FeedList } from '@/components/console/feed-list'
import { TableFooter } from '@/components/console/table-footer'
import { createFeedStore } from '@/lib/live/feed-store'
import { sectionEntry, testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

// ---- the engine the cards stand in front of -----------------------------

const PROJECT = 'demo-shop'

const STATUS: ConsoleStatus = testStatus({
  projectId: PROJECT,
  engine: { name: 'Firenook', version: '0.2.0', revision: null, consoleBuild: 'design-system' },
  services: [
    { name: 'auth', host: '127.0.0.1', port: 9099, listening: true, pid: null },
    { name: 'firestore', host: '127.0.0.1', port: 8080, listening: true, pid: null },
  ],
  sections: ['firestore', 'auth'].map((id) => sectionEntry(id)),
})

const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/** The console's providers around a card, with the query cache filled as given. */
function Kit({ fill, children }: { fill?: (client: QueryClient) => void; children: ReactNode }) {
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(statusQuery.queryKey, STATUS)
    fill?.(created)
    return created
  })
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: CardRoot }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    }),
  )
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CardContent value={children}>
          <RouterProvider router={router} />
        </CardContent>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** A piece of a page at its real size: a bordered box, fixed height for a list. */
function Frame({
  height,
  className,
  children,
}: {
  height?: number
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative flex min-w-0 flex-col overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line',
        className,
      )}
      style={height === undefined ? undefined : { height }}
    >
      {children}
    </div>
  )
}

const noop = () => {}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A time this long before the card loads, so relative times read as they would. */
const ago = (ms: number) => Date.now() - ms
const agoIso = (ms: number) => new Date(ago(ms)).toISOString()

/** A feed row's menu handle that opens nothing: the cards hold no pointer. */
const HANDLE: { readonly current: FeedMenuHandle } = { current: { open: noop, press: noop } }

// ---- users grid rows -----------------------------------------------------

function user(fields: Partial<AuthUserRow> & Pick<AuthUserRow, 'uid'>): AuthUserRow {
  return {
    tenant: null,
    email: null,
    emailVerified: false,
    phoneNumber: null,
    displayName: null,
    photoUrl: null,
    providers: [],
    anonymous: false,
    disabled: false,
    mfa: 0,
    claimKeys: [],
    customAuth: false,
    createdAt: ago(3 * DAY),
    lastSignInAt: ago(2 * HOUR),
    ...fields,
  }
}

const USER_ROWS: AuthUserRow[] = [
  user({
    uid: 'Xk2pL9qZ4mVb7Rt1',
    email: 'ada@example.test',
    emailVerified: true,
    displayName: 'Ada Lovelace',
    providers: ['password', 'google.com'],
    claimKeys: ['role'],
    createdAt: ago(12 * DAY),
    lastSignInAt: ago(4 * MINUTE),
  }),
  user({
    uid: 'pH7nQ2wE5rT8yU3i',
    phoneNumber: '+15550100',
    providers: ['phone'],
    createdAt: ago(6 * DAY),
    lastSignInAt: ago(3 * HOUR),
  }),
  user({
    uid: 'aN0nYm0u5gU3st42',
    anonymous: true,
    createdAt: ago(40 * MINUTE),
    lastSignInAt: null,
  }),
  user({
    uid: 'mFa8dK3sL6jH1gF4',
    email: 'grace@example.test',
    emailVerified: false,
    displayName: 'Grace Hopper',
    providers: ['password'],
    disabled: true,
    mfa: 1,
    claimKeys: ['admin', 'org'],
    createdAt: ago(30 * DAY),
    lastSignInAt: ago(9 * DAY),
  }),
]

const USERS = { one: 'user', other: 'users' }
const SORTABLE = ['created', 'signedIn', 'email', 'name', 'phone', 'uid']

function UserRowsCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="Users grid rows"
          note="32 px rows: the identifier in the data face, one quiet glyph per provider, the ages in words, and one coloured chip — disabled, the state that changes what the app can do."
        >
          <Frame height={4 * 32 + 72}>
            <DataTable<AuthUserRow>
              ariaLabel="Users"
              rows={USER_ROWS}
              rowKey={(row) => row.uid}
              columns={userColumns({ sortable: SORTABLE, pinned: true })}
              memoryKey="ds.auth.users"
              keyboard="focus"
              sort={{ column: 'created', direction: 'desc' }}
              onSortChange={noop}
              selection={{ checked: new Set(), everything: false, onChange: noop }}
              openKey={USER_ROWS[0]?.uid}
              onOpen={noop}
              total={{ count: USER_ROWS.length, exact: true }}
              hasMore={false}
              empty={<p />}
              footer={
                <TableFooter
                  loaded={USER_ROWS.length}
                  total={{ count: USER_ROWS.length, exact: true }}
                  hasMore={false}
                  noun={USERS}
                />
              }
            />
          </Frame>
          <Text variant="secondary" size="sm">
            A password account with Google linked and a claim · a phone account · an anonymous one
            that never signed in again · a disabled account with an unverified email: its MFA and
            claims chips wait in the cell's tooltip, since a chip is shown whole or not at all.
          </Text>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- provider glyphs -----------------------------------------------------

const PROVIDER_IDS = [
  'password',
  'emailLink',
  'phone',
  'google.com',
  'apple.com',
  'github.com',
  'facebook.com',
  'twitter.com',
  'microsoft.com',
  'yahoo.com',
  'gc.apple.com',
  'playgames.google.com',
  'saml.okta',
  'oidc.auth0',
  'custom',
  'passkey',
  'anonymous',
]

const LINKED = { providers: ['password', 'google.com', 'saml.okta', 'saml.azure'] }

function ProviderGlyphsCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="Provider glyphs"
          note="Quiet and 14 px; the ids, which are what a filter takes, are in the tooltip."
        >
          <div className="grid rounded-lg bg-kumo-base px-4 py-1 ring ring-kumo-line">
            {PROVIDER_IDS.map((id) => {
              const Glyph = providerGlyph(id)
              const label = providerLabel(id)
              return (
                <div
                  key={id}
                  className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 border-b border-kumo-hairline py-1.5 last:border-b-0"
                >
                  <Glyph size={14} className="text-kumo-subtle" aria-hidden />
                  <span className="truncate text-[13px] text-kumo-default">
                    {label === id ? 'Any other provider' : label}
                  </span>
                  <span className="font-mono text-[12px] text-kumo-subtle">{id}</span>
                </div>
              )
            })}
          </div>
        </Section>
        <Section
          title="In a row"
          note="One glyph per kind, in link order: two SAML providers share the identity card. Beside it, its tooltip."
        >
          <div className="flex items-start gap-6">
            <span className="pt-0.5">
              <ProviderGlyphs row={{ ...LINKED, customAuth: false, anonymous: false }} />
            </span>
            <p className="m-0 text-[12px] leading-5 whitespace-pre-line text-kumo-subtle">
              {glyphsTooltip(rowGlyphs({ ...LINKED, customAuth: false, anonymous: false }))}
            </p>
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- claims meter --------------------------------------------------------

function ClaimsMeterCard() {
  return (
    <Stack>
      <Section
        title="Claims meter"
        note="What Firebase measures: the JavaScript length of the compact JSON (an emoji counts two), against the 1,000-character limit."
      >
        <div className="grid gap-5 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
          <div className="grid gap-1.5">
            <Text variant="secondary" size="sm">
              Quiet
            </Text>
            <ClaimsMeter length={212} />
          </div>
          <div className="grid gap-1.5">
            <Text variant="secondary" size="sm">
              Crowded, from 900
            </Text>
            <ClaimsMeter length={944} />
          </div>
          <div className="grid gap-1.5">
            <Text variant="secondary" size="sm">
              Over the limit: Save is refused with CLAIMS_TOO_LARGE
            </Text>
            <ClaimsMeter length={1_086} />
          </div>
        </div>
      </Section>
    </Stack>
  )
}

// ---- inbox rows ----------------------------------------------------------

function message(fields: Partial<AuthMessage> & Pick<AuthMessage, 'id' | 'kind'>): AuthMessage {
  return {
    at: agoIso(MINUTE),
    tenant: null,
    channel: 'email',
    to: 'ada@example.test',
    newEmail: null,
    uid: 'Xk2pL9qZ4mVb7Rt1',
    code: 'kQ3vY8mZpL0nW5rT2xB7cD9fG1hJ4sA6',
    link: null,
    continueUrl: null,
    delivery: 'sent',
    origin: null,
    used: false,
    usedAt: null,
    activity: null,
    usedBy: null,
    text: '',
    ...fields,
  }
}

const MESSAGES: AuthMessage[] = [
  message({
    id: 41,
    kind: 'smsSignIn',
    channel: 'sms',
    to: '+15550100',
    uid: null,
    code: '482913',
    at: agoIso(12_000),
  }),
  message({ id: 40, kind: 'emailSignIn', to: 'linus@example.test', uid: null, at: agoIso(MINUTE) }),
  message({
    id: 39,
    kind: 'verifyEmail',
    to: 'grace@example.test',
    used: true,
    usedAt: agoIso(2 * MINUTE),
    at: agoIso(6 * MINUTE),
  }),
  message({ id: 38, kind: 'passwordReset', delivery: 'returned', at: agoIso(20 * MINUTE) }),
  message({
    id: 37,
    kind: 'smsMfaSignIn',
    channel: 'sms',
    to: '+15550199',
    code: '090417',
    tenant: 'acme',
    delivery: 'restored',
    at: null,
  }),
]

/** The two newest arrived since the Inbox was last looked at. */
const UNREAD = new Set([41, 40])

function InboxRowsCard() {
  const [store] = useState(() => {
    const created = createFeedStore<AuthMessage>({
      max: 100,
      key: (item) => String(item.id),
    })
    // The store holds the newest last.
    created.push(MESSAGES.toReversed())
    return created
  })
  return (
    <Kit>
      <Stack>
        <Section
          title="Inbox rows"
          note="One grid of columns: the unread dot, the channel, who it went to, what it is for, an SMS code at 14 px with its copy button, what became of it, the tenant (every tenant is shown) and the time."
        >
          <Frame height={MESSAGES.length * 32 + 2}>
            <FeedList<AuthMessage>
              ariaLabel="Codes and links"
              store={store}
              order="newest-first"
              rowHeight={32}
              rowKey={(item) => String(item.id)}
              renderRow={(item) => (
                <MessageRow
                  message={item}
                  unread={UNREAD.has(item.id)}
                  showTenant
                  handle={HANDLE}
                />
              )}
              selectedKey="39"
              onSelect={noop}
              follow
              onFollowChange={noop}
              empty={<p />}
            />
          </Frame>
          <Text variant="secondary" size="sm">
            An unread SMS sign-in code · an unread email sign-in link · a verification link the app
            used · a reset link returned to the caller (nothing was logged) · a tenant's MFA code
            found in saved state, which has no time.
          </Text>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- activity rows -------------------------------------------------------

function call(
  fields: Partial<AuthActivitySummary> & Pick<AuthActivitySummary, 'id' | 'operation'>,
): AuthActivitySummary {
  return {
    at: agoIso(MINUTE),
    durationMicros: 3_400,
    project: PROJECT,
    tenant: null,
    caller: 'client',
    origin: null,
    credential: 'apiKey',
    client: 'Firebase/JsCore/12.6.0',
    method: 'POST',
    path: '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
    kind: 'sign-in',
    identifier: 'ada@example.test',
    provider: 'password',
    uid: 'Xk2pL9qZ4mVb7Rt1',
    newUser: false,
    status: 200,
    error: null,
    steps: [],
    moreSteps: 0,
    ...fields,
  }
}

const CALLS: AuthActivitySummary[] = [
  call({
    id: 1207,
    operation: 'identitytoolkit.accounts.signInWithPassword',
    at: agoIso(8_000),
    durationMicros: 2_100,
  }),
  call({
    id: 1206,
    operation: 'identitytoolkit.accounts.signInWithPassword',
    at: agoIso(40_000),
    identifier: 'grace@example.test',
    uid: null,
    status: 400,
    error: { code: 'INVALID_LOGIN_CREDENTIALS', message: 'INVALID_LOGIN_CREDENTIALS' },
  }),
  call({
    id: 1205,
    operation: 'identitytoolkit.accounts.signUp',
    path: '/identitytoolkit.googleapis.com/v1/accounts:signUp',
    kind: 'sign-up',
    at: agoIso(2 * MINUTE),
    durationMicros: 46_800,
    identifier: 'x@blocked.test',
    uid: null,
    newUser: true,
    status: 400,
    error: {
      code: 'BLOCKING_FUNCTION_ERROR_RESPONSE',
      message:
        'BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to http://127.0.0.1:5001/demo-shop/us-central1/beforeCreate returned HTTP error 400: {"error":{"status":"INVALID_ARGUMENT","message":"Sign-ups from blocked.test are not allowed"}}))',
    },
    steps: [
      {
        kind: 'blocking',
        event: 'beforeCreate',
        function: 'beforeCreate',
        uri: 'http://127.0.0.1:5001/demo-shop/us-central1/beforeCreate',
        durationMicros: 41_200,
        invocation: 'b7c2e9',
        changed: [],
        customClaims: [],
        sessionClaims: [],
        failure: {
          message: 'Sign-ups from blocked.test are not allowed',
          status: 400,
          raw: 'HTTP request to http://127.0.0.1:5001/demo-shop/us-central1/beforeCreate returned HTTP error 400',
        },
      },
    ],
  }),
  call({
    id: 1204,
    operation: 'identitytoolkit.accounts.signInWithPhoneNumber',
    path: '/identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber',
    caller: 'client',
    origin: null,
    at: agoIso(5 * MINUTE),
    identifier: '+15550100',
    provider: 'phone',
    uid: 'pH7nQ2wE5rT8yU3i',
    steps: [{ kind: 'messageUsed', id: 41 }],
  }),
  call({
    id: 1203,
    operation: 'identitytoolkit.accounts.signUp',
    path: '/identitytoolkit.googleapis.com/v1/accounts:signUp',
    kind: 'sign-up',
    caller: 'console',
    origin: 'replay',
    at: agoIso(9 * MINUTE),
    durationMicros: 61_000,
    identifier: 'y@claims.test',
    uid: 'cL4iMs9tE2sT7uV1',
    newUser: true,
    steps: [
      {
        kind: 'blocking',
        event: 'beforeCreate',
        function: 'beforeCreate',
        uri: 'http://127.0.0.1:5001/demo-shop/us-central1/beforeCreate',
        durationMicros: 18_000,
        invocation: 'c1d4f0',
        changed: [],
        customClaims: [],
        sessionClaims: [],
        failure: null,
      },
      {
        kind: 'blocking',
        event: 'beforeSignIn',
        function: 'beforeSignIn',
        uri: 'http://127.0.0.1:5001/demo-shop/us-central1/beforeSignIn',
        durationMicros: 22_000,
        invocation: 'c1d4f1',
        changed: [],
        customClaims: ['tester'],
        sessionClaims: ['session'],
        failure: null,
      },
      { kind: 'trigger', event: 'user.create', uid: 'cL4iMs9tE2sT7uV1', outcome: 'queued' },
      {
        kind: 'user',
        tenant: null,
        uid: 'cL4iMs9tE2sT7uV1',
        change: 'created',
        fields: ['email', 'passwordHash', 'customAttributes'],
      },
    ],
  }),
]

function ActivityRowsCard() {
  const [store] = useState(() => {
    const created = createFeedStore<AuthActivitySummary>({
      max: 100,
      key: (item) => String(item.id),
    })
    created.push(CALLS.toReversed())
    return created
  })
  return (
    <Kit>
      <Stack>
        <Section
          title="Activity rows"
          note="The time, who called (Try and Replay are the calls the console was asked to make), the operation in words, the identifier and provider in the data face, ok or the emulator's code with the name the SDK gives it, what the call caused, and its latency."
        >
          <Frame height={CALLS.length * 32 + 2}>
            <FeedList<AuthActivitySummary>
              ariaLabel="Calls"
              store={store}
              order="newest-first"
              rowHeight={32}
              rowKey={(item) => String(item.id)}
              renderRow={(item) => <ActivityRow call={item} handle={HANDLE} />}
              onSelect={noop}
              follow
              onFollowChange={noop}
              empty={<p />}
            />
          </Frame>
          <Text variant="secondary" size="sm">
            A sign-in · a refused sign-in · a sign-up beforeCreate refused, its step in the danger
            tone · a phone sign-in from Try, using the code the Inbox holds · a replayed sign-up
            that ran both blocking functions, set claims and queued the account trigger.
          </Text>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- token verdicts ------------------------------------------------------
// The sentences are the engine's own (auth-front console/mint.rs and
// console-front auth/routes.rs), word for word.

function inspection(fields: Partial<AuthTokenInspection>): AuthTokenInspection {
  return {
    kind: 'idToken',
    signed: false,
    header: { alg: 'none', typ: 'JWT' },
    payload: {},
    project: PROJECT,
    tenant: null,
    uid: 'Xk2pL9qZ4mVb7Rt1',
    userExists: true,
    checks: [],
    ...fields,
  }
}

const FRESH = "Get a fresh token: the app's SDK refreshes it on its own; sign in again otherwise."
const RULES_SEE = "The rules see request.auth with uid `Xk2pL9qZ4mVb7Rt1` and the token's claims."

const TOKENS: { title: string; inspection: AuthTokenInspection }[] = [
  {
    title: 'Expired',
    inspection: inspection({
      checks: [
        {
          consumer: 'rules',
          ok: false,
          reason:
            'Expired 2 h ago (exp 07:14:02 UTC): the rules see no signed-in user, and Firestore answers 401.',
          fix: FRESH,
        },
        {
          consumer: 'authEmulator',
          ok: true,
          reason: "Accepted although it has expired: the emulator's own calls do not check `exp`.",
          fix: null,
        },
        {
          consumer: 'verify',
          ok: false,
          reason: 'Expired 2 h ago (exp 07:14:02 UTC).',
          fix: FRESH,
        },
        {
          consumer: 'verifyRevoked',
          ok: false,
          reason: 'Expired 2 h ago (exp 07:14:02 UTC).',
          fix: FRESH,
        },
      ],
    }),
  },
  {
    title: 'Revoked',
    inspection: inspection({
      checks: [
        { consumer: 'rules', ok: true, reason: RULES_SEE, fix: null },
        {
          consumer: 'authEmulator',
          ok: false,
          reason:
            "Issued at 09:02:11 UTC, before the user's tokens were revoked at 09:40:05 UTC: the emulator answers TOKEN_EXPIRED.",
          fix: 'Sign in again to get a fresh token.',
        },
        { consumer: 'verify', ok: true, reason: null, fix: null },
        {
          consumer: 'verifyRevoked',
          ok: false,
          reason:
            'Revoked: the user signed in at 09:02:11 UTC, before the tokens were revoked at 09:40:05 UTC (auth/id-token-revoked).',
          fix: 'Sign in again to get a fresh token.',
        },
      ],
    }),
  },
  {
    title: 'Accepted',
    inspection: inspection({
      tenant: 'acme',
      checks: [
        {
          consumer: 'rules',
          ok: true,
          reason: RULES_SEE,
          fix: null,
        },
        { consumer: 'authEmulator', ok: true, reason: null, fix: null },
        { consumer: 'verify', ok: true, reason: null, fix: null },
        { consumer: 'verifyRevoked', ok: true, reason: null, fix: null },
      ],
    }),
  },
]

function TokenVerdictsCard() {
  return (
    <Kit>
      <Stack>
        {TOKENS.map(({ title, inspection: result }) => (
          <Section key={title} title={title} note={kindLine(result)}>
            <ul className="m-0 grid list-none gap-2.5 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
              {result.checks.map((check) => (
                <TokenVerdict key={check.consumer} check={check} kind={result.kind} />
              ))}
            </ul>
          </Section>
        ))}
      </Stack>
    </Kit>
  )
}

/** When the card's minted token stops being accepted: within the hour, as a minted one does. */
const MINTED_EXPIRES = new Date(ago(-59 * MINUTE)).toISOString()

/** What Sign in as said of a token it minted, as Inspect a token shows it above the verdicts. */
function MintedNoteCard() {
  return (
    <Kit>
      <Frame className="w-[440px] py-2">
        <MintedNoteView
          note={{
            who: 'mfa-ada@example.test',
            minted: {
              idToken: 'eyJhbGciOiJub25lIn0.e30.',
              provider: 'password',
              secondFactor: {
                enrollmentId: 'mfa-1',
                displayName: 'Phone',
                phoneNumber: '+15550111',
                enrolledAt: null,
              },
              expiresAt: MINTED_EXPIRES,
              beforeSignIn: {
                function: 'beforeSignIn',
                durationMicros: 41_000,
                customClaims: ['tester'],
                sessionClaims: ['session'],
                call: 1207,
              },
              differences: [
                'beforeSignIn ran, but the account was not changed: what it set is in this token only.',
              ],
            },
          }}
        />
      </Frame>
    </Kit>
  )
}

// ---- tenant picker -------------------------------------------------------

function tenant(tenantId: string, displayName: string | null, users: number): AuthTenant {
  return {
    tenantId,
    displayName,
    users,
    allowPasswordSignup: true,
    enableEmailLinkSignin: false,
    enableAnonymousUser: false,
    disableAuth: false,
    mfaState: 'DISABLED',
    mfaProviders: [],
  }
}

function tenantList(items: AuthTenant[], total: number): AuthTenantList {
  return { projectUsers: 45, items, total }
}

const FEW = tenantList([tenant('acme', 'Acme Corp', 5), tenant('globex', 'Globex', 27)], 2)
const MANY = tenantList(
  Array.from({ length: 20 }, (_, index) =>
    tenant(`tenant-${String(index + 1).padStart(2, '0')}`, null, index * 3),
  ),
  64,
)

function Picker({
  label,
  page,
  scope,
}: {
  label: string
  page: 'users' | 'inbox'
  scope: TenantScope
}) {
  return (
    <div className="grid gap-1.5">
      <Text variant="secondary" size="sm">
        {label}
      </Text>
      <TenantPicker project={PROJECT} page={page} scope={scope} onChange={noop} />
    </div>
  )
}

function TenantPickerCard() {
  return (
    <Stack>
      <Section
        title="Tenant picker"
        note="The scope's name inside the box, the value in the data face; never a figure."
      >
        <Kit fill={(client) => client.setQueryData(tenantPickerQuery(PROJECT).queryKey, FEW)}>
          <div className="grid gap-4">
            <Picker
              label="Users: the project's own users"
              page="users"
              scope={{ kind: 'project' }}
            />
            <Picker label="A tenant" page="users" scope={{ kind: 'tenant', tenant: 'acme' }} />
            <Picker label="Inbox and Activity: every tenant" page="inbox" scope={{ kind: 'all' }} />
          </div>
        </Kit>
      </Section>
      <Section
        title="Past 20 tenants, a search"
        note="Typing asks the engine, which matches ids and display names; at most 50 are listed."
      >
        <Kit fill={(client) => client.setQueryData(tenantPickerQuery(PROJECT).queryKey, MANY)}>
          <Picker label="64 tenants" page="users" scope={{ kind: 'tenant', tenant: 'tenant-07' }} />
        </Kit>
      </Section>
    </Stack>
  )
}

// ---- facets --------------------------------------------------------------

const FACETS = {
  disabled: 2,
  unverified: 5,
  anonymous: 3,
  customToken: 1,
  sample: 0,
  mfa: 1,
  claims: 7,
  neverSignedIn: 6,
  providers: [
    { provider: 'password', users: 25 },
    { provider: 'phone', users: 5 },
    { provider: 'google.com', users: 4 },
    { provider: 'github.com', users: 2 },
    { provider: 'apple.com', users: 1 },
  ],
}

function FacetsCard() {
  const [q, setQ] = useState('provider:google.com')
  return (
    <Kit>
      <Stack>
        <Section title="Filters panel" note="Counts from the engine, exact.">
          <FacetList value={q} onChange={setQ} groups={userFacetGroups(FACETS)} />
          <Text variant="secondary" size="sm">
            q = <span className="font-mono text-[12px] text-kumo-default">{q}</span>
          </Text>
        </Section>
      </Stack>
    </Kit>
  )
}

defineCards([
  {
    id: 'auth-user-rows',
    group: 'Patterns',
    name: 'Users grid rows',
    subtitle: 'Identifier, providers, ages and the one coloured chip',
    width: 1100,
    surface: 'canvas',
    render: () => <UserRowsCard />,
  },
  {
    id: 'auth-user-rows-dark',
    group: 'Patterns',
    name: 'Users grid rows, dark',
    subtitle: 'The same, in dark mode',
    width: 1100,
    dark: true,
    surface: 'canvas',
    render: () => <UserRowsCard />,
  },
  {
    id: 'auth-provider-glyphs',
    group: 'Patterns',
    name: 'Provider glyphs',
    subtitle: 'One quiet glyph per provider, ids in the tooltip',
    width: 420,
    surface: 'canvas',
    render: () => <ProviderGlyphsCard />,
  },
  {
    id: 'auth-claims-meter',
    group: 'Patterns',
    name: 'Claims meter',
    subtitle: 'Quiet, crowded (≥ 900 characters) and over the limit',
    width: 520,
    surface: 'canvas',
    render: () => <ClaimsMeterCard />,
  },
  {
    id: 'auth-inbox-rows',
    group: 'Patterns',
    name: 'Inbox rows',
    subtitle: '32 px; SMS code first, email links, used/returned/restored',
    width: 900,
    surface: 'canvas',
    render: () => <InboxRowsCard />,
  },
  {
    id: 'auth-activity-rows',
    group: 'Patterns',
    name: 'Activity rows',
    subtitle: 'OutcomeChip, SDK error name, steps and latency; the Replay chip',
    width: 1100,
    surface: 'canvas',
    render: () => <ActivityRowsCard />,
  },
  {
    id: 'auth-token-verdicts',
    group: 'Patterns',
    name: 'Token verdicts',
    subtitle: 'One line per consumer with reason and fix',
    width: 640,
    surface: 'canvas',
    render: () => <TokenVerdictsCard />,
  },
  {
    id: 'auth-minted-note',
    group: 'Patterns',
    name: 'Minted by Sign in as',
    subtitle: 'Above the verdicts of a token View the token handed to Inspect',
    width: 520,
    surface: 'canvas',
    render: () => <MintedNoteCard />,
  },
  {
    id: 'auth-tenant-picker',
    group: 'Patterns',
    name: 'Tenant picker',
    subtitle: 'Name inside the box, mono value; the searchable form',
    width: 320,
    surface: 'canvas',
    render: () => <TenantPickerCard />,
  },
  {
    id: 'auth-facets',
    group: 'Patterns',
    name: 'Filters panel facets',
    subtitle: "The foundation's FacetList with Auth's groups, one pressed",
    width: 264,
    surface: 'canvas',
    render: () => <FacetsCard />,
  },
])
