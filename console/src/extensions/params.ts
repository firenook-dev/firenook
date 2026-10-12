// An instance's configuration as it is edited: what each value would be,
// what is wrong with it as it is typed, what a Save sends and which files
// it writes. The checks mirror the engine's (`extensions::params::validate`
// and the reconfigure route), word for word, so the message under a field
// is the one the engine would answer with; the engine still checks again.
// A pattern only JavaScript can compile, which the engine cannot check, is
// checked here: the browser is a JavaScript engine.

import type { ExtensionParam } from '@/api/generated/compute/ExtensionParam'
import type { ExtensionReconfigureRequest } from '@/api/generated/compute/ExtensionReconfigureRequest'

/** Every param's value as edited, by param name. A secret's entry is the new secret, `''` to keep it. */
export type ParamDraft = Readonly<Record<string, string>>

/** The draft a param list starts from: every value as it is, every secret kept. */
export function initialDraft(params: readonly ExtensionParam[]): ParamDraft {
  const draft: Record<string, string> = {}
  for (const param of params)
    draft[param.param] = param.type === 'secret' ? '' : (param.value ?? '')
  return draft
}

/** The entries of a multiSelect value, as the engine splits them. */
export function multiValues(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** The pattern compiled the way the extension's own (JavaScript) runtime would, or undefined. */
function compile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

/**
 * What is wrong with `value` for `param`, in the engine's words, or
 * undefined when it is acceptable. An empty secret keeps the current one,
 * so it is a problem only when there is none and one is required.
 */
export function paramProblem(param: ExtensionParam, value: string): string | undefined {
  if (value === '') {
    if (param.type === 'secret')
      return param.required && !param.provided ? 'A value is required.' : undefined
    return param.required ? 'A value is required.' : undefined
  }
  const options = param.options.map((option) => option.value)
  if (param.type === 'select' && options.length > 0 && !options.includes(value))
    return `Choose one of: ${options.join(', ')}.`
  if (param.type === 'multiSelect' && options.length > 0) {
    const unknown = multiValues(value).find((entry) => !options.includes(entry))
    if (unknown !== undefined)
      return `${unknown} is not an option; choose from: ${options.join(', ')}.`
  }
  if (!param.validationRegex) return undefined
  const regex = compile(param.validationRegex)
  if (!regex || regex.test(value)) return undefined
  return param.validationErrorMessage || `Does not match the pattern ${param.validationRegex}.`
}

/** The params whose drafted value differs from what the instance runs with. */
export function changedParams(
  params: readonly ExtensionParam[],
  draft: ParamDraft,
): ExtensionParam[] {
  return params.filter((param) => {
    const value = draft[param.param]
    if (value === undefined) return false
    return param.type === 'secret' ? value !== '' : value !== (param.value ?? '')
  })
}

/** Each drafted value's problem, by param, for the params that changed. */
export function draftProblems(
  params: readonly ExtensionParam[],
  draft: ParamDraft,
): ReadonlyMap<string, string> {
  const problems = new Map<string, string>()
  for (const param of changedParams(params, draft)) {
    const problem = paramProblem(param, draft[param.param] ?? '')
    if (problem !== undefined) problems.set(param.param, problem)
  }
  return problems
}

/** What a Save sends: the changed values, secrets apart. */
export function reconfigureRequest(
  params: readonly ExtensionParam[],
  draft: ParamDraft,
): ExtensionReconfigureRequest {
  const values: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const param of changedParams(params, draft)) {
    const value = draft[param.param] ?? ''
    if (param.type === 'secret') secrets[param.param] = value
    else values[param.param] = value
  }
  return { values, secrets }
}

/** One value a Save changes, as the dialog lists it. */
export interface PlannedChange {
  key: string
  /** The value now; null when the key is not set in that file (or is a secret). */
  before: string | null
  /** The value it will hold. */
  after: string
  secret: boolean
}

/** One file a Save writes and the values it changes there. */
export interface PlannedFile {
  /** Relative to the project: `extensions/greeter.env`. */
  file: string
  changes: PlannedChange[]
}

/**
 * The files a Save writes, chosen as the engine chooses them: a value goes
 * back to the instance's own parameter file that set it
 * (`extensions/<id>.env`, `.env.local`, `.env.<project>` …), else to
 * `extensions/<id>.env`; a secret always to `extensions/<id>.secret.local`.
 */
export function plannedFiles(
  instanceId: string,
  params: readonly ExtensionParam[],
  draft: ParamDraft,
): PlannedFile[] {
  const own = `extensions/${instanceId}.env`
  const files = new Map<string, PlannedChange[]>()
  const add = (file: string, change: PlannedChange) => {
    const list = files.get(file)
    if (list) list.push(change)
    else files.set(file, [change])
  }
  for (const param of changedParams(params, draft)) {
    const after = draft[param.param] ?? ''
    if (param.type === 'secret') {
      add(`extensions/${instanceId}.secret.local`, {
        key: param.param,
        before: null,
        after,
        secret: true,
      })
      continue
    }
    const file = param.file?.startsWith(own) ? param.file : own
    add(file, {
      key: param.param,
      before: param.source === 'file' && param.file === file ? param.value : null,
      after,
      secret: false,
    })
  }
  return [...files.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, changes]) => ({ file, changes }))
}

/** Where a value comes from, as its chip says it: the file's name, `default` or `not set`. */
export function sourceWord(param: ExtensionParam): string {
  if (param.source === 'file' && param.file) return param.file.replace(/^extensions\//, '')
  if (param.source === 'default') return param.provided ? 'default' : 'not set'
  return 'not set'
}

/** The label a select or multiSelect shows for a stored value. */
export function optionLabel(param: ExtensionParam, value: string): string | undefined {
  return param.options.find((option) => option.value === value)?.label ?? undefined
}
