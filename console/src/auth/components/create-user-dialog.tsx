// New user (`?new=user`, `n`): an account of any kind, made through the
// official API as code would make it (`user-form.ts`), so it is exactly the
// account the app or the Admin SDK would have made. "Create and add
// another" keeps the dialog and the kind (the official UI's "Save and create
// another"); a refusal is explained with its fix.

import { Button, Collapsible, Dialog, Switch, Tabs, Tooltip } from '@cloudflare/kumo'
import { ArrowsClockwiseIcon, InfoIcon, XIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { CodeEditor } from '@/components/code-editor'
import { toast } from '@/lib/toasts'
import { AuthEmulatorError, callAuthEmulator, toolkitPath } from '../api'
import { claimsMarks, formatClaims } from '../claims'
import { LINKABLE_PROVIDERS } from '../providers'
import { refusal } from '../user-actions'
import {
  type CreatePlan,
  EMPTY_FORM,
  NEW_USER_KINDS,
  type NewUserForm,
  type NewUserKind,
  createErrorText,
  createPlan,
  formProblems,
  nextForm,
} from '../user-form'
import { triggerSentence, useAccountTriggers } from '../user-triggers'
import { DialogField, DialogInput } from './dialog-field'
import { UserAvatar } from './user-avatar'

/** A password worth typing in a test: two words and a number. */
function generatedPassword(): string {
  const words = [
    'amber',
    'birch',
    'cedar',
    'delta',
    'ember',
    'flint',
    'grove',
    'heron',
    'iris',
    'juniper',
  ]
  const pick = () => words[Math.floor(Math.random() * words.length)] ?? 'ember'
  return `${pick()}-${pick()}-${10 + Math.floor(Math.random() * 90)}`
}

/** Runs a creation's calls in order; answers the new uid. */
async function runPlan(
  project: string,
  tenant: string | undefined,
  plan: CreatePlan,
): Promise<string> {
  const path = (call: CreatePlan['create']) =>
    call.scoped ? toolkitPath(call.operation, { project, tenant }) : toolkitPath(call.operation)
  const created = await callAuthEmulator<{ localId?: string }>({
    method: 'POST',
    path: path(plan.create),
    body: plan.create.body,
    as: plan.create.as,
    origin: 'write',
  })
  const uid = created.body.localId
  if (!uid) throw new Error('The emulator created the account but did not say its uid.')
  for (const call of plan.followUps) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each step writes to the account the one before made
      await callAuthEmulator({
        method: 'POST',
        path: path(call),
        body: { ...call.body, localId: uid },
        as: call.as,
        origin: 'write',
      })
    } catch (error) {
      throw new Error(`Created ${uid}, but the next step was refused: ${refusal(error)}`, {
        cause: error,
      })
    }
  }
  return uid
}

