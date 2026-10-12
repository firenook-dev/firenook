// "Copy as code" for an object: the Web SDK, the Admin SDK for Node and the
// REST protocol, each to read it and to upload a file with its metadata —
// typed, with the real bucket, name, token and metadata, so a fixture or a
// seed script starts from what is in the emulator. The import line holds
// what the body uses and nothing else; the bucket is named only when it is
// not the default one; REST uses the Storage service's own address (what an
// app connected to the emulator reaches), and says which it assumed.

import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { defaultConnectHost, hostLiteral } from '@/lib/connect'
import { encodeObjectPath } from './paths'

export type CodeDialect = 'web' | 'admin' | 'rest'
export type CodeVariant = 'read' | 'upload'

/** What an object's code is written from. */
export interface ObjectForCode {
  bucket: string
  defaultBucket: string
  name: string
  /** A download token, when the object has one and the page may see it. */
  token: string | undefined
  contentType: string | null
  cacheControl: string | null
  contentDisposition: string | null
  contentEncoding: string | null
  contentLanguage: string | null
  customMetadata: Record<string, string>
}

/** `host:port` of the Storage emulator as an app on this machine reaches it, or `undefined` when it is not running. */
export function storageAddress(status: ConsoleStatus | undefined): string | undefined {
  if (!status) return undefined
  const service = status.services.find((entry) => entry.name === 'storage')
  if (!service?.port) return undefined
  return `${hostLiteral(defaultConnectHost(status).host)}:${service.port}`
}

/** The protocol download URL an app gets from `getDownloadURL()` when connected to `address`. */
export function downloadUrl(address: string, bucket: string, name: string, token: string): string {
  return `http://${address}/v0/b/${encodeURIComponent(bucket)}/o/${encodeObjectPath(name)}?alt=media&token=${encodeURIComponent(token)}`
}

/** A JavaScript string literal: single quotes, as the console writes code. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/** A key as an object literal writes it: bare when it can be. */
function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name)
}

/** The standard fields and custom keys set on the object, as `{ key: value }` lines. */
function metadataLines(object: ObjectForCode, indent: string, custom: string): string[] {
  const lines: string[] = []
  const add = (name: string, value: string | null) => {
    if (value) lines.push(`${indent}${name}: ${quote(value)},`)
  }
  add('contentType', object.contentType)
  add('cacheControl', object.cacheControl)
  add('contentDisposition', object.contentDisposition)
  add('contentEncoding', object.contentEncoding)
  add('contentLanguage', object.contentLanguage)
  const entries = Object.entries(object.customMetadata)
  if (entries.length > 0) {
    lines.push(`${indent}${custom}: {`)
    for (const [name, value] of entries) lines.push(`${indent}  ${key(name)}: ${quote(value)},`)
    lines.push(`${indent}},`)
  }
  return lines
}

function webCode(object: ObjectForCode, variant: CodeVariant): string {
  const named = object.bucket !== object.defaultBucket
  const storage = named
    ? `const storage = getStorage(app, ${quote(`gs://${object.bucket}`)})`
    : 'const storage = getStorage(app)'
  if (variant === 'read')
    return [
      `import { getStorage, ref, getDownloadURL, getMetadata } from 'firebase/storage'`,
      '',
      storage,
      `const fileRef = ref(storage, ${quote(object.name)})`,
      'const url = await getDownloadURL(fileRef)',
      'const metadata = await getMetadata(fileRef)',
    ].join('\n')
  const lines = metadataLines(object, '  ', 'customMetadata')
  return [
    `import { getStorage, ref, uploadBytes } from 'firebase/storage'`,
    '',
    storage,
    lines.length > 0
      ? `await uploadBytes(ref(storage, ${quote(object.name)}), file, {\n${lines.join('\n')}\n})`
      : `await uploadBytes(ref(storage, ${quote(object.name)}), file)`,
  ].join('\n')
}

function adminCode(object: ObjectForCode, variant: CodeVariant): string {
  const bucket =
    object.bucket !== object.defaultBucket ? `bucket(${quote(object.bucket)})` : 'bucket()'
  if (variant === 'read')
    return [
      `import { getStorage } from 'firebase-admin/storage'`,
      '',
      `const file = getStorage().${bucket}.file(${quote(object.name)})`,
      'const [metadata] = await file.getMetadata()',
      'const [contents] = await file.download()',
    ].join('\n')
  // The Admin SDK takes the type beside `metadata`, and nests custom keys
  // one level further down: `metadata.metadata`.
  const metadata = metadataLines({ ...object, contentType: null }, '    ', 'metadata')
  const options = [
    ...(object.contentType ? [`  contentType: ${quote(object.contentType)},`] : []),
    ...(metadata.length > 0 ? ['  metadata: {', ...metadata, '  },'] : []),
  ]
  return [
    `import { getStorage } from 'firebase-admin/storage'`,
    '',
    options.length > 0
      ? `await getStorage().${bucket}.file(${quote(object.name)}).save(contents, {\n${options.join('\n')}\n})`
      : `await getStorage().${bucket}.file(${quote(object.name)}).save(contents)`,
  ].join('\n')
}

function restCode(object: ObjectForCode, variant: CodeVariant, address: string): string {
  const base = `http://${address}/v0/b/${encodeURIComponent(object.bucket)}/o`
  const path = `${base}/${encodeObjectPath(object.name)}`
  if (variant === 'read')
    return [
      '# The object’s metadata (Admin: Bearer owner skips the rules)',
      `curl ${quote(path)} -H 'Authorization: Bearer owner'`,
      '',
      '# Its bytes',
      object.token
        ? `curl ${quote(`${path}?alt=media&token=${encodeURIComponent(object.token)}`)} -o ${quote(object.name.split('/').at(-1) ?? 'download')}`
        : `curl ${quote(`${path}?alt=media`)} -H 'Authorization: Bearer owner' -o ${quote(object.name.split('/').at(-1) ?? 'download')}`,
    ].join('\n')
  const body: Record<string, unknown> = {}
  if (object.cacheControl) body.cacheControl = object.cacheControl
  if (object.contentDisposition) body.contentDisposition = object.contentDisposition
  if (object.contentEncoding) body.contentEncoding = object.contentEncoding
  if (object.contentLanguage) body.contentLanguage = object.contentLanguage
  if (Object.keys(object.customMetadata).length > 0) body.metadata = object.customMetadata
  const upload = [
    `curl -X POST ${quote(`${base}?name=${encodeObjectPath(object.name)}`)} \\`,
    `  -H 'Authorization: Bearer owner' \\`,
    `  -H ${quote(`Content-Type: ${object.contentType ?? 'application/octet-stream'}`)} \\`,
    `  --data-binary @${object.name.split('/').at(-1) ?? 'file'}`,
  ]
  if (Object.keys(body).length === 0) return upload.join('\n')
  return [
    ...upload,
    '',
    '# Then its metadata',
    `curl -X PATCH ${quote(path)} \\`,
    `  -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' \\`,
    `  -d ${quote(JSON.stringify(body))}`,
  ].join('\n')
}

/** The object as code in one dialect and variant; REST needs the service's address. */
export function objectAsCode(
  dialect: CodeDialect,
  variant: CodeVariant,
  object: ObjectForCode,
  address: string | undefined,
): string {
  if (dialect === 'web') return webCode(object, variant)
  if (dialect === 'admin') return adminCode(object, variant)
  return address === undefined
    ? '# The Storage emulator is not running in this suite.'
    : restCode(object, variant, address)
}
