// Creating things in Firestore is one operation wearing three hats: a
// document, a collection (which is its first document), and a batch of
// documents from JSON. Any part of the workbench can open the dialog with
// one of these requests; the dialog itself lives in the workbench shell.

import { create } from 'zustand'
import type { FsDocument } from './value'

export type CreateRequest =
  | {
      kind: 'document'
      /** The collection the document goes into. */
      collection: string
      /** A document to copy the fields from (duplicate). */
      template?: FsDocument | undefined
      /** An id decided already (creating a missing ancestor). */
      id?: string | undefined
    }
  | {
      kind: 'collection'
      /** The parent document, or empty for a root collection. */
      parent: string
      /** A collection id typed somewhere already (the path bar). */
      id?: string | undefined
    }
  | {
      kind: 'import'
      collection: string
    }

interface CreateDialogState {
  request: CreateRequest | null
  /** Bumps on every open so the form mounts fresh. */
  session: number
  open: (request: CreateRequest) => void
  close: () => void
}

export const useCreateDialog = create<CreateDialogState>((set) => ({
  request: null,
  session: 0,
  open: (request) => set((state) => ({ request, session: state.session + 1 })),
  close: () => set({ request: null }),
}))

/** Auto ids the way the SDKs mint them: 20 characters from the same alphabet. */
export function generateId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

/** What Firestore accepts as a collection or document id, and why not. */
export function validateId(id: string, what: 'collection' | 'document'): string | undefined {
  if (id === '') return `A ${what} id is required`
  if (id.includes('/')) return 'An id cannot contain a slash'
  if (id === '.' || id === '..') return 'An id cannot be . or ..'
  if (/^__.*__$/.test(id)) return 'Ids wrapped in double underscores are reserved'
  if (new TextEncoder().encode(id).length > 1500) return 'An id is at most 1,500 bytes'
  return undefined
}

export interface ImportedDocument {
  /** Undefined asks for an auto id. */
  id: string | undefined
  fields: Record<string, unknown>
}

/**
 * Reads pasted or dropped JSON into documents. Three shapes are understood:
 * an object keyed by document id, an array of documents (auto ids), and
 * NDJSON with one document per line (auto ids). A document's fields must be
 * an object.
 */
export function parseImport(text: string): ImportedDocument[] {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('Paste some JSON first')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Not one JSON value: try one document per line.
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '')
    return lines.map((line, index) => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Line ${index + 1} is not valid JSON`)
      }
      return { id: undefined, fields: asFields(value, `line ${index + 1}`) }
    })
  }
  if (Array.isArray(parsed))
    return parsed.map((item, index) => ({
      id: undefined,
      fields: asFields(item, `item ${index + 1}`),
    }))
  if (parsed && typeof parsed === 'object')
    return Object.entries(parsed as Record<string, unknown>).map(([id, value]) => ({
      id,
      fields: asFields(value, id),
    }))
  throw new Error('Expected an object keyed by id, an array of documents, or NDJSON')
}

function asFields(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`The fields of ${where} must be a JSON object`)
  return value as Record<string, unknown>
}
