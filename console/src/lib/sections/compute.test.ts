import { describe, expect, it } from 'vitest'
import { seenBadges } from '@/components/console/section-gate'
import { sectionEntry, testStatus } from '@/test/status'
import { linkTo } from '../links'
import { eventarc } from './eventarc'
import { extensions } from './extensions'
import { functions } from './functions'

const route = (section: typeof functions, kind: string, key: string) =>
  section.routes?.[kind]?.(key)

describe('where compute things open', () => {
  it('a function, an invocation and a codebase on the Functions pages', () => {
    expect(route(functions, 'functions.function', 'us-central1-api')).toEqual({
      to: '/functions',
      search: { function: 'us-central1-api' },
    })
    expect(route(functions, 'functions.invocation', 'a3f9c1-1284')).toEqual({
      to: '/functions/invocations',
      search: { invocation: 'a3f9c1-1284' },
    })
    expect(route(functions, 'functions.codebase', 'jobs')).toEqual({
      to: '/functions',
      search: { codebase: 'jobs' },
    })
  })

  it('an extension instance, an event and a channel whose name holds slashes', () => {
    expect(route(extensions, 'extensions.instance', 'greeter')).toEqual({
      to: '/extensions',
      search: { instance: 'greeter' },
    })
    expect(route(eventarc, 'eventarc.event', 'a3f9c1-212')).toEqual({
      to: '/eventarc',
      search: { event: 'a3f9c1-212' },
    })
    const channel = 'projects/demo-x/locations/us-central1/channels/firebase'
    expect(route(eventarc, 'eventarc.channel', channel)).toEqual({
      to: '/eventarc',
      search: { channel },
    })
    expect(route(eventarc, 'eventarc.channel', 'google')).toEqual({
      to: '/eventarc',
      search: { channel: 'google' },
    })
  })

  it('names the search groups for functions and instances', () => {
    expect(functions.searchLabels).toEqual({ 'functions.function': 'Functions' })
    expect(extensions.searchLabels).toEqual({ 'extensions.instance': 'Extensions' })
  })
})

describe('pages and badges', () => {
  it('each badge sits on the page it is about, so only that page marks it seen', () => {
    expect(functions.badges).toBeUndefined()
    expect(seenBadges(functions, '/functions')).toEqual(['functions.load'])
    expect(seenBadges(functions, '/functions/invocations')).toEqual(['functions.failed'])
  })

  it('Eventarc has its events and its channels, and no Alerts page without alert delivery', () => {
    expect(eventarc.pages?.map((page) => page.to)).toEqual(['/eventarc', '/eventarc/channels'])
    expect(eventarc.actions?.[0]?.link).toEqual({ to: '/eventarc', search: { new: 'event' } })
  })
})

describe('built once their journeys pass', () => {
  const status = testStatus({
    sections: ['functions', 'extensions', 'eventarc'].map((id) => sectionEntry(id)),
  })

  it('Functions, Extensions and Eventarc are built, so a link into them opens their page', () => {
    expect([functions.built, extensions.built, eventarc.built]).toEqual([true, true, true])
    expect(linkTo({ kind: 'functions.function', key: 'us-central1-api' }, status)).toEqual({
      to: '/functions',
      search: { function: 'us-central1-api' },
    })
    expect(linkTo({ kind: 'functions.invocation', key: 'a3f9c1-1' }, status)).toEqual({
      to: '/functions/invocations',
      search: { invocation: 'a3f9c1-1' },
    })
    expect(linkTo({ kind: 'extensions.instance', key: 'greeter' }, status)).toEqual({
      to: '/extensions',
      search: { instance: 'greeter' },
    })
    expect(linkTo({ kind: 'eventarc.event', key: 'a3f9c1-2' }, status)).toEqual({
      to: '/eventarc',
      search: { event: 'a3f9c1-2' },
    })
  })

  it('a built section absent from this engine reads as text too', () => {
    const absent = testStatus({
      sections: [sectionEntry('extensions', { state: 'absent' }), sectionEntry('eventarc')],
    })
    expect(linkTo({ kind: 'extensions.instance', key: 'greeter' }, absent)).toBeNull()
  })
})
