import { describe, expect, it } from 'vitest'
import type { StorageProfile } from '@/api/generated/storage/StorageProfile'
import { operationsText, patternText, readsFirestore } from './folders-panel'
import {
  TEMPLATES,
  insertBlock,
  sizeLimitMb,
  starterFromData,
  typeCheck,
  uncoveredRoots,
} from './starter'

const MB = 1024 * 1024

function profile(patch: Partial<StorageProfile>): StorageProfile {
  return {
    bucket: 'demo.appspot.com',
    prefix: '',
    objects: 4,
    bytes: 4 * MB,
    maxSize: 2 * MB,
    typicalSize: MB,
    contentTypes: [],
    metadataKeys: [],
    childFolders: [],
    sampled: false,
    ...patch,
  }
}

const RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    // a } in a comment, and one in a string',
  "    match /public/{file} { allow read: if '}' != ''; }",
  '  }',
  '}',
  '',
].join('\n')

describe('starter templates', () => {
  it('are match blocks for the shapes most apps have, indented for inside the bucket match', () => {
    expect(TEMPLATES.map((template) => template.id)).toEqual([
      'owner',
      'public',
      'images',
      'read-only',
    ])
    for (const template of TEMPLATES) {
      expect(template.block.startsWith('    // ')).toBe(true)
      expect(template.block).toMatch(/\n {4}match \//)
      expect(template.path).not.toBe('')
    }
    expect(TEMPLATES[0]?.block).toContain('request.auth.uid == uid')
    expect(TEMPLATES[2]?.block).toContain("matches('image/.*')")
  })
})

describe('starter rules from a folder’s files', () => {
  it('limits uploads to twice the typical file, rounded up to a whole MB', () => {
    expect(sizeLimitMb(profile({ typicalSize: 1.2 * MB }))).toBe(3)
    expect(sizeLimitMb(profile({ typicalSize: 100 }))).toBe(1)
    expect(sizeLimitMb(profile({ objects: 0, typicalSize: 0 }))).toBe(10)
  })

  it('keeps uploads to the type family every file shares, or one type, or none', () => {
    const types = (...names: string[]) =>
      profile({ contentTypes: names.map((contentType) => ({ contentType, objects: 1, bytes: 1 })) })
    expect(typeCheck(types('image/png', 'image/jpeg'))).toBe(
      "request.resource.contentType.matches('image/.*')",
    )
    expect(typeCheck(types('application/pdf'))).toBe(
      "request.resource.contentType == 'application/pdf'",
    )
    expect(typeCheck(types('image/png', 'application/pdf'))).toBeUndefined()
    expect(typeCheck(types())).toBeUndefined()
  })

  it('gives each user their folder when its folders are named after Auth users', () => {
    const block = starterFromData(
      'avatars/',
      profile({
        childFolders: ['u_ada', 'u_grace', 'tmp'],
        contentTypes: [
          { contentType: 'image/png', objects: 3, bytes: 3 * MB },
          { contentType: 'image/jpeg', objects: 1, bytes: MB },
        ],
        typicalSize: 1.2 * MB,
      }),
      new Set(['u_ada', 'u_grace']),
    )
    expect(block).toContain('match /avatars/{uid}/{allPaths=**} {')
    expect(block).toContain('allow read: if request.auth != null && request.auth.uid == uid;')
    expect(block).toContain('&& request.resource.size < 3 * 1024 * 1024')
    expect(block).toContain("&& request.resource.contentType.matches('image/.*');")
    expect(block).toContain('2 of its folders are named after Auth users')
    expect(block).toContain('uploads of image/* only, as every file there is')
  })

  it('says when nothing tells who owns the files, and writes star segments as wildcards', () => {
    const block = starterFromData('users/*/uploads/', profile({}), new Set())
    expect(block).toContain('match /users/{folder}/uploads/{allPaths=**} {')
    expect(block).toContain('allow read: if request.auth != null;')
    expect(block).toContain('narrow this')
    expect(block).toMatch(/size < 2 \* 1024 \* 1024;/)
  })

  it('governs only the files at the bucket’s root for the root, never every file', () => {
    expect(starterFromData('', profile({}), new Set())).toContain('match /{file} {')
  })

  it('offers one block per uncovered folder, not one for each folder below another', () => {
    expect(
      uncoveredRoots([
        { pattern: 'misc/', uncovered: true },
        { pattern: 'misc/old/', uncovered: true },
        { pattern: 'users/*/', uncovered: false },
        { pattern: 'users/*/uploads/2026/', uncovered: true },
        { pattern: '', uncovered: true },
      ]),
    ).toEqual(['misc/', 'users/*/uploads/2026/', ''])
  })
})

describe('putting a block in the rules', () => {
  it('goes inside match /b/{bucket}/o, before it closes, past braces in comments and strings', () => {
    const { text, line } = insertBlock(RULES, '    match /misc/{file} {}')
    const lines = text.split('\n')
    expect(lines[line - 1]).toBe('    match /misc/{file} {}')
    expect(lines[line]).toBe('  }')
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('goes at the end when there is no bucket match', () => {
    const { text, line } = insertBlock('// nothing yet', 'match /x/{f} {}')
    expect(text).toBe('// nothing yet\n\nmatch /x/{f} {}\n')
    expect(text.split('\n')[line - 1]).toBe('match /x/{f} {}')
  })
})

describe('the folders panel’s words', () => {
  it('says what an allow grants the way people do', () => {
    expect(operationsText(['get', 'list', 'create', 'update', 'delete'])).toBe('read, write')
    expect(operationsText(['get', 'list'])).toBe('read')
    expect(operationsText(['get', 'create'])).toBe('get, create')
    expect(operationsText([])).toBe('')
  })

  it('names the bucket’s root, and knows rules that read Firestore', () => {
    expect(patternText('')).toBe('(bucket root)')
    expect(patternText('misc/')).toBe('misc/')
    expect(
      readsFirestore(
        'allow read: if firestore.get(/databases/(default)/documents/x/y).data.a == 1;',
      ),
    ).toBe(true)
    expect(readsFirestore('allow read: if firestore . exists (/x);')).toBe(true)
    expect(readsFirestore('allow read: if true; // firestore')).toBe(false)
  })
})
