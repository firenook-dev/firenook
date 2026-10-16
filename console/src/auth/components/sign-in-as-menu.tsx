// "Sign in as": the tokens a sign-in of this user would produce, minted by
// the engine without signing in (nothing stored, the last sign-in left as it
// was) — with the provider the token names, the second factor an MFA user's
// sign-in ends with, and, when asked, the beforeSignIn function run the way
// a sign-in runs it (its claims and session claims in the token; the
// account not changed; its own side effects happen). Copied as a token, an
// Authorization header, a custom token for the app's devtools, a Firestore
// request; viewed in Inspect a token, with what still differs from a real
// sign-in; or opened in Firestore and the rules playground as this user.

import { Button, DropdownMenu, Tooltip } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  CopyIcon,
  DatabaseIcon,
  EyeIcon,
  FlaskIcon,
  KeyIcon,
  TerminalIcon,
  UserFocusIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { AuthMintedToken } from '@/api/generated/auth/AuthMintedToken'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { statusQuery } from '@/api/queries'
import { MenuCheck } from '@/components/kit'
import { hostLiteral, defaultConnectHost } from '@/lib/connect'
import { toast } from '@/lib/toasts'
import { mintToken } from '../api'
import { identifierOf } from '../identifier'
import { handOffToken } from '../inspect-handoff'
import { firestoreAsUser, playgroundAsUser } from '../links'
import { providerLabel } from '../providers'
import { hooksQuery } from '../queries'
import { projectParam } from '../tenant-scope'
import {
  type FactorChoice,
  type TokenChoice,
  authorizationHeader,
  customTokenSnippet,
  firestoreCurl,
  tokenRequest,
} from '../token-request'
import { copyToClipboard } from '@/lib/copy'
import { type UserTarget, refusal } from '../user-actions'

