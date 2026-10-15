import { describe, expect, it } from 'vitest'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { type ObjectForCode, downloadUrl, objectAsCode, storageAddress } from './code'

const object: ObjectForCode = {
  bucket: 'demo.appspot.com',
  defaultBucket: 'demo.appspot.com',
  name: 'users/u1/avatar.png',
  contentType: 'image/png',
  cacheControl: 'public, max-age=3600',
  contentDisposition: null,
  contentEncoding: null,
  contentLanguage: null,
  customMetadata: { ownerUid: 'u1', 'x-tag': "it's" },
}

describe('an object as code', () => {
  it('imports only what the Web body uses and names no default bucket', () => {
    const read = objectAsCode('web', 'read', object, undefined)
    expect(read).toContain(
      `import { getStorage, ref, getDownloadURL, getMetadata } from 'firebase/storage'`,
    )
    expect(read).toContain('getStorage(app)')
    expect(read).toContain(`ref(storage, 'users/u1/avatar.png')`)
    const upload = objectAsCode('web', 'upload', object, undefined)
    expect(upload).toContain(`import { getStorage, ref, uploadBytes } from 'firebase/storage'`)
    expect(upload).toContain(`contentType: 'image/png',`)
    expect(upload).toContain(`customMetadata: {`)
    expect(upload).toContain(`'x-tag': 'it\\'s',`)
  })

  it('names a bucket that is not the default', () => {
    const other = { ...object, bucket: 'demo-media' }
    expect(objectAsCode('web', 'read', other, undefined)).toContain(
      `getStorage(app, 'gs://demo-media')`,
    )
    expect(objectAsCode('node', 'read', other, undefined)).toContain(`bucket('demo-media')`)
  })

  it('nests the Admin SDK’s custom keys one level down', () => {
    const upload = objectAsCode('node', 'upload', object, undefined)
    expect(upload).toContain(`import { getStorage } from 'firebase-admin/storage'`)
    expect(upload).toContain(`  contentType: 'image/png',`)
    expect(upload).toContain(
      `  metadata: {\n    cacheControl: 'public, max-age=3600',\n    metadata: {\n      ownerUid: 'u1',`,
    )
  })

  it('writes REST against the service address, the name encoded', () => {
    const read = objectAsCode('rest', 'read', object, '127.0.0.1:9199')
    expect(read).toContain('http://127.0.0.1:9199/v0/b/demo.appspot.com/o/users%2Fu1%2Favatar.png')
    // The bytes as Admin: the download URL with its token is Location's.
    expect(read).toContain(`alt=media' -H 'Authorization: Bearer owner'`)
    expect(read).not.toContain('token=')
    const upload = objectAsCode('rest', 'upload', object, '127.0.0.1:9199')
    expect(upload).toContain('o?name=users%2Fu1%2Favatar.png')
    expect(upload).toContain(`curl -X PATCH`)
    expect(objectAsCode('rest', 'read', object, undefined)).toMatch(/not running/)
  })

  it('makes the download URL an app gets', () => {
    expect(downloadUrl('127.0.0.1:9199', 'b', 'a b/c.png', 't')).toBe(
      'http://127.0.0.1:9199/v0/b/b/o/a%20b%2Fc.png?alt=media&token=t',
    )
  })

  it('finds the Storage service’s address', () => {
    const status = {
      services: [
        { name: 'hub', host: '127.0.0.1', port: 4400 },
        { name: 'storage', host: '127.0.0.1', port: 9199 },
      ],
    } as unknown as ConsoleStatus
    expect(storageAddress(status)).toBe('127.0.0.1:9199')
    expect(storageAddress({ services: [] } as unknown as ConsoleStatus)).toBeUndefined()
  })
})
