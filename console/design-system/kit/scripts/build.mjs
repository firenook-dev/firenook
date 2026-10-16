// Build the component library package the design tool consumes: the entry
// (Kumo re-exports plus the console's own pieces) with its .d.ts tree, the
// themed stylesheet with the enumerated utility vocabulary, and one doc per
// Kumo component from Kumo's own registry so the design agent gets Kumo's
// usage guidance verbatim.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const kit = fileURLToPath(new URL('../', import.meta.url))
const consoleDir = fileURLToPath(new URL('../../../', import.meta.url))
const bin = (name) => join(consoleDir, 'node_modules', '.bin', name)
const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: 'inherit', cwd: kit, ...options })

rmSync(join(kit, 'dist'), { recursive: true, force: true })
rmSync(join(kit, 'docs'), { recursive: true, force: true })
mkdirSync(join(kit, 'dist'), { recursive: true })
mkdirSync(join(kit, 'docs'), { recursive: true })

run(bin('tsc'), ['-p', 'tsconfig.json'])
run(bin('tailwindcss'), ['-i', 'src/kit.css', '-o', 'dist/kit.css', '--minify'])

// Kumo's registry, one file per component, category as the group.
const registry = execFileSync(bin('kumo'), ['docs'], {
  cwd: kit,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const sections = registry.split(/^# (?=[A-Z][A-Za-z0-9]*$)/m).slice(1)
let written = 0
for (const section of sections) {
  const newline = section.indexOf('\n')
  const name = section.slice(0, newline).trim()
  const body = section.slice(newline + 1).trim()
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) continue
  const category = /\*\*Category:\*\*\s*([^\n]+)/.exec(body)?.[1]?.trim() ?? 'Other'
  const doc = `---\ncategory: ${category}\n---\n\n# ${name}\n\n${body}\n`
  writeFileSync(join(kit, 'docs', `${name}.md`), doc)
  written++
}
console.error(`kit: ${written} component docs from Kumo's registry`)
console.error(`kit: dist has ${readdirSync(join(kit, 'dist')).length} entries`)
