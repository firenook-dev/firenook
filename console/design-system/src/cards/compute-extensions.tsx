// Extensions' own pieces: a configuration's param rows — a validated
// string, selects, a secret masked and one revealed, a required value that
// is missing, a value its pattern refuses — in read mode and in edit mode,
// on the console's providers so the real components draw them.

import { TooltipProvider } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ReactNode, createContext, use, useState } from 'react'
import type { ExtensionParam } from '@/api/generated/compute/ExtensionParam'
import { statusQuery } from '@/api/queries'
import { ParamRow } from '@/extensions/components/param-row'
import { paramProblem } from '@/extensions/params'
import { testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/** The console's providers around a card: a status in the query client, a router, tooltips. */
function Kit({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(statusQuery.queryKey, testStatus({ projectId: 'demo-shop' }))
    return created
  })
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: CardRoot }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    }),
  )
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CardContent value={children}>
          <RouterProvider router={router} />
        </CardContent>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function param(overrides: Partial<ExtensionParam> & { param: string }): ExtensionParam {
  return {
    label: null,
    description: null,
    type: 'string',
    required: false,
    immutable: false,
    default: null,
    example: null,
    options: [],
    validationRegex: null,
    validationErrorMessage: null,
    value: null,
    provided: false,
    source: 'missing',
    file: null,
    problem: null,
    unchecked: null,
    ...overrides,
  }
}

const PARAMS: ExtensionParam[] = [
  param({
    param: 'GREETING_TEMPLATE',
    label: 'Greeting template',
    description: 'What every visitor reads. **{name}** is replaced by their name.',
    required: true,
    validationRegex: '^.*\\{name\\}.*$',
    validationErrorMessage: 'The template must contain {name}.',
    value: 'Hello, {name}!',
    provided: true,
    source: 'file',
    file: 'extensions/greeter.env',
  }),
  param({
    param: 'LOCATION',
    label: 'Location',
    type: 'select',
    required: true,
    immutable: true,
    options: [
      { value: 'us-central1', label: 'Iowa (us-central1)' },
      { value: 'europe-west1', label: 'Belgium (europe-west1)' },
    ],
    value: 'us-central1',
    provided: true,
    source: 'file',
    file: 'extensions/greeter.env.local',
  }),
  param({
    param: 'MODE',
    label: 'Mode',
    type: 'select',
    default: 'fast',
    options: [
      { value: 'fast', label: 'Fast' },
      { value: 'thorough', label: 'Thorough' },
    ],
    value: 'fast',
    provided: true,
    source: 'default',
  }),
  param({
    param: 'API_TOKEN',
    label: 'API token',
    type: 'secret',
    required: true,
    provided: true,
    source: 'file',
    file: 'extensions/greeter.secret.local',
  }),
  param({
    param: 'BUCKET',
    label: 'Bucket',
    required: true,
    problem: 'A value is required.',
  }),
  param({
    param: 'TAGLINE',
    label: 'Tagline',
    validationRegex: '^[A-Z]',
    validationErrorMessage: 'Start with a capital letter.',
    value: 'lowercase start',
    provided: true,
    source: 'file',
    file: 'extensions/greeter.env',
    problem: 'Start with a capital letter.',
  }),
]

/** A revealed secret's value, as the engine's reveal route answers. */
const reveal = () => Promise.resolve('tok-123')

function ParamRows({ editing }: { editing: boolean }) {
  // Edit mode with one value changed and one refused as typed.
  const drafted: Record<string, string> = {
    GREETING_TEMPLATE: 'Hi there',
    LOCATION: 'europe-west1',
  }
  return (
    <div className="grid rounded-lg bg-kumo-base px-5 ring ring-kumo-line">
      {PARAMS.map((entry) => {
        const value = editing
          ? (drafted[entry.param] ?? (entry.type === 'secret' ? '' : (entry.value ?? '')))
          : (entry.value ?? '')
        return (
          <ParamRow
            key={entry.param}
            param={entry}
            editing={editing}
            value={value}
            problem={editing ? paramProblem(entry, value) : undefined}
            onChange={() => undefined}
            reveal={reveal}
          />
        )
      })}
    </div>
  )
}

function ParamRowsCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="Reading a configuration"
          note="Each value in a box in the data face, the file that set it beside it; a default and a missing value say so; a secret stays masked until its eye is pressed; what the engine refuses is said under the value."
        >
          <ParamRows editing={false} />
        </Section>
        <Section
          title="Editing it"
          note="The same rows with inputs of each type in the same place; a changed value is marked, and one its pattern refuses is said as it is typed."
        >
          <ParamRows editing />
        </Section>
      </Stack>
    </Kit>
  )
}

defineCards([
  {
    id: 'param-rows',
    group: 'Patterns',
    name: 'Extension params',
    subtitle:
      'String, selects, a secret, a missing required value and a refused one, in read and edit modes',
    width: 760,
    surface: 'canvas',
    render: () => <ParamRowsCard />,
  },
  {
    id: 'param-rows-dark',
    group: 'Patterns',
    name: 'Extension params, dark',
    subtitle: 'The same, in dark mode',
    width: 760,
    dark: true,
    surface: 'canvas',
    render: () => <ParamRowsCard />,
  },
])
