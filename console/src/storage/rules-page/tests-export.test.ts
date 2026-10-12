import { describe, expect, it } from 'vitest'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import { EMPTY_FORM, type PlaygroundForm } from './requests'
import { exportTests } from './tests-export'
import type { TestCase } from './tests-store'

const BUCKET = 'demo.appspot.com'

const SEED: StorageRulesObjectView = {
  name: 'users/u1/a.png',
  bucket: BUCKET,
  size: 2048,
  contentType: 'image/png',
  contentDisposition: null,
  contentEncoding: null,
  metadata: { ownerUid: 'u1' },
  generation: '1',
  metageneration: '1',
  timeCreated: '2026-10-12T09:00:00Z',
  updated: '2026-10-12T09:00:00Z',
  md5Hash: 'x',
  crc32c: 'y',
  etag: 'z',
}

const ada = { kind: 'user', uid: 'u1', email: 'ada@example.test', claims: { admin: true } } as const

function test(
  name: string,
  form: Partial<PlaygroundForm>,
  expected: 'allow' | 'deny',
  seed?: StorageRulesObjectView | null,
): TestCase {
  return { id: name, name, expected, form: { ...EMPTY_FORM, ...form }, seed }
}

const row = (key: string, value: string) => ({ id: key, key, value, enabled: true })

describe('the saved tests as a rules-unit-testing file', () => {
  const file = exportTests(
    [
      test(
        'get',
        { method: 'get', path: 'users/u1/a.png', who: { kind: 'as', viewAs: ada } },
        'allow',
        SEED,
      ),
      test('list', { method: 'list', path: 'users/u2', who: { kind: 'as', viewAs: ada } }, 'deny'),
      test(
        'upload',
        {
          method: 'create',
          path: 'users/u1/big.mov',
          size: '7',
          unit: 'MB',
          contentType: 'video/quicktime',
          metadata: [row('ownerUid', 'u1')],
          who: { kind: 'as', viewAs: ada },
        },
        'deny',
      ),
      test(
        'update',
        {
          method: 'update',
          path: 'users/u1/a.png',
          contentType: '',
          metadata: [row('source', 'camera'), row('ownerUid', '')],
          who: { kind: 'as', viewAs: ada },
        },
        'allow',
        SEED,
      ),
      test('delete', { method: 'delete', path: 'users/u1/a.png', bucket: 'demo-media' }, 'deny'),
    ],
    { project: 'demo', bucket: BUCKET, rulesFile: 'storage.rules' },
  )

  it('starts a Storage test environment with the rules file', () => {
    expect(file).toContain("from '@firebase/rules-unit-testing'")
    expect(file).toContain(
      "import {\n  deleteObject,\n  getMetadata,\n  listAll,\n  ref,\n  updateMetadata,\n  uploadBytes,\n} from 'firebase/storage'",
    )
    expect(file).toContain('projectId: "demo",')
    expect(file).toContain(`storage: { rules: readFileSync("storage.rules", 'utf8') },`)
    expect(file).toContain('beforeEach(() => env.clearStorage())')
  })

  it('uploads the file a test read first, with the rules out of the way', () => {
    expect(file).toContain('await env.withSecurityRulesDisabled(async (context) => {')
    expect(file).toContain(
      'await uploadBytes(ref(storage, "users/u1/a.png"), new Uint8Array(2048), { contentType: "image/png", customMetadata: { "ownerUid": "u1" } })',
    )
  })

  it('asserts each verdict with the call an app makes', () => {
    expect(file).toContain(
      'const storage = env.authenticatedContext("u1", {"email":"ada@example.test","email_verified":true,"admin":true}).storage("gs://demo.appspot.com")',
    )
    expect(file).toContain('await assertSucceeds(getMetadata(ref(storage, "users/u1/a.png")))')
    expect(file).toContain('await assertFails(listAll(ref(storage, "users/u2/")))')
    expect(file).toContain(
      'await assertFails(uploadBytes(ref(storage, "users/u1/big.mov"), new Uint8Array(7340032), { contentType: "video/quicktime", customMetadata: { "ownerUid": "u1" } }))',
    )
    expect(file).toContain(
      'await assertSucceeds(updateMetadata(ref(storage, "users/u1/a.png"), { customMetadata: { "source": "camera", "ownerUid": null } as unknown as Record<string, string> }))',
    )
    // Not signed in, in the bucket the test named.
    expect(file).toContain(
      'const storage = env.unauthenticatedContext().storage("gs://demo-media")',
    )
    expect(file).toContain('await assertFails(deleteObject(ref(storage, "users/u1/a.png")))')
  })

  it('names each test by its request and the verdict it should get', () => {
    expect(file).toContain('test("upload is denied", async () => {')
    expect(file).toContain('test("get is allowed", async () => {')
  })

  it('replays a recorded identity with the claims it carried', () => {
    const recorded = exportTests(
      [
        test(
          'recorded',
          {
            path: 'a.png',
            who: {
              kind: 'recorded',
              auth: { uid: 'u9', token: { sub: 'u9', firebase: {}, plan: 'pro' } },
            },
          },
          'allow',
        ),
      ],
      { project: 'demo', bucket: BUCKET, rulesFile: 'storage.rules' },
    )
    expect(recorded).toContain('env.authenticatedContext("u9", {"plan":"pro"})')
  })
})
