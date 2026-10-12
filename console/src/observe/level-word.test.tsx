import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LevelWord } from './level-word'

afterEach(cleanup)

describe('the level word', () => {
  it('names every level, info included, in the row’s colours', () => {
    render(
      <>
        <LevelWord level="debug" testId="debug" />
        <LevelWord level="info" testId="info" />
        <LevelWord level="warn" testId="warn" />
        <LevelWord level="error" testId="error" />
      </>,
    )
    expect(screen.getByTestId('info')).toHaveTextContent('info')
    expect(screen.getByTestId('info').className).toContain('text-kumo-subtle')
    expect(screen.getByTestId('debug').className).toContain('text-kumo-inactive')
    expect(screen.getByTestId('warn').className).toContain('text-kumo-warning')
    expect(screen.getByTestId('error').className).toContain('text-kumo-danger')
    expect(screen.getByTestId('error')).toHaveAttribute('data-level', 'error')
  })

  it('draws the row’s rail before a warning or an error only when asked', () => {
    render(
      <>
        <LevelWord level="error" rail testId="railed" />
        <LevelWord level="error" testId="plain" />
        <LevelWord level="info" rail testId="info" />
      </>,
    )
    const rail = screen.getByTestId('railed').querySelector('[aria-hidden="true"]')
    expect(rail?.className).toContain('bg-kumo-danger')
    expect(screen.getByTestId('plain').querySelector('[aria-hidden="true"]')).toBeNull()
    expect(screen.getByTestId('info').querySelector('[aria-hidden="true"]')).toBeNull()
    // The rail is a mark, not a word: the text stays the level alone.
    expect(screen.getByTestId('railed')).toHaveTextContent(/^error$/)
  })
})
