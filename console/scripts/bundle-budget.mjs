// The console ships inside the engine binary, so what a first visit loads
// has measured budgets, gzip-compressed:
//
// - the entry: the shell, its stylesheet and every chunk the entry imports
//   statically — what any route needs before it can draw;
// - the landing route: the entry plus the Overview's own chunk and every
//   chunk that one imports statically — what `/console` loads before its
//   first paint, which is where every visit starts.
//
// Other route chunks load on demand and are not counted.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 300 * 1024
const LANDING_BUDGET_BYTES = 420 * 1024
/** The Overview's route chunk, as the router's code splitting names it in the manifest. */
const LANDING_ROUTE = 'src/routes/index.tsx?tsr-split=component'

const dist = new URL('../dist/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist), 'utf8'))
const entry = Object.values(manifest).find((chunk) => chunk.isEntry)
if (!entry) throw new Error('The build manifest has no entry chunk')
const landing = manifest[LANDING_ROUTE]
if (!landing) throw new Error(`The build manifest has no ${LANDING_ROUTE} chunk`)

/** A chunk, its stylesheets and every chunk it imports statically, into `files`. */
function collect(chunk, files) {
  if (!chunk || files.has(chunk.file)) return files
  files.add(chunk.file)
  for (const css of chunk.css ?? []) files.add(css)
  for (const key of chunk.imports ?? []) collect(manifest[key], files)
  return files
}

const sizes = new Map()
const gzip = (file) => {
  let bytes = sizes.get(file)
  if (bytes === undefined) {
    bytes = gzipSync(readFileSync(join(dist.pathname, file))).length
    sizes.set(file, bytes)
  }
  return bytes
}

const first = collect(entry, new Set(['index.html']))
const route = collect(landing, new Set(first))
const total = (files) => [...files].reduce((sum, file) => sum + gzip(file), 0)

const rows = [...first].map((file) => ({ file, gzip: gzip(file) }))
rows.sort((a, b) => b.gzip - a.gzip)
for (const row of rows) console.log(`${String(row.gzip).padStart(8)}  ${row.file}`)
const entryTotal = total(first)
console.log(`${String(entryTotal).padStart(8)}  first route total (budget ${BUDGET_BYTES})`)

const added = [...route]
  .filter((file) => !first.has(file))
  .map((file) => ({ file, gzip: gzip(file) }))
added.sort((a, b) => b.gzip - a.gzip)
console.log('\nThe landing route adds:')
for (const row of added) console.log(`${String(row.gzip).padStart(8)}  ${row.file}`)
const landingTotal = total(route)
console.log(
  `${String(landingTotal).padStart(8)}  landing route total, /console (budget ${LANDING_BUDGET_BYTES})`,
)

let failed = false
if (entryTotal > BUDGET_BYTES) {
  console.error(`The first route exceeds its budget by ${entryTotal - BUDGET_BYTES} gzip bytes`)
  failed = true
}
if (landingTotal > LANDING_BUDGET_BYTES) {
  console.error(
    `The landing route exceeds its budget by ${landingTotal - LANDING_BUDGET_BYTES} gzip bytes`,
  )
  failed = true
}
if (failed) process.exit(1)
