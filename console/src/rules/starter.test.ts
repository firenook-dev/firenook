import { describe, expect, it } from 'vitest'
import { FIRESTORE_ROOT, STORAGE_ROOT, insertBlock } from './starter'

describe('putting a block in the rules', () => {
  const firestore = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    "    match /a/{b} { allow read: if '}' == '}'; } // a } in a comment",
    '  }',
    '}',
  ].join('\n')
  const storage = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    // a } in a comment, and one in a string',
    "    match /public/{file} { allow read: if '}' != ''; }",
    '  }',
    '}',
    '',
  ].join('\n')

  it('goes inside the documents block, before it closes', () => {
    const { text, line } = insertBlock(firestore, '    match /x/{y} {}', FIRESTORE_ROOT)
    const lines = text.split('\n')
    expect(lines[line - 1]).toBe('    match /x/{y} {}')
    expect(lines[line]).toBe('  }')
    expect(lines.at(-1)).toBe('}')
  })

  it('goes inside match /b/{bucket}/o, past braces in comments and strings', () => {
    const { text, line } = insertBlock(storage, '    match /misc/{file} {}', STORAGE_ROOT)
    const lines = text.split('\n')
    expect(lines[line - 1]).toBe('    match /misc/{file} {}')
    expect(lines[line]).toBe('  }')
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('goes at the end when there is no root block', () => {
    const one = insertBlock('service cloud.firestore {}', 'X', FIRESTORE_ROOT)
    expect(one.text.split('\n')[one.line - 1]).toBe('X')
    const other = insertBlock('// nothing yet', 'match /x/{f} {}', STORAGE_ROOT)
    expect(other.text).toBe('// nothing yet\n\nmatch /x/{f} {}\n')
    expect(other.text.split('\n')[other.line - 1]).toBe('match /x/{f} {}')
  })
})
