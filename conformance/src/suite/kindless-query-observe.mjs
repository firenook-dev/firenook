// What one Firestore endpoint answers to kindless queries: an all-descendants
// selector with no collection id, the shape the Admin SDK's recursiveDelete
// sends. The capture records this against the official emulator; the replay
// test runs the same observations against the native engine and compares.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { Firestore, v1 } = require('@google-cloud/firestore');
const { credentials } = require('@grpc/grpc-js');

export const project = 'demo-firenook-kindless';
const root = `projects/${project}/databases/(default)/documents`;
const owner = { otherArgs: { headers: { authorization: 'Bearer owner' } } };
const selector = { allDescendants: true };
const NAME = { fieldPath: '__name__' };
const MIN_ID = '__id-9223372036854775808__';

const seedPaths = [
  'rd/A', 'rd/a', 'rd/__id5__', 'rd/a/sub/x', 'rd/a/sub/x/deep/y', 'rd/ghost/sub/z',
  'rd-sibling/a', 'rd0/a', 'rc/a', 'top/parent', 'top/parent/c1/one', 'top/parent/c1/one/c2/two',
  'top/parent/c3/three', 'top/other/c1/four',
];
const reference = (path) => ({ referenceValue: `${root}/${path}` });
const nameFilter = (op, value) => ({ fieldFilter: { field: NAME, op, value } });
// The range the SDK sends for a collection: every name from the lowest id in
// `collection` up to the lowest id of the next possible collection.
const sdkRange = (collection) => ({
  compositeFilter: {
    op: 'AND',
    filters: [
      nameFilter('GREATER_THAN_OR_EQUAL', reference(`${collection}/${MIN_ID}`)),
      nameFilter('LESS_THAN', reference(`${collection}\u0000/${MIN_ID}`)),
    ],
  },
});
const ascending = [{ field: NAME, direction: 'ASCENDING' }];
const namesOnly = { fields: [NAME] };

