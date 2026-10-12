// One user in full, beside the table: Details (every stored field, the
// account actions), Claims (the editor that shows the token it produces),
// Activity (this user's calls and messages) and Raw (the stored record).
//
// Edits are a per-field draft (`user-draft.ts`): an app that keeps signing
// the user in moves fields the draft does not hold, so it never interrupts
// an edit; someone else changing the very field being edited is said for
// that field, with Use theirs and Keep mine. Save writes the draft in one
// `accounts:update`, through the official API, as the Admin SDK would.

import { Button, Tooltip } from '@cloudflare/kumo'
import { CheckCircleIcon, ProhibitIcon, TrashIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { AuthMintedToken } from '@/api/generated/auth/AuthMintedToken'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import {
  Inspector,
  InspectorFooter,
  InspectorTitle,
  useInspectorRoom,
} from '@/components/console/inspector'
import { exactTime } from '@/components/console/relative-time'
import { SectionBanner } from '@/components/console/section-banner'
import { PanelTitle } from '@/components/kit'
import { relativeTime } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { identifierOf } from '../identifier'
import { authKeys, userQuery } from '../queries'
import { type TenantScope, tenantKey, usersTenant } from '../tenant-scope'
import { refusal, setUserDisabled, updateUser } from '../user-actions'
import {
  type DraftField,
  FIELD_LABELS,
  type UserDraft,
  type UserValues,
  changedFields,
  draftBase,
  draftConflicts,
  draftProblems,
  editDraft,
  keepMine,
  shownValue,
  updateBody,
  takeTheirs,
  valuesOf,
} from '../user-draft'
import { ClaimsEditor } from './claims-editor'
import { InspectorDetails } from './inspector-details'
import { RawRecord } from './raw-record'
import { SignInAsMenu } from './sign-in-as-menu'
import { TokenDialog } from './token-dialog'
import { UserActivity } from './user-activity'
import { UserAvatar } from './user-avatar'
import { UserCodeMenu } from './user-code-menu'

export type InspectorTab = 'details' | 'claims' | 'activity' | 'raw'

const FIELDS: readonly DraftField[] = [
  'displayName',
  'photoUrl',
  'email',
  'emailVerified',
  'phoneNumber',
  'disabled',
  'createdAt',
  'lastLoginAt',
  'claims',
]

/** A value as a conflict banner quotes it. */
function quoted(value: UserValues[DraftField]): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (value === '') return 'nothing'
  return value.length > 60 ? `${value.slice(0, 57)}…` : value
}

