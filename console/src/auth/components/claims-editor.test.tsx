import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaimsMeter } from './claims-editor'

afterEach(() => cleanup())

/** The meter's filled bar: the element Kumo draws the brand gradient on. */
function indicatorOf(meter: HTMLElement): HTMLElement {
  const bar = meter.querySelector<HTMLElement>('[role="meter"] [class*="transition-[width]"]')
  if (!bar) throw new Error('the meter has no indicator')
  return bar
}

describe('the claims meter', () => {
  it('reads quiet, crowded from 900 and over above 1,000, in Firebase’s characters', () => {
    const cases = [
      { length: 212, tone: 'quiet', text: '212 / 1,000 characters' },
      { length: 900, tone: 'crowded', text: '900 / 1,000 characters' },
      { length: 1_000, tone: 'crowded', text: '1,000 / 1,000 characters' },
      { length: 1_086, tone: 'over', text: '1,086 / 1,000 characters' },
    ] as const
    for (const { length, tone, text } of cases) {
      const view = render(<ClaimsMeter length={length} />)
      const meter = view.getByTestId('claims-meter')
      expect(meter.dataset['tone']).toBe(tone)
      expect(meter.textContent).toContain(text)
      view.unmount()
    }
  })

  it('colours the bar itself: the tone replaces every stop of the brand gradient', () => {
    const stops = (length: number) => {
      const view = render(<ClaimsMeter length={length} />)
      const classes = [...indicatorOf(view.getByTestId('claims-meter')).classList].filter((name) =>
        /^(from|via|to)-/.test(name),
      )
      view.unmount()
      return classes.toSorted()
    }
    // A background colour alone never shows: Kumo paints the bar as a gradient.
    expect(stops(212)).toEqual(['from-kumo-brand', 'to-kumo-brand', 'via-kumo-brand'])
    expect(stops(944)).toEqual(['from-kumo-warning', 'to-kumo-warning', 'via-kumo-warning'])
    expect(stops(1_086)).toEqual(['from-kumo-danger', 'to-kumo-danger', 'via-kumo-danger'])
  })

  it('says so while the text is not JSON yet, and stays quiet', () => {
    const view = render(<ClaimsMeter length={undefined} />)
    const meter = view.getByTestId('claims-meter')
    expect(meter.dataset['tone']).toBe('quiet')
    expect(meter.textContent).toContain('not JSON yet')
  })
})
