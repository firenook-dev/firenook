// Where the Functions fixture finds the firebase-functions SDK and the
// Admin SDK, offline: the pinned install in `e2e/functions-sdk`
// (`npm run e2e:sdk`, the only step that needs the network), or any
// `node_modules` directory named by FIRENOOK_FUNCTIONS_SDK. The owned
// runtime finds the SDK by walking up from the codebase to
// `node_modules/firebase-functions`, so a link is all a codebase needs.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FUNCTIONS_VERSION = '7.2.5'
export const ADMIN_VERSION = '13.10.0'

const PINNED = fileURLToPath(new URL('../e2e/functions-sdk/node_modules/', import.meta.url))

function versionOf(modules, name) {
  try {
    return JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/**
 * The node_modules directory holding firebase-functions and firebase-admin:
 * FIRENOOK_FUNCTIONS_SDK when set, else console/e2e/functions-sdk/node_modules.
 */
export function resolveFunctionsSdk() {
  const modules = process.env.FIRENOOK_FUNCTIONS_SDK ?? PINNED
  const functions = versionOf(modules, 'firebase-functions')
  const admin = versionOf(modules, 'firebase-admin')
  if (!existsSync(modules) || functions !== FUNCTIONS_VERSION || admin !== ADMIN_VERSION)
    throw new Error(
      `The Functions fixture needs firebase-functions ${FUNCTIONS_VERSION} and firebase-admin ${ADMIN_VERSION}. ` +
        'Run `npm run e2e:sdk` once, or set FIRENOOK_FUNCTIONS_SDK to a node_modules directory that has them.' +
        (functions || admin
          ? ` (${modules} has firebase-functions ${functions ?? 'none'} and firebase-admin ${admin ?? 'none'}.)`
          : ''),
    )
  return modules
}
