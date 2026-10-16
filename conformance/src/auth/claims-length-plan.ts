// How the official Auth emulator (firebase-tools 15.22.0) measures custom
// claims against its 1,000 limit: `claims.length`, the JavaScript string length,
// which counts UTF-16 code units — not bytes, and not characters. `é` counts
// one (two UTF-8 bytes), `🔥` counts two (a surrogate pair, four UTF-8 bytes).
// Recorded at 999, 1,000 and 1,001 units through every path that validates a
// serialized claims object: the privileged accounts:update, batchCreate
// (importUsers) and a beforeCreate blocking function's customClaims.
//
// Same programs shape, runner and normalization as the Phase I1 corpus
// (`emulator-plan.ts`); recorded into its own fixture directory so the frozen
// corpus is never rewritten.

import { API_KEY, PROJECT, PROJECT_V2, V1, type Json, type Program, type Step, type StubResponse } from "./emulator-plan.ts";

const OWNER = { Authorization: "Bearer owner" } as const;

/** One UTF-16 code unit, two UTF-8 bytes. */
const ACCENT = "é";
/** Two UTF-16 code units (a surrogate pair), four UTF-8 bytes. */
const FIRE = "🔥";

function owner(id: string, method: Step["method"], path: string, body?: Json, extra: Partial<Step> = {}): Step {
  return { id, method, path, headers: OWNER, ...(body === undefined ? {} : { body }), ...extra };
}

function client(id: string, path: string, body: Json, extra: Partial<Step> = {}): Step {
  return { id, method: "POST", path: `${path}?key=${API_KEY}`, body, ...extra };
}

/** The claim value that makes `{"k":"<value>"}` exactly `length` UTF-16 code units long. */
function claimValue(length: number, last = ""): string {
  const value = `${ACCENT.repeat(length - '{"k":""}'.length - last.length)}${last}`;
  const serialized = JSON.stringify({ k: value });
  if (serialized.length !== length) throw new Error(`claims of ${String(serialized.length)} units, wanted ${String(length)}`);
  return value;
}

/** A serialized claims object of exactly `length` UTF-16 code units. */
function claims(length: number, last = ""): string {
  return JSON.stringify({ k: claimValue(length, last) });
}

/** The same length in ASCII, the case bytes and code units agree on. */
function asciiClaims(length: number): string {
  return JSON.stringify({ k: "x".repeat(length - '{"k":""}'.length) });
}

function update(id: string, customAttributes: string): Step {
  return owner(id, "POST", `${PROJECT}/accounts:update`, { localId: "claims-length", customAttributes });
}

function beforeCreateClaims(length: number, last = ""): StubResponse {
  return { body: { userRecord: { updateMask: "customClaims", customClaims: { k: claimValue(length, last) } } } };
}

export const CLAIMS_LENGTH_PROGRAMS: readonly Program[] = [
  {
    id: "custom-claims-length",
    category: "claims",
    title: "custom claims are measured in UTF-16 code units: é counts one, 🔥 counts two, at 999 to 1,001",
    steps: [
      owner("create", "POST", `${PROJECT}/accounts`, { localId: "claims-length", email: "claims-length@example.com", password: "password1" }),
      update("ascii-1000", asciiClaims(1000)),
      update("ascii-1001", asciiClaims(1001)),
      update("accented-999", claims(999)),
      update("accented-1000", claims(1000)),
      update("accented-1001", claims(1001)),
      owner("lookup-accented", "POST", `${PROJECT}/accounts:lookup`, { localId: ["claims-length"] }),
      update("emoji-1000", claims(1000, FIRE)),
      update("emoji-1001", claims(1001, FIRE)),
      owner("lookup-emoji", "POST", `${PROJECT}/accounts:lookup`, { localId: ["claims-length"] }),
      client("signin-carries-claims", `${V1}/accounts:signInWithPassword`, { email: "claims-length@example.com", password: "password1", returnSecureToken: true }),
      owner("import", "POST", `${PROJECT}/accounts:batchCreate`, {
        users: [
          { localId: "imp-accented-1000", email: "imp-accented-1000@example.com", customAttributes: claims(1000) },
          { localId: "imp-accented-1001", email: "imp-accented-1001@example.com", customAttributes: claims(1001) },
          { localId: "imp-emoji-1000", email: "imp-emoji-1000@example.com", customAttributes: claims(1000, FIRE) },
          { localId: "imp-emoji-1001", email: "imp-emoji-1001@example.com", customAttributes: claims(1001, FIRE) },
        ],
      }),
      owner("imported", "POST", `${PROJECT}/accounts:lookup`, { localId: ["imp-accented-1000", "imp-accented-1001", "imp-emoji-1000", "imp-emoji-1001"] }),
      owner("configure-blocking", "PATCH", `${PROJECT_V2}/config`, { blockingFunctions: { triggers: { beforeCreate: { functionUri: "{{functionsOrigin}}/blocking/beforeCreate" } } } }, { query: { updateMask: "blockingFunctions" } }),
      client("blocking-accented-1000", `${V1}/accounts:signUp`, { email: "blocking-1000@example.com", password: "password1", returnSecureToken: true }, { functions: { beforeCreate: beforeCreateClaims(1000) } }),
      client("blocking-emoji-1000", `${V1}/accounts:signUp`, { email: "blocking-emoji-1000@example.com", password: "password1", returnSecureToken: true }, { functions: { beforeCreate: beforeCreateClaims(1000, FIRE) } }),
      client("blocking-emoji-1001", `${V1}/accounts:signUp`, { email: "blocking-emoji-1001@example.com", password: "password1", returnSecureToken: true }, { functions: { beforeCreate: beforeCreateClaims(1001, FIRE) } }),
      owner("lookup-blocking", "POST", `${PROJECT}/accounts:lookup`, { email: ["blocking-1000@example.com", "blocking-emoji-1000@example.com", "blocking-emoji-1001@example.com"] }),
    ],
  },
];