export function UserInspector({
  project,
  scope,
  uid,
  tab,
  onTab,
  onClose,
  onPrev,
  onNext,
  blocked,
  onDelete,
  onSeen,
}: {
  project: string
  scope: TenantScope
  uid: string
  tab: InspectorTab
  onTab: (tab: InspectorTab) => void
  onClose: () => void
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
  /** Why writes are refused (the tenant was deleted). */
  blocked: string | undefined
  onDelete: (row: AuthUserRow) => void
  /** The user's name once it is known, for the recents. */
  onSeen?: ((label: string) => void) | undefined
}) {
  const queryClient = useQueryClient()
  const detail = useQuery({ ...userQuery(project, scope, uid), enabled: project !== '' })
  const target = { project, tenant: usersTenant(scope), uid }
  const [draft, setDraft] = useState<UserDraft>({})
  const [viewing, setViewing] = useState<AuthMintedToken | undefined>(undefined)
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: authKeys.user(project, tenantKey(scope), uid),
      exact: true,
    })

  const data = detail.data
  const label = data ? identifierOf(data.row).text : undefined
  // Said once per name: the page's callback is a new function on every render.
  const seen = useRef(onSeen)
  useLayoutEffect(() => {
    seen.current = onSeen
  })
  useEffect(() => {
    if (label !== undefined) seen.current?.(label)
  }, [label])

  const server = data ? valuesOf(data) : undefined
  const shown = server
    ? (Object.fromEntries(
        FIELDS.map((field) => [field, shownValue(draft, server, field)]),
      ) as unknown as UserValues)
    : undefined
  const changed = server ? changedFields(draft, server) : []
  const problems = draftProblems(draft)
  const problemCount = changed.filter((field) => problems[field] !== undefined).length
  const conflicts = server ? draftConflicts(draftBase(draft), server, draft) : []

  const save = useMutation({
    mutationFn: async () => {
      if (!server) return
      await updateUser(target, updateBody(uid, draft, server))
    },
    onSuccess: () => {
      setDraft({})
      refresh()
      toast({ key: `auth.save.${uid}`, title: 'User saved', description: label, tone: 'success' })
    },
  })
  const toggle = useMutation({
    mutationFn: (disabled: boolean) => setUserDisabled(target, disabled),
    onSuccess: refresh,
    onError: (error) =>
      toast({
        key: `auth.disable.${uid}`,
        title: 'The emulator did not change the account',
        description: refusal(error),
        tone: 'danger',
      }),
  })
  const canSave =
    changed.length > 0 && problemCount === 0 && conflicts.length === 0 && blocked === undefined
  const doSave = () => {
    if (canSave && !save.isPending) save.mutate()
  }
  useShortcuts({ id: 'auth.user', label: 'User' }, [
    { key: 'Mod+s', label: 'Save the user', allowInInputs: true, run: doSave, when: () => canSave },
  ])

  const edit = <F extends DraftField>(field: F, value: UserValues[F]) => {
    if (server) setDraft((current) => editDraft(current, server, field, value))
  }

  const deleted = detail.error instanceof ApiError && detail.error.code === 'not-found'
  const row = data?.row
  const meta = row ? (
    <>
      {row.createdAt !== null && (
        <Tooltip
          content={`Created ${exactTime(new Date(row.createdAt).toISOString())}`}
          render={
            <span className="cursor-default" data-testid="user-created">
              {relativeTime(new Date(row.createdAt).toISOString())}
            </span>
          }
        />
      )}
      {row.createdAt !== null && <span aria-hidden>·</span>}
      {row.lastSignInAt === null ? (
        <span>never signed in</span>
      ) : (
        <Tooltip
          content={`Last signed in ${exactTime(new Date(row.lastSignInAt).toISOString())}`}
          render={
            <span className="cursor-default" data-testid="user-signed-in">
              signed in {relativeTime(new Date(row.lastSignInAt).toISOString())}
            </span>
          }
        />
      )}
    </>
  ) : undefined

  return (
    <Inspector
      widthKey="auth.user"
      title={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {row && (
            <UserAvatar
              photoUrl={row.photoUrl}
              name={row.displayName}
              email={row.email}
              anonymous={row.anonymous}
            />
          )}
          <InspectorTitle value={uid} />
        </span>
      }
      meta={meta}
      onClose={onClose}
      closeLabel="Close the user"
      noun="user"
      onPrev={onPrev}
      onNext={onNext}
      tabs={
        data
          ? {
              value: tab,
              onChange: (value) => onTab(value as InspectorTab),
              items: [
                { value: 'details', label: 'Details' },
                { value: 'claims', label: 'Claims', count: data.row.claimKeys.length || undefined },
                { value: 'activity', label: 'Activity' },
                { value: 'raw', label: 'Raw' },
              ],
            }
          : undefined
      }
      footer={
        data && row && server ? (
          <UserFooter
            row={row}
            detail={data}
            target={target}
            blocked={blocked}
            changed={changed.length}
            problemCount={problemCount}
            conflictCount={conflicts.length}
            saving={save.isPending}
            saveError={save.isError ? refusal(save.error) : undefined}
            canSave={canSave}
            onSave={doSave}
            toggling={toggle.isPending}
            onToggle={() => toggle.mutate(!row.disabled)}
            onDelete={() => onDelete(row)}
            onView={setViewing}
          />
        ) : undefined
      }
      testId="user-inspector"
    >
      {deleted ? (
        <div className="grid gap-3 p-5" data-testid="user-deleted">
          <PanelTitle>This user was deleted.</PanelTitle>
          <div>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : detail.isError ? (
        <div className="grid gap-2 p-5">
          <PanelTitle>The engine did not answer for this user</PanelTitle>
          <p className="text-[13px] text-kumo-subtle">{refusal(detail.error)}</p>
          <div>
            <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
              Retry
            </Button>
          </div>
        </div>
      ) : !data || !server || !shown ? (
        <p className="p-5 text-[13px] text-kumo-subtle">Reading the user…</p>
      ) : (
        <>
          {conflicts.map((conflict) => (
            <SectionBanner
              key={conflict.field}
              tone="warning"
              testId="user-conflict"
              action={
                <>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setDraft((current) => takeTheirs(current, conflict.field))}
                    data-testid="use-theirs"
                  >
                    Use theirs
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setDraft((current) => keepMine(current, server, conflict.field))}
                    data-testid="keep-mine"
                  >
                    Keep mine
                  </Button>
                </>
              }
            >
              Someone changed {FIELD_LABELS[conflict.field]} while you were editing: now{' '}
              <span className="font-mono text-[0.9em]">{quoted(conflict.theirs)}</span>.
            </SectionBanner>
          ))}
          {tab === 'details' && (
            <InspectorDetails
              detail={data}
              server={server}
              draft={draft}
              shown={shown}
              changed={new Set(changed)}
              problems={problems}
              onEdit={edit}
              target={target}
              blocked={blocked}
              onActed={refresh}
            />
          )}
          {tab === 'claims' && (
            <ClaimsEditor
              detail={data}
              project={project}
              tenant={target.tenant}
              text={shown.claims}
              onChange={(text) => edit('claims', text)}
              problem={changed.includes('claims') ? problems.claims : undefined}
              onSave={doSave}
            />
          )}
          {tab === 'activity' && <UserActivity project={project} scope={scope} uid={uid} />}
          {tab === 'raw' && <RawRecord detail={data} />}
        </>
      )}
      <TokenDialog
        open={viewing !== undefined}
        onOpenChange={(open) => {
          if (!open) setViewing(undefined)
        }}
        minted={viewing}
        who={label ?? uid}
        project={project}
      />
    </Inspector>
  )
}

