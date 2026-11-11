// Firestore's registry entry: the data, rules and indexes pages, and where a
// collection, a document or a rules decision opens when ⌘K finds one or
// another section's payload points at one.

import { DatabaseIcon } from '@phosphor-icons/react'
import type { ConsoleSection, SectionLink } from '../services'
import { parentPath, splitKey } from './keys'

/** The route's `db` param: absent for the default database, as the page writes it. */
function dbParam(database: string): string | undefined {
  return database === '(default)' || database === '' ? undefined : database
}

// The collection id of a collection-group pattern (`**/orders`,
// `users/u_1/**/orders`); `undefined` for a collection path or a schema
// pattern (`users/*/orders`), which the page reads as they are.
function collectionGroupOf(pattern: string): string | undefined {
  const segments = pattern.split('/')
  const wildcard = segments.indexOf('**')
  if (wildcard === -1) return undefined
  const id = segments.at(-1)
  return wildcard === segments.length - 2 && id && id !== '**' && id !== '*' ? id : undefined
}

/** `<db>|<rest>`: the database and the path, pattern or request id after it. */
function split(key: string): [string, string] {
  const [database = '', rest = ''] = splitKey(key)
  return [database, rest]
}

export const firestore: ConsoleSection = {
  id: 'firestore',
  to: '/firestore',
  label: 'Firestore',
  services: ['firestore'],
  area: 'data',
  icon: DatabaseIcon,
  summary:
    "Path bar, document grid with inferred columns, a query builder that runs the same engine query the app runs, and view-as-user over the rules engine. Security rules have their own page: an editor that knows the language, every decision with the line and values behind it, a playground and saved tests. Indexes have theirs: the indexes in firestore.indexes.json, the ones the app's queries are missing, and Add and Remove that save the file.",
  // Rules and indexes are pages of their own, not modes of the data view:
  // different jobs — writing who may do what, declaring what queries may
  // ask — with URLs of their own, the way Firebase's own console files them.
  pages: [
    { to: '/firestore', label: 'Data', exact: true, keywords: 'documents collections grid query' },
    {
      to: '/firestore/rules',
      label: 'Rules',
      // `firestore.denials` is published by the observe stream; listed here
      // so its count lands on the right page the day it does.
      badges: ['firestore.rules', 'firestore.denials'],
      keywords: 'security permissions decisions playground',
    },
    {
      to: '/firestore/indexes',
      label: 'Indexes',
      // The indexes production would refuse the app's queries for, until
      // the index file declares them.
      badges: ['firestore.indexes'],
      keywords: 'composite indexes field overrides firestore.indexes.json missing',
    },
  ],
  projectScope: true,
  searchLabels: {
    'firestore.collection': 'Collections',
    'firestore.document': 'Documents',
  },
  // Firestore's `?q=` is the SDK query chain, not a text filter: there is
  // no "search Firestore for this text" to open, and the hits already
  // name every collection and document the text matches.
  searchLink: null,
  routes: {
    'firestore.collection': (key): SectionLink => {
      const [database, pattern] = split(key)
      // A collection group as the rules engine names a refused list
      // (`**/orders`, or `users/u_1/**/orders` under one document): the
      // grid's group view of `orders`, which runs from the root — the page
      // has no ancestor-scoped group, so the link opens the whole group.
      const group = collectionGroupOf(pattern)
      if (group !== undefined)
        return { to: '/firestore', search: { db: dbParam(database), path: group, group: true } }
      return { to: '/firestore', search: { db: dbParam(database), path: pattern } }
    },
    'firestore.document': (key): SectionLink => {
      const [database, path] = split(key)
      return {
        to: '/firestore',
        search: { db: dbParam(database), path: parentPath(path), doc: path },
      }
    },
    'firestore.decision': (key): SectionLink => {
      const [database, requestId] = split(key)
      return {
        to: '/firestore/rules',
        search: { db: dbParam(database), panel: 'decisions', decision: requestId },
      }
    },
  },
}
