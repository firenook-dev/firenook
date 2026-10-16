import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkFilter } from '@/lib/filter'
import cases from '@/logs/filter-cases.json'
import { SourceChip, functionName, labelSource, lineSource, sourceTokenText } from './source-chip'

afterEach(cleanup)

const LOG_FIELDS = { fields: cases.fields as never, regex: true }

describe('where a line came from', () => {
  it('is the function’s short name, with its region in words', () => {
    expect(functionName('us-central1-hello')).toEqual({ name: 'hello', region: 'us-central1' })
    expect(functionName('northamerica-northeast1-send-mail')).toEqual({
      name: 'send-mail',
      region: 'northamerica-northeast1',
    })
    expect(functionName('hello')).toEqual({ name: 'hello', region: undefined })
    expect(lineSource({ service: 'functions', function: 'us-central1-hello' })).toEqual({
      text: 'hello',
      description: 'Function us-central1-hello in us-central1',
      filter: 'Filter by function us-central1-hello',
      token: { key: 'function', value: 'us-central1-hello' },
    })
  })

  it('else the extension instance, else the service', () => {
    expect(lineSource({ service: 'functions', extension: 'resize-images' })).toEqual({
      text: 'resize-images',
      description: 'Extension instance resize-images',
      filter: 'Filter by extension instance resize-images',
      token: { key: 'instance', value: 'resize-images' },
    })
    expect(lineSource({ service: 'firestore' })).toEqual({
      text: 'firestore',
      description: 'Firestore',
      filter: 'Filter by service firestore',
      token: { key: 'service', value: 'firestore' },
    })
    expect(lineSource({ service: 'hub', source: null }).description).toBe('Emulator hub')
  })

  it('reads a function from the terminal’s label, matched by that label', () => {
    expect(lineSource({ service: 'functions', source: 'functions[us-central1-hello]' })).toEqual({
      text: 'hello',
      description: 'Function us-central1-hello in us-central1',
      filter: 'Filter by function us-central1-hello',
      token: { phrase: 'functions[us-central1-hello]' },
    })
    expect(lineSource({ service: 'functions', source: 'extensions[resize]' }).token).toEqual({
      phrase: 'extensions[resize]',
    })
    // A label that is not a family's falls back to the service.
    expect(lineSource({ service: 'functions', source: 'functions' }).text).toBe('functions')
  })

  it('reads the Overview’s labels the same way', () => {
    expect(labelSource('functions[us-central1-fails]').text).toBe('fails')
    expect(labelSource('extensions[resize-images]').description).toBe(
      'Extension instance resize-images',
    )
    expect(labelSource('firestore').token).toEqual({ key: 'service', value: 'firestore' })
  })

  it('writes its filter item so the Logs filter reads it back', () => {
    const tokens = [
      { key: 'function', value: 'us-central1-hello' },
      { key: 'instance', value: 'resize images' },
      { key: 'service', value: 'firestore' },
      { phrase: 'functions[us-central1-hello]' },
    ] as const
    expect(tokens.map(sourceTokenText)).toEqual([
      'function:us-central1-hello',
      'instance:"resize images"',
      'service:firestore',
      '"functions[us-central1-hello]"',
    ])
    const parsed = checkFilter(tokens.map(sourceTokenText).join(' '), LOG_FIELDS)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.query.terms.map((term) => [term.key, term.value])).toEqual([
      ['function', 'us-central1-hello'],
      ['instance', 'resize images'],
      ['service', 'firestore'],
    ])
    expect(parsed.query.words.map((word) => word.text)).toEqual(['functions[us-central1-hello]'])
  })
})

describe('the source chip', () => {
  const hello = lineSource({ service: 'functions', function: 'us-central1-hello' })

  it('is the quiet chip at rest', () => {
    render(<SourceChip source={hello} testId="chip" />)
    const chip = screen.getByTestId('chip')
    expect(chip.tagName).toBe('SPAN')
    expect(chip).toHaveTextContent('hello')
    expect(chip.className).toContain('bg-kumo-tint')
  })

  it('hands its filter item over on a click, without opening the row under it', () => {
    const pick = vi.fn()
    const row = vi.fn()
    render(
      <div onClick={row}>
        <SourceChip source={hello} onPick={pick} tabIndex={-1} testId="chip" />
      </div>,
    )
    const chip = screen.getByTestId('chip')
    expect(chip.tagName).toBe('BUTTON')
    expect(chip).toHaveAccessibleName('Filter by function us-central1-hello')
    expect(chip).toHaveAttribute('tabindex', '-1')
    fireEvent.click(chip)
    expect(pick).toHaveBeenCalledWith({ key: 'function', value: 'us-central1-hello' })
    expect(row).not.toHaveBeenCalled()
  })
})