function UserFooter({
  row,
  detail,
  target,
  blocked,
  changed,
  problemCount,
  conflictCount,
  saving,
  saveError,
  canSave,
  onSave,
  toggling,
  onToggle,
  onDelete,
  onView,
}: {
  row: AuthUserRow
  detail: Parameters<typeof SignInAsMenu>[0]['detail']
  target: { project: string; tenant: string | undefined; uid: string }
  blocked: string | undefined
  changed: number
  problemCount: number
  conflictCount: number
  saving: boolean
  saveError: string | undefined
  canSave: boolean
  onSave: () => void
  toggling: boolean
  onToggle: () => void
  onDelete: () => void
  onView: (minted: AuthMintedToken) => void
}) {
  // The footer is as wide as the panel: words go by width, the least needed
  // first — the destructive pair's words, then the tools'. Save keeps its.
  const { width } = useInspectorRoom()
  const words = { tools: width >= 420, danger: width >= 540 }
  const status = saveError ? (
    <span className="min-w-0 truncate text-[13px] text-kumo-danger" data-testid="save-error">
      {saveError}
    </span>
  ) : conflictCount > 0 ? (
    <span className="text-[13px] whitespace-nowrap text-kumo-warning" data-testid="save-blocked">
      {conflictCount === 1 ? '1 conflict' : `${conflictCount} conflicts`}
    </span>
  ) : problemCount > 0 ? (
    <span className="text-[13px] whitespace-nowrap text-kumo-danger" data-testid="save-blocked">
      {`${problemCount} to fix`}
    </span>
  ) : changed > 0 ? (
    <span className="text-[13px] whitespace-nowrap text-kumo-subtle" data-testid="save-pending">
      {changed === 1 ? '1 change' : `${changed} changes`}
    </span>
  ) : null
  const saveButton = (
    <Button
      variant={changed > 0 && problemCount === 0 && conflictCount === 0 ? 'primary' : 'secondary'}
      size="sm"
      onClick={onSave}
      disabled={!canSave}
      loading={saving}
      data-testid="save-user"
    >
      Save
    </Button>
  )
  return (
    <InspectorFooter
      tools={
        <>
          <SignInAsMenu detail={detail} target={target} onView={onView} words={words.tools} />
          <UserCodeMenu
            detail={detail}
            project={target.project}
            tenant={target.tenant}
            words={words.tools}
          />
        </>
      }
      danger={
        <>
          {words.danger ? (
            <Button
              variant="ghost"
              size="sm"
              icon={row.disabled ? <CheckCircleIcon /> : <ProhibitIcon />}
              onClick={onToggle}
              loading={toggling}
              disabled={blocked !== undefined}
              data-testid="toggle-disabled"
            >
              {row.disabled ? 'Enable' : 'Disable'}
            </Button>
          ) : (
            <Tooltip
              content={row.disabled ? 'Enable' : 'Disable'}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={row.disabled ? <CheckCircleIcon /> : <ProhibitIcon />}
                  aria-label={row.disabled ? 'Enable' : 'Disable'}
                  onClick={onToggle}
                  disabled={blocked !== undefined}
                  data-testid="toggle-disabled"
                />
              }
            />
          )}
          {words.danger ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<TrashIcon className="text-kumo-danger" />}
              onClick={onDelete}
              disabled={blocked !== undefined}
              aria-label="Delete this user"
              data-testid="delete-user-button"
            >
              <span className="text-kumo-danger">Delete</span>
            </Button>
          ) : (
            <Tooltip
              content="Delete this user"
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<TrashIcon className="text-kumo-danger" />}
                  onClick={onDelete}
                  disabled={blocked !== undefined}
                  aria-label="Delete this user"
                  data-testid="delete-user-button"
                />
              }
            />
          )}
        </>
      }
      primary={
        <>
          {status}
          {blocked ? (
            <Tooltip content={blocked} render={<span className="inline-flex">{saveButton}</span>} />
          ) : (
            saveButton
          )}
        </>
      }
      testId="user-footer"
    />
  )
}
