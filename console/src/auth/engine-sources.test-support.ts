// The Auth engine's Rust sources, read by the tests that hold the console's
// copies of the engine's tables (error codes, operation ids) to the engine
// itself. Vitest runs in Node from `console/`; the console's own TypeScript
// knows no Node types, so the module is reached by name and given the calls
// it needs.

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string
  readdirSync(path: string): string[]
  statSync(path: string): { isDirectory(): boolean }
}

const NODE_FS: string = 'node:fs'

/** The engine crate's sources: path under `src/` → text, tests left out. */
export async function authFrontSources(): Promise<Map<string, string>> {
  const fs = (await import(/* @vite-ignore */ NODE_FS)) as NodeFs
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd()
  const root = `${cwd}/../crates/auth-front/src`
  const found = new Map<string, string>()
  const walk = (relative: string) => {
    for (const name of fs.readdirSync(`${root}/${relative}`)) {
      const path = `${relative}${name}`
      if (fs.statSync(`${root}/${path}`).isDirectory()) walk(`${path}/`)
      else if (name.endsWith('.rs') && !name.includes('test'))
        found.set(path, fs.readFileSync(`${root}/${path}`, 'utf8'))
    }
  }
  walk('')
  return found
}
