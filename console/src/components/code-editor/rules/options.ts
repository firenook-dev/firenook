// What the console tells the rules language about the project, so that
// completion can offer names from real data. Its own file so that callers
// can name the type without importing CodeMirror.

export interface RulesLanguageOptions {
  /**
   * Which service's rules the text is. Absent, the text's own `service`
   * header decides (`firebase.storage` is Storage's), and Firestore's is
   * assumed before there is one.
   */
  dialect?: 'firestore' | 'storage' | undefined
  // Field names seen in documents of a collection pattern such as
  // "users/*/orders" (top-level names plus dotted nested map keys, e.g.
  // "address.city"). May be async.
  fields?: (pattern: string) => readonly string[] | Promise<readonly string[]>
  /** Custom claim names seen on Auth users, beyond the standard token fields. */
  claims?: () => readonly string[]
  /**
   * Storage: custom metadata keys seen on files under a folder (`users/`,
   * `''` for the whole bucket), the folder being the literal start of the
   * match around the cursor. May be async.
   */
  metadataKeys?: (prefix: string) => readonly string[] | Promise<readonly string[]>
}
