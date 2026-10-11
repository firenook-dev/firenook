// What the console tells the rules language about the project, so that
// completion can offer names from real data. Its own file so that callers
// can name the type without importing CodeMirror.

export interface RulesLanguageOptions {
  // Field names seen in documents of a collection pattern such as
  // "users/*/orders" (top-level names plus dotted nested map keys, e.g.
  // "address.city"). May be async.
  fields?: (pattern: string) => readonly string[] | Promise<readonly string[]>
  /** Custom claim names seen on Auth users, beyond the standard token fields. */
  claims?: () => readonly string[]
}
