import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { CodeLanguage } from '@/lib/code-language'
import { colour, parserFor } from './code-highlight'

/** For each language: code, one keyword in it and one string. */
const SAMPLES: Record<CodeLanguage, [code: string, keyword: string, text: string]> = {
  js: [
    "import { getAuth } from 'firebase/auth'\nconst port = 9099 // auth",
    'import',
    "'firebase/auth'",
  ],
  ts: ['const port: number = 9099\nexport { port }', 'const', ''],
  json: ['{\n  "emulators": { "auth": { "port": 9099 } }\n}', '', '"emulators"'],
  python: [
    'import firebase_admin\nos.environ["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8080"',
    'import',
    '"127.0.0.1:8080"',
  ],
  go: ['package main\n\nimport "os"', 'package', '"os"'],
  dart: [
    "import 'package:firebase_auth/firebase_auth.dart';\nfinal port = 9099;",
    'final',
    "'package:firebase_auth/firebase_auth.dart'",
  ],
  swift: ['import FirebaseAuth\nlet host = "127.0.0.1"', 'let', '"127.0.0.1"'],
  kotlin: ['import com.google.firebase.Firebase\nval host = "10.0.2.2"', 'val', '"10.0.2.2"'],
  java: [
    'import com.google.firebase.FirebaseApp;\nString host = "127.0.0.1";',
    'import',
    '"127.0.0.1"',
  ],
  shell: ['export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"', 'export', '"127.0.0.1:8080"'],
  dotenv: [
    'FIRESTORE_EMULATOR_HOST=127.0.0.1:8080  # set by emulators:exec',
    'FIRESTORE_EMULATOR_HOST',
    '127.0.0.1:8080',
  ],
}

/** The classes on the runs that make up `token` exactly. */
function classesOf(runs: ReturnType<typeof colour>, token: string): string | undefined {
  for (const run of runs) {
    if (
      isValidElement<{ className: string; children: string }>(run) &&
      run.props.children === token
    )
      return run.props.className
  }
  return undefined
}

describe('code in colour', () => {
  for (const [language, [code, keyword, text]] of Object.entries(SAMPLES) as [
    CodeLanguage,
    [string, string, string],
  ][]) {
    it(`colours ${language} and keeps every character`, async () => {
      const runs = colour(code, await parserFor(language))
      const back = runs
        .map((run) =>
          typeof run === 'string'
            ? run
            : isValidElement<{ children: string }>(run)
              ? run.props.children
              : '',
        )
        .join('')
      expect(back).toBe(code)
      const keywordClass = keyword ? classesOf(runs, keyword) : undefined
      const textClass = text ? classesOf(runs, text) : undefined
      if (keyword) expect(keywordClass, `${keyword} in ${language}`).toBeTruthy()
      if (text) expect(textClass, `${text} in ${language}`).toBeTruthy()
      if (keyword && text) expect(keywordClass).not.toBe(textClass)
    })
  }

  it('leaves a member after a dot plain, whatever the mode calls it', async () => {
    const go = colour('os.Setenv("A", "b")', await parserFor('go'))
    expect(classesOf(go, '.')).toBeUndefined()
    const dart = colour("await db.collection('a').doc('b').set(data);", await parserFor('dart'))
    expect(classesOf(dart, 'set')).toBeUndefined()
    expect(classesOf(dart, 'await')).toBeTruthy()
  })

  it('reads a .env line as a name, a value and a comment', async () => {
    const runs = colour(
      'GCLOUD_PROJECT=demo-shop  # set by emulators:exec',
      await parserFor('dotenv'),
    )
    const name = classesOf(runs, 'GCLOUD_PROJECT')
    const value = classesOf(runs, 'demo-shop')
    const comment = classesOf(runs, '# set by emulators:exec')
    expect(new Set([name, value, comment]).size).toBe(3)
    expect([name, value, comment].every(Boolean)).toBe(true)
  })

  it('puts the ink on the page once', async () => {
    colour('const a = 1', await parserFor('js'))
    colour('const b = 2', await parserFor('js'))
    expect(document.querySelectorAll('style[data-code-ink]')).toHaveLength(1)
  })
})
