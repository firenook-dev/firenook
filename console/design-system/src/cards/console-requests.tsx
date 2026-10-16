// The kit's request composer, identity picker and destructive confirmation
// (foundation commit 9c). The composer's parts and the answer are the real
// components; the menu and the dialogs are drawn open, in the states they
// are met in, because a card cannot hold a pointer over them.

import { Button, Checkbox, Input, Tabs, Text } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  IdentificationBadgeIcon,
  ShieldCheckIcon,
  UserCircleDashedIcon,
  UserIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { CodeBlock } from '@/components/console/code-block'
import { BodyEditor } from '@/components/console/request/body-editor'
import { REQUEST_DIALECTS, codeTab, requestAsCode } from '@/components/console/request/as-code'
import { MethodSelect } from '@/components/console/request/method-select'
import { ResponseView } from '@/components/console/request/response-view'
import { SendButton } from '@/components/console/request/send-button'
import type { ComposedRequest, ResponseRecord } from '@/components/console/request/types'
import { UrlField } from '@/components/console/request/url-field'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const noop = () => {}

const greet: ComposedRequest = {
  method: 'POST',
  url: '/console/api/v1/functions/native/demo-x/us-central1/greet',
  codeUrl: 'http://127.0.0.1:5001/demo-x/us-central1/greet',
  query: [{ key: 'name', value: 'ada', enabled: true }],
  headers: [
    { key: 'x-trace', value: 'abc123', enabled: true },
    { key: 'x-debug', value: '1', enabled: false },
  ],
  body: { kind: 'json', text: '{\n  "greeting": "hello",\n  "times": 2\n}' },
  identity: { kind: 'custom', uid: 'tester', claims: { admin: true } },
}

const answered: ResponseRecord = {
  status: 200,
  statusText: 'OK',
  headers: [
    ['content-type', 'application/json; charset=utf-8'],
    ['x-firenook-execution', 'a3f9c1-1284'],
    ['content-length', '58'],
    ['date', 'Mon, 12 Oct 2026 06:02:11 GMT'],
    ['connection', 'keep-alive'],
    ['etag', 'W/"3a-1f"'],
  ],
  bodyText: '{"message":"hello ada","times":2,"servedBy":"us-central1-greet"}',
  contentType: 'application/json; charset=utf-8',
  firstByteMs: 12,
  durationMs: 41,
  sizeBytes: 312,
  at: '2026-10-12T06:02:11Z',
}

const streaming: ResponseRecord = {
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'text/event-stream']],
  contentType: 'text/event-stream',
  firstByteMs: 18,
  durationMs: 1520,
  sizeBytes: 96,
  at: '2026-10-12T06:02:11Z',
  receiving: true,
  chunks: [
    { atMs: 18, text: 'data: {"step":"loading cart"}\n\n' },
    { atMs: 640, text: 'data: {"step":"pricing"}\n\n' },
    { atMs: 1520, text: 'data: {"step":"charging"}\n\n' },
  ],
}

const failed: ResponseRecord = {
  status: 500,
  statusText: 'Internal Server Error',
  headers: [['content-type', 'text/plain']],
  bodyText:
    "TypeError: cannot read properties of undefined (reading 'id')\n    at handler (/functions/index.js:41:18)",
  contentType: 'text/plain',
  firstByteMs: 8,
  durationMs: 9,
  sizeBytes: 104,
  at: '2026-10-12T06:02:11Z',
}

/** A trigger as the toolbar draws it: "As" muted, the identity, a caret. */
function IdentityTrigger({
  icon,
  name,
  quiet = false,
  warn = false,
}: {
  icon: ReactNode
  name: string
  quiet?: boolean
  warn?: boolean
}) {
  return (
    <Button variant={quiet ? 'ghost' : 'secondary'} size="sm" icon={icon}>
      <span className="flex items-center gap-1">
        <span className="text-kumo-subtle">As</span>
        <span>{name}</span>
        {warn && <span className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />}
        <CaretDownIcon size={12} className="text-kumo-subtle" />
      </span>
    </Button>
  )
}

function Composer() {
  return (
    <div className="grid gap-0 overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
      <div className="flex items-center gap-2 border-b border-kumo-line px-3 py-2">
        <MethodSelect value="POST" onChange={noop} />
        <UrlField
          prefix="http://127.0.0.1:5001/demo-x/us-central1/greet"
          value="?name=ada"
          onChange={noop}
        />
        <IdentityTrigger icon={<IdentificationBadgeIcon size={14} />} name="tester" />
        <SendButton onSend={noop} pending={false} />
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-kumo-line px-3 py-1.5">
        <Tabs
          size="sm"
          variant="segmented"
          selectedValue="body"
          tabs={[
            { value: 'params', label: 'Params · 1' },
            { value: 'headers', label: 'Headers · 1' },
            { value: 'body', label: 'Body (JSON)' },
          ]}
        />
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="sm" icon={<ClockCounterClockwiseIcon />}>
            History
          </Button>
          <Button variant="ghost" size="sm" icon={<CodeIcon />}>
            Code
          </Button>
        </span>
      </div>
      <div className="px-3 py-3">
        <BodyEditor value={greet.body} onChange={noop} />
      </div>
      <div className="grid gap-2 border-t border-kumo-line px-3 py-3">
        <Text variant="secondary" size="xs">
          Response
        </Text>
        <ResponseView response={answered} pending={false} />
      </div>
    </div>
  )
}

