import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { GoogleAuth } from "google-auth-library";

import { resolveTarget } from "../src/target.ts";

interface RestDocument {
  readonly fields?: Readonly<Record<string, RestValue>>;
  readonly name?: string;
}

interface RestError {
  readonly error?: {
    readonly code?: number;
    readonly status?: string;
  };
}

interface RestValue {
  readonly arrayValue?: { readonly values?: readonly RestValue[] };
  readonly doubleValue?: number;
  readonly integerValue?: string;
  readonly nullValue?: null;
  readonly stringValue?: string;
  readonly timestampValue?: string;
}

interface RestWriteResult {
  readonly transformResults?: readonly RestValue[];
  readonly updateTime?: string;
}

interface RestBatchGetResponse {
  readonly found?: RestDocument;
  readonly missing?: string;
}

interface RestCommitResponse {
  readonly commitTime?: string;
  readonly writeResults?: readonly RestWriteResult[];
}

interface RestRunQueryResponse {
  readonly document?: RestDocument;
  readonly readTime?: string;
}

test("REST v1 patches, reads, deletes, and reports missing documents", async () => {
  const configuration = resolveTarget(process.env);
  const runId = randomUUID();
  const documentPath = `runs/${runId}/firenook_conformance/rest`;
  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const resource = `${baseUrl}/v1/projects/${configuration.projectId}/databases/(default)/documents/${documentPath}`;
  const headers = await authorizationHeaders(configuration.host === undefined);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();

  const patched = await fetch(resource, {
    method: "PATCH",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        _fireside_expires_at: { timestampValue: expiresAt },
        count: { integerValue: "7" },
        source: { stringValue: "rest-v1" },
      },
    }),
  });
  assert.equal(patched.status, 200);
  const patchedDocument = await json<RestDocument>(patched);
  assert.equal(patchedDocument.name?.endsWith(`/${documentPath}`), true);
  assert.equal(patchedDocument.fields?.source?.stringValue, "rest-v1");
  assert.equal(patchedDocument.fields?.count?.integerValue, "7");

  const fetched = await fetch(resource, { headers });
  assert.equal(fetched.status, 200);
  const fetchedDocument = await json<RestDocument>(fetched);
  assert.equal(fetchedDocument.fields?.source?.stringValue, "rest-v1");
  assert.equal(fetchedDocument.fields?.count?.integerValue, "7");

  const deleted = await fetch(resource, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);

  const missing = await fetch(resource, { headers });
  assert.equal(missing.status, 404);
  const missingError = await json<RestError>(missing);
  assert.equal(missingError.error?.code, 404);
  assert.equal(missingError.error?.status, "NOT_FOUND");
});

