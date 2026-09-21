import type { ReactNode } from 'react'

export type CardGroup = 'Brand' | 'Foundations' | 'Components' | 'Patterns'

export interface Card {
  /** Stable id; also the folder name in the bundle. */
  id: string
  group: CardGroup
  name: string
  /** What the card shows, in one line. */
  subtitle: string
  /** Card width in CSS px; the height comes from the content. */
  width: number
  /** Render the card in Kumo's dark mode. */
  dark?: boolean
  /** Background token behind the card content. */
  surface?: 'base' | 'canvas'
  render: () => ReactNode
}

export const cards: Card[] = []

export function defineCards(list: Card[]): void {
  for (const card of list) {
    if (cards.some((existing) => existing.id === card.id)) {
      throw new Error(`duplicate card id: ${card.id}`)
    }
    cards.push(card)
  }
}
