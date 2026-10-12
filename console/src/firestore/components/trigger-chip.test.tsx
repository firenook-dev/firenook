import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TriggersAnswer } from '@/lib/triggers'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'

const answers = vi.hoisted(() => ({
  current: 'unknown' as TriggersAnswer,
  asked: [] as Array<[string, string | undefined]>,
}))

vi.mock('@/lib/triggers', async (original) => ({
  ...(await original<typeof import('@/lib/triggers')>()),
  useTriggersFor: (service: string, resource: string | undefined) => {
    answers.asked.push([service, resource])
    return answers.current
  },
}))

const { TriggerChip, firestoreChange } = await import('./trigger-chip')

const status = testStatus({ sections: [sectionEntry('firestore'), sectionEntry('functions')] })

afterEach(() => {
  answers.current = 'unknown'
  answers.asked = []
})

describe('which functions run on a document', () => {
  it('reads the change each trigger fires on, in either generation', () => {
    expect(firestoreChange('providers/cloud.firestore/eventTypes/document.create')).toBe('create')
    expect(firestoreChange('google.cloud.firestore.document.v1.created')).toBe('create')
    expect(firestoreChange('google.cloud.firestore.document.v1.updated.withAuthContext')).toBe(
      'update',
    )
    expect(firestoreChange('providers/cloud.firestore/eventTypes/document.delete')).toBe('delete')
    expect(firestoreChange('google.cloud.firestore.document.v1.written')).toBe('every write')
  })

  it('asks for the document in its database, and draws nothing until it is known', async () => {
    await renderInConsole(() => <TriggerChip database="(default)" path="orders/o_1" />, { status })
    expect(answers.asked.at(-1)).toEqual(['firestore', '(default)|orders/o_1'])
    expect(screen.queryByTestId('document-triggers')).toBeNull()
  })

  it('draws nothing when Functions are absent or nothing listens', async () => {
    answers.current = 'absent'
    const absent = await renderInConsole(
      () => <TriggerChip database="(default)" path="orders/o_1" />,
      { status },
    )
    expect(screen.queryByTestId('document-triggers')).toBeNull()
    absent.unmount()
    answers.current = { functions: [], backgroundEnabled: true }
    await renderInConsole(() => <TriggerChip database="(default)" path="orders/o_1" />, {
      status,
    })
    expect(screen.queryByTestId('document-triggers')).toBeNull()
  })

  it('counts the functions and names each with the change it fires on', async () => {
    answers.current = {
      backgroundEnabled: false,
      functions: [
        {
          functionId: 'us-central1-onOrderCreated',
          codebase: 'default',
          eventType: 'providers/cloud.firestore/eventTypes/document.create',
          kind: 'firestore',
          function: { kind: 'functions.function', key: 'us-central1-onOrderCreated' },
        },
        {
          functionId: 'us-central1-onOrderWritten',
          codebase: 'default',
          eventType: 'google.cloud.firestore.document.v1.written',
          kind: 'firestore',
        },
      ],
    }
    await renderInConsole(() => <TriggerChip database="(default)" path="orders/o_1" />, { status })
    const chip = await screen.findByTestId('document-triggers')
    expect(chip.textContent).toBe('2')
    expect(chip.getAttribute('aria-label')).toBe('2 functions run on this document')
    fireEvent.click(chip)
    const rows = await screen.findAllByTestId('document-trigger')
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'onOrderCreated — create',
      'onOrderWritten — every write',
    ])
    expect(screen.getByTestId('document-triggers-paused').textContent).toMatch(/paused/)
  })
})
