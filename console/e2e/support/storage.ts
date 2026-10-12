// What the Storage journeys do to an engine behind the page's back: requests
// an app makes, straight to the Storage emulator's own port with a token the
// Auth emulator minted (so the rules judge them and the decisions feed
// records them), files put in place as the owner through the console's own
// route, and the rules in force read and put back.

import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { SEED_USERS } from '../../scripts/seed/identities.mjs'
import type { Engine } from '../fixtures'
import { ownerFetch } from './api'

export { SEED_USERS }

/** The seed people by name: `ada`, `grace`, `linus`. */
export const person = (name: 'ada' | 'grace' | 'linus') => {
  const found = SEED_USERS.find((user) => user.email.startsWith(`${name}@`))
  if (!found) throw new Error(`no seed user ${name}`)
  return found
}

/** The default bucket and the media bucket of the storage profile's project. */
export function bucketsOf(engine: Pick<Engine, 'project'>) {
  return { default: `${engine.project}.appspot.com`, media: `${engine.project}-media` }
}

/** An ID token the Auth emulator issues for `uid`, as the app holds it. */
export async function tokenFor(engine: Engine, uid: string): Promise<string> {
  const response = await ownerFetch(engine, '/auth/tokens', {
    method: 'POST',
    body: JSON.stringify({ uid }),
  })
  expect(response.ok, `token for ${uid} → ${response.status}`).toBe(true)
  return ((await response.json()) as { idToken: string }).idToken
}

const storageOrigin = (engine: Engine) => `http://127.0.0.1:${engine.ports.storage}`

function bearer(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * An upload as the Web SDK's `uploadBytes` sends it (`multipart/related`:
 * the metadata, then the bytes), straight to the Storage emulator.
 */
export function upload(
  engine: Engine,
  file: {
    bucket: string
    name: string
    size: number
    contentType: string
    metadata?: Record<string, string>
    token?: string | undefined
  },
): Promise<Response> {
  const boundary = `firenook-${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({
      name: file.name,
      contentType: file.contentType,
      ...(file.metadata ? { metadata: file.metadata } : {}),
    })}\r\n--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, Buffer.alloc(file.size, 7), tail])
  return fetch(
    `${storageOrigin(engine)}/v0/b/${file.bucket}/o?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: {
        'content-type': `multipart/related; boundary=${boundary}`,
        'x-goog-upload-protocol': 'multipart',
        ...bearer(file.token),
      },
      body,
    },
  )
}

/** `getMetadata()` as an app calls it. */
export function getMetadata(
  engine: Engine,
  file: { bucket: string; name: string; token?: string | undefined },
): Promise<Response> {
  return fetch(`${storageOrigin(engine)}/v0/b/${file.bucket}/o/${encodeURIComponent(file.name)}`, {
    headers: bearer(file.token),
  })
}

/** `list()` of a folder as an app calls it. */
export function listFolder(
  engine: Engine,
  folder: { bucket: string; prefix: string; token?: string | undefined },
): Promise<Response> {
  return fetch(
    `${storageOrigin(engine)}/v0/b/${folder.bucket}/o?prefix=${encodeURIComponent(folder.prefix)}&delimiter=%2F`,
    { headers: bearer(folder.token) },
  )
}

/** A file put in place as the owner, through the console's own route (no rules, no app). */
export async function putFile(
  engine: Engine,
  file: { bucket: string; name: string; size: number; contentType: string },
): Promise<void> {
  const response = await ownerFetch(
    engine,
    `/storage/object?bucket=${encodeURIComponent(file.bucket)}&name=${encodeURIComponent(file.name)}`,
    {
      method: 'PUT',
      headers: { 'content-type': file.contentType },
      body: Buffer.alloc(file.size, 1),
    },
  )
  expect(
    response.ok,
    `put ${file.name} → ${response.status} ${await response.clone().text()}`,
  ).toBe(true)
}

/** A file removed as the owner; one that is not there is fine. */
export async function removeFile(
  engine: Engine,
  file: { bucket: string; name: string },
): Promise<void> {
  const response = await ownerFetch(engine, '/storage/object', {
    method: 'DELETE',
    body: JSON.stringify({ bucket: file.bucket, name: file.name }),
  })
  expect([200, 204, 404]).toContain(response.status)
}

export interface StorageRulesNow {
  bucket: string | null
  source: string
  path: string | null
  hash: string
  fileSource: string | null
}

/** The rules in force for a bucket's scope. */
export async function rulesNow(
  page: Page,
  engine: Engine,
  bucket?: string,
): Promise<StorageRulesNow> {
  const query = bucket ? `?bucket=${encodeURIComponent(bucket)}` : ''
  const response = await page.request.get(`${engine.origin}/console/api/v1/storage/rules${query}`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()) as StorageRulesNow
}

/** Put the rules in force back, and the file on disk with them. */
export async function restoreRules(engine: Engine, original: StorageRulesNow): Promise<void> {
  const { writeFileSync } = await import('node:fs')
  if (original.path) writeFileSync(original.path, original.source)
  const response = await ownerFetch(engine, '/storage/rules', {
    method: 'PUT',
    body: JSON.stringify({
      ...(original.bucket ? { bucket: original.bucket } : {}),
      source: original.source,
      save: false,
    }),
  })
  expect(response.ok, `restore → ${response.status}`).toBe(true)
}

/**
 * Replace the editor's text the way a person pastes it: typing would meet
 * the editor's own bracket closing and indenting.
 */
export async function pasteRules(page: Page, text: string): Promise<void> {
  const editor = page.getByTestId('rules-source')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.evaluate(
    (value) =>
      (
        navigator as Navigator & { clipboard: { writeText(text: string): Promise<void> } }
      ).clipboard.writeText(value),
    text,
  )
  await page.keyboard.press('ControlOrMeta+v')
}