export const queryCases = [
  ['root-all', '', { from: [selector] }],
  ['root-explicit-empty-id', '', { from: [{ collectionId: '', allDescendants: true }] }],
  ['under-document', 'top/parent', { from: [selector] }],
  ['under-missing-document', 'rd/ghost', { from: [selector] }],
  ['under-nothing', 'nope/nope', { from: [selector] }],
  ['sdk-range-root', '', { from: [selector], select: namesOnly, where: sdkRange('rd'), orderBy: ascending, limit: { value: 5000 } }],
  ['sdk-range-sub', 'top/parent', { from: [selector], select: namesOnly, where: sdkRange('top/parent/c1'), orderBy: ascending, limit: { value: 5000 } }],
  ['sdk-range-small-limit', '', { from: [selector], select: namesOnly, where: sdkRange('top'), orderBy: ascending, limit: { value: 2 } }],
  ['limit', '', { from: [selector], limit: { value: 3 } }],
  ['limit-zero', '', { from: [selector], limit: { value: 0 } }],
  ['offset', '', { from: [selector], offset: 2, limit: { value: 2 } }],
  ['start-after', '', { from: [selector], orderBy: ascending, startAt: { values: [reference('rd/a/sub/x')], before: false }, limit: { value: 2 } }],
  ['start-at', '', { from: [selector], orderBy: ascending, startAt: { values: [reference('rd/a/sub/x')], before: true }, limit: { value: 2 } }],
  ['end-before', '', { from: [selector], orderBy: ascending, endAt: { values: [reference('rd/A')], before: true } }],
  ['end-at', '', { from: [selector], orderBy: ascending, endAt: { values: [reference('rd/A')], before: false } }],
  ['name-equal', '', { from: [selector], where: nameFilter('EQUAL', reference('rd/a/sub/x')) }],
  ['name-equal-outside-parent', 'top/parent', { from: [selector], where: nameFilter('EQUAL', reference('rd/a')) }],
  ['name-in', '', { from: [selector], where: { fieldFilter: { field: NAME, op: 'IN', value: { arrayValue: { values: [reference('rd/a'), reference('top/parent')] } } } } }],
  ['name-not-equal', '', { from: [selector], where: nameFilter('NOT_EQUAL', reference('rd/a')), limit: { value: 2 } }],
  ['name-not-in', '', { from: [selector], where: { fieldFilter: { field: NAME, op: 'NOT_IN', value: { arrayValue: { values: [reference('rc/a')] } } } }, limit: { value: 2 } }],
  ['name-or', '', { from: [selector], where: { compositeFilter: { op: 'OR', filters: [nameFilter('EQUAL', reference('rc/a')), nameFilter('EQUAL', reference('rd0/a'))] } } }],
  ['name-greater-than', '', { from: [selector], where: nameFilter('GREATER_THAN', reference('top/parent/c1/one')) }],
  ['name-not-a-reference', '', { from: [selector], where: nameFilter('GREATER_THAN', { stringValue: 'rd' }) }],
  ['name-descending', '', { from: [selector], orderBy: [{ field: NAME, direction: 'DESCENDING' }], limit: { value: 3 } }],
  ['field-equal', '', { from: [selector], where: { fieldFilter: { field: { fieldPath: 'n' }, op: 'EQUAL', value: { integerValue: '1' } } } }],
  ['field-inequality', '', { from: [selector], where: { fieldFilter: { field: { fieldPath: 'n' }, op: 'GREATER_THAN', value: { integerValue: '12' } } } }],
  ['field-unary', '', { from: [selector], where: { unaryFilter: { field: { fieldPath: 'missing' }, op: 'IS_NULL' } } }],
  ['field-order', '', { from: [selector], orderBy: [{ field: { fieldPath: 'n' }, direction: 'ASCENDING' }], limit: { value: 2 } }],
  ['field-in-composite', '', { from: [selector], where: { compositeFilter: { op: 'AND', filters: [nameFilter('GREATER_THAN', reference('rd/a')), { fieldFilter: { field: { fieldPath: 'n' }, op: 'EQUAL', value: { integerValue: '1' } } }] } } }],
  ['select-field', '', { from: [selector], select: { fields: [{ fieldPath: 'n' }] }, limit: { value: 1 } }],
  ['nearest', '', { from: [selector], findNearest: { vectorField: { fieldPath: 'v' }, queryVector: { mapValue: { fields: { __type__: { stringValue: '__vector__' }, value: { arrayValue: { values: [{ doubleValue: 1 }] } } } } }, distanceMeasure: 'EUCLIDEAN', limit: { value: 1 } } }],
  ['empty-id-direct-children', '', { from: [{ collectionId: '', allDescendants: false }] }],
  ['parent-is-a-collection', 'top', { from: [selector] }],
];
export const aggregationCases = [
  ['count-root', '', { from: [selector] }, [{ alias: 'c', count: {} }]],
  ['count-under-document', 'top/parent', { from: [selector] }, [{ alias: 'c', count: {} }]],
  ['count-sdk-range', '', { from: [selector], where: sdkRange('rd') }, [{ alias: 'c', count: {} }]],
  ['count-limit', '', { from: [selector], limit: { value: 4 } }, [{ alias: 'c', count: {} }]],
  ['sum', '', { from: [selector] }, [{ alias: 's', sum: { field: { fieldPath: 'n' } } }]],
];
// The ruleset, the caller, then what each is allowed to read.
export const rulesets = {
  'allow-all': "match /{document=**} { allow read: if true; }",
  'signed-in': "match /{document=**} { allow read: if request.auth != null; }",
  'list-only': "match /{document=**} { allow list: if true; }",
  'get-only': "match /{document=**} { allow get: if true; }",
  'one-collection': "match /rd/{doc} { allow read: if true; }",
  'one-group': "match /{path=**}/sub/{doc} { allow read: if true; }",
  'one-subtree': "match /top/parent/{rest=**} { allow read: if true; }",
  'wildcard-subtree': "match /top/{which}/{rest=**} { allow read: if which == 'parent'; }",
  'deny-all': "match /{document=**} { allow read: if false; }",
};
const rulesSource = (body) => `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    ${body}\n  }\n}\n`;

