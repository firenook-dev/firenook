import { describe, expect, it } from 'vitest'
import type { SectionStatus } from '@/api/generated/SectionStatus'
import { sectionEntry, testStatus } from '@/test/status'
import { linkTo } from './links'

const status = (sections: Array<Pick<SectionStatus, 'id' | 'state'>>) =>
  testStatus({ sections: sections.map(({ id, state }) => sectionEntry(id, { state })) })

describe('links between sections', () => {
  const ready = status([{ id: 'firestore', state: 'ready' }])

  it('resolve through the target section’s registry', () => {
    expect(linkTo({ kind: 'firestore.document', key: '(default)|users/u1' }, ready)).toEqual({
      to: '/firestore',
      search: { db: undefined, path: 'users', doc: 'users/u1' },
    })
  })

  it('are plain text into a section the engine does not run', () => {
    const absent = status([{ id: 'firestore', state: 'absent' }])
    expect(linkTo({ kind: 'firestore.document', key: '(default)|users/u1' }, absent)).toBeNull()
  })

  it('still lead into a section that is starting, whose gate fills in', () => {
    const starting = status([{ id: 'firestore', state: 'starting' }])
    expect(
      linkTo({ kind: 'firestore.collection', key: '(default)|users' }, starting),
    ).not.toBeNull()
  })

  it('are plain text for a kind nobody knows', () => {
    expect(linkTo({ kind: 'firestore.index', key: 'x' }, ready)).toBeNull()
    expect(linkTo({ kind: 'nothing', key: 'x' }, ready)).toBeNull()
    expect(linkTo({ kind: '.document', key: 'x' }, ready)).toBeNull()
  })
})
