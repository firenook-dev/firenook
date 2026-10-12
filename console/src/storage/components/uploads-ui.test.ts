import { describe, expect, it } from 'vitest'
import { conflictTitle } from './conflict-dialog'
import { folderNameProblems } from './create-folder-dialog'
import { bulkPatch } from './edit-metadata-dialog'
import { previewSentence } from './file-actions'
import { jobVerb } from './jobs'
import { traySummary } from './upload-tray'

describe('the upload and organizing dialogs', () => {
  it('ask about taken names in a sentence that agrees', () => {
    expect(conflictTitle(12, 340)).toBe('12 of 340 files already exist')
    expect(conflictTitle(1, 3)).toBe('1 of 3 files already exists')
    expect(conflictTitle(1, 1)).toBe('1 file already exists')
    expect(conflictTitle(0, 2)).toBe('Upload 2 files')
  })

  it('check a new folder’s name as it is typed', () => {
    expect(folderNameProblems('a/b', '').error).toMatch(/cannot contain/)
    expect(folderNameProblems('x'.repeat(1_100), '').error).toMatch(/1,024 bytes/)
    expect(folderNameProblems('drafts[1]', '').warning).toMatch(/gsutil/)
    expect(folderNameProblems('drafts', 'users/')).toEqual({ error: undefined, warning: undefined })
  })

  it('send only the metadata fields touched', () => {
    const fields = {
      contentType: { value: '', clear: false },
      cacheControl: { value: '', clear: true },
      contentDisposition: { value: 'inline', clear: false },
      contentEncoding: { value: '', clear: false },
      contentLanguage: { value: '', clear: false },
    }
    expect(
      bulkPatch(
        fields,
        [{ id: '1', key: 'reviewed', value: 'true', enabled: true }],
        'tmpTag, draft',
      ),
    ).toEqual({
      cacheControl: null,
      contentDisposition: 'inline',
      customMetadata: { tmpTag: null, draft: null, reviewed: 'true' },
    })
  })

  it('say what a job will touch and did', () => {
    expect(
      previewSentence({
        objects: 900,
        bytes: 20 * 1024 * 1024,
        folders: 121,
        conflicts: 0,
        conflictSample: [],
      }),
    ).toBe('900 files · 20.0 MB in 121 folders')
    expect(jobVerb('storage.move')).toBe('moved')
    expect(jobVerb('storage.delete')).toBe('deleted')
    expect(
      traySummary(
        [
          { id: 'a', bucket: 'b', name: 'a', size: 1, loaded: 0, state: 'uploading' },
          { id: 'b', bucket: 'b', name: 'b', size: 1, loaded: 1, state: 'done' },
        ],
        { files: 2, finished: 1 },
      ),
    ).toBe('Uploading · 1 of 2 done')
  })
})
