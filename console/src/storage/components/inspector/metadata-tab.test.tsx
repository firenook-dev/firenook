import { TooltipProvider } from '@cloudflare/kumo'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { draftOf } from '../../metadata-draft'
import { MetadataTab } from './metadata-tab'

const object: StorageObjectDetail = {
  bucket: 'b',
  name: 'users/u1/cover.jpg',
  size: 1_024,
  contentType: 'image/jpeg',
  cacheControl: 'public, max-age=3600',
  contentDisposition: 'inline',
  contentEncoding: null,
  contentLanguage: null,
  customMetadata: { caption: 'Lisbon' },
  downloadTokens: [],
  tokensVisible: true,
  md5Hash: 'k2Q0bF6m3yR9xTqWv8sLdA==',
  crc32c: 'p4VgXw==',
  etag: 'MTox',
  generation: '1',
  metageneration: '1',
  storageClass: 'STANDARD',
  timeCreated: '2026-10-12T10:00:00Z',
  updated: '2026-10-12T10:00:00Z',
  sniffed: { mime: 'image/jpeg', family: 'image', definite: true },
  placeholder: false,
  decision: null,
}

describe('the Metadata tab', () => {
  afterEach(() => vi.restoreAllMocks())

  it('names every box it draws, so nothing warns when it opens', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const draft = draftOf(object)
    render(
      <TooltipProvider>
        <MetadataTab
          object={object}
          base={draft}
          draft={draft}
          onChange={() => {}}
          keySuggestions={[]}
        />
      </TooltipProvider>,
    )
    expect(screen.getByRole('textbox', { name: 'contentLanguage' })).toBeTruthy()
    expect(warn.mock.calls.map((call) => String(call[0]))).not.toContainEqual(
      expect.stringContaining('accessible name'),
    )
  })
})
