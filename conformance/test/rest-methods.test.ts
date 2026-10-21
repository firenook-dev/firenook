// Every Firestore REST v1 method, status and body, against the official
// emulator and Firenook alike. Each test writes under its own
// `runs/<uuid>/...` path and authenticates as the owner, so the files run in
// parallel with the rest of the suite. Where Firenook keeps production's
// behaviour over the official emulator's, the branch says so; the recorded
// official answers are in the comments.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { resolveTarget, type TargetConfiguration } from "../src/target.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Answer {
  readonly status: number;
  readonly body: Json;
}

interface Rest {
  readonly configuration: TargetConfiguration;
  readonly root: string;
  readonly run: string;
  call(method: string, path: string, options?: CallOptions): Promise<Answer>;
}

interface CallOptions {
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly body?: Json;
  readonly raw?: string;
  readonly authorization?: string | null;
}

const PAYLOAD_INVALID = "Payload isn't valid for request.";
const TRANSACTION_ENDED = "The referenced transaction has expired or is no longer valid.";
const AUTO_ID = /^[A-Za-z0-9]{20}$/u;
const int = (value: number): Json => ({ integerValue: String(value) });

/** A REST client for one emulator target, or a skip in production. */
function rest(context: TestContext): Rest | undefined {
  const configuration = resolveTarget(process.env);
  if (configuration.host === undefined) {
    context.skip("the REST method audit uses the emulators' owner credential");
    return undefined;
  }
  const root = `projects/${configuration.projectId}/databases/(default)/documents`;
  const base = `http://${configuration.host}/v1/projects/${configuration.projectId}/databases/(default)/`;
  return {
    configuration,
    root,
    run: `runs/${randomUUID()}`,
    async call(method, path, options = {}) {
      const query = (options.query ?? []).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
      const headers: Record<string, string> = {};
      if (options.authorization !== null) headers.authorization = options.authorization ?? "Bearer owner";
      const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`${base}${path}${query ? `?${query}` : ""}`, { method, headers, ...(body === undefined ? {} : { body }) });
      const text = await response.text();
      let parsed: Json = text;
      try {
        parsed = JSON.parse(text) as Json;
      } catch {
        // A plain-text answer is kept as it is.
      }
      return { status: response.status, body: parsed };
    },
  };
}

function object(value: Json | undefined): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `an object: ${JSON.stringify(value)}`);
  return value;
}

function array(value: Json | undefined): Json[] {
  assert.ok(Array.isArray(value), `an array: ${JSON.stringify(value)}`);
  return value;
}

/** An error answer: its HTTP status, its status name, and the message when given. */
function assertError(answer: Answer, status: number, name: string, message?: string | RegExp): void {
  assert.equal(answer.status, status, JSON.stringify(answer.body));
  const error = object(object(answer.body).error);
  assert.equal(error.code, status);
  assert.equal(error.status, name);
  assert.equal(typeof error.message, "string");
  if (typeof message === "string") assert.equal(error.message, message);
  else if (message !== undefined) assert.match(String(error.message), message);
}

/** A document as REST writes it: exactly name, fields when it has any, and both times. */
function assertDocument(value: Json | undefined, name: string, fields?: JsonObject): JsonObject {
  const document = object(value);
  assert.deepEqual(Object.keys(document).sort(), [...(fields === undefined ? [] : ["fields"]), "createTime", "name", "updateTime"].sort());
  assert.equal(document.name, name);
  if (fields !== undefined) assert.deepEqual(document.fields, fields);
  assert.match(String(document.createTime), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/u);
  assert.match(String(document.updateTime), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/u);
  return document;
}

/**
 * A streamed REST answer without its `done` marker. The official emulator
 * ends every runQuery and runAggregationQuery stream with `"done": true`;
 * production, recorded in fixtures/rest-v1/production-cloud-firestore, does
 * not, and neither does Firenook.
 */
function stream(rest: Rest, answer: Answer): JsonObject[] {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const items = array(answer.body).map(object);
  const last = items.at(-1);
  if (rest.configuration.name === "java") assert.equal(last?.done, true);
  else assert.equal(items.some((item) => "done" in item), false);
  return items.map(({ done: _done, ...rest }) => rest);
}

