// Phase G1: capture the production expression corpus for
// `service firebase.storage` from the Rules API (`projects.test`).
//
// Every request carries synthetic values only; the API evaluates the source
// against the supplied request and returns per-case states with FULL
// expression reports. No credentials or authorization headers are stored.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GoogleAuth } from "google-auth-library";

import {
  STORAGE_LANGUAGE_CASES,
  STORAGE_RULES_CASES_PER_BATCH,
  STORAGE_RULES_CORPUS_SEED,
  STORAGE_RULES_PROJECT_ID,
  buildStorageLanguageBatches,
} from "./language-plan.ts";

const MAXIMUM_REQUESTS = 128;

const allowlist = process.env.CONFORMANCE_CLOUD_ALLOWLIST;
if (allowlist !== STORAGE_RULES_PROJECT_ID) {
  throw new Error(
    `storage rules oracle requires CONFORMANCE_CLOUD_ALLOWLIST=${STORAGE_RULES_PROJECT_ID}`,
  );
}
if (process.env.FIRESTORE_EMULATOR_HOST !== undefined) {
  throw new Error("storage rules oracle refuses FIRESTORE_EMULATOR_HOST");
}

interface TestResult {
  readonly state?: string;
  readonly debugMessages?: readonly string[];
  readonly errorPosition?: unknown;
  readonly functionCalls?: readonly unknown[];
  readonly visitedExpressions?: readonly unknown[];
  readonly expressionReports?: readonly unknown[];
}

interface TestResponse {
  readonly issues?: ReadonlyArray<{
    readonly severity?: string;
    readonly description?: string;
    readonly sourcePosition?: unknown;
  }>;
  readonly testResults?: readonly TestResult[];
}

const outputRoot = resolve("fixtures/storage-rules-v1");
const outputPath = resolve(outputRoot, "production-expression-corpus.json");
const batches = buildStorageLanguageBatches();
if (batches.length > MAXIMUM_REQUESTS) {
  throw new Error(`${batches.length} batches exceed the ${MAXIMUM_REQUESTS}-request budget`);
}
const client = await new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
}).getClient();

const captured = [];
let requests = 0;
for (const batch of batches) {
  requests += 1;
  const response = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${STORAGE_RULES_PROJECT_ID}:test`,
    method: "POST",
    data: {
      source: { files: [{ name: "storage.rules", content: batch.source }] },
      testSuite: { testCases: batch.testCases },
    },
  });
  const body = response.data as TestResponse;
  const compilerErrors = body.issues?.filter(({ severity }) => severity === "ERROR") ?? [];
  if (compilerErrors.length !== 0) {
    throw new Error(`${batch.id} returned compiler errors: ${JSON.stringify(compilerErrors, null, 2)}`);
  }
  if ((body.testResults?.length ?? 0) !== batch.cases.length) {
    throw new Error(
      `${batch.id} returned ${body.testResults?.length ?? 0} results for ${batch.cases.length} cases`,
    );
  }
  captured.push({
    id: batch.id,
    sourceSha256: sha256(batch.source),
    source: batch.source,
    cases: batch.cases,
    testCases: batch.testCases,
    response: body,
  });
  const states = body.testResults?.map(({ state }) => state ?? "UNKNOWN") ?? [];
  console.log(
    `captured ${batch.id}: ${states.filter((state) => state === "SUCCESS").length} allow, ${states.filter((state) => state === "FAILURE").length} deny, ${body.issues?.length ?? 0} issues`,
  );
}

const results = captured.flatMap((batch) =>
  batch.cases.map((testCase, index) => ({
    id: testCase.id,
    category: testCase.category,
    method: testCase.method,
    state: batch.response.testResults?.[index]?.state ?? "UNKNOWN",
    error: (batch.response.testResults?.[index]?.debugMessages ?? []).find((message) =>
      message.startsWith("Error:"),
    ),
  })),
);
const categories = Object.fromEntries(
  [...new Set(STORAGE_LANGUAGE_CASES.map(({ category }) => category))].map((category) => [
    category,
    STORAGE_LANGUAGE_CASES.filter((testCase) => testCase.category === category).length,
  ]),
);

const fixture = {
  schemaVersion: 1,
  target: "production-firebase-rules-projects-test",
  service: "firebase.storage",
  targetProject: STORAGE_RULES_PROJECT_ID,
  endpoint: `https://firebaserules.googleapis.com/v1/projects/${STORAGE_RULES_PROJECT_ID}:test`,
  generatorSeed: STORAGE_RULES_CORPUS_SEED,
  capturedAt: new Date().toISOString(),
  pathEncoding: "PLAIN",
  expressionReportLevel: "FULL",
  expectationProbe: "ALLOW",
  credentialsStored: false,
  authorizationHeadersStored: false,
  persistentCloudReads: 0,
  persistentCloudWrites: 0,
  rulesApiRequests: requests,
  casesPerBatch: STORAGE_RULES_CASES_PER_BATCH,
  caseCount: STORAGE_LANGUAGE_CASES.length,
  batchCount: captured.length,
  categories,
  verdictSummary: {
    allow: results.filter(({ state }) => state === "SUCCESS").length,
    deny: results.filter(({ state }) => state === "FAILURE").length,
    denyWithRuntimeError: results.filter(({ error }) => error !== undefined).length,
  },
  results,
  batches: captured,
};
await mkdir(outputRoot, { recursive: true });
const text = `${JSON.stringify(fixture, null, 2)}\n`;
await writeFile(outputPath, text, "utf8");
console.log(`wrote ${outputPath}`);
console.log(JSON.stringify({ ...fixture.verdictSummary, sha256: sha256(text) }));

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
