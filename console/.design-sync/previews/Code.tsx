import { Code } from '@firenook/kit'

/** Highlighted code, as in copy-as-code output. */
export function TypeScript() {
  return (
    <Code
      lang="ts"
      code={`const snap = await getDocs(\n  query(collection(db, 'orders'), where('status', '==', 'paid'), orderBy('createdAt', 'desc'), limit(50)),\n)`}
    />
  )
}

export function Shell() {
  return <Code lang="bash" code="firenook emulators:start --only firestore,auth" />
}
