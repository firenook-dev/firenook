// Firestore Security Rules for the code editor. Import it only from the
// editor's own lazily loaded chunk: it brings CodeMirror with it.

export type { RulesLanguageOptions } from './options'
export { rulesLanguage } from './language'
export { documentPattern, enclosingMatchPath, wildcardsAt } from './outline'