async function seed(rest: Rest, documents: Record<string, JsonObject>): Promise<void> {
  const writes = Object.entries(documents).map(([path, fields]) => ({ update: { name: `${rest.root}/${rest.run}/${path}`, fields } }));
  const answer = await rest.call("POST", "documents:commit", { body: { writes } });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

async function begin(rest: Rest, options?: JsonObject): Promise<string> {
  const answer = await rest.call("POST", "documents:beginTransaction", { body: options === undefined ? {} : { options } });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return String(object(answer.body).transaction);
}

test("createDocument takes documentId or makes an id, refuses an existing document and applies mask", async (context) => {
  const r = rest(context);
  if (!r) return;
  const orders = `documents/${r.run}/orders`;
  const name = (path: string): string => `${r.root}/${r.run}/${path}`;

  const created = await r.call("POST", orders, { query: [["documentId", "o1"]], body: { fields: { total: int(42) } } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const document = assertDocument(created.body, name("orders/o1"), { total: int(42) });
  assert.equal(document.createTime, document.updateTime);
  assert.deepEqual((await r.call("GET", `${orders}/o1`)).body, created.body);

  assertError(await r.call("POST", orders, { query: [["documentId", "o1"]], body: { fields: { total: int(43) } } }), 409, "ALREADY_EXISTS");
  assert.deepEqual(object((await r.call("GET", `${orders}/o1`)).body).fields, { total: int(42) });

  // An id the server makes: 20 letters and digits, as the client SDKs make them.
  for (const query of [[], [["documentId", ""]]] as const) {
    const automatic = await r.call("POST", orders, { query, body: { fields: { total: int(7) } } });
    assert.equal(automatic.status, 200, JSON.stringify(automatic.body));
    const id = String(object(automatic.body).name).split("/").at(-1) ?? "";
    assert.match(id, AUTO_ID);
    assertDocument(automatic.body, name(`orders/${id}`), { total: int(7) });
    assert.equal((await r.call("GET", `${orders}/${id}`)).status, 200);
  }

  // Under a document, even one that does not exist.
  assertDocument((await r.call("POST", `${orders}/o1/items`, { query: [["documentId", "i1"]], body: { fields: { q: int(5) } } })).body, name("orders/o1/items/i1"), { q: int(5) });
  assertDocument((await r.call("POST", `${orders}/ghost/items`, { query: [["documentId", "g1"]], body: { fields: { q: int(1) } } })).body, name("orders/ghost/items/g1"), { q: int(1) });

  // mask shapes the answer, not what is stored.
  const masked = await r.call("POST", orders, {
    query: [["documentId", "o2"], ["mask.fieldPaths", "m.a"], ["mask.fieldPaths", "absent"]],
    body: { fields: { m: { mapValue: { fields: { a: int(1), b: int(2) } } }, other: { stringValue: "y" } } },
  });
  assertDocument(masked.body, name("orders/o2"), { m: { mapValue: { fields: { a: int(1) } } } });
  assert.deepEqual(Object.keys(object(object((await r.call("GET", `${orders}/o2`)).body).fields)).sort(), ["m", "other"]);

  // An empty body, no body, server times in the body and unknown query
  // parameters all create the document.
  assertDocument((await r.call("POST", orders, { query: [["documentId", "empty"]], body: {} })).body, name("orders/empty"));
  assertDocument((await r.call("POST", orders, { query: [["documentId", "nobody"]] })).body, name("orders/nobody"));
  const timed = await r.call("POST", orders, { query: [["documentId", "timed"], ["bogus", "1"]], body: { createTime: "2001-01-01T00:00:00Z", updateTime: "2001-01-01T00:00:00Z" } });
  assert.notEqual(assertDocument(timed.body, name("orders/timed")).createTime, "2001-01-01T00:00:00Z");

  // Ids as the official emulator reads them.
  for (const id of ["__id5__", "a b", "ü", "x".repeat(1500)]) {
    assertDocument((await r.call("POST", orders, { query: [["documentId", id]], body: {} })).body, name(`orders/${id}`));
  }
  const refusals: ReadonlyArray<readonly [string, string, string]> = [
    [orders, "bad/id", 'Resource id "bad/id" is invalid because it contains "/".'],
    [orders, "__bad__", 'Resource id "__bad__" is invalid because it is reserved.'],
    [orders, ".", 'Resource id "." is invalid because it is reserved.'],
    [orders, "..", 'Resource id ".." is invalid because it is reserved.'],
    [orders, "x".repeat(1501), "The key path element name is longer than 1500 bytes."],
    [`documents/${r.run}/__c__`, "x", 'Collection id "__c__" is invalid because it is reserved.'],
  ];
  for (const [path, id, message] of refusals) assertError(await r.call("POST", path, { query: [["documentId", id]], body: {} }), 400, "INVALID_ARGUMENT", message);
  assertError(await r.call("POST", orders, { query: [["documentId", "named"]], body: { name: name("orders/other"), fields: {} } }), 400, "INVALID_ARGUMENT", "document.name must not be set");
  // The parent must be a document: `orders/o1` makes `o1` the collection.
  const parent = `${r.root}/${r.run}/orders`;
  assertError(await r.call("POST", `${orders}/o1`, { query: [["documentId", "x"]], body: {} }), 400, "INVALID_ARGUMENT",
    `Document parent name "${parent}" lacks "/" at index ${parent.length}.`);
  for (const raw of ['{"fields":', "[]", '{"fields":{"x":{"integerValue":"nope"}}}', '{"fields":{},"unknownField":1}']) {
    assertError(await r.call("POST", orders, { query: [["documentId", "bad"]], raw }), 400, "INVALID_ARGUMENT", PAYLOAD_INVALID);
  }
  assert.equal((await r.call("GET", `${orders}/bad`)).status, 404);
});

test("get applies mask; list applies pageSize, pageToken, orderBy, mask and showMissing", async (context) => {
  const r = rest(context);
  if (!r) return;
  await seed(r, {
    "orders/a": { n: int(1), s: { stringValue: "x" }, m: { mapValue: { fields: { a: int(1), b: int(2) } } } },
    "orders/b": { n: int(3) },
    "orders/c": { n: int(2) },
    "orders/ghost/items/g1": { q: int(1) },
  });
  const orders = `documents/${r.run}/orders`;
  const name = (id: string): string => `${r.root}/${r.run}/orders/${id}`;

  assertDocument((await r.call("GET", `${orders}/a`, { query: [["mask.fieldPaths", "n"], ["mask.fieldPaths", "m.a"]] })).body, name("a"),
    { n: int(1), m: { mapValue: { fields: { a: int(1) } } } });
  assertError(await r.call("GET", `${orders}/none`), 404, "NOT_FOUND");

  const names = (answer: Answer): unknown[] => array(object(answer.body).documents ?? []).map((document) => object(document).name);
  const first = await r.call("GET", orders, { query: [["pageSize", "2"], ["mask.fieldPaths", "n"]] });
  assert.equal(first.status, 200);
  assert.deepEqual(names(first), [name("a"), name("b")]);
  assert.deepEqual(object(array(object(first.body).documents)[0]).fields, { n: int(1) });
  const token = object(first.body).nextPageToken;
  assert.equal(typeof token, "string");
  const second = await r.call("GET", orders, { query: [["pageSize", "2"], ["pageToken", String(token)]] });
  assert.deepEqual(names(second), [name("c")]);

  assert.deepEqual(names(await r.call("GET", orders, { query: [["orderBy", "n desc"]] })), [name("b"), name("c"), name("a")]);
  assert.deepEqual(names(await r.call("GET", orders, { query: [["orderBy", "n desc, __name__"]] })), [name("b"), name("c"), name("a")]);
  const bare = await r.call("GET", orders, { query: [["mask.fieldPaths", "absent"]] });
  for (const document of array(object(bare.body).documents)) assert.equal("fields" in object(document), false);

  // showMissing lists the document a subcollection hangs from, with its
  // name alone. (The official emulator then also ignores mask, so this
  // listing asks for none.)
  const missing = await r.call("GET", orders, { query: [["showMissing", "true"]] });
  assert.deepEqual(names(missing), [name("a"), name("b"), name("c"), name("ghost")]);
  assert.deepEqual(array(object(missing.body).documents).at(-1), { name: name("ghost") });

  // Unknown query parameters are ignored; a negative page size and a page
  // token this server did not write are refused.
  assert.deepEqual(names(await r.call("GET", orders, { query: [["bogus", "1"], ["key", "demo"]] })), [name("a"), name("b"), name("c")]);
  assertError(await r.call("GET", orders, { query: [["pageSize", "-1"]] }), 400, "INVALID_ARGUMENT", "Page size must be nonnegative.");
  assertError(await r.call("GET", orders, { query: [["pageToken", "garbage"]] }), 400, "INVALID_ARGUMENT");
  assert.deepEqual(names(await r.call("GET", `${orders}/ghost/items`)), [`${name("ghost")}/items/g1`]);
  assert.deepEqual(object((await r.call("GET", `documents/${r.run}/none`)).body), {});

  // Without a collection id (a trailing slash), a listing takes every
  // collection under the parent; the database root itself is no listing.
  await seed(r, { "orders/a/notes/n1": { q: int(2) } });
  assert.deepEqual(names(await r.call("GET", `${orders}/a/`)), [`${name("a")}/notes/n1`]);
  assert.deepEqual(names(await r.call("GET", `${orders}/ghost/`)), [`${name("ghost")}/items/g1`]);
  const everything = await r.call("GET", "documents/");
  assert.equal(everything.status, 200);
  assert.equal(Array.isArray(object(everything.body).documents ?? []), true);
  assert.equal((await r.call("GET", "documents")).status, 404);
});

test("patch applies updateMask, mask and currentDocument; delete applies currentDocument", async (context) => {
  const r = rest(context);
  if (!r) return;
  await seed(r, { "orders/a": { n: int(1), s: { stringValue: "x" }, gone: int(0) }, "orders/b": { n: int(2) } });
  const orders = `documents/${r.run}/orders`;
  const name = (id: string): string => `${r.root}/${r.run}/orders/${id}`;

  const patched = await r.call("PATCH", `${orders}/a`, { query: [["updateMask.fieldPaths", "n"], ["updateMask.fieldPaths", "gone"]], body: { fields: { n: int(10), s: { stringValue: "ignored" } } } });
  assertDocument(patched.body, name("a"), { n: int(10), s: { stringValue: "x" } });
  assertDocument((await r.call("PATCH", `${orders}/a`, { query: [["updateMask.fieldPaths", "n"], ["mask.fieldPaths", "n"]], body: { fields: { n: int(11) } } })).body, name("a"), { n: int(11) });
  assertDocument((await r.call("PATCH", `${orders}/new`, { query: [["mask.fieldPaths", "k"]], body: { fields: { k: int(1), j: int(2) } } })).body, name("new"), { k: int(1) });
  assertDocument((await r.call("PATCH", `${orders}/nobody`)).body, name("nobody"));

  assertError(await r.call("PATCH", `${orders}/a`, { query: [["currentDocument.exists", "false"]], body: { fields: {} } }), 409, "ALREADY_EXISTS");
  assertError(await r.call("PATCH", `${orders}/none`, { query: [["currentDocument.exists", "true"]], body: { fields: {} } }), 404, "NOT_FOUND");
  assertError(await r.call("PATCH", `${orders}/a`, { query: [["currentDocument.updateTime", "2001-01-01T00:00:00Z"]], body: { fields: {} } }), 400, "FAILED_PRECONDITION");
  const current = String(object((await r.call("GET", `${orders}/b`)).body).updateTime);
  const right = await r.call("PATCH", `${orders}/b`, { query: [["currentDocument.updateTime", current]], body: { fields: { n: int(20) } } });
  if (r.configuration.name === "java") {
    // The official REST adapter reads a query-string updateTime as version 0,
    // so even the document's own update time fails; production and Firenook
    // compare it.
    assertError(right, 400, "FAILED_PRECONDITION", /does not match the required base version \(0\)/u);
  } else {
    assertDocument(right.body, name("b"), { n: int(20) });
  }

  assert.deepEqual((await r.call("DELETE", `${orders}/b`, { query: [["currentDocument.exists", "true"]] })).body, {});
  assertError(await r.call("DELETE", `${orders}/b`, { query: [["currentDocument.exists", "true"]] }), 404, "NOT_FOUND");
  const absent = await r.call("DELETE", `${orders}/b`);
  assert.deepEqual([absent.status, absent.body], [200, {}]);
  assert.deepEqual((await r.call("DELETE", `${orders}/b`, { query: [["currentDocument.exists", "false"]] })).body, {});
  assertError(await r.call("DELETE", `${orders}/a`, { query: [["currentDocument.exists", "false"]] }), 409, "ALREADY_EXISTS");
  assertError(await r.call("DELETE", `${orders}/a`, { query: [["currentDocument.updateTime", "2001-01-01T00:00:00Z"]] }), 400, "FAILED_PRECONDITION");
  assert.equal((await r.call("GET", `${orders}/a`)).status, 200);
});

test("batchGet, beginTransaction, commit and rollback, with ended transactions", async (context) => {
  const r = rest(context);
  if (!r) return;
  await seed(r, { "orders/a": { n: int(1) } });
  const a = `${r.root}/${r.run}/orders/a`;
  const none = `${r.root}/${r.run}/orders/none`;

  const batch = await r.call("POST", "documents:batchGet", { body: { documents: [a, none], mask: { fieldPaths: ["n"] } } });
  assert.equal(batch.status, 200);
  const [found, missing] = array(batch.body).map(object);
  assert.deepEqual(Object.keys(found ?? {}).sort(), ["found", "readTime"]);
  assertDocument(found?.found, a, { n: int(1) });
  assert.deepEqual(Object.keys(missing ?? {}).sort(), ["missing", "readTime"]);
  assert.equal(missing?.missing, none);
  const opened = array((await r.call("POST", "documents:batchGet", { body: { documents: [a], newTransaction: { readOnly: {} } } })).body).map(object);
  assert.deepEqual(Object.keys(opened[0] ?? {}), ["transaction"]);
  assert.equal(opened[1]?.found !== undefined, true);
  assert.deepEqual((await r.call("POST", "documents:batchGet")).body, []);

  // A body is optional where every field is.
  const begun = await r.call("POST", "documents:beginTransaction");
  assert.equal(begun.status, 200);
  assert.deepEqual(Object.keys(object(begun.body)), ["transaction"]);

  const transaction = await begin(r);
  const committed = await r.call("POST", "documents:commit", { body: { transaction, writes: [{ update: { name: `${r.root}/${r.run}/orders/t1`, fields: { n: int(1) } } }] } });
  assert.equal(committed.status, 200);
  assert.deepEqual(Object.keys(object(committed.body)).sort(), ["commitTime", "writeResults"]);
  assertError(await r.call("POST", "documents:commit", { body: { transaction, writes: [] } }), 409, "ABORTED", TRANSACTION_ENDED);
  assertError(await r.call("POST", "documents:batchGet", { body: { documents: [a], transaction } }), 409, "ABORTED", TRANSACTION_ENDED);

  const rolled = await begin(r);
  assert.deepEqual((await r.call("POST", "documents:rollback", { body: { transaction: rolled } })).body, {});
  const again = await r.call("POST", "documents:rollback", { body: { transaction: rolled } });
  assert.deepEqual([again.status, again.body], [200, {}]);
  assertError(await r.call("POST", "documents:commit", { body: { transaction: rolled } }), 409, "ABORTED", TRANSACTION_ENDED);
  assertError(await r.call("POST", "documents:rollback", { body: {} }), 400, "INVALID_ARGUMENT", "Invalid transaction.");
  assertError(await r.call("POST", "documents:rollback"), 400, "INVALID_ARGUMENT", "Invalid transaction.");
  assertError(await r.call("POST", "documents:commit", { body: { transaction: "AAAAAAAAAAAA" } }), 400, "INVALID_ARGUMENT", "Invalid transaction.");

  // A commit without writes answers with nothing.
  for (const body of [{}, { writes: [] }, undefined]) {
    const empty = await r.call("POST", "documents:commit", body === undefined ? {} : { body });
    assert.deepEqual([empty.status, empty.body], [200, {}]);
  }
  const transformed = await r.call("POST", "documents:commit", {
    body: { writes: [{ transform: { document: `${r.root}/${r.run}/orders/tr`, fieldTransforms: [{ fieldPath: "k", increment: int(2) }] } }] },
  });
  assert.deepEqual(object(array(object(transformed.body).writeResults)[0]).transformResults, [int(2)]);
  for (const method of ["documents:commit", "documents:runQuery", "documents:batchGet", "documents:beginTransaction"]) {
    assertError(await r.call("POST", method, { raw: '{"writes":' }), 400, "INVALID_ARGUMENT", PAYLOAD_INVALID);
  }
});

test("runQuery and runAggregationQuery at the root and on a parent, with transactions and readTime", async (context) => {
  const r = rest(context);
  if (!r) return;
  await seed(r, { "orders/a": { n: int(1) }, "orders/b": { n: int(2) }, "orders/c": { n: int(3) }, "orders/a/items/i1": { q: int(1) } });
  const name = (path: string): string => `${r.root}/${r.run}/${path}`;
  const parent = `documents/${r.run}`;
  const orders = { from: [{ collectionId: "orders" }] };
  const atLeast = (value: number): JsonObject => ({ fieldFilter: { field: { fieldPath: "n" }, op: "GREATER_THAN_OR_EQUAL", value: int(value) } });
  const documents = (items: JsonObject[]): unknown[] => items.flatMap((item) => (item.document === undefined ? [] : [object(item.document).name]));

  const queried = stream(r, await r.call("POST", `${parent}:runQuery`, { body: { structuredQuery: { ...orders, where: atLeast(2), orderBy: [{ field: { fieldPath: "n" }, direction: "DESCENDING" }] } } }));
  assert.deepEqual(documents(queried), [name("orders/c"), name("orders/b")]);
  for (const item of queried) assert.deepEqual(Object.keys(item).sort(), ["document", "readTime"]);
  assert.deepEqual(documents(stream(r, await r.call("POST", `${parent}/orders/a:runQuery`, { body: { structuredQuery: { from: [{ collectionId: "items" }] } } }))), [name("orders/a/items/i1")]);
  const empty = stream(r, await r.call("POST", `${parent}:runQuery`, { body: { structuredQuery: { from: [{ collectionId: "none" }] } } }));
  assert.deepEqual(empty.map((item) => Object.keys(item)), [["readTime"]]);

  // newTransaction: the transaction comes first, on its own.
  const opened = stream(r, await r.call("POST", `${parent}:runQuery`, { body: { structuredQuery: orders, newTransaction: { readOnly: {} } } }));
  assert.deepEqual(Object.keys(opened[0] ?? {}), ["transaction"]);
  assert.deepEqual(documents(opened), [name("orders/a"), name("orders/b"), name("orders/c")]);
  const openedEmpty = stream(r, await r.call("POST", `${parent}:runQuery`, { body: { structuredQuery: { from: [{ collectionId: "none" }] }, newTransaction: {} } }));
  assert.deepEqual(openedEmpty.map((item) => Object.keys(item)), [["transaction"], ["readTime"]]);

  // readTime and a transaction read the documents as they were.
  const before = String(object((await r.call("GET", `${parent}/orders/b`)).body).updateTime);
  const transaction = await begin(r, { readOnly: {} });
  await seed(r, { "orders/b": { n: int(20) } });
  const historical = { structuredQuery: { ...orders, where: { fieldFilter: { field: { fieldPath: "n" }, op: "EQUAL", value: int(2) } } } };
  assert.deepEqual(documents(stream(r, await r.call("POST", `${parent}:runQuery`, { body: { ...historical, readTime: before } }))), [name("orders/b")]);
  assert.deepEqual(documents(stream(r, await r.call("POST", `${parent}:runQuery`, { body: { ...historical, transaction } }))), [name("orders/b")]);
  assert.deepEqual(documents(stream(r, await r.call("POST", `${parent}:runQuery`, { body: historical }))), []);

  const count = (query: JsonObject, extra: JsonObject = {}): JsonObject => ({
    structuredAggregationQuery: { structuredQuery: query, aggregations: [{ alias: "c", count: {} }] }, ...extra,
  });
  const result = (items: JsonObject[]): Json => object(items.find((item) => item.result !== undefined)?.result).aggregateFields ?? null;
  const totals = stream(r, await r.call("POST", `${parent}:runAggregationQuery`, {
    body: { structuredAggregationQuery: { structuredQuery: orders, aggregations: [{ alias: "c", count: {} }, { alias: "s", sum: { field: { fieldPath: "n" } } }, { alias: "v", avg: { field: { fieldPath: "n" } } }] } },
  }));
  assert.deepEqual(result(totals), { c: int(3), s: int(24), v: { doubleValue: 8 } });
  assert.deepEqual(Object.keys(totals[0] ?? {}).sort(), ["readTime", "result"]);
  assert.deepEqual(result(stream(r, await r.call("POST", `${parent}/orders/a:runAggregationQuery`, { body: count({ from: [{ collectionId: "items" }] }) }))), { c: int(1) });
  assert.deepEqual(result(stream(r, await r.call("POST", `${parent}:runAggregationQuery`, { body: count(historical.structuredQuery, { readTime: before }) }))), { c: int(1) });
  assert.deepEqual(result(stream(r, await r.call("POST", `${parent}:runAggregationQuery`, { body: count(historical.structuredQuery, { transaction }) }))), { c: int(1) });
  const counted = stream(r, await r.call("POST", `${parent}:runAggregationQuery`, { body: count(orders, { newTransaction: { readOnly: {} } }) }));
  assert.deepEqual(Object.keys(counted[0] ?? {}), ["transaction"]);
  assert.deepEqual(result(counted), { c: int(3) });

  // An ended transaction, a collection as the parent, and no query.
  assert.deepEqual((await r.call("POST", "documents:rollback", { body: { transaction } })).body, {});
  assertError(await r.call("POST", `${parent}:runQuery`, { body: { ...historical, transaction } }), 409, "ABORTED", TRANSACTION_ENDED);
  const collection = `${r.root}/${r.run}/orders`;
  assertError(await r.call("POST", `${parent}/orders:runQuery`, { body: { structuredQuery: { from: [{ collectionId: "items" }] } } }), 400, "INVALID_ARGUMENT",
    `Document parent name "${collection}" lacks "/" at index ${collection.length}.`);
  assertError(await r.call("POST", `${parent}:runQuery`, { body: {} }), 400, "INVALID_ARGUMENT");
});

test("partitionQuery, listCollectionIds and batchWrite", async (context) => {
  const r = rest(context);
  if (!r) return;
  await seed(r, { "orders/a": { n: int(1) }, "orders/a/items/i1": { q: int(1) }, "orders/a/notes/n1": { q: int(1) } });
  const parent = `documents/${r.run}`;
  const name = (path: string): string => `${r.root}/${r.run}/${path}`;

  // The official emulator does not implement PartitionQuery (gRPC code 12);
  // Firenook answers it on gRPC and REST alike, as production does, and
  // refuses a document parent, which production does not support.
  const partition = { structuredQuery: { from: [{ collectionId: "orders", allDescendants: true }], orderBy: [{ field: { fieldPath: "__name__" } }] }, partitionCount: "2" };
  const atRoot = await r.call("POST", "documents:partitionQuery", { body: partition });
  const underDocument = await r.call("POST", `${parent}/orders/a:partitionQuery`, { body: partition });
  if (r.configuration.name === "java") {
    for (const answer of [atRoot, underDocument]) assertError(answer, 501, "UNIMPLEMENTED", "Method google.firestore.v1.Firestore/PartitionQuery is unimplemented");
  } else {
    assert.equal(atRoot.status, 200, JSON.stringify(atRoot.body));
    for (const cursor of array(object(atRoot.body).partitions ?? [])) assert.equal(typeof object(array(object(cursor).values)[0]).referenceValue, "string");
    assertError(underDocument, 400, "INVALID_ARGUMENT");
  }
  assertError(await r.call("POST", "documents:partitionQuery", { body: partition, authorization: null }), r.configuration.name === "java" ? 501 : 403,
    r.configuration.name === "java" ? "UNIMPLEMENTED" : "PERMISSION_DENIED");

  const ids = await r.call("POST", `${parent}/orders/a:listCollectionIds`, { body: {} });
  assert.deepEqual(ids.body, { collectionIds: ["items", "notes"] });
  const page = object((await r.call("POST", `${parent}/orders/a:listCollectionIds`, { body: { pageSize: 1 } })).body);
  assert.deepEqual(page.collectionIds, ["items"]);
  assert.equal(typeof page.nextPageToken, "string");
  assert.deepEqual(object((await r.call("POST", `${parent}/orders/a:listCollectionIds`, { body: { pageSize: 1, pageToken: String(page.nextPageToken) } })).body).collectionIds, ["notes"]);
  assert.deepEqual(object((await r.call("POST", `${parent}/orders/a:listCollectionIds`)).body).collectionIds, ["items", "notes"]);
  assertError(await r.call("POST", "documents:listCollectionIds", { body: {}, authorization: null }), 403, "PERMISSION_DENIED", "Metadata operations require admin authentication.");

  const written = await r.call("POST", "documents:batchWrite", {
    body: {
      writes: [
        { update: { name: name("orders/w1"), fields: { n: int(1) } }, updateTransforms: [{ fieldPath: "k", increment: int(1) }] },
        { delete: name("orders/w0") },
        { update: { name: name("orders/w2"), fields: { n: int(2) } }, currentDocument: { exists: true } },
        { update: { name: name("orders/a"), fields: { n: int(1) } }, currentDocument: { exists: false } },
      ],
      labels: { origin: "conformance" },
    },
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const results = array(object(written.body).writeResults).map(object);
  assert.deepEqual(results.map((item) => Object.keys(item).sort()), [["transformResults", "updateTime"], [], [], []]);
  assert.deepEqual(results[0]?.transformResults, [int(1)]);
  const statuses = array(object(written.body).status).map(object);
  assert.deepEqual(statuses.map((item) => item.code ?? 0), [0, 0, 5, 6]);
  assert.deepEqual(statuses.slice(0, 2), [{}, {}]);
  for (const failed of statuses.slice(2)) assert.equal(typeof failed.message, "string");
  assert.equal((await r.call("GET", `${parent}/orders/w2`)).status, 404);
  assert.deepEqual((await r.call("POST", "documents:batchWrite", { body: {} })).body, {});
  assertError(await r.call("POST", "documents:batchWrite", { body: { writes: [{ update: { name: name("orders/d"), fields: {} } }, { delete: name("orders/d") }] } }), 400, "INVALID_ARGUMENT",
    "the same document cannot be written more than once in a single request");
  assertError(await r.call("POST", "documents:batchWrite", { body: { writes: [] }, authorization: null }), 403, "PERMISSION_DENIED", "Batch writes require admin authentication.");
});

test("the `:` routes under documents answer as the official emulator's do", async (context) => {
  const r = rest(context);
  if (!r) return;
  // The streaming RPCs have no REST form.
  for (const method of ["write", "listen", "frobnicate"]) assert.equal((await r.call("POST", `documents:${method}`, { body: {} })).status, 404);
  // A colon inside a document path is a collection id there: createDocument
  // under a collection, which is refused.
  const parent = `${r.root}/${r.run}/orders`;
  assertError(await r.call("POST", `documents/${r.run}/orders/a:frobnicate`, { body: {} }), 400, "INVALID_ARGUMENT", `Document parent name "${parent}" lacks "/" at index ${parent.length}.`);
  // ExecutePipeline on a Standard edition database: production says
  // FAILED_PRECONDITION; the official emulator says INVALID_ARGUMENT.
  assertError(await r.call("POST", "documents:executePipeline", { body: {} }), 400, r.configuration.name === "java" ? "INVALID_ARGUMENT" : "FAILED_PRECONDITION");
});
