// How a sign-in provider is drawn: one quiet glyph per provider, and its
// name in words for a tooltip or a list. The ids are the Identity Toolkit's
// (`providerUserInfo[].providerId`); `saml.*` and `oidc.*` are families, and
// any id this list does not know is still shown, as a generic identity card,
// so a provider is never dropped from a row.

import {
  AppleLogoIcon,
  EnvelopeSimpleIcon,
  FacebookLogoIcon,
  FingerprintIcon,
  GameControllerIcon,
  GithubLogoIcon,
  GoogleLogoIcon,
  type Icon,
  IdentificationCardIcon,
  KeyIcon,
  LinkSimpleIcon,
  PhoneIcon,
  UserCircleDashedIcon,
  WindowsLogoIcon,
  XLogoIcon,
} from '@phosphor-icons/react'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'

/** What a row marks besides its linked providers: a custom-token sign-in, an anonymous account, a passkey. */
export const CUSTOM_TOKEN = 'custom'
export const ANONYMOUS = 'anonymous'
export const PASSKEY = 'passkey'
/** An email-link sign-in, when an account says it used one. */
export const EMAIL_LINK = 'emailLink'

interface ProviderLook {
  glyph: Icon
  label: string
}

const KNOWN: Readonly<Record<string, ProviderLook>> = {
  password: { glyph: EnvelopeSimpleIcon, label: 'Email and password' },
  [EMAIL_LINK]: { glyph: LinkSimpleIcon, label: 'Email link' },
  phone: { glyph: PhoneIcon, label: 'Phone' },
  'google.com': { glyph: GoogleLogoIcon, label: 'Google' },
  'apple.com': { glyph: AppleLogoIcon, label: 'Apple' },
  'github.com': { glyph: GithubLogoIcon, label: 'GitHub' },
  'facebook.com': { glyph: FacebookLogoIcon, label: 'Facebook' },
  'twitter.com': { glyph: XLogoIcon, label: 'X (Twitter)' },
  'microsoft.com': { glyph: WindowsLogoIcon, label: 'Microsoft' },
  'gc.apple.com': { glyph: GameControllerIcon, label: 'Game Center' },
  'playgames.google.com': { glyph: GameControllerIcon, label: 'Play Games' },
  'yahoo.com': { glyph: IdentificationCardIcon, label: 'Yahoo' },
  [CUSTOM_TOKEN]: { glyph: KeyIcon, label: 'Custom token' },
  [PASSKEY]: { glyph: FingerprintIcon, label: 'Passkey' },
  [ANONYMOUS]: { glyph: UserCircleDashedIcon, label: 'Anonymous' },
}

/** The provider ids a developer is offered when linking one (the known federated ones first). */
export const LINKABLE_PROVIDERS: readonly string[] = [
  'google.com',
  'apple.com',
  'github.com',
  'facebook.com',
  'twitter.com',
  'microsoft.com',
  'yahoo.com',
  'gc.apple.com',
  'playgames.google.com',
]

/** The glyph for a provider id; SAML, OIDC and any unknown id share the identity card. */
export function providerGlyph(id: string): Icon {
  return KNOWN[id]?.glyph ?? IdentificationCardIcon
}

/** A provider id in words: "Google", "SAML (saml.okta)", or the id itself when unknown. */
export function providerLabel(id: string): string {
  const known = KNOWN[id]
  if (known) return known.label
  if (id.startsWith('saml.')) return `SAML (${id})`
  if (id.startsWith('oidc.')) return `OIDC (${id})`
  return id
}

/** One glyph a row shows, with the ids it stands for. */
export interface RowGlyph {
  key: string
  glyph: Icon
  ids: string[]
}

/**
 * The glyphs a users row shows, in link order: one per glyph (two SAML
 * providers are one identity card, both ids in its tooltip), then a custom
 * token and anonymous, which are not linked providers but say how the
 * account signs in.
 */
export function rowGlyphs(
  row: Pick<AuthUserRow, 'providers' | 'customAuth' | 'anonymous'>,
): RowGlyph[] {
  const glyphs: RowGlyph[] = []
  const add = (id: string) => {
    const glyph = providerGlyph(id)
    const existing = glyphs.find((entry) => entry.glyph === glyph)
    if (existing) {
      if (!existing.ids.includes(id)) existing.ids.push(id)
      return
    }
    glyphs.push({ key: id, glyph, ids: [id] })
  }
  for (const id of row.providers) add(id)
  if (row.customAuth && !row.providers.includes(CUSTOM_TOKEN)) add(CUSTOM_TOKEN)
  if (row.anonymous) add(ANONYMOUS)
  return glyphs
}

/** The tooltip of a row's glyphs: each id in words, then the ids as typed for a filter. */
export function glyphsTooltip(glyphs: readonly RowGlyph[]): string {
  return glyphs
    .flatMap((entry) => entry.ids)
    .map((id) => {
      const label = providerLabel(id)
      // SAML and OIDC labels already hold the id.
      return label === id || label.endsWith(`(${id})`) ? label : `${label} · ${id}`
    })
    .join('\n')
}
