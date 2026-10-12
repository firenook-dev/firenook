// The storage seeder: two buckets of files a real app might hold, every byte
// generated here (no assets), and the manifest the Storage journeys derive
// every expected number from (`STORAGE_SEED`), so no spec types a count.
// Deterministic and idempotent: a second run writes the same bytes under
// the same names. The storage stream owns this file.
//
// Files go in as the console puts them — `PUT /console/api/v1/storage/object`
// as the owner with `x-firenook-console: 1` — and one more arrives the way
// an app sends it, through the storage protocol (`/storage/native`) as Ada
// with a token the Auth emulator minted, so the Activity tab has an entry
// "from your app" and the decisions feed an allow.
//
// For development it also runs as a script against a running engine:
// `node scripts/seed/storage.mjs <ui-origin>`.

import { crc32, deflateSync, gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { SEED_USERS, ensureSeedUsers } from './identities.mjs'

const ADA = SEED_USERS[0].uid
const GRACE = SEED_USERS[1].uid

/** A small PRNG with a fixed start, so every run writes the same bytes. */
function random(start) {
  let state = start >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const check = Buffer.alloc(4)
  check.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, check])
}

/** An RGBA PNG of `width` × `height`, each pixel from `paint(x, y)`. */
function png(width, height, paint) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y)
      const at = y * stride + 1 + x * 4
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      raw[at + 3] = a
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)))

/**
 * A gradient with grain: it looks like a picture, and the grain keeps it
 * from compressing to nothing, so it is large enough to be thumbnailed.
 */
function grainyGradient(width, height, hue, start) {
  const next = random(start)
  return png(width, height, (x, y) => {
    const grain = (next() - 0.5) * 48
    return [
      clamp((255 * x) / width + grain),
      clamp(hue + grain),
      clamp((255 * y) / height + grain),
      255,
    ]
  })
}

/** A flat gradient: small. */
function gradient(width, height, hue) {
  return png(width, height, (x, y) => [
    Math.round((255 * x) / width),
    hue & 255,
    Math.round((255 * y) / height),
    255,
  ])
}

