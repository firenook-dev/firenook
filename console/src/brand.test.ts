// The console wears the brand kit (`brand/` at the repository root) by
// copy: the tab's icons are `brand/favicon/`'s files, and the top bar's
// logo is `brand/logo/firenook-logo-flat.svg`'s paths. A rebuilt kit
// reaches the console only through a new copy, so this says when one is
// due. (The web manifest is the console's own: its addresses are relative
// to `/console/`.)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// This file's folder, `console/src` (the test DOM gives `import.meta.url` an http scheme).
const consoleDir = join(import.meta.dirname, '..')
const brandDir = join(consoleDir, '..', 'brand')

const ICONS = [
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
]

const paths = (text: string) => [...text.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1])

describe('the brand kit, as the console wears it', () => {
  it.each(ICONS)('serves %s as the kit has it', (icon) => {
    expect(readFileSync(join(consoleDir, 'public', icon))).toEqual(
      readFileSync(join(brandDir, 'favicon', icon)),
    )
  })

  it('draws the logo with the flat logo’s own paths', () => {
    const logo = paths(
      readFileSync(join(consoleDir, 'src/components/kit/firenook-logo.tsx'), 'utf8'),
    )
    expect(logo.length).toBeGreaterThan(0)
    expect(logo).toEqual(paths(readFileSync(join(brandDir, 'logo/firenook-logo-flat.svg'), 'utf8')))
  })
})
