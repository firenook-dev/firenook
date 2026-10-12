import { describe, expect, it } from 'vitest'
import { KIND_WORDS } from '@/compute/kind-badge'
import {
  KIND_ICON,
  actionTitle,
  answersOnUrl,
  generationText,
  kindVerb,
  runForm,
  runTabLabel,
} from './kinds'

describe('a kind on the Functions page', () => {
  it('has one Run form, verb and tab label, and every kind has a glyph', () => {
    const table = KIND_WORDS.map((kind) => [kind, runForm(kind), kindVerb(kind), runTabLabel(kind)])
    expect(table).toEqual([
      ['http', 'invoke', 'Invoke', 'Invoke'],
      ['callable', 'callable', 'Call', 'Call'],
      ['firestore', 'event', 'Send test event', 'Test event'],
      ['storage', 'event', 'Send test event', 'Test event'],
      ['auth', 'event', 'Send test event', 'Test event'],
      ['pubsub', 'event', 'Send test event', 'Test event'],
      ['schedule', 'schedule', 'Run now', 'Run'],
      ['eventarc', 'event', 'Send test event', 'Test event'],
      ['tasks', 'task', 'Enqueue', 'Enqueue'],
      ['blocking', 'blocking', 'Test', 'Test'],
      ['alerts', 'event', 'Send test event', 'Test event'],
      ['database', 'event', 'Send test event', 'Test event'],
      ['other', 'invoke', 'Invoke', 'Invoke'],
    ])
    for (const kind of KIND_WORDS) expect(KIND_ICON[kind]).toBeDefined()
  })

  it('says its action as ⌘K does', () => {
    expect(actionTitle('http', 'api')).toBe('Invoke api')
    expect(actionTitle('firestore', 'onOrderCreated')).toBe('Send a test event to onOrderCreated')
    expect(actionTitle('schedule', 'nightly')).toBe('Run nightly now')
    expect(actionTitle('tasks', 'resize')).toBe('Enqueue a task for resize')
    expect(actionTitle('blocking', 'beforeCreate')).toBe('Test beforeCreate')
  })

  it('answers on a URL only for http, callable and blocking functions', () => {
    expect(KIND_WORDS.filter(answersOnUrl)).toEqual(['http', 'callable', 'blocking'])
    expect(generationText('gcfv1')).toBe('1st gen')
    expect(generationText('gcfv2')).toBe('2nd gen')
  })
})