/** One second of a 440 Hz tone, 8 kHz 16-bit PCM. */
function wav() {
  const rate = 8000
  const data = Buffer.alloc(rate * 2)
  for (let index = 0; index < rate; index++)
    data.writeInt16LE(Math.round(Math.sin((index / rate) * 2 * Math.PI * 440) * 8000), index * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** A zip with every entry stored (no compression), written by hand. */
function zip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, content] of entries) {
    const data = Buffer.from(content)
    const label = Buffer.from(name)
    const check = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(check, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(label.length, 26)
    parts.push(local, label, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(check, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(label.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, label)
    offset += 30 + label.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

/** A one-page PDF a browser draws: "Q3 report". */
function pdf() {
  const content = 'BT /F1 18 Tf 40 70 Td (Q3 report) Tj ET'
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** A CSV of about 2 MB, with quoted commas. */
function bigCsv() {
  const rows = ['id,name,amount']
  let size = rows[0].length + 1
  for (let index = 0; size < 2 * 1024 * 1024; index++) {
    const row = `${index},"row ${index}, quoted",${(index * 3.7).toFixed(2)}`
    rows.push(row)
    size += row.length + 1
  }
  return Buffer.from(`${rows.join('\n')}\n`)
}

/**
 * @typedef {{
 *   name: string,
 *   body: Buffer,
 *   contentType: string,
 *   metadata?: { customMetadata?: Record<string, string>, cacheControl?: string, contentEncoding?: string },
 * }} SeedFile
 */

/** @param {string} name @param {Buffer | string} body @param {string} contentType @param {SeedFile['metadata']} [metadata] */
const file = (name, body, contentType, metadata) => ({
  name,
  body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  contentType,
  ...(metadata ? { metadata } : {}),
})

/** The default bucket's files, in the order they are written. */
function defaultFiles() {
  const pixels = random(7)
  return [
    file(
      'public/logo.png',
      png(64, 64, (x, y) => [(x * 4) & 255, 80, (y * 4) & 255, (x + y) % 16 < 8 ? 255 : 120]),
      'image/png',
    ),
    file(
      'public/logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#f6821f"/><text x="32" y="40" font-size="22" text-anchor="middle" fill="#fff">F</text></svg>',
      'image/svg+xml',
    ),
    file(
      'public/docs/readme.md',
      '# Readme\n\nThis folder holds the **public** documents.\n\n- logo\n- report\n',
      'text/markdown',
    ),
    file(
      'public/docs/report.docx',
      zip([
        ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types/>'],
        ['word/document.xml', '<w:document/>'],
      ]),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ),
    file(
      'public/data/products.json',
      `${JSON.stringify(
        {
          products: [
            { id: 1, name: 'Mug', price: 12.5 },
            { id: 2, name: 'Shirt', price: 20 },
          ],
          updated: '2026-10-01',
        },
        null,
        2,
      )}\n`,
      'application/json',
    ),
    file(
      'public/data/events.json.gz',
      gzipSync(
        JSON.stringify([
          { type: 'click', at: 1 },
          { type: 'view', at: 2 },
        ]),
      ),
      'application/json',
      { contentEncoding: 'gzip' },
    ),
    file('public/data/big.csv', bigCsv(), 'text/csv'),
    file('public/sounds/tone.wav', wav(), 'audio/wav'),
    file(`users/${ADA}/avatar.png`, grainyGradient(400, 400, 120, 11), 'image/png', {
      customMetadata: { ownerUid: ADA },
      cacheControl: 'public, max-age=3600',
    }),
    file(`users/${ADA}/bio.md`, '# Ada\n\nMathematician.\n', 'text/markdown'),
    file(`users/${ADA}/prefs.json`, '{"theme":"dark","digest":true}\n', 'application/json'),
    file(`users/${GRACE}/avatar.png`, gradient(256, 256, 30), 'image/png', {
      customMetadata: { ownerUid: GRACE },
    }),
    ...Array.from({ length: 120 }, (_, index) =>
      file(
        `users/u_${String(index).padStart(3, '0')}/avatar.png`,
        gradient(32, 32, index * 2),
        'image/png',
      ),
    ),
    ...Array.from({ length: 1200 }, (_, index) =>
      file(
        `exports/export-${String(index).padStart(4, '0')}.csv`,
        `id,value\n${index},${index * 2}\n`,
        'text/csv',
      ),
    ),
    file(
      'exports/2026-10-01.zip',
      zip([
        ['data/a.csv', 'a,b\n1,2\n'],
        ['readme.md', '# export\n'],
      ]),
      'application/zip',
    ),
    file('reports/q3.pdf', pdf(), 'application/pdf'),
    file('shared/ada.png', gradient(64, 64, 90), 'image/png', {
      customMetadata: { ownerUid: ADA },
    }),
    file('shared/grace.png', gradient(64, 64, 160), 'image/png', {
      customMetadata: { ownerUid: GRACE },
    }),
    file(
      'misc/blob.bin',
      Buffer.from(Array.from({ length: 4096 }, () => Math.floor(pixels() * 256))),
      'application/octet-stream',
    ),
    file(
      'misc/mislabelled.png',
      png(48, 48, () => [200, 40, 40, 255]),
      'application/octet-stream',
    ),
    file(
      'misc//double.png',
      png(16, 16, () => [40, 200, 40, 255]),
      'image/png',
    ),
    file(
      '/lead.png',
      png(16, 16, () => [40, 40, 200, 255]),
      'image/png',
    ),
  ]
}

/** The media bucket's files. */
function mediaFiles() {
  return [
    ...Array.from({ length: 30 }, (_, index) =>
      file(
        `banners/banner-${String(index + 1).padStart(2, '0')}.png`,
        grainyGradient(640, 200, (index * 8) & 255, 100 + index),
        'image/png',
      ),
    ),
    file('audio/tone.wav', wav(), 'audio/wav'),
  ]
}

/** The file an app uploads as Ada through the storage protocol. */
function appFile() {
  return file(`users/${ADA}/from-app.png`, gradient(48, 48, 200), 'image/png')
}

/** Zero-byte folder markers (`empty/`), as a console's New folder makes them. */
const MARKERS = ['empty/']

/** Each folder's direct entries (files and folders), keyed by prefix (`''` = the root). */
function countsOf(names) {
  /** @type {Map<string, Set<string>>} */
  const entries = new Map([['', new Set()]])
  const add = (folder, entry) => {
    if (!entries.has(folder)) entries.set(folder, new Set())
    entries.get(folder)?.add(entry)
  }
  for (const name of names) {
    let start = 0
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1)) {
      const folder = name.slice(0, slash + 1)
      add(name.slice(0, start), folder)
      if (!entries.has(folder)) entries.set(folder, new Set())
      start = slash + 1
    }
    if (!name.endsWith('/')) add(name.slice(0, start), name)
  }
  return Object.fromEntries([...entries].map(([folder, set]) => [folder, set.size]))
}

/** The bytes of a list of files. */
const total = (files) => files.reduce((sum, entry) => sum + entry.body.length, 0)

function manifest() {
  const main = [...defaultFiles(), appFile()]
  const media = mediaFiles()
  const counts = countsOf([...main.map((entry) => entry.name), ...MARKERS])
  const largest = main.reduce((most, entry) =>
    entry.body.length > most.body.length ? entry : most,
  )
  return {
    users: { ada: ADA, grace: GRACE },
    default: {
      files: main.length,
      bytes: total(main),
      rootFolders: counts[''],
    },
    media: { files: media.length, bytes: total(media), banners: 30 },
    /** Direct entries (files and folders) of each folder of the default bucket. */
    counts,
    /** The CSV files in `exports/`. */
    csvCount: main.filter(
      (entry) => entry.name.startsWith('exports/') && entry.contentType === 'text/csv',
    ).length,
    largest: { name: largest.name, size: largest.body.length },
    /** Sizes by name, for the inspector's exact bytes. */
    sizes: Object.fromEntries([...main, ...media].map((entry) => [entry.name, entry.body.length])),
    names: {
      avatar: `users/${ADA}/avatar.png`,
      graceAvatar: `users/${GRACE}/avatar.png`,
      fromApp: appFile().name,
      readme: 'public/docs/readme.md',
      products: 'public/data/products.json',
      events: 'public/data/events.json.gz',
      bigCsv: 'public/data/big.csv',
      report: 'public/docs/report.docx',
      tone: 'public/sounds/tone.wav',
      pdf: 'reports/q3.pdf',
      zip: 'exports/2026-10-01.zip',
      blob: 'misc/blob.bin',
      mislabelled: 'misc/mislabelled.png',
      double: 'misc//double.png',
      lead: '/lead.png',
      logo: 'public/logo.png',
      logoSvg: 'public/logo.svg',
      marker: 'empty/',
      sharedAda: 'shared/ada.png',
      sharedGrace: 'shared/grace.png',
    },
  }
}

/** What the seed holds; the journeys derive every expected number from it. */
export const STORAGE_SEED = manifest()

/** The buckets of a project in the storage profile's shape. */
function bucketsOf(project) {
  return { default: `${project}.appspot.com`, media: `${project}-media` }
}

const OWNER = { authorization: 'Bearer owner', 'x-firenook-console': '1' }

/** Puts one file in place as the console does. */
async function put(origin, bucket, entry) {
  const headers = { ...OWNER, 'content-type': entry.contentType }
  if (entry.metadata)
    headers['x-firenook-metadata'] = `b64.${Buffer.from(JSON.stringify(entry.metadata)).toString(
      'base64url',
    )}`
  const response = await fetch(
    `${origin}/console/api/v1/storage/object?bucket=${encodeURIComponent(bucket)}&name=${encodeURIComponent(entry.name)}`,
    { method: 'PUT', headers, body: entry.body },
  )
  if (!response.ok)
    throw new Error(`seeding ${entry.name} → ${response.status} ${await response.text()}`)
}

/** Many puts, a few at a time. */
async function putAll(origin, bucket, entries) {
  const queue = [...entries]
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift())
      // oxlint-disable-next-line no-await-in-loop -- each worker writes its share in turn
      await put(origin, bucket, entry)
  }
  await Promise.all(Array.from({ length: 6 }, worker))
}

/** The upload an app makes: multipart through the storage protocol, as Ada. */
async function uploadAsAda(origin, bucket) {
  const tokenResponse = await fetch(`${origin}/console/api/v1/auth/tokens`, {
    method: 'POST',
    headers: { ...OWNER, 'content-type': 'application/json' },
    body: JSON.stringify({ uid: ADA }),
  })
  if (!tokenResponse.ok)
    throw new Error(`a token for Ada → ${tokenResponse.status} ${await tokenResponse.text()}`)
  const { idToken } = /** @type {{ idToken: string }} */ (await tokenResponse.json())
  const entry = appFile()
  const boundary = 'firenook-seed'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({
        name: entry.name,
        contentType: entry.contentType,
      })}\r\n--${boundary}\r\nContent-Type: ${entry.contentType}\r\n\r\n`,
    ),
    entry.body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const response = await fetch(
    `${origin}/console/api/v1/storage/native/v0/b/${bucket}/o?name=${encodeURIComponent(entry.name)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${idToken}`,
        'content-type': `multipart/related; boundary=${boundary}`,
        'x-goog-upload-protocol': 'multipart',
      },
      body,
    },
  )
  if (!response.ok) throw new Error(`Ada's upload → ${response.status} ${await response.text()}`)
}

/** @param {{ origin: string, project: string }} engine */
export async function seed(engine) {
  await ensureSeedUsers(engine)
  const buckets = bucketsOf(engine.project)
  await putAll(engine.origin, buckets.default, defaultFiles())
  for (const marker of MARKERS) {
    const response = await fetch(`${engine.origin}/console/api/v1/storage/folders`, {
      method: 'POST',
      headers: { ...OWNER, 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: buckets.default, prefix: marker }),
    })
    // A second run meets the marker already there.
    if (!response.ok && response.status !== 409)
      throw new Error(`seeding ${marker} → ${response.status} ${await response.text()}`)
  }
  await putAll(engine.origin, buckets.media, mediaFiles())
  await uploadAsAda(engine.origin, buckets.default)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const origin = process.argv[2]
  if (!origin) throw new Error('Usage: node scripts/seed/storage.mjs <ui-origin>')
  const status = /** @type {{ projectId: string }} */ (
    await (await fetch(`${origin}/console/api/v1/status`)).json()
  )
  await seed({ origin, project: status.projectId })
  console.log(`seeded ${STORAGE_SEED.default.files + STORAGE_SEED.media.files} files`)
}
