// The console ships inside the engine binary, so the first route has a
// measured budget: the shell, its stylesheet and every chunk the entry imports
// statically, gzip-compressed. Route chunks load on demand and are not counted.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 300 * 1024
const dist = new URL('../dist/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist), 'utf8'))
const entry = Object.values(manifest).find((chunk) => chunk.isEntry)
if (!entry) throw new Error('The build manifest has no entry chunk')

const files = new Set()
function collect(chunk) {
  if (!chunk || files.has(chunk.file)) return
  files.add(chunk.file)
  for (const css of chunk.css ?? []) files.add(css)
  for (const key of chunk.imports ?? []) collect(manifest[key])
}
collect(entry)
files.add('index.html')

let total = 0
const rows = []
for (const file of files) {
  const bytes = gzipSync(readFileSync(join(dist.pathname, file))).length
  total += bytes
  rows.push({ file, gzip: bytes })
}
rows.sort((a, b) => b.gzip - a.gzip)
for (const row of rows) console.log(`${String(row.gzip).padStart(8)}  ${row.file}`)
console.log(`${String(total).padStart(8)}  first route total (budget ${BUDGET_BYTES})`)
if (total > BUDGET_BYTES) {
  console.error(`The first route exceeds its budget by ${total - BUDGET_BYTES} gzip bytes`)
  process.exit(1)
}