export function CreateUserDialog({
  open,
  onOpenChange,
  project,
  tenant,
  blocked,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string
  /** The tenant the user goes to; absent for the project's users. */
  tenant: string | undefined
  /** Why writes are refused (the tenant was deleted). */
  blocked: string | undefined
  /** A user was created; `close` when the dialog is done. */
  onCreated: (uid: string, close: boolean) => void
}) {
  const [kind, setKind] = useState<NewUserKind>('password')
  const [form, setForm] = useState<NewUserForm>(EMPTY_FORM)
  const [touched, setTouched] = useState(false)
  const [claimsOpen, setClaimsOpen] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setForm(EMPTY_FORM)
      setTouched(false)
      setClaimsOpen(false)
    }
  }
  const triggers = useAccountTriggers(tenant, 'user.create')
  const problems = formProblems(kind, form)
  const ready = Object.keys(problems).length === 0 && blocked === undefined
  const set = <K extends keyof NewUserForm>(key: K, value: NewUserForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }))
  const create = useMutation({
    mutationFn: async (another: boolean) => ({
      uid: await runPlan(project, tenant, createPlan(kind, form, tenant)),
      another,
    }),
    onSuccess: ({ uid, another }) => {
      const label = form.email.trim() || form.phone.trim() || form.displayName.trim() || uid
      toast({ key: `auth.created.${uid}`, title: `Created ${label}`, tone: 'success' })
      onCreated(uid, !another)
      if (another) {
        setForm(nextForm(form))
        setTouched(false)
      }
    },
  })
  const failure = create.error
  const failureText =
    failure instanceof AuthEmulatorError
      ? createErrorText(failure.code, failure.message)
      : failure
        ? refusal(failure)
        : undefined
  const shown = (key: keyof NewUserForm) => (touched ? problems[key] : undefined)
  const submit = (another: boolean) => {
    setTouched(true)
    if (ready) create.mutate(another)
  }
  const sentence = triggerSentence(triggers, 'user.create')
  const note =
    kind === 'anonymous'
      ? `Signs in anonymously, as signInAnonymously() does, so your blocking functions run for it.${sentence ? ` ${sentence}` : ''}`
      : `Created as createUser() does${sentence ? `: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1, -1)}` : ''}; blocking functions do not run — they run for sign-ups from a client.`
  const has = (field: 'email' | 'password' | 'phone' | 'uid' | 'provider') => {
    switch (field) {
      case 'email':
        return kind === 'password' || kind === 'federated' || kind === 'custom'
      case 'password':
        return kind === 'password' || kind === 'custom'
      case 'phone':
        return kind === 'phone' || kind === 'custom'
      case 'uid':
        return kind !== 'anonymous'
      case 'provider':
        return kind === 'federated'
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <form
          className="flex max-h-[calc(100vh-6rem)] flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            submit(false)
          }}
          data-testid="create-user-dialog"
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">New user</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            In{' '}
            {tenant ? (
              <>
                tenant <span className="font-mono text-[0.9em] text-kumo-default">{tenant}</span>
              </>
            ) : (
              'the project’s users (no tenant)'
            )}
            .
          </Dialog.Description>
          <div className="-mx-1 mt-4 grid min-h-0 gap-3 overflow-y-auto px-1 py-1">
            <Tabs
              size="sm"
              variant="segmented"
              value={kind}
              onValueChange={(value) => {
                setKind(value as NewUserKind)
                setTouched(false)
                create.reset()
              }}
              tabs={NEW_USER_KINDS.map((entry) => ({ value: entry.id, label: entry.label }))}
            />
            {has('provider') && (
              <div className="grid grid-cols-2 gap-3">
                <DialogField label="Provider id" error={shown('providerId')}>
                  <DialogInput
                    value={form.providerId}
                    onChange={(value) => set('providerId', value)}
                    invalid={shown('providerId') !== undefined}
                    placeholder="google.com"
                    testId="new-provider-id"
                  />
                </DialogField>
                <DialogField label="Raw id" hint="(blank for a generated one)">
                  <DialogInput
                    value={form.rawId}
                    onChange={(value) => set('rawId', value)}
                    placeholder="109317432651"
                    testId="new-raw-id"
                  />
                </DialogField>
                <div className="col-span-2 -mt-1 flex flex-wrap gap-1">
                  {LINKABLE_PROVIDERS.map((id) => (
                    <Button
                      key={id}
                      type="button"
                      variant={form.providerId === id ? 'secondary' : 'ghost'}
                      size="xs"
                      onClick={() => set('providerId', id)}
                      aria-pressed={form.providerId === id}
                    >
                      <span className="font-mono text-[11px]">{id}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {has('email') && (
                <DialogField
                  label="Email"
                  hint={kind === 'password' ? undefined : '(optional)'}
                  error={shown('email')}
                  className="col-span-2"
                >
                  <div className="flex items-center gap-3">
                    <DialogInput
                      value={form.email}
                      onChange={(value) => set('email', value)}
                      invalid={shown('email') !== undefined}
                      type="email"
                      placeholder="ada@journey.test"
                      autoFocus={kind === 'password'}
                      testId="new-email"
                    />
                    <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-kumo-subtle">
                      <Switch
                        variant="neutral"
                        size="sm"
                        checked={form.emailVerified}
                        onClick={() => set('emailVerified', !form.emailVerified)}
                        aria-label="Verified email"
                        data-testid="new-verified"
                      />
                      Verified
                    </span>
                  </div>
                </DialogField>
              )}
              {has('password') && (
                <DialogField
                  label="Password"
                  hint={
                    kind === 'custom'
                      ? '(optional; 6 or more characters)'
                      : '(6 or more characters)'
                  }
                  error={shown('password')}
                >
                  <div className="flex items-center gap-1">
                    <DialogInput
                      value={form.password}
                      onChange={(value) => set('password', value)}
                      invalid={shown('password') !== undefined}
                      testId="new-password"
                    />
                    <Tooltip
                      content="Make one up"
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          shape="square"
                          icon={<ArrowsClockwiseIcon />}
                          aria-label="Make up a password"
                          onClick={() => set('password', generatedPassword())}
                        />
                      }
                    />
                  </div>
                </DialogField>
              )}
              {has('phone') && (
                <DialogField
                  label="Phone"
                  hint={kind === 'phone' ? '(E.164)' : '(optional)'}
                  error={shown('phone')}
                >
                  <DialogInput
                    value={form.phone}
                    onChange={(value) => set('phone', value)}
                    invalid={shown('phone') !== undefined}
                    type="tel"
                    placeholder="+15550100"
                    autoFocus={kind === 'phone'}
                    testId="new-phone"
                  />
                </DialogField>
              )}
              <DialogField label="Display name" hint="(optional)">
                <DialogInput
                  value={form.displayName}
                  onChange={(value) => set('displayName', value)}
                  placeholder="Ada Lovelace"
                  testId="new-display-name"
                />
              </DialogField>
              <DialogField label="Photo URL" hint="(optional)" error={shown('photoUrl')}>
                <div className="flex items-center gap-2">
                  <DialogInput
                    value={form.photoUrl}
                    onChange={(value) => set('photoUrl', value)}
                    invalid={shown('photoUrl') !== undefined}
                    type="url"
                    placeholder="https://…"
                    testId="new-photo-url"
                  />
                  {form.photoUrl.trim() && (
                    <UserAvatar
                      photoUrl={form.photoUrl.trim()}
                      name={form.displayName || null}
                      email={form.email || null}
                      anonymous={false}
                      size={24}
                    />
                  )}
                </div>
              </DialogField>
              {has('uid') && (
                <DialogField
                  label="uid"
                  hint={kind === 'custom' ? undefined : '(blank for a generated id)'}
                  error={shown('uid')}
                >
                  <DialogInput
                    value={form.uid}
                    onChange={(value) => set('uid', value)}
                    invalid={shown('uid') !== undefined}
                    placeholder={kind === 'custom' ? 'u_custom' : 'auto'}
                    autoFocus={kind === 'custom'}
                    testId="new-uid"
                  />
                </DialogField>
              )}
              <label className="flex items-center gap-2 self-end pb-1.5 text-[13px] text-kumo-subtle">
                <Switch
                  variant="neutral"
                  size="sm"
                  checked={form.disabled}
                  onClick={() => set('disabled', !form.disabled)}
                  aria-label="Disabled"
                  data-testid="new-disabled"
                />
                Disabled
              </label>
            </div>
            <Collapsible.Root open={claimsOpen} onOpenChange={setClaimsOpen}>
              <Collapsible.DefaultTrigger>Custom claims (optional)</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <div className="grid gap-1.5 pt-1">
                  <div className="flex h-32 min-h-0 flex-col">
                    <CodeEditor
                      value={form.claims}
                      onChange={(value) => set('claims', value)}
                      language="json"
                      marks={claimsMarks(form.claims)}
                      tidyPaste={(pasted) => formatClaims(pasted)}
                      ariaLabel="Custom claims"
                      testId="new-claims"
                    />
                  </div>
                  {shown('claims') && (
                    <span className="text-[12px] text-kumo-danger">{shown('claims')}</span>
                  )}
                </div>
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
            <p
              className="flex items-start gap-1.5 text-[13px] text-kumo-subtle"
              data-testid="new-user-note"
            >
              <span className="flex h-5 shrink-0 items-center">
                <InfoIcon size={14} />
              </span>
              <span>{note}</span>
            </p>
          </div>
          {failureText && (
            <p className="mt-3 text-[13px] text-kumo-danger" data-testid="create-user-error">
              {failureText}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close render={<Button variant="secondary">Cancel</Button>} />
            <Button
              type="button"
              variant="secondary"
              onClick={() => submit(true)}
              loading={create.isPending && create.variables === true}
              disabled={blocked !== undefined}
              data-testid="create-another"
            >
              Create and add another
            </Button>
            {blocked ? (
              <Tooltip
                content={blocked}
                render={
                  <span className="inline-flex">
                    <Button type="submit" variant="primary" disabled>
                      Create user
                    </Button>
                  </span>
                }
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                loading={create.isPending && create.variables === false}
                data-testid="create-user"
              >
                Create user
              </Button>
            )}
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
