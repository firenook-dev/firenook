import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FacetGroup,
  FacetList,
  facetState,
  hideFacet,
  isCompoundFacet,
  onlyFacet,
  toggleFacet,
} from './facet-list'

const LEVELS: FacetGroup = {
  label: 'Level',
  facets: [
    { term: 'level:error', label: 'Error', count: 12, tone: 'danger' },
    { term: 'level:warn', label: 'Warning', count: 40, tone: 'warning' },
    { term: 'level:info', label: 'Info', count: 1_820 },
  ],
}

afterEach(cleanup)

describe('editing the filter text', () => {
  it('reads whether a term is in, negated or out, whatever its case', () => {
    expect(facetState('Level:Error ada', 'level:error')).toBe('on')
    expect(facetState('-level:debug', 'level:debug')).toBe('negated')
    expect(facetState('level:error', 'level:warn')).toBe('off')
    expect(facetState('level:>error', 'level:error')).toBe('off')
    expect(facetState('"level:error"', 'level:error')).toBe('off')
  })

  it('adds a term at the end and takes it out where it stands, leaving the rest as typed', () => {
    expect(toggleFacet('', 'level:error')).toBe('level:error')
    expect(toggleFacet('ada  "two  spaces"', 'level:error')).toBe('ada  "two  spaces" level:error')
    expect(toggleFacet('ada level:error  "two  spaces"', 'level:error')).toBe('ada "two  spaces"')
    expect(toggleFacet('-level:debug ada', 'level:debug')).toBe('ada')
  })

  it('hides a term by its negation, once', () => {
    expect(hideFacet('level:debug ada', 'level:debug')).toBe('ada -level:debug')
    expect(hideFacet('-level:debug', 'level:debug')).toBe('-level:debug')
  })

  it('makes a term the only one of its group', () => {
    expect(onlyFacet('level:warn ada -level:debug level:info', 'level:error', LEVELS.facets)).toBe(
      'ada level:error',
    )
  })

  it('still adds a term to a filter that does not parse', () => {
    expect(toggleFacet('"unclosed', 'level:error')).toBe('"unclosed level:error')
  })
})

describe('a facet of several terms, or of a negated one', () => {
  const UNVERIFIED = 'has:email -is:verified'
  const NEVER = '-has:sign-in'

  it('is compound, and a plain term is not', () => {
    expect(isCompoundFacet(UNVERIFIED)).toBe(true)
    expect(isCompoundFacet(NEVER)).toBe(true)
    expect(isCompoundFacet('level:error')).toBe(false)
    expect(isCompoundFacet('provider:"saml.my idp"')).toBe(false)
  })

  it('is pressed only while every term is in the filter, as written', () => {
    expect(facetState('ada has:email -is:verified', UNVERIFIED)).toBe('on')
    expect(facetState('-IS:verified Has:Email', UNVERIFIED)).toBe('on')
    expect(facetState('has:email', UNVERIFIED)).toBe('off')
    expect(facetState('has:email is:verified', UNVERIFIED)).toBe('off')
    expect(facetState('-has:sign-in', NEVER)).toBe('on')
    expect(facetState('has:sign-in', NEVER)).toBe('off')
  })

  it('writes the terms it lacks, and takes out every one of them when pressed again', () => {
    expect(toggleFacet('', UNVERIFIED)).toBe('has:email -is:verified')
    expect(toggleFacet('ada has:email', UNVERIFIED)).toBe('ada has:email -is:verified')
    expect(toggleFacet('has:email ada -is:verified is:disabled', UNVERIFIED)).toBe(
      'ada is:disabled',
    )
    expect(toggleFacet('ada', NEVER)).toBe('ada -has:sign-in')
    expect(toggleFacet('-has:sign-in ada', NEVER)).toBe('ada')
  })

  it('replaces a term it contradicts rather than adding beside it', () => {
    expect(toggleFacet('is:verified ada', UNVERIFIED)).toBe('ada has:email -is:verified')
    expect(toggleFacet('has:sign-in', NEVER)).toBe('-has:sign-in')
  })
})

const facet = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) })

describe('FacetList', () => {
  function Harness({ initial = '' }: { initial?: string }) {
    const [q, setQ] = useState(initial)
    return (
      <>
        <output data-testid="q">{q}</output>
        <FacetList groups={[LEVELS]} value={q} onChange={setQ} />
      </>
    )
  }

  it('is a group of toggles that write the page’s q', () => {
    render(<Harness />)
    expect(screen.getByRole('group', { name: 'Level' })).toBeInTheDocument()
    expect(facet('Error')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(facet('Error'))
    expect(screen.getByTestId('q')).toHaveTextContent('level:error')
    expect(facet('Error')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(facet('Error'))
    expect(screen.getByTestId('q')).toBeEmptyDOMElement()
  })

  it('draws a negated term struck through and pressed as mixed; Only and Hide change the group', () => {
    render(<Harness initial="level:warn" />)
    const info = screen.getAllByTestId('facet')[2] as HTMLElement
    fireEvent.click(within(info).getByRole('button', { name: 'Hide Info' }))
    expect(screen.getByTestId('q')).toHaveTextContent('level:warn -level:info')
    expect(facet('Info')).toHaveAttribute('aria-pressed', 'mixed')
    expect(within(facet('Info')).getByText('Info').className).toContain('line-through')
    const error = screen.getAllByTestId('facet')[0] as HTMLElement
    fireEvent.click(within(error).getByRole('button', { name: 'Show only Error' }))
    expect(screen.getByTestId('q')).toHaveTextContent(/^level:error$/)
  })

  it('shows each count in the data face, toned where it is a warning', () => {
    render(<Harness />)
    expect(within(facet('Info')).getByText('1,820').className).toContain('font-mono')
    expect(within(facet('Error')).getByText('12')).toHaveAttribute(
      'class',
      expect.stringContaining('text-kumo-danger'),
    )
  })

  it('offers neither Only nor Hide on a compound facet, and keeps its count in sight', () => {
    const group: FacetGroup = {
      label: 'Not yet',
      facets: [
        { term: 'has:email -is:verified', label: 'Unverified email', count: 41 },
        { term: 'level:debug', label: 'Debug', count: 3 },
      ],
    }
    function Compound() {
      const [q, setQ] = useState('')
      return (
        <>
          <output data-testid="q">{q}</output>
          <FacetList groups={[group]} value={q} onChange={setQ} />
        </>
      )
    }
    render(<Compound />)
    const [unverified, debug] = screen.getAllByTestId('facet') as HTMLElement[]
    expect(within(unverified as HTMLElement).queryByTestId('facet-only')).toBeNull()
    expect(within(unverified as HTMLElement).getByText('41').className).not.toContain('invisible')
    expect(within(debug as HTMLElement).getByTestId('facet-only')).toBeInTheDocument()
    fireEvent.click(facet('Unverified email'))
    expect(screen.getByTestId('q')).toHaveTextContent('has:email -is:verified')
    expect(facet('Unverified email')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(facet('Unverified email'))
    expect(screen.getByTestId('q')).toBeEmptyDOMElement()
  })

  it('leaves Only and Hide out when asked', () => {
    render(<FacetList groups={[LEVELS]} value="" onChange={() => {}} exclusions={false} />)
    expect(screen.queryByTestId('facet-only')).toBeNull()
  })
})
