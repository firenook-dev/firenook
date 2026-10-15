import type { Plugin } from 'vite'

/** The Phosphor weights the console renders; every other weight is stripped at build time. */
export const ICON_WEIGHTS: readonly ['regular', 'bold', 'fill']

/** A Phosphor `defs` module with only `keep`'s entries; throws on a module of another shape. */
export function stripIconWeights(code: string, id?: string, keep?: readonly string[]): string

/** The build plugin: strips every weight outside `ICON_WEIGHTS` from Phosphor's `defs` modules. */
export function iconWeights(): Plugin
