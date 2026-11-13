// Production's limit on how large one rules expression may be (#204).
//
// production-limit-probes.json shows a chain of `request.auth.token.n >= k`
// terms joined by `&&` answered at 50 terms, failing with 500 INTERNAL from
// 60 to 90, and refused at compile with "Expression is too complex to
// evaluate safely." at 100, while the same terms split across functions
// never are. These probes find both edges to the term, and vary what one
// term is, which side its literal is on and how the chain is bracketed, so
// the measure production applies can be read from its answers rather than
// guessed. They are written to their own folder with its own SHA256SUMS;
// the earlier fixtures stay as recorded.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GoogleAuth } from "google-auth-library";

import { PHASE3_RULES_PROJECT_ID } from "./phase3-oracle-plan.ts";

const allowlist = process.env.CONFORMANCE_CLOUD_ALLOWLIST;
if (allowlist !== PHASE3_RULES_PROJECT_ID) {
  throw new Error(
    `rules oracle requires CONFORMANCE_CLOUD_ALLOWLIST=${PHASE3_RULES_PROJECT_ID}`,
  );
}
if (process.env.FIRESTORE_EMULATOR_HOST !== undefined) {
  throw new Error("rules oracle refuses FIRESTORE_EMULATOR_HOST");
}

const outputRoot = resolve("fixtures/rules-v2/expression-size");
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();
const endpoint = `https://firebaserules.googleapis.com/v1/projects/${PHASE3_RULES_PROJECT_ID}:test`;

interface Observation {
  readonly id: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly source: string;
  readonly httpStatus: number;
  readonly response: unknown;
}

/** A term as deep as `>=` over `request.auth.token.n` (five levels). */
const tokenTerm = (index: number) => `request.auth.token.n >= ${index}`;
/** The same comparison with its literal on the left. */
const literalLeftTerm = (index: number) => `${index} <= request.auth.token.n`;
/** Three levels: `!=` over `request.time`, and a literal. */
const timeTerm = () => "request.time != null";
/** One level. */
const trueTerm = () => "true";

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

const families: readonly {
  readonly family: string;
  readonly counts: readonly number[];
  readonly expression: (terms: number) => string;
}[] = [
  // Both edges of what production-limit-probes.json recorded, to the term.
  { family: "linear-expression-terms", counts: [...range(51, 59), ...range(91, 99)], expression: (n) => chain(n, tokenTerm) },
  // Shallower terms: an edge that moves with a term's depth, or with the count alone.
  {
    family: "true-chain-terms",
    counts: [50, 55, 60, 70, 80, 90, ...range(95, 110), 120, 150, 200],
    expression: (n) => chain(n, trueTerm),
  },
  { family: "time-chain-terms", counts: [50, 55, 60, 70, 80, 90, ...range(95, 105), 120], expression: (n) => chain(n, timeTerm) },
  // The recorded 100-term refusal names a literal among its positions.
  { family: "literal-left-terms", counts: [50, 60, 90, ...range(95, 100)], expression: (n) => chain(n, literalLeftTerm) },
  // Bracketed to the right, and balanced: depth against count.
  { family: "right-nested-terms", counts: [20, 50, 60, 90, 100], expression: (n) => rightNested(n, tokenTerm) },
  { family: "balanced-parenthesised-terms", counts: [60, 100, 200, 400], expression: (n) => balanced(0, n, tokenTerm) },
];

const observations: Observation[] = [];
for (const { family, counts, expression } of families) {
  for (const terms of counts) {
    const id = `${family}-${terms}`;
    observations.push(await observe(id, wrap(`allow get: if ${expression(terms)};`)));
    console.log(`captured ${id}`);
  }
}

await mkdir(outputRoot, { recursive: true });
await writeFixture("production-expression-size-probes.json", {
  schemaVersion: 1,
  target: "production-firebase-rules-projects-test",
  targetProject: PHASE3_RULES_PROJECT_ID,
  capturedAt: new Date().toISOString(),
  credentialsStored: false,
  authorizationHeadersStored: false,
  observations,
});

function chain(terms: number, term: (index: number) => string): string {
  return Array.from({ length: terms }, (_, index) => term(index)).join(" && ");
}

function rightNested(terms: number, term: (index: number) => string): string {
  let expression = term(terms - 1);
  for (let index = terms - 2; index >= 0; index -= 1) {
    expression = `${term(index)} && (${expression})`;
  }
  return expression;
}

function balanced(from: number, to: number, term: (index: number) => string): string {
  if (to - from === 1) return term(from);
  const middle = from + Math.floor((to - from) / 2);
  return `(${balanced(from, middle, term)}) && (${balanced(middle, to, term)})`;
}

async function observe(id: string, source: string): Promise<Observation> {
  const data = {
    source: { files: [{ name: "firestore.rules", content: source }] },
    testSuite: {
      testCases: [
        {
          expectation: "ALLOW",
          request: {
            auth: { uid: "limit-probe", token: { n: 10_000 } },
            method: "get",
            path: "/databases/(default)/documents/phase3/limit-probe",
            time: "2026-01-01T00:00:00Z",
          },
          pathEncoding: "PLAIN",
          expressionReportLevel: "FULL",
        },
      ],
    },
  };
  let httpStatus = 200;
  let response: unknown;
  try {
    const result = await client.request({ url: endpoint, method: "POST", data });
    httpStatus = result.status;
    response = result.data;
  } catch (error) {
    const failure = error as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    httpStatus = failure.response?.status ?? 0;
    response = failure.response?.data ?? { message: failure.message ?? "unknown error" };
  }
  return {
    id,
    sourceSha256: sha256(source),
    sourceBytes: Buffer.byteLength(source),
    source,
    httpStatus,
    response,
  };
}

function wrap(body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /phase3/{document} {
      ${body}
    }
  }
}
`;
}

async function writeFixture(name: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(resolve(outputRoot, name), text, "utf8");
  await writeFile(resolve(outputRoot, "SHA256SUMS"), `${sha256(text)}  ${name}\n`, "utf8");
  console.log(`wrote ${resolve(outputRoot, name)}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
