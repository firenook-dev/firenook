import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FunctionKind } from '@/api/generated/compute/FunctionKind'
import { KIND_HELP, KIND_WORDS, KindBadge } from './kind-badge'

afterEach(cleanup)

/** Every kind the engine sends: a `Record` over the generated union fails when one is added. */
const ENGINE_KINDS: Record<FunctionKind, true> = {
  http: true,
  callable: true,
  firestore: true,
  storage: true,
  auth: true,
  pubsub: true,
  schedule: true,
  eventarc: true,
  tasks: true,
  blocking: true,
  alerts: true,
  database: true,
  other: true,
}

describe('the kind chip', () => {
  it('knows every kind the engine sends, each with a sentence', () => {
    expect(KIND_WORDS.toSorted()).toEqual(Object.keys(ENGINE_KINDS).toSorted())
    for (const kind of KIND_WORDS) expect(KIND_HELP[kind]).toMatch(/^[A-Z].*\.$/)
  })

  it("writes the shell's word in the data face, one quiet ground for every kind", () => {
    render(
      <>
        {KIND_WORDS.map((kind) => (
          <KindBadge key={kind} kind={kind} />
        ))}
      </>,
    )
    const chips = screen.getAllByTestId('kind-badge')
    expect(chips.map((chip) => chip.textContent)).toEqual([...KIND_WORDS])
    const grounds = new Set(chips.map((chip) => chip.className))
    expect(grounds.size).toBe(1)
    const [classes = ''] = grounds
    for (const token of [
      'font-mono',
      'text-[11px]',
      'bg-kumo-tint',
      'text-kumo-subtle',
      'group-hover:ink',
    ])
      expect(classes.split(' ')).toContain(token)
    expect(chips[2]).toHaveAttribute('data-kind', 'firestore')
  })

  it('draws the same chip without its tooltip where the kind is explained already', () => {
    render(<KindBadge kind="tasks" tooltip={false} />)
    expect(screen.getByTestId('kind-badge')).toHaveTextContent('tasks')
  })
})
