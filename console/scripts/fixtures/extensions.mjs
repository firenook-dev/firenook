// Local extensions for the synthetic project: every directory under
// `scripts/fixtures/extensions/` (an `extension.yaml` and its functions) is
// copied to `<project>/extensions/<id>` and installed as an instance of the
// same id, its parameters from `<id>.env` beside it when there is one. The
// compute stream owns the extensions themselves.

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('./extensions/', import.meta.url))

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'extensions',
  prepare(directory, firebaseJson) {
    if (!existsSync(SOURCE)) return
    const instances = {}
    for (const entry of readdirSync(SOURCE, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      cpSync(join(SOURCE, entry.name), join(directory, 'extensions', entry.name), {
        recursive: true,
      })
      const params = join(SOURCE, `${entry.name}.env`)
      if (existsSync(params)) {
        mkdirSync(join(directory, 'extensions'), { recursive: true })
        cpSync(params, join(directory, 'extensions', `${entry.name}.env`))
      }
      instances[entry.name] = `./extensions/${entry.name}`
    }
    if (Object.keys(instances).length > 0) firebaseJson.extensions = instances
  },
}