function RequestComposerCard() {
  return (
    <Stack>
      <Section
        title="Compose, send, read the answer"
        note="Method, the service's address with the part you edit, who it runs as, and Send (⌘↵). The answer says how it went and how long it took before the body."
      >
        <Composer />
      </Section>
      <Section
        title="Streamed and failed answers"
        note="Chunks show as they arrive; a 5xx is red, a 4xx amber, and the body is never hidden."
      >
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg bg-kumo-base p-3 ring ring-kumo-line">
            <ResponseView response={streaming} pending testId="response-streaming" />
          </div>
          <div className="rounded-lg bg-kumo-base p-3 ring ring-kumo-line">
            <ResponseView response={failed} pending={false} testId="response-failed" />
          </div>
        </div>
      </Section>
      <Section
        title="Code to copy"
        note="Against the service's own port, never the console; the identity's token as the console sends it."
      >
        <div className="w-[560px] rounded-lg bg-kumo-base p-3 shadow-lg ring ring-kumo-line">
          <CodeBlock
            label="This request as code"
            dialects={REQUEST_DIALECTS.map((dialect) =>
              codeTab(dialect, requestAsCode(greet, dialect, 'demo-x')),
            )}
          />
          <div className="mt-2">
            <Text size="xs" variant="secondary">
              Sent to 127.0.0.1, the engine&apos;s address, not the console.
            </Text>
          </div>
        </div>
      </Section>
    </Stack>
  )
}

