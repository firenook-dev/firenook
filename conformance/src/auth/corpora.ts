// The Auth oracle corpora. Each is a fixture directory under
// `conformance/fixtures` with its own digests and receipt, so a frozen corpus
// is never rewritten when a case is recorded later. The capture records one
// corpus (`--corpus=<id>`, the Phase I1 corpus by default); the replay
// replays every corpus unless one is named.

import { CLAIMS_LENGTH_PROGRAMS } from "./claims-length-plan.ts";
import { PROGRAMS, type Program } from "./emulator-plan.ts";

export interface Corpus {
  /** The fixture directory under `conformance/fixtures`. */
  readonly id: string;
  readonly programs: readonly Program[];
  readonly hypothesis: string;
  /** Measured against the Phase I gate's inventory of official operations. */
  readonly coversInventory: boolean;
}

export const CORPORA: readonly Corpus[] = [
  {
    id: "auth-v1",
    programs: PROGRAMS,
    hypothesis:
      "Every operation the official Auth emulator implements, recorded as raw HTTP programs on fresh emulator state with lifecycle multicasts and blocking-function calls observed",
    coversInventory: true,
  },
  {
    id: "auth-claims-length-v1",
    programs: CLAIMS_LENGTH_PROGRAMS,
    hypothesis:
      "The official Auth emulator measures serialized custom claims in UTF-16 code units (JavaScript string length) against its 1,000 limit, on accounts:update, batchCreate and a beforeCreate function's customClaims",
    coversInventory: false,
  },
];

export const DEFAULT_CORPUS = "auth-v1";

export function corpusById(id: string): Corpus {
  const found = CORPORA.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown corpus ${id}; known: ${CORPORA.map((candidate) => candidate.id).join(", ")}`);
  return found;
}
