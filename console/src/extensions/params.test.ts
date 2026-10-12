import { describe, expect, it } from 'vitest'
import type { ExtensionParam } from '@/api/generated/compute/ExtensionParam'
import {
  changedParams,
  draftProblems,
  initialDraft,
  multiValues,
  optionLabel,
  paramProblem,
  plannedFiles,
  reconfigureRequest,
  sourceWord,
} from './params'

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

const GREETING = param({
  param: 'GREETING_TEMPLATE',
  required: true,
  validationRegex: '^.*\\{name\\}.*$',
  validationErrorMessage: 'The template must contain {name}.',
  value: 'Hello, {name}!',
  provided: true,
  source: 'file',
  file: 'extensions/greeter.env',
})
const LOCATION = param({
  param: 'LOCATION',
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
})
const MODE = param({
  param: 'MODE',
  type: 'select',
  default: 'fast',
  options: [
    { value: 'fast', label: 'Fast' },
    { value: 'thorough', label: null },
  ],
  value: 'fast',
  provided: true,
  source: 'default',
})
const TAGS = param({
  param: 'TAGS',
  type: 'multiSelect',
  options: [
    { value: 'a', label: null },
    { value: 'b', label: null },
  ],
  value: 'a',
  provided: true,
  source: 'file',
  file: 'extensions/greeter.env',
})
const TOKEN = param({
  param: 'API_TOKEN',
  type: 'secret',
  required: true,
  provided: true,
  source: 'file',
  file: 'extensions/greeter.secret.local',
})
const PARAMS = [GREETING, LOCATION, MODE, TAGS, TOKEN]

describe('checking a value as the engine does', () => {
  it('a required value must be there', () => {
    expect(paramProblem(GREETING, '')).toBe('A value is required.')
    expect(paramProblem(MODE, '')).toBeUndefined()
  })

  it('a select takes one of its options, in the engine’s words', () => {
    expect(paramProblem(LOCATION, 'europe-west1')).toBeUndefined()
    expect(paramProblem(LOCATION, 'mars-central1')).toBe(
      'Choose one of: us-central1, europe-west1.',
    )
  })

  it('a multiSelect names the entry that is not an option', () => {
    expect(paramProblem(TAGS, 'a, b')).toBeUndefined()
    expect(paramProblem(TAGS, 'a,c')).toBe('c is not an option; choose from: a, b.')
    expect(multiValues(' a, ,b ')).toEqual(['a', 'b'])
  })

  it('a pattern says the extension’s own message, or the pattern', () => {
    expect(paramProblem(GREETING, 'Hi, {name}')).toBeUndefined()
    expect(paramProblem(GREETING, 'Hi there')).toBe('The template must contain {name}.')
    expect(paramProblem(param({ param: 'X', validationRegex: '^[a-z]+$' }), 'ABC')).toBe(
      'Does not match the pattern ^[a-z]+$.',
    )
  })

  it('checks a JavaScript-only pattern the engine could not, and skips one that does not compile', () => {
    const lookbehind = param({
      param: 'X',
      validationRegex: '(?<=a)b',
      unchecked: 'Not checked here',
    })
    expect(paramProblem(lookbehind, 'ab')).toBeUndefined()
    expect(paramProblem(lookbehind, 'cb')).toBe('Does not match the pattern (?<=a)b.')
    expect(paramProblem(param({ param: 'X', validationRegex: '([' }), 'anything')).toBeUndefined()
  })

  it('an empty secret keeps the one there is, and is required only when there is none', () => {
    expect(paramProblem(TOKEN, '')).toBeUndefined()
    expect(paramProblem({ ...TOKEN, provided: false }, '')).toBe('A value is required.')
  })
})

describe('a draft and what a Save sends', () => {
  it('starts from the values in force with every secret kept', () => {
    expect(initialDraft(PARAMS)).toEqual({
      GREETING_TEMPLATE: 'Hello, {name}!',
      LOCATION: 'us-central1',
      MODE: 'fast',
      TAGS: 'a',
      API_TOKEN: '',
    })
    expect(changedParams(PARAMS, initialDraft(PARAMS))).toEqual([])
  })

  it('sends the changed values and secrets apart, and only those', () => {
    const draft = {
      ...initialDraft(PARAMS),
      GREETING_TEMPLATE: 'Hi, {name}',
      API_TOKEN: 'tok-456',
    }
    expect(changedParams(PARAMS, draft).map((entry) => entry.param)).toEqual([
      'GREETING_TEMPLATE',
      'API_TOKEN',
    ])
    expect(reconfigureRequest(PARAMS, draft)).toEqual({
      values: { GREETING_TEMPLATE: 'Hi, {name}' },
      secrets: { API_TOKEN: 'tok-456' },
    })
  })

  it('lists the problems of the changed values only', () => {
    const draft = { ...initialDraft(PARAMS), LOCATION: 'mars', GREETING_TEMPLATE: 'no name' }
    expect([...draftProblems(PARAMS, draft)]).toEqual([
      ['GREETING_TEMPLATE', 'The template must contain {name}.'],
      ['LOCATION', 'Choose one of: us-central1, europe-west1.'],
    ])
  })
})

describe('the files a Save writes', () => {
  it('a value goes back to the instance’s own file that set it, else its .env; a secret to .secret.local', () => {
    const draft = {
      ...initialDraft(PARAMS),
      GREETING_TEMPLATE: 'Hi, {name}',
      LOCATION: 'europe-west1',
      MODE: 'thorough',
      API_TOKEN: 'tok-456',
    }
    expect(plannedFiles('greeter', PARAMS, draft)).toEqual([
      {
        file: 'extensions/greeter.env',
        changes: [
          {
            key: 'GREETING_TEMPLATE',
            before: 'Hello, {name}!',
            after: 'Hi, {name}',
            secret: false,
          },
          // A default had no file: it is written to the instance's .env, from nothing.
          { key: 'MODE', before: null, after: 'thorough', secret: false },
        ],
      },
      {
        file: 'extensions/greeter.env.local',
        changes: [{ key: 'LOCATION', before: 'us-central1', after: 'europe-west1', secret: false }],
      },
      {
        file: 'extensions/greeter.secret.local',
        changes: [{ key: 'API_TOKEN', before: null, after: 'tok-456', secret: true }],
      },
    ])
  })

  it('a value set outside the instance’s own files is written to its .env', () => {
    const shared = { ...GREETING, file: '.env' }
    expect(plannedFiles('greeter', [shared], { GREETING_TEMPLATE: 'Yo, {name}' })[0]?.file).toBe(
      'extensions/greeter.env',
    )
  })
})

describe('words', () => {
  it('names the file a value comes from, or that it is a default or not set', () => {
    expect(sourceWord(GREETING)).toBe('greeter.env')
    expect(sourceWord(TOKEN)).toBe('greeter.secret.local')
    expect(sourceWord(MODE)).toBe('default')
    expect(sourceWord(param({ param: 'X' }))).toBe('not set')
  })

  it('finds the label of an option', () => {
    expect(optionLabel(LOCATION, 'europe-west1')).toBe('Belgium (europe-west1)')
    expect(optionLabel(MODE, 'thorough')).toBeUndefined()
  })
})
