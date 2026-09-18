// Phase G0: one production Rules API request confirming that projects.test
// accepts `service firebase.storage` sources for the conformance project.
// The receipt (digest, timing, result states) is recorded in
// benchmarks/phase-g-storage-rules.json; no credentials are stored.
import { createHash } from "node:crypto";

import { GoogleAuth } from "google-auth-library";

import { PHASE3_RULES_PROJECT_ID } from "../rules/phase3-oracle-plan.ts";

const allowlist = process.env.CONFORMANCE_CLOUD_ALLOWLIST;
if (allowlist !== PHASE3_RULES_PROJECT_ID) {
  throw new Error(
    `storage rules probe requires CONFORMANCE_CLOUD_ALLOWLIST=${PHASE3_RULES_PROJECT_ID}`,
  );
}

const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /probe/{name} {
      allow read: if request.auth != null && request.auth.uid == 'probe-user';
      allow write: if request.resource != null && request.resource.size < 1024;
    }
  }
}
`;

const testCases = [
  {
    expectation: "ALLOW",
    request: {
      auth: { uid: "probe-user", token: {} },
      method: "get",
      path: "/b/probe-bucket/o/probe/object.txt",
      time: "2026-01-15T12:34:56.123456789Z",
    },
    pathEncoding: "PLAIN",
    expressionReportLevel: "FULL",
  },
  {
    expectation: "DENY",
    request: {
      auth: null,
      method: "get",
      path: "/b/probe-bucket/o/probe/object.txt",
      time: "2026-01-15T12:34:56.123456789Z",
    },
    pathEncoding: "PLAIN",
    expressionReportLevel: "FULL",
  },
  {
    expectation: "ALLOW",
    request: {
      auth: { uid: "probe-user", token: {} },
      method: "create",
      path: "/b/probe-bucket/o/probe/object.txt",
      time: "2026-01-15T12:34:56.123456789Z",
      resource: { name: "probe/object.txt", bucket: "probe-bucket", size: 12, contentType: "text/plain" },
    },
    pathEncoding: "PLAIN",
    expressionReportLevel: "FULL",
  },
];

const client = await new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
}).getClient();
const startedAt = new Date();
const response = await client.request({
  url: `https://firebaserules.googleapis.com/v1/projects/${PHASE3_RULES_PROJECT_ID}:test`,
  method: "POST",
  data: {
    source: { files: [{ name: "storage.rules", content: source }] },
    testSuite: { testCases },
  },
});
const elapsedMs = Date.now() - startedAt.getTime();
const data = response.data as {
  readonly issues?: ReadonlyArray<{ readonly severity?: string; readonly description?: string }>;
  readonly testResults?: ReadonlyArray<{
    readonly state?: string;
    readonly debugMessages?: readonly string[];
    readonly errorPosition?: unknown;
    readonly functionCalls?: readonly unknown[];
    readonly visitedExpressions?: readonly unknown[];
    readonly expressionReports?: readonly unknown[];
  }>;
};
const body = JSON.stringify(data);
console.log(
  JSON.stringify(
    {
      probedAt: startedAt.toISOString(),
      elapsedMs,
      httpStatus: response.status,
      issues: data.issues ?? [],
      states: (data.testResults ?? []).map(({ state }) => state),
      expressionReportsPerCase: (data.testResults ?? []).map(
        ({ expressionReports }) => expressionReports?.length ?? 0,
      ),
      responseSha256: createHash("sha256").update(body).digest("hex"),
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    },
    null,
    2,
  ),
);
console.error(JSON.stringify(data, null, 2));
