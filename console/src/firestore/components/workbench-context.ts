// What every part of the workbench shares: the Firestore scope (project,
// database, identity), the view state in the URL, and the setters that
// navigate. Server data stays in TanStack Query; selection sets in Zustand.

import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { createContext, useContext, useMemo } from 'react'
import { statusQuery } from '@/api/queries'
import type { FirestoreSearch } from '@/routes/firestore'
import { EMPTY_QUERY, QueryParseError, type WorkbenchQuery, parseQuery, printQuery } from '../query'
import type { FirestoreScope } from '../rest'
import { type ViewAs, authorizationFor, parseViewAs, serializeViewAs } from '../view-as'

export const DEFAULT_DATABASE = '(default)'

export interface Workbench {
  project: string
  database: string
  scope: FirestoreScope
  /** The owner scope, for counts and structure the identity must not hide. */
  ownerScope: FirestoreScope
  viewAs: ViewAs
  /** The path in the URL: a collection (`users`, `users/u1/orders`), or empty for the root. */
  path: string
  /** Whether `path` names a collection (odd segment count) rather than a document. */
  isCollection: boolean
  /** The collection the grid shows, or empty at the root. */
  collectionPath: string
  group: boolean
  queryText: string
  query: WorkbenchQuery
  queryError: string | undefined
  selectedDocument: string | undefined
  tab: 'fields' | 'json'
  origin: string
  navigate: (patch: Partial<FirestoreSearch>, options?: { replace?: boolean }) => void
  setPath: (path: string) => void
  setQuery: (query: WorkbenchQuery) => void
  setQueryText: (text: string) => void
  setGroup: (group: boolean) => void
  setViewAs: (viewAs: ViewAs) => void
  selectDocument: (path: string | undefined) => void
  setTab: (tab: 'fields' | 'json') => void
  setDatabase: (database: string) => void
}

const WorkbenchContext = createContext<Workbench | null>(null)
export const WorkbenchProvider = WorkbenchContext.Provider

export function useWorkbench(): Workbench {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbench needs a WorkbenchProvider')
  return value
}

export function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/')
}

export function useWorkbenchState(): Workbench | null {
  const search = useSearch({ from: '/firestore' })
  const router = useNavigate({ from: '/firestore' })
  const status = useQuery(statusQuery)
  const project = status.data?.projectId

  return useMemo(() => {
    if (!project) return null
    const database = search.db ?? DEFAULT_DATABASE
    const viewAs = parseViewAs(search.as)
    const authorization = authorizationFor(viewAs, project)
    const scope: FirestoreScope = { project, database, authorization }
    const ownerScope: FirestoreScope = {
      project,
      database,
      authorization: authorizationFor({ kind: 'owner' }, project),
    }
    const path = normalizePath(search.path ?? '')
    const segments = path ? path.split('/') : []
    const isCollection = segments.length % 2 === 1
    const collectionPath = isCollection ? path : ''
    const queryText = search.q ?? ''
    let query = EMPTY_QUERY
    let queryError: string | undefined
    if (queryText) {
      try {
        query = parseQuery(queryText)
      } catch (error) {
        queryError = error instanceof QueryParseError ? error.message : String(error)
      }
    }
    const navigate = (patch: Partial<FirestoreSearch>, options?: { replace?: boolean }) =>
      void router({
        search: (previous) => {
          const next: FirestoreSearch = { ...previous, ...patch }
          for (const key of Object.keys(next) as Array<keyof FirestoreSearch>)
            if (next[key] === undefined || next[key] === '' || next[key] === false) delete next[key]
          return next
        },
        replace: options?.replace ?? false,
      })
    return {
      project,
      database,
      scope,
      ownerScope,
      viewAs,
      path,
      isCollection,
      collectionPath,
      group: Boolean(search.group),
      queryText,
      query,
      queryError,
      selectedDocument: search.doc,
      tab: search.tab ?? 'fields',
      origin: window.location.origin,
      navigate,
      setPath: (next) => {
        const normalized = normalizePath(next)
        const nextSegments = normalized ? normalized.split('/') : []
        // A document path opens that document in its collection.
        if (nextSegments.length % 2 === 0 && nextSegments.length > 0)
          navigate({
            path: nextSegments.slice(0, -1).join('/'),
            doc: normalized,
            q: undefined,
            group: undefined,
          })
        else navigate({ path: normalized, doc: undefined, q: undefined, group: undefined })
      },
      setQuery: (next) => navigate({ q: printQuery(next) || undefined }),
      setQueryText: (text) => navigate({ q: text.trim() || undefined }),
      setGroup: (group) => navigate({ group: group || undefined, doc: undefined }),
      setViewAs: (next) => navigate({ as: serializeViewAs(next) }),
      selectDocument: (doc) => navigate({ doc }, { replace: true }),
      setTab: (tab) => navigate({ tab: tab === 'fields' ? undefined : tab }, { replace: true }),
      setDatabase: (next) =>
        navigate({
          db: next === DEFAULT_DATABASE ? undefined : next,
          path: undefined,
          doc: undefined,
          q: undefined,
        }),
    }
  }, [project, search, router])
}
