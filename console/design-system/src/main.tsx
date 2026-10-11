import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Link, Text } from '@cloudflare/kumo'
import { cards } from './registry'
import './cards/brand'
import './cards/foundations'
import './cards/components'
import './cards/patterns'
import './styles.css'

declare global {
  interface Window {
    __cards?: Array<
      Pick<(typeof cards)[number], 'id' | 'group' | 'name' | 'subtitle' | 'width' | 'dark'>
    >
    __ready?: boolean
  }
}

const params = new URLSearchParams(window.location.search)
const cardId = params.get('card')
const card = cardId ? cards.find((candidate) => candidate.id === cardId) : undefined

window.__cards = cards.map(({ id, group, name, subtitle, width, dark }) => ({
  id,
  group,
  name,
  subtitle,
  width,
  ...(dark ? { dark } : {}),
}))

if (card?.dark) document.documentElement.dataset['mode'] = 'dark'

function Ready({ children }: { children: ReactNode }) {
  useEffect(() => {
    let cancelled = false
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) window.__ready = true
        })
      })
    })
    return () => {
      cancelled = true
    }
  }, [])
  return children
}

function CardPage() {
  if (!card) {
    return (
      <div className="bg-kumo-canvas p-6 text-kumo-default">
        <Text variant="heading" as="h1">
          Card not found
        </Text>
      </div>
    )
  }
  const surface = card.surface === 'canvas' ? 'bg-kumo-canvas' : 'bg-kumo-base'
  return (
    <Ready>
      <div id="card" className={`${surface} text-kumo-default`} style={{ width: card.width }}>
        <div className="p-6">{card.render()}</div>
      </div>
    </Ready>
  )
}

function Index() {
  const groups = Array.from(new Set(cards.map((entry) => entry.group)))
  return (
    <div className="mx-auto grid max-w-3xl gap-8 bg-kumo-canvas px-6 py-8 text-kumo-default">
      <div className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h1">
          Firenook component library
        </Text>
        <Text variant="secondary">
          {cards.length} cards. Each opens alone at{' '}
          <span className="font-mono text-[0.9em]">?card=id</span>.
        </Text>
      </div>
      {groups.map((group) => (
        <section key={group} className="grid gap-2">
          <Text variant="heading" as="h2">
            {group}
          </Text>
          <ul className="grid gap-1">
            {cards
              .filter((entry) => entry.group === group)
              .map((entry) => (
                <li key={entry.id} className="flex items-baseline gap-3">
                  <Link href={`?card=${entry.id}`}>{entry.name}</Link>
                  <Text variant="secondary" size="sm">
                    {entry.subtitle}
                  </Text>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('missing root')
createRoot(container).render(<StrictMode>{cardId ? <CardPage /> : <Index />}</StrictMode>)