export function SignInAsMenu({
  detail,
  target,
  words = true,
}: {
  detail: AuthUserDetail
  target: UserTarget
  /** Room for the word on the trigger (the footer gives it up by width). */
  words?: boolean
}) {
  const navigate = useNavigate()
  const status = useQuery(statusQuery)
  const hooks = useQuery({ ...hooksQuery(target.project), enabled: target.project !== '' })
  const [provider, setProvider] = useState<string | undefined>(undefined)
  const [factor, setFactor] = useState<FactorChoice>('default')
  const [runBeforeSignIn, setRunBeforeSignIn] = useState(false)
  const firestore = status.data?.services.find((service) => service.name === 'firestore')
  const providers = detail.row.providers.length > 0 ? detail.row.providers : []
  const choice: TokenChoice = {
    uid: target.uid,
    tenant: target.tenant,
    provider,
    secondFactor: factor,
    runBeforeSignIn: runBeforeSignIn && hooks.data?.beforeSignIn !== null,
  }
  const mint = async (what: string): Promise<AuthMintedToken | undefined> => {
    try {
      return await mintToken(target.project, tokenRequest(choice))
    } catch (error) {
      toast({
        key: `auth.mint.${target.uid}`,
        title: `The engine did not mint ${what}`,
        description: refusal(error),
        tone: 'danger',
      })
      return undefined
    }
  }
  const copyFrom = (what: string, pick: (minted: AuthMintedToken) => string) => async () => {
    const minted = await mint(what)
    if (minted)
      await copyToClipboard(pick(minted), {
        what,
        refused: 'Allow clipboard access for this page, or copy it from the inspector.',
      })
  }
  const as = { uid: target.uid, tenant: target.tenant, email: detail.row.email }
  const factorLabel =
    factor === 'none'
      ? 'None'
      : factor === 'default'
        ? (detail.mfa[0]?.phoneNumber ?? 'None')
        : (detail.mfa.find((item) => item.enrollmentId === factor.enrollment)?.phoneNumber ??
          'None')
  const shownProvider = provider ?? providers[0]
  const trigger = words ? (
    <Button variant="ghost" size="sm" icon={<UserFocusIcon />} data-testid="sign-in-as">
      <span className="flex items-center gap-1">
        Sign in as
        <CaretDownIcon size={12} />
      </span>
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={<UserFocusIcon />}
      aria-label="Sign in as this user"
      data-testid="sign-in-as"
    />
  )
  return (
    <DropdownMenu>
      <Tooltip
        content="Tokens a sign-in of this user would produce, minted without signing in"
        render={<DropdownMenu.Trigger render={trigger} />}
      />
      <DropdownMenu.Content align="start" className="w-80">
        <div data-testid="sign-in-as-menu">
          {providers.length > 1 && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger icon={KeyIcon}>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  Token as
                  <span className="ml-auto truncate font-mono text-[12px] text-kumo-subtle">
                    {shownProvider}
                  </span>
                </span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent>
                {providers.map((id, index) => (
                  <DropdownMenu.Item
                    key={id}
                    closeOnClick={false}
                    onClick={() => setProvider(index === 0 ? undefined : id)}
                  >
                    <span className="font-mono text-[12px]">{id}</span>
                    <span className="pl-2 text-[12px] text-kumo-subtle">{providerLabel(id)}</span>
                    <MenuCheck on={shownProvider === id} />
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          )}
          {detail.mfa.length > 0 && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger icon={KeyIcon}>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  Second factor
                  <span className="ml-auto truncate font-mono text-[12px] text-kumo-subtle">
                    {factorLabel}
                  </span>
                </span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent>
                {detail.mfa.map((item, index) => {
                  const chosen =
                    (factor === 'default' && index === 0) ||
                    (typeof factor === 'object' && factor.enrollment === item.enrollmentId)
                  return (
                    <DropdownMenu.Item
                      key={item.enrollmentId}
                      closeOnClick={false}
                      onClick={() =>
                        setFactor(index === 0 ? 'default' : { enrollment: item.enrollmentId })
                      }
                    >
                      <span className="font-mono text-[12px]">{item.phoneNumber}</span>
                      {item.displayName && (
                        <span className="pl-2 text-[12px] text-kumo-subtle">
                          {item.displayName}
                        </span>
                      )}
                      <MenuCheck on={chosen} />
                    </DropdownMenu.Item>
                  )
                })}
                <DropdownMenu.Item closeOnClick={false} onClick={() => setFactor('none')}>
                  None (a first-factor token)
                  <MenuCheck on={factor === 'none'} />
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          )}
          {hooks.data?.beforeSignIn && (
            <Tooltip
              content="Runs your function, so its own side effects (writes, logs) happen. The account is not changed."
              side="right"
              render={
                <span className="block">
                  <DropdownMenu.Item
                    closeOnClick={false}
                    onClick={() => setRunBeforeSignIn(!runBeforeSignIn)}
                    data-testid="run-before-sign-in"
                  >
                    Run beforeSignIn
                    <MenuCheck on={runBeforeSignIn} />
                  </DropdownMenu.Item>
                </span>
              }
            />
          )}
          {(providers.length > 1 || detail.mfa.length > 0 || hooks.data?.beforeSignIn) && (
            <DropdownMenu.Separator />
          )}
          <DropdownMenu.Item
            icon={CopyIcon}
            onClick={() => void copyFrom('an ID token', (minted) => minted.idToken)()}
            data-testid="copy-id-token"
          >
            Copy ID token
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={CopyIcon}
            onClick={() =>
              void copyFrom('the Authorization header', (minted) =>
                authorizationHeader(minted.idToken),
              )()
            }
            data-testid="copy-authorization"
          >
            Copy Authorization header
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={CopyIcon}
            className="items-start"
            onClick={() =>
              void copyFrom('a custom token line', (minted) =>
                customTokenSnippet(minted.customToken),
              )()
            }
            data-testid="copy-custom-token"
          >
            <span className="grid gap-0.5">
              <span>Copy custom token for your app</span>
              <span className="text-[12px] text-kumo-subtle">
                Paste in your app’s devtools:{' '}
                <span className="font-mono text-[0.9em]">signInWithCustomToken(getAuth(), …)</span>.
                The account is then marked as having used a custom token, as in production.
              </span>
            </span>
          </DropdownMenu.Item>
          {firestore && (
            <DropdownMenu.Item
              icon={TerminalIcon}
              onClick={() =>
                void copyFrom('a Firestore request as this user', (minted) =>
                  firestoreCurl({
                    idToken: minted.idToken,
                    project: target.project,
                    firestoreAddress: `${hostLiteral(
                      status.data ? defaultConnectHost(status.data).host : firestore.host,
                    )}:${firestore.port}`,
                  }),
                )()
              }
              data-testid="copy-firestore-curl"
            >
              Copy curl (Firestore as this user)
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            icon={EyeIcon}
            onClick={() =>
              void mint('a token to view').then((minted) => {
                if (!minted) return
                handOffToken(minted.idToken, { who: identifierOf(detail.row).text, minted })
                void navigate({
                  to: '/auth/activity' as never,
                  search: { panel: 'inspect', project: projectParam(target.project) } as never,
                })
              })
            }
            data-testid="view-token"
          >
            View the token…
          </DropdownMenu.Item>
          {firestore && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={DatabaseIcon}
                onClick={() => {
                  const link = firestoreAsUser(as)
                  void navigate({ to: link.to as never, search: link.search as never })
                }}
                data-testid="open-firestore-as"
              >
                Open Firestore as this user
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={FlaskIcon}
                onClick={() => {
                  const link = playgroundAsUser(as)
                  void navigate({ to: link.to as never, search: link.search as never })
                }}
                data-testid="open-playground-as"
              >
                Open the rules playground as this user
              </DropdownMenu.Item>
            </>
          )}
        </div>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