test("REST v1 commit, batchGet, and runQuery share document semantics", async () => {
  const configuration = resolveTarget(process.env);
  const runId = randomUUID();
  const databaseRoot = `projects/${configuration.projectId}/databases/(default)`;
  const documentPath = `runs/${runId}/firenook_conformance/rest-rpc`;
  const documentName = `${databaseRoot}/documents/${documentPath}`;
  const missingName = `${databaseRoot}/documents/runs/${runId}/firenook_conformance/missing`;
  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const documentsUrl = `${baseUrl}/v1/${databaseRoot}/documents`;
  const headers = {
    ...await authorizationHeaders(configuration.host === undefined),
    "content-type": "application/json",
  };

  const committed = await fetch(`${documentsUrl}:commit`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: documentName,
            fields: {
              rank: { integerValue: "1" },
              source: { stringValue: "rest-rpc" },
            },
          },
        },
      ],
    }),
  });
  assert.equal(committed.status, 200);
  const commit = await json<RestCommitResponse>(committed);
  assert.equal(commit.writeResults?.length, 1);
  assert.equal(typeof commit.commitTime, "string");

  const batch = await fetch(`${documentsUrl}:batchGet`, {
    method: "POST",
    headers,
    body: JSON.stringify({ documents: [documentName, missingName] }),
  });
  assert.equal(batch.status, 200);
  const batchResponses = await json<readonly RestBatchGetResponse[]>(batch);
  assert.equal(batchResponses.length, 2);
  assert.equal(
    batchResponses.some((response) => response.found?.name === documentName),
    true,
  );
  assert.equal(
    batchResponses.some((response) => response.missing === missingName),
    true,
  );

  const queried = await fetch(`${documentsUrl}/runs/${runId}:runQuery`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "firenook_conformance" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "source" },
            op: "EQUAL",
            value: { stringValue: "rest-rpc" },
          },
        },
      },
    }),
  });
  assert.equal(queried.status, 200);
  const queryResponses = await json<readonly RestRunQueryResponse[]>(queried);
  assert.deepEqual(
    queryResponses
      .flatMap((response) => response.document?.name ?? [])
      .filter((name) => name === documentName),
    [documentName],
  );
  assert.equal(
    queryResponses.every((response) => typeof response.readTime === "string"),
    true,
  );

  const deleted = await fetch(`${documentsUrl}/${documentPath}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleted.status, 200);
});

test("REST v1 runQuery honors select projections and count aggregations", async () => {
  const configuration = resolveTarget(process.env);
  const runId = randomUUID();
  const databaseRoot = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const documentsUrl = `${baseUrl}/v1/${databaseRoot}/documents`;
  const headers = {
    ...await authorizationHeaders(configuration.host === undefined),
    "content-type": "application/json",
  };
  const names = ["a", "b", "c"].map((id) =>
    `${databaseRoot}/documents/${parentPath}/firenook_conformance/${id}`
  );

  const committed = await fetch(`${documentsUrl}:commit`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      writes: names.map((name, index) => ({
        update: {
          name,
          fields: {
            rank: { integerValue: String(index) },
            label: { stringValue: `label ${index}` },
            even: { booleanValue: index % 2 === 0 },
          },
        },
      })),
    }),
  });
  assert.equal(committed.status, 200);

  try {
    // `select` limits the returned fields; selecting only `__name__` returns
    // the document identity without any field.
    const selected = await fetch(`${documentsUrl}/${parentPath}:runQuery`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "firenook_conformance" }],
          select: { fields: [{ fieldPath: "label" }] },
          orderBy: [{ field: { fieldPath: "__name__" } }],
        },
      }),
    });
    assert.equal(selected.status, 200);
    const selectedResponses = await json<readonly RestRunQueryResponse[]>(selected);
    assert.deepEqual(
      selectedResponses.map((response) => response.document?.name),
      names,
    );
    assert.deepEqual(
      selectedResponses.map((response) => Object.keys(response.document?.fields ?? {})),
      [["label"], ["label"], ["label"]],
    );
    assert.equal(selectedResponses[0]?.document?.fields?.label?.stringValue, "label 0");

    const nameOnly = await fetch(`${documentsUrl}/${parentPath}:runQuery`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "firenook_conformance" }],
          select: { fields: [{ fieldPath: "__name__" }] },
          limit: 1,
        },
      }),
    });
    assert.equal(nameOnly.status, 200);
    const nameOnlyResponses = await json<readonly RestRunQueryResponse[]>(nameOnly);
    assert.equal(nameOnlyResponses.length, 1);
    assert.equal(nameOnlyResponses[0]?.document?.name, names[0]);
    assert.deepEqual(Object.keys(nameOnlyResponses[0]?.document?.fields ?? {}), []);

    // A count without filters, with a filter, and bounded with `upTo`.
    const count = async (structuredQuery: unknown, aggregation: unknown) => {
      const response = await fetch(`${documentsUrl}/${parentPath}:runAggregationQuery`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          structuredAggregationQuery: {
            structuredQuery,
            aggregations: [{ ...(aggregation as object), alias: "n" }],
          },
        }),
      });
      assert.equal(response.status, 200);
      const [first] = await json<readonly { result?: { aggregateFields?: Record<string, RestValue> } }[]>(response);
      return first?.result?.aggregateFields?.n?.integerValue;
    };
    assert.equal(await count({ from: [{ collectionId: "firenook_conformance" }] }, { count: {} }), "3");
    assert.equal(
      await count(
        {
          from: [{ collectionId: "firenook_conformance" }],
          where: {
            fieldFilter: { field: { fieldPath: "even" }, op: "EQUAL", value: { booleanValue: true } },
          },
        },
        { count: {} },
      ),
      "2",
    );
    assert.equal(
      await count({ from: [{ collectionId: "firenook_conformance" }] }, { count: { upTo: "2" } }),
      "2",
    );
    assert.equal(
      await count({ from: [{ collectionId: "firenook_conformance" }], offset: 1 }, { count: {} }),
      "2",
    );
    assert.equal(
      await count({ from: [{ collectionId: "firenook_conformance" }], limit: 1 }, { count: {} }),
      "1",
    );
  } finally {
    await Promise.all(
      names.map((name) => fetch(`${baseUrl}/v1/${name}`, { method: "DELETE", headers })),
    );
  }
});

test("REST v1 commit applies update and document transforms", async () => {
  const configuration = resolveTarget(process.env);
  const runId = randomUUID();
  const databaseRoot = `projects/${configuration.projectId}/databases/(default)`;
  const collectionPath = `runs/${runId}/firenook_conformance`;
  const updateName = `${databaseRoot}/documents/${collectionPath}/update-transforms`;
  const transformName = `${databaseRoot}/documents/${collectionPath}/document-transform`;
  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const documentsUrl = `${baseUrl}/v1/${databaseRoot}/documents`;
  const headers = {
    ...await authorizationHeaders(configuration.host === undefined),
    "content-type": "application/json",
  };
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();

  const seeded = await fetch(`${baseUrl}/v1/${transformName}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      fields: {
        _fireside_expires_at: { timestampValue: expiresAt },
        bound: { stringValue: "replace me" },
        count: { integerValue: "10" },
        tags: {
          arrayValue: {
            values: [{ stringValue: "a" }, { stringValue: "b" }],
          },
        },
      },
    }),
  });
  assert.equal(seeded.status, 200);

  try {
    const committed = await fetch(`${documentsUrl}:commit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: updateName,
              fields: {
                _fireside_expires_at: { timestampValue: expiresAt },
                count: { integerValue: "1" },
                maximum: { integerValue: "2" },
                minimum: { doubleValue: 5 },
                tags: {
                  arrayValue: { values: [{ stringValue: "a" }] },
                },
              },
            },
            updateTransforms: [
              { fieldPath: "count", increment: { integerValue: "2" } },
              { fieldPath: "maximum", maximum: { doubleValue: 4.5 } },
              { fieldPath: "minimum", minimum: { integerValue: "4" } },
              { fieldPath: "touched", setToServerValue: "REQUEST_TIME" },
              {
                fieldPath: "tags",
                appendMissingElements: {
                  values: [{ stringValue: "b" }],
                },
              },
            ],
          },
          {
            transform: {
              document: transformName,
              fieldTransforms: [
                { fieldPath: "count", increment: { integerValue: "2" } },
                {
                  fieldPath: "tags",
                  removeAllFromArray: {
                    values: [{ stringValue: "a" }],
                  },
                },
                { fieldPath: "bound", maximum: { integerValue: "7" } },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(committed.status, 200);
    const commit = await json<RestCommitResponse>(committed);
    assert.equal(commit.writeResults?.length, 2);
    assert.deepEqual(
      commit.writeResults?.map((result) =>
        result.transformResults?.map(restValueKind)
      ),
      [
        ["integer:3", "double:4.5", "integer:4", "timestamp", "null"],
        ["integer:12", "null", "integer:7"],
      ],
    );

    const [updatedResponse, transformedResponse] = await Promise.all([
      fetch(`${baseUrl}/v1/${updateName}`, { headers }),
      fetch(`${baseUrl}/v1/${transformName}`, { headers }),
    ]);
    assert.equal(updatedResponse.status, 200);
    assert.equal(transformedResponse.status, 200);
    const updated = await json<RestDocument>(updatedResponse);
    const transformed = await json<RestDocument>(transformedResponse);
    assert.deepEqual(
      [
        updated.fields?.count,
        updated.fields?.maximum,
        updated.fields?.minimum,
        updated.fields?.touched,
      ].map(restValueKind),
      ["integer:3", "double:4.5", "integer:4", "timestamp"],
    );
    assert.deepEqual(
      updated.fields?.tags?.arrayValue?.values?.map(restValueKind),
      ["string:a", "string:b"],
    );
    assert.deepEqual(
      [transformed.fields?.count, transformed.fields?.bound].map(restValueKind),
      ["integer:12", "integer:7"],
    );
    assert.deepEqual(
      transformed.fields?.tags?.arrayValue?.values?.map(restValueKind),
      ["string:b"],
    );
  } finally {
    await Promise.all(
      [updateName, transformName].map(async (name) => {
        await fetch(`${baseUrl}/v1/${name}`, { method: "DELETE", headers });
      }),
    );
  }
});

test("REST v1 preserves the production missing-index status", async () => {
  const configuration = resolveTarget(process.env);
  const runId = randomUUID();
  const databaseRoot = `projects/${configuration.projectId}/databases/(default)`;
  const collectionPath = `runs/${runId}/firenook_conformance`;
  const documentNames = ["first", "second"].map(
    (id) => `${databaseRoot}/documents/${collectionPath}/${id}`,
  );
  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const documentsUrl = `${baseUrl}/v1/${databaseRoot}/documents`;
  const headers = {
    ...await authorizationHeaders(configuration.host === undefined),
    "content-type": "application/json",
  };

  const committed = await fetch(`${documentsUrl}:commit`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      writes: documentNames.map((name, index) => ({
        update: {
          name,
          fields: {
            strictGroup: { stringValue: "x" },
            strictScore: { integerValue: String(index + 1) },
          },
        },
      })),
    }),
  });
  assert.equal(committed.status, 200);

  try {
    const queried = await fetch(
      `${documentsUrl}/runs/${runId}:runQuery`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "firenook_conformance" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "strictGroup" },
                op: "EQUAL",
                value: { stringValue: "x" },
              },
            },
            orderBy: [
              {
                field: { fieldPath: "strictScore" },
                direction: "ASCENDING",
              },
            ],
          },
        }),
      },
    );

    if (configuration.name === "cloud") {
      assert.equal(queried.status, 400);
      const errors = await json<readonly RestError[]>(queried);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.error?.code, 400);
      assert.equal(errors[0]?.error?.status, "FAILED_PRECONDITION");
    } else {
      assert.equal(queried.status, 200);
      const responses = await json<readonly RestRunQueryResponse[]>(queried);
      assert.deepEqual(
        responses.flatMap((response) => response.document?.name ?? []),
        documentNames,
      );
    }
  } finally {
    await Promise.all(
      documentNames.map(async (name) => {
        const resource = `${baseUrl}/v1/${name}`;
        await fetch(resource, { method: "DELETE", headers });
      }),
    );
  }
});

async function authorizationHeaders(
  cloud: boolean,
): Promise<Record<string, string>> {
  if (!cloud) {
    return { authorization: "Bearer owner" };
  }
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders();
  return Object.fromEntries(headers.entries());
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function restValueKind(value: RestValue | undefined): string {
  if (value?.integerValue !== undefined) {
    return `integer:${value.integerValue}`;
  }
  if (value?.doubleValue !== undefined) {
    return `double:${String(value.doubleValue)}`;
  }
  if (value?.stringValue !== undefined) {
    return `string:${value.stringValue}`;
  }
  if (value?.timestampValue !== undefined) {
    return "timestamp";
  }
  if ("nullValue" in (value ?? {})) {
    return "null";
  }
  return "other";
}