/** A menu row as Kumo draws one, held open. */
function MenuRow({
  icon,
  children,
  checked = false,
  lit = false,
  muted = false,
}: {
  icon?: ReactNode
  children: ReactNode
  checked?: boolean
  lit?: boolean
  muted?: boolean
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px] ${lit ? 'ink' : ''} ${muted ? 'text-kumo-subtle' : 'text-kumo-default'}`}
    >
      {icon && <span className="flex h-[18px] shrink-0 items-center text-kumo-subtle">{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {checked && (
        <span className="flex h-[18px] shrink-0 items-center pl-3 text-kumo-brand">
          <CheckIcon size={13} />
        </span>
      )}
    </div>
  )
}

function UserRow({
  name,
  uid,
  tenant,
  checked,
  lit,
}: {
  name: string
  uid: string
  tenant?: string
  checked?: boolean
  lit?: boolean
}) {
  return (
    <MenuRow icon={<UserIcon size={14} />} checked={checked ?? false} lit={lit ?? false}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate">{name}</span>
        <span className="truncate font-mono text-[12px] text-kumo-subtle">
          {uid}
          {tenant ? ` · ${tenant}` : ''}
        </span>
      </span>
    </MenuRow>
  )
}

function IdentityMenu() {
  return (
    <div className="w-80 rounded-lg bg-kumo-base p-1 shadow-lg ring ring-kumo-line">
      <MenuRow icon={<ShieldCheckIcon size={14} />}>Admin (bypasses rules)</MenuRow>
      <MenuRow icon={<UserCircleDashedIcon size={14} />}>Anonymous client</MenuRow>
      <div className="mx-1 my-1 h-px bg-kumo-line" />
      <div className="px-2 pt-1 pb-1.5 text-[12px] font-medium text-kumo-subtle">Auth users</div>
      <div className="px-1.5 pb-1">
        <Input
          size="sm"
          value="ad"
          readOnly
          aria-label="Search Auth users"
          className="w-full font-mono"
        />
      </div>
      <UserRow name="ada@example.test" uid="u_k65eq" checked lit />
      <UserRow name="ada@acme.test" uid="u_7ar2c" tenant="acme" />
      <UserRow name="Adam Hopper" uid="u_ad41m" />
      <div className="px-2 pt-0.5 pb-1 text-[12px] text-kumo-subtle">
        More match: type more to narrow.
      </div>
      <div className="mx-1 my-1 h-px bg-kumo-line" />
      <MenuRow icon={<IdentificationBadgeIcon size={14} />}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>Custom identity…</span>
          <span className="truncate text-[12px] text-kumo-subtle">
            Any uid and claims, no Auth record needed
          </span>
        </span>
      </MenuRow>
    </div>
  )
}

function NoAuthMenu() {
  return (
    <div className="w-80 rounded-lg bg-kumo-base p-1 shadow-lg ring ring-kumo-line">
      <MenuRow icon={<UserCircleDashedIcon size={14} />} checked>
        Anonymous client
      </MenuRow>
      <div className="mx-1 my-1 h-px bg-kumo-line" />
      <div className="px-2 pt-1 pb-1.5 text-[12px] font-medium text-kumo-subtle">Auth users</div>
      <MenuRow muted>
        <span className="text-[12px] leading-snug">
          Authentication is not running, so there are no users to pick; a custom identity still
          works.
        </span>
      </MenuRow>
      <div className="mx-1 my-1 h-px bg-kumo-line" />
      <MenuRow icon={<IdentificationBadgeIcon size={14} />}>Custom identity…</MenuRow>
    </div>
  )
}

/** A dialog as it sits on screen: 16 px title, 14 px body, actions on the right. */
function DialogFrame({
  title,
  children,
  width = 'w-[384px]',
}: {
  title: string
  children: ReactNode
  width?: string
}) {
  return (
    <div className={`${width} rounded-xl bg-kumo-base p-6 shadow-lg ring ring-kumo-line`}>
      <div className="mb-3 flex items-start justify-between gap-4">
        <h3 className="text-lg font-semibold text-kumo-default">{title}</h3>
        <Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />
      </div>
      {children}
    </div>
  )
}

function CustomIdentityForm() {
  return (
    <DialogFrame title="Custom identity" width="w-[512px]">
      <p className="text-[14px] text-kumo-subtle">
        Requests carry an unsigned token with this uid and these claims, which the emulator accepts
        as it would a signed one. No Auth record is needed, and Authentication need not be running.
      </p>
      <div className="mt-4 grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1.5">
            <Text as="span" size="xs" variant="secondary">
              uid
            </Text>
            <Input
              size="sm"
              value="tester"
              readOnly
              className="w-full font-mono"
              aria-label="uid"
            />
          </label>
          <label className="grid gap-1.5">
            <Text as="span" size="xs" variant="secondary">
              Email (optional)
            </Text>
            <Input
              size="sm"
              value="tester@example.test"
              readOnly
              className="w-full font-mono"
              aria-label="Email"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <div className="grid gap-1.5">
            <Text as="span" size="xs" variant="secondary">
              Sign-in provider
            </Text>
            <div className="flex h-[26px] items-center justify-between rounded-md bg-kumo-control px-2 font-mono text-[12px] ring ring-kumo-line">
              google.com
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </div>
          </div>
          <div className="pb-1">
            <Checkbox checked label="Email verified" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Text as="span" size="xs" variant="secondary">
            Claims
          </Text>
          <pre className="h-20 rounded-md bg-kumo-control px-2 py-2 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line">
            {'{\n  "admin": true,\n  "plan": "pro"\n}'}
          </pre>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary">Cancel</Button>
          <Button variant="primary">Use this identity</Button>
        </div>
      </div>
    </DialogFrame>
  )
}

function IdentityPickerCard() {
  return (
    <Stack>
      <Section
        title="The trigger"
        note="Quiet for the default, framed for anything else; a user with no Auth record carries an amber dot."
      >
        <div className="flex flex-wrap items-center gap-3">
          <IdentityTrigger
            icon={<ShieldCheckIcon size={14} />}
            name="Admin (bypasses rules)"
            quiet
          />
          <IdentityTrigger icon={<UserIcon size={14} />} name="ada@example.test" />
          <IdentityTrigger icon={<UserIcon size={14} />} name="ada@acme.test · acme" />
          <IdentityTrigger icon={<IdentificationBadgeIcon size={14} />} name="tester (custom)" />
          <IdentityTrigger icon={<UserIcon size={14} />} name="u_gone" warn />
        </div>
      </Section>
      <Section
        title="Open, searching"
        note="Users come from the engine's bounded search, every tenant, eight at first and a search once there are more."
      >
        <div className="flex items-start gap-6">
          <IdentityMenu />
          <NoAuthMenu />
        </div>
      </Section>
      <Section
        title="A custom identity"
        note="Any uid and claims, minted here; it works without Authentication running."
      >
        <CustomIdentityForm />
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'request-composer',
    group: 'Patterns',
    name: 'Request composer',
    subtitle:
      'Method, URL, identity, params, headers, body, Send; the response with status, time, size, headers and body; code to copy',
    width: 1100,
    surface: 'canvas',
    render: () => <RequestComposerCard />,
  },
  {
    id: 'identity-picker',
    group: 'Patterns',
    name: 'Identity picker',
    subtitle:
      'Who requests run as: the owner, an anonymous client, Auth users from every tenant by search, and a custom identity',
    width: 880,
    surface: 'canvas',
    render: () => <IdentityPickerCard />,
  },
])
