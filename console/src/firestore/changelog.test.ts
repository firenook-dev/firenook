import { describe, expect, it } from 'vitest'
import type { LoggedCommit } from '@/api/generated/LoggedCommit'
import { describeCommit, documentName, undoBlockedBecause } from './changelog'

const commit = (over: Partial<LoggedCommit> = {}): LoggedCommit => ({
  id: 1,
  revision: 10,
  commitTime: '2026-10-08T03:00:00Z',
  documents: [{ database: '(default)', path: 'users/u1', kind: 'updated' }],
  undoable: true,
  undid: null,
  undone: false,
  ...over,
})

describe('the line a commit reads as', () => {
  it('counts each kind it holds, in a fixed order', () => {
    expect(
      describeCommit(
        commit({
          documents: [
            { database: '(default)', path: 'a/1', kind: 'deleted' },
            { database: '(default)', path: 'a/2', kind: 'created' },
            { database: '(default)', path: 'a/3', kind: 'created' },
            { database: '(default)', path: 'a/4', kind: 'updated' },
          ],
        }),
      ),
    ).toBe('2 created, 1 updated, 1 deleted')
  })

  it('leaves out the kinds a commit does not hold', () => {
    expect(describeCommit(commit())).toBe('1 updated')
  })

  it('says what an undo was, rather than counting it again', () => {
    expect(describeCommit(commit({ undid: 4 }))).toBe('Undid an earlier change')
  })

  it('does not claim documents a commit has none of', () => {
    expect(describeCommit(commit({ documents: [] }))).toBe('No documents')
  })
})

describe('whether undo is offered', () => {
  it('is offered for a commit whose documents are still held', () => {
    expect(undoBlockedBecause(commit())).toBeUndefined()
  })

  it('says so when it has already been put back', () => {
    expect(undoBlockedBecause(commit({ undone: true }))).toBe('Already undone')
  })

  it('says so when the documents were too large to keep', () => {
    expect(undoBlockedBecause(commit({ undoable: false }))).toBe(
      'Too large to keep the documents it replaced',
    )
  })

  it('prefers the clearer reason when both apply', () => {
    expect(undoBlockedBecause(commit({ undone: true, undoable: false }))).toBe('Already undone')
  })
})

describe('the chip a document shows', () => {
  // The id alone is an opaque string: a uuid-keyed document read as
  // `1fcedbc4-4bb9-4333-9c68-49a089b92cd7` and left no way to tell what
  // had been touched, while the whole path was on the wire already.
  it('is the collection and the id, which is what names a document', () => {
    expect(documentName('users/u_9f3k2/orders/o_1')).toBe('orders/o_1')
    expect(documentName('users/u_9f3k2')).toBe('users/u_9f3k2')
    expect(documentName('users')).toBe('users')
  })
})
