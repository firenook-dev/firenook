// createDocument under Security Rules: evaluated as a create, against the
// official emulator and Firenook alike. It replaces the ruleset, so it runs
// in the serial control phase (`npm run test:control`), never beside the
// parallel suite, and puts the open ruleset back at the end.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { resolveTarget } from "../src/target.ts";

const OPEN = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }";

test("createDocument is evaluated by Security Rules as a create", async (context) => {
  const configuration = resolveTarget(process.env);
  if (configuration.host === undefined) {
    context.skip("Security Rules are deployed, not set, in production");
    return;
  }
  const project = configuration.projectId;
  const run = `runs/${randomUUID()}`;
  const base = `http://${configuration.host}/v1/projects/${project}/databases/(default)/documents/${run}`;
  const setRules = async (content: string): Promise<void> => {
    const answer = await fetch(`http://${configuration.host}/emulator/v1/projects/${project}:securityRules`, {
      method: "PUT",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ rules: { files: [{ content }] } }),
    });
    assert.equal(answer.status, 200);
  };
  const call = async (method: string, path: string, body: unknown): Promise<{ status: number; body: { error?: { status?: string }; name?: string } }> => {
    const answer = await fetch(`${base}/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: (await answer.json()) as { error?: { status?: string }; name?: string } };
  };
  const n = (value: number) => ({ fields: { n: { integerValue: String(value) } } });

  await setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /runs/{run}/guarded/{id} { allow create: if request.resource.data.n == 1; allow read: if true; }
    match /runs/{run}/updatable/{id} { allow read, update: if true; }
  }
}`);
  try {
    const created = await call("POST", "guarded?documentId=g1", n(1));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.name, `projects/${project}/databases/(default)/documents/${run}/guarded/g1`);
    const automatic = await call("POST", "guarded", n(1));
    assert.equal(automatic.status, 200, JSON.stringify(automatic.body));

    const denied = await call("POST", "guarded?documentId=g2", n(2));
    assert.deepEqual([denied.status, denied.body.error?.status], [403, "PERMISSION_DENIED"]);
    // Allowed as a create, then refused because the document exists.
    const existing = await call("POST", "guarded?documentId=g1", n(1));
    assert.deepEqual([existing.status, existing.body.error?.status], [409, "ALREADY_EXISTS"]);
    // A patch of the same document is an update, which no rule allows.
    const updated = await call("PATCH", "guarded/g1", n(1));
    assert.deepEqual([updated.status, updated.body.error?.status], [403, "PERMISSION_DENIED"]);
    // A rule that allows update alone does not allow createDocument.
    const notCreate = await call("POST", "updatable?documentId=u1", n(1));
    assert.deepEqual([notCreate.status, notCreate.body.error?.status], [403, "PERMISSION_DENIED"]);
  } finally {
    await setRules(OPEN);
  }
});