function userToken() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    aud: project, iss: `https://securetoken.google.com/${project}`, sub: 'kindless-user', user_id: 'kindless-user',
    auth_time: now - 10, iat: now - 10, exp: now + 3600, firebase: { sign_in_provider: 'custom', identities: {} },
  })}.`;
}
const relative = (name) => name.slice(name.indexOf('/documents/') + '/documents/'.length);

function collect(stream) {
  return new Promise((resolve) => {
    const documents = [];
    const fields = new Set();
    let aggregate;
    stream.on('data', (row) => {
      if (row.document?.name) {
        documents.push(relative(row.document.name));
        for (const field of Object.keys(row.document.fields ?? {})) fields.add(field);
      }
      if (row.result) aggregate = row.result.aggregateFields;
    });
    stream.on('error', (error) => resolve({ code: error.code, message: String(error.details ?? error.message) }));
    stream.on('end', () => resolve({ code: 0, documents, fields: [...fields].sort(), ...(aggregate ? { aggregate } : {}) }));
  });
}
// REST takes the wrappers the gRPC client spells out as plain numbers.
const restQuery = (query) => {
  const copy = structuredClone(query);
  if (copy.limit) copy.limit = copy.limit.value;
  if (copy.findNearest?.limit) copy.findNearest.limit = copy.findNearest.limit.value;
  return copy;
};

export async function observe(host, log = () => {}) {
  const [hostname, port] = host.split(':');
  const db = new Firestore({ projectId: project, host, ssl: false });
  const tenant = new Firestore({ projectId: project, databaseId: 'tenant-a', host, ssl: false });
  const raw = new v1.FirestoreClient({ apiEndpoint: hostname, port: Number(port), projectId: project, sslCreds: credentials.createInsecure() });
  const parentOf = (path) => (path ? `${root}/${path}` : root);

  const wipe = async () => {
    for (const database of ['(default)', 'tenant-a']) {
      const response = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/${database}/documents`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`wipe ${database}: ${response.status}`);
    }
  };
  const seed = async () => {
    const writer = db.bulkWriter();
    seedPaths.forEach((path, index) => writer.set(db.doc(path), { n: index + 1, tag: 'x', nested: { v: index + 1 } }));
    await writer.close();
  };
  const setRules = async (body) => {
    const response = await fetch(`http://${host}/emulator/v1/projects/${project}:securityRules`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rulesSource(body) }] } }),
    });
    if (!response.ok) throw new Error(`rules ${response.status}: ${await response.text()}`);
    await delay(200);
  };
  const names = async () => {
    const result = await collect(raw.runQuery({ parent: root, structuredQuery: { from: [selector] } }, owner));
    return result.documents ?? result;
  };
  // Opens one listener on a kindless target, optionally changing data after
  // its first snapshot, and reports what it was told.
  const listen = (parent, query, auth, afterCurrent) => new Promise((resolve) => {
    const call = raw.listen(auth);
    const initial = [];
    const changes = [];
    let current = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      call.cancel();
      resolve(result);
    };
    const success = () => finish({ code: 0, documents: initial.slice().sort(), changes: changes.slice().sort() });
    const deadline = setTimeout(() => finish({ code: 'no-answer-in-8s', documents: initial.slice().sort() }), 8000);
    call.on('data', (message) => {
      const change = message.documentChange;
      if (change?.document?.name) {
        const removed = !(change.targetIds ?? []).includes(1);
        const path = relative(change.document.name);
        if (current) changes.push(`${removed ? 'left' : 'changed'} ${path}`);
        else if (!removed) initial.push(path);
      }
      for (const entry of [message.documentDelete, message.documentRemove]) {
        if (entry?.document && current) changes.push(`left ${relative(entry.document)}`);
      }
      if (message.targetChange?.targetChangeType === 'REMOVE') {
        finish({ code: message.targetChange.cause?.code ?? 'removed', documents: [] });
      }
      if (message.targetChange?.targetChangeType === 'CURRENT' && !current) {
        current = true;
        if (!afterCurrent) success();
        else void afterCurrent().then(() => delay(2_000)).then(success, (error) => finish({ code: 'driver-failed', message: String(error) }));
      }
    });
    call.on('error', (error) => finish({ code: error.code, message: String(error.details ?? error.message), documents: [] }));
    call.write({ database: root.replace('/documents', ''), addTarget: { targetId: 1, query: { parent, structuredQuery: query } } });
  });

  const result = { seed: seedPaths, queries: {}, aggregations: {}, listens: {}, rules: {}, databases: {}, sdk: {} };
  await wipe();
  await setRules('match /{document=**} { allow read, write: if true; }');
  await seed();

  // The cases below only read, so they run together: the Google client takes
  // about seven seconds to report a refused stream, from either emulator.
  await Promise.all(queryCases.map(async ([id, parent, query]) => {
    const grpc = await collect(raw.runQuery({ parent: parentOf(parent), structuredQuery: query }, owner));
    const response = await fetch(`http://${host}/v1/${parentOf(parent)}:runQuery`, {
      method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ structuredQuery: restQuery(query) }),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    const rest = response.status === 200
      ? { status: 200, documents: body.flatMap((row) => (row.document?.name ? [relative(row.document.name)] : [])) }
      : { status: response.status, message: body?.error?.message ?? String(body).slice(0, 200), errorStatus: body?.error?.status };
    result.queries[id] = { parent, structuredQuery: query, grpc, rest };
    log(`${id}: grpc ${grpc.code} ${JSON.stringify(grpc.documents ?? grpc.message)} | rest ${rest.status} ${JSON.stringify(rest.documents ?? rest.message)}`);
  }));
  await Promise.all(aggregationCases.map(async ([id, parent, query, aggregations]) => {
    result.aggregations[id] = await collect(raw.runAggregationQuery({ parent: parentOf(parent), structuredAggregationQuery: { structuredQuery: query, aggregations } }, owner));
    log(`${id}: ${JSON.stringify(result.aggregations[id])}`);
  }));

  result.listens['root'] = await listen(root, { from: [selector] }, owner);
  log(`listen root: ${JSON.stringify(result.listens['root'])}`);
  result.listens['sdk-range'] = await listen(root, { from: [selector], where: sdkRange('rd') }, owner);
  log(`listen sdk-range: ${JSON.stringify(result.listens['sdk-range'])}`);
  result.listens['changes-under-document'] = await listen(`${root}/top/parent`, { from: [selector] }, owner, async () => {
    await db.doc('top/parent/c9/added').set({ n: 100 });
    await db.doc('top/parent/c1/one/c2/added').set({ n: 101 });
    await db.doc('top/parent/c3/three').update({ n: 102 });
    await db.doc('top/parent/c1/one').delete();
    await db.doc('top/other/c9/outside').set({ n: 103 });
    await db.doc('top/parent').set({ n: 104 });
  });
  log(`listen changes: ${JSON.stringify(result.listens['changes-under-document'])}`);
  // The same driver on a plain collection, so an empty list above can be told
  // from a listener that was never told anything.
  await wipe();
  await seed();
  result.listens['control-collection'] = await listen(`${root}/top/parent`, { from: [{ collectionId: 'c1' }] }, owner, async () => {
    await db.doc('top/parent/c1/added').set({ n: 100 });
    await db.doc('top/parent/c1/one').update({ n: 101 });
  });
  log(`listen control: ${JSON.stringify(result.listens['control-collection'])}`);
  await wipe();
  await seed();

  const callers = { user: { otherArgs: { headers: { authorization: `Bearer ${userToken()}` } } }, 'signed-out': {}, owner };
  for (const [name, body] of Object.entries(rulesets)) {
    await setRules(body);
    result.rules[name] = {};
    await Promise.all(Object.entries(callers).map(async ([who, auth]) => {
      const [atRoot, underDocument, listening] = await Promise.all([
        collect(raw.runQuery({ parent: root, structuredQuery: { from: [selector], limit: { value: 2 } } }, auth)),
        collect(raw.runQuery({ parent: `${root}/top/parent`, structuredQuery: { from: [selector], limit: { value: 2 } } }, auth)),
        listen(root, { from: [selector], limit: { value: 2 } }, auth),
      ]);
      result.rules[name][who] = { root: atRoot.code, rootDocuments: atRoot.documents ?? [], underDocument: underDocument.code, underDocumentDocuments: underDocument.documents ?? [], listen: listening.code };
      log(`rules ${name} ${who}: ${JSON.stringify(result.rules[name][who])}`);
    }));
  }
  await setRules('match /{document=**} { allow read, write: if true; }');

  // One database's kindless query never sees another's documents.
  await tenant.doc('rd/only-in-tenant').set({ n: 1 });
  await tenant.doc('elsewhere/x').set({ n: 2 });
  const tenantRoot = `projects/${project}/databases/tenant-a/documents`;
  const tenantHeaders = { otherArgs: { headers: { authorization: 'Bearer owner', 'x-goog-request-params': `project_id=${project}&database_id=tenant-a` } } };
  result.databases.named = await collect(raw.runQuery({ parent: tenantRoot, structuredQuery: { from: [selector] } }, tenantHeaders));
  result.databases.default = await names();
  await tenant.recursiveDelete(tenant.collection('rd'));
  result.databases.afterRecursiveDelete = {
    named: await collect(raw.runQuery({ parent: tenantRoot, structuredQuery: { from: [selector] } }, tenantHeaders)),
    default: await names(),
  };
  log(`databases: ${JSON.stringify(result.databases)}`);

  const attempt = async (id, target) => {
    await wipe();
    await seed();
    try {
      await db.recursiveDelete(target());
      result.sdk[id] = { ok: true, left: await names() };
    } catch (error) {
      result.sdk[id] = { ok: false, error: String(error.message), left: await names() };
    }
    log(`sdk ${id}: ${JSON.stringify(result.sdk[id])}`);
  };
  await attempt('root-collection', () => db.collection('rd'));
  await attempt('document', () => db.doc('top/parent'));
  await attempt('subcollection', () => db.collection('top/parent/c1'));
  await attempt('document-under-collection', () => db.doc('rd/a'));
  await attempt('missing-document-with-children', () => db.doc('rd/ghost'));
  await attempt('nothing-there', () => db.collection('none'));
  // More than one page: the SDK asks for 5,000 names at a time, then starts
  // after the last one it saw.
  {
    await wipe();
    await seed();
    const writer = db.bulkWriter();
    for (let index = 0; index < 5_200; index += 1) writer.set(db.doc(`big/d${String(index).padStart(5, '0')}`), { index });
    for (let index = 0; index < 40; index += 1) writer.set(db.doc(`big/d00001/kids/k${index}`), { index });
    await writer.close();
    try {
      await db.recursiveDelete(db.collection('big'));
      result.sdk['more-than-one-page'] = { ok: true, left: await names() };
    } catch (error) {
      result.sdk['more-than-one-page'] = { ok: false, error: String(error.message), left: await names() };
    }
    log(`sdk more-than-one-page: ${JSON.stringify(result.sdk['more-than-one-page'])}`);
  }
  // A custom writer's callbacks see every deletion.
  {
    await wipe();
    await seed();
    const writer = db.bulkWriter();
    const deleted = [];
    writer.onWriteResult((ref) => deleted.push(ref.path));
    await db.recursiveDelete(db.collection('top/parent/c1'), writer);
    await writer.close();
    result.sdk['custom-writer'] = { ok: true, deleted: deleted.sort(), left: await names() };
    log(`sdk custom-writer: ${JSON.stringify(result.sdk['custom-writer'])}`);
  }
  await db.terminate();
  await tenant.terminate();
  await raw.close();
  return {
    ...result,
    queries: Object.fromEntries(queryCases.map(([id]) => [id, result.queries[id]])),
    aggregations: Object.fromEntries(aggregationCases.map(([id]) => [id, result.aggregations[id]])),
    rules: Object.fromEntries(Object.entries(result.rules).map(([name, callers]) => [name, {
      user: callers.user, 'signed-out': callers['signed-out'], owner: callers.owner,
    }])),
  };
}
