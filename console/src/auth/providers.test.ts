import {
  EnvelopeSimpleIcon,
  GameControllerIcon,
  GoogleLogoIcon,
  IdentificationCardIcon,
  KeyIcon,
  PhoneIcon,
  UserCircleDashedIcon,
  WindowsLogoIcon,
  XLogoIcon,
} from '@phosphor-icons/react'
import { describe, expect, it } from 'vitest'
import { glyphsTooltip, providerGlyph, providerLabel, rowGlyphs } from './providers'

describe('provider glyphs', () => {
  it('draws one glyph per known provider id', () => {
    expect(providerGlyph('password')).toBe(EnvelopeSimpleIcon)
    expect(providerGlyph('phone')).toBe(PhoneIcon)
    expect(providerGlyph('google.com')).toBe(GoogleLogoIcon)
    expect(providerGlyph('twitter.com')).toBe(XLogoIcon)
    expect(providerGlyph('microsoft.com')).toBe(WindowsLogoIcon)
    expect(providerGlyph('gc.apple.com')).toBe(GameControllerIcon)
    expect(providerGlyph('playgames.google.com')).toBe(GameControllerIcon)
  })

  it('folds SAML, OIDC and unknown ids into the identity card, and names them', () => {
    expect(providerGlyph('saml.okta')).toBe(IdentificationCardIcon)
    expect(providerGlyph('oidc.auth0')).toBe(IdentificationCardIcon)
    expect(providerGlyph('example.org')).toBe(IdentificationCardIcon)
    expect(providerLabel('saml.okta')).toBe('SAML (saml.okta)')
    expect(providerLabel('oidc.auth0')).toBe('OIDC (oidc.auth0)')
    expect(providerLabel('example.org')).toBe('example.org')
    expect(providerLabel('google.com')).toBe('Google')
  })

  it('lists a row in link order, one glyph per kind, then custom token and anonymous', () => {
    const glyphs = rowGlyphs({
      providers: ['google.com', 'saml.a', 'password', 'saml.b'],
      customAuth: true,
      anonymous: false,
    })
    expect(glyphs.map((entry) => entry.glyph)).toEqual([
      GoogleLogoIcon,
      IdentificationCardIcon,
      EnvelopeSimpleIcon,
      KeyIcon,
    ])
    expect(glyphs[1]?.ids).toEqual(['saml.a', 'saml.b'])
    expect(rowGlyphs({ providers: [], customAuth: false, anonymous: true })[0]?.glyph).toBe(
      UserCircleDashedIcon,
    )
    expect(rowGlyphs({ providers: [], customAuth: false, anonymous: false })).toEqual([])
  })

  it('says every id in the tooltip, in words where it has them', () => {
    expect(
      glyphsTooltip(
        rowGlyphs({ providers: ['password', 'saml.x'], customAuth: false, anonymous: false }),
      ),
    ).toBe('Email and password · password\nSAML (saml.x)')
  })
})
