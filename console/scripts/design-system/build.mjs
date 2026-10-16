// Build the Firenook component library bundle: every card of the preview app
// (design-system/) rendered by a real browser under the Firenook theme, then
// saved as a self-contained HTML page with the @dsCard marker the design tool
// reads. Output: console/.design-system/bundle (pages, fonts, cards.json) and
// console/.design-system/screenshots for review. Never touches a consumer.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const consoleDir = fileURLToPath(new URL('../../', import.meta.url))
const site = join(consoleDir, '.design-system', 'site')
const bundle = join(consoleDir, '.design-system', 'bundle')
const screenshots = join(consoleDir, '.design-system', 'screenshots')
const skipBuild = process.argv.includes('--no-build')

if (!skipBuild) {
  execFileSync('npx', ['vite', 'build', '--config', 'design-system/vite.config.ts'], {
    cwd: consoleDir,
    stdio: 'inherit',
  })
}
if (!existsSync(join(site, 'index.html'))) throw new Error('the preview app did not build')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  let path = decodeURIComponent(url.pathname)
  if (path.startsWith('/console/fonts/')) path = path.replace('/console/fonts/', '/fonts/')
  if (path === '/') path = '/index.html'
  const file = resolve(site, `.${path}`)
  if (!file.startsWith(site) || !existsSync(file)) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  response.end(readFileSync(file))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

const cssFile = readdirSync(join(site, 'assets')).find((name) => name.endsWith('.css'))
if (!cssFile) throw new Error('the preview build has no stylesheet')
const css = readFileSync(join(site, 'assets', cssFile), 'utf8').replaceAll(
  '/console/fonts/',
  '../../fonts/',
)

rmSync(bundle, { recursive: true, force: true })
rmSync(screenshots, { recursive: true, force: true })
mkdirSync(join(bundle, 'fonts'), { recursive: true })
mkdirSync(screenshots, { recursive: true })
cpSync(join(consoleDir, 'public', 'fonts'), join(bundle, 'fonts'), { recursive: true })

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
const attr = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('--', '&#45;&#45;')

const browser = await chromium.launch()
const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: 'light' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

await page.goto(`${origin}/`)
const cards = await page.evaluate(() => window.__cards ?? [])
if (!cards.length) throw new Error('the preview app registered no cards')

const manifest = []
for (const card of cards) {
  await page.setViewportSize({ width: card.width, height: 900 })
  await page.goto(`${origin}/?card=${encodeURIComponent(card.id)}`)
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(400)
  const box = await page.locator('#card').boundingBox()
  if (!box) throw new Error(`card ${card.id} did not render`)
  const height = Math.ceil(box.height)
  await page.setViewportSize({ width: card.width, height })
  await page.waitForTimeout(150)
  await page.locator('#card').screenshot({ path: join(screenshots, `${card.id}.png`) })

  let html = await page.evaluate(() => document.documentElement.outerHTML)
  html = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*rel="(?:stylesheet|modulepreload)"[^>]*>/g, '')
    .replace('</head>', `<style>\n${css}\n</style>\n</head>`)
  const marker = `<!-- @dsCard group="${attr(card.group)}" name="${attr(card.name)}" subtitle="${attr(card.subtitle)}" width="${card.width}" height="${height}" -->`
  const relative = join(slug(card.group), card.id, 'index.html')
  const target = join(bundle, relative)
  mkdirSync(join(bundle, slug(card.group), card.id), { recursive: true })
  writeFileSync(target, `${marker}\n<!doctype html>\n${html}\n`)
  manifest.push({
    id: card.id,
    group: card.group,
    name: card.name,
    subtitle: card.subtitle,
    path: relative,
    width: card.width,
    height,
    dark: Boolean(card.dark),
  })
  console.log(
    `${card.group.padEnd(12)} ${card.name.padEnd(32)} ${card.width}×${height}  ${relative}`,
  )
}

await browser.close()
server.close()

writeFileSync(
  join(bundle, 'cards.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), cards: manifest }, null, 2)}\n`,
)
writeFileSync(
  join(bundle, 'README.md'),
  `# Firenook component library\n\nKumo (Cloudflare's component library, MIT) under the Firenook theme: the ember accent, Inter for the interface and IBM Plex Mono for data. Every card is the real component rendered by a browser, so what the design tool shows is what the console renders.\n\nCards are listed in cards.json; each page starts with an @dsCard marker. Fonts are under fonts/ and referenced relatively.\n\nGenerated by console/scripts/design-system/build.mjs. Do not edit by hand.\n`,
)
if (errors.length) {
  console.error(`\n${errors.length} browser errors during capture:`)
  for (const error of errors.slice(0, 20)) console.error(`  ${error}`)
  process.exitCode = 1
}
