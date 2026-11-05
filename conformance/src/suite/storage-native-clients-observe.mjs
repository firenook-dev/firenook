// What a Storage endpoint answers to the requests the native SDKs and browsers
// send: the iOS SDK's upload start on the object path, the Android SDK's on the
// bucket path, CORS preflights, and listing under rules. The capture records
// this against the official emulator; the replay test runs the same requests
// against the native engine.
export const project = 'demo-firenook-native-clients';
export const bucket = `${project}.appspot.com`;

const rulesSource = (body) => `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    ${body}\n  }\n}\n`;
export const uploadRules = [
  'match /open/{name} { allow read, write: if true; }',
  'match /deep/{allPaths=**} { allow read, write: if true; }',
  'match /users/{uid}/{name} { allow read, write: if request.auth != null && request.auth.uid == uid; }',
].join('\n    ');
export const startRules = rulesSource(uploadRules);

// Each ruleset is asked to list these prefixes, signed out.
export const listRules = {
  'single-wildcard': 'match /open/{name} { allow list: if true; }',
  'single-wildcard-read': 'match /open/{name} { allow read: if true; }',
  'single-wildcard-get-only': 'match /open/{name} { allow get: if true; }',
  'recursive-wildcard': 'match /open/{allPaths=**} { allow list: if true; }',
  'root-single-wildcard': 'match /{name} { allow list: if true; }',
  'root-recursive-wildcard': 'match /{allPaths=**} { allow list: if true; }',
  'exact-folder': 'match /open { allow list: if true; }',
  'deeper-single-wildcard': 'match /open/sub/{name} { allow list: if true; }',
  'two-wildcards': 'match /{a}/{b} { allow list: if true; }',
  'three-wildcards': 'match /{a}/{b}/{c} { allow list: if true; }',
  'nested-match': 'match /open { match /{name} { allow list: if true; } }',
  'wildcard-then-literal': 'match /{folder}/sub/{name} { allow list: if true; }',
  'binds-the-folder': "match /{folder}/{name} { allow list: if folder == 'open'; }",
  'name-is-empty': "match /open/{name} { allow list: if name == ''; }",
  'name-is-a-string': 'match /open/{name} { allow list: if name is string; }',
  'name-unknown-denies': "match /open/{name} { allow list: if name == 'x'; }",
  'name-not-equal': "match /open/{name} { allow list: if name != 'x'; }",
  'name-negated': "match /open/{name} { allow list: if !(name == 'x'); }",
  'name-or-true': "match /open/{name} { allow list: if name == 'x' || true; }",
  'name-and-true': "match /open/{name} { allow list: if true && name == 'x'; }",
  'recursive-binding-is-path': 'match /open/{allPaths=**} { allow list: if allPaths is path; }',
  'recursive-binding-negated': "match /open/{allPaths=**} { allow list: if !(allPaths == path('x')); }",
  'recursive-value-empty': "match /open/{allPaths=**} { allow list: if string(allPaths) == ''; }",
  'recursive-value-slash': "match /open/{allPaths=**} { allow list: if string(allPaths) == '/'; }",
  'recursive-value-sub': "match /open/{allPaths=**} { allow list: if string(allPaths) == 'sub'; }",
  'recursive-value-slash-sub': "match /open/{allPaths=**} { allow list: if string(allPaths) == '/sub'; }",
  'recursive-value-deep': "match /open/{allPaths=**} { allow list: if string(allPaths) == 'sub/deep'; }",
  'recursive-value-is-string': "match /open/{allPaths=**} { allow list: if allPaths is string; }",
  'recursive-then-wildcard': "match /{rest=**}/{name} { allow list: if true; }",
  'recursive-equals-sub': "match /open/{allPaths=**} { allow list: if allPaths == path('sub'); }",
  'recursive-equals-slash-sub': "match /open/{allPaths=**} { allow list: if allPaths == /sub; }",
  'request-path': `match /open/{name} { allow list: if request.path == /b/${bucket}/o/open; }`,
};
const prefixes = ['', 'open/', 'open/sub/', 'open/sub/deep/', 'other/'];

const object = (name) => encodeURIComponent(name);
const v0 = (path = '') => `/v0/b/${bucket}/o${path}`;
const base64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function userToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  return `${base64({ alg: 'none', typ: 'JWT' })}.${base64({
    aud: project, iss: `https://securetoken.google.com/${project}`, sub: uid, user_id: uid,
    auth_time: now - 10, iat: now - 10, exp: now + 3600, firebase: { sign_in_provider: 'custom', identities: {} },
  })}.`;
}
const headerNames = (value) => (value ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean).sort();

// The parts of a response a client reads. Ids, times and hashes change per run.
async function observed(response) {
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not every answer is JSON */ }
  const result = {
    status: response.status,
    uploadStatus: response.headers.get('x-goog-upload-status'),
    chunkGranularity: response.headers.get('x-goog-upload-chunk-granularity'),
    sizeReceived: response.headers.get('x-goog-upload-size-received'),
    hasUploadId: response.headers.has('x-gupload-uploadid'),
  };
  const url = response.headers.get('x-goog-upload-url');
  if (url) {
    const parsed = new URL(url);
    result.uploadUrl = { path: parsed.pathname, name: parsed.searchParams.get('name'), protocol: parsed.searchParams.get('upload_protocol'), hasId: parsed.searchParams.has('upload_id') };
  }
  if (json && typeof json === 'object') {
    const { name, bucket: inBucket, contentType, size, metadata, contentDisposition, cacheControl, error, items, prefixes: folders } = json;
    result.body = { name, bucket: inBucket, contentType, size, contentDisposition, cacheControl, error };
    if (metadata !== undefined) result.body.metadata = metadata;
    if (items) result.body.items = items.map((item) => item.name);
    if (folders) result.body.prefixes = folders;
    result.body.hasDownloadTokens = typeof json.downloadTokens === 'string' && json.downloadTokens.length > 0;
  }
  return result;
}

export async function observe(origin, log = () => {}) {
  const call = async (path, { method = 'POST', headers = {}, body } = {}) => fetch(origin + path, { method, headers, body, signal: AbortSignal.timeout(20_000) });
  const seen = async (id, section, path, options) => {
    const response = await call(path, options);
    const result = await observed(response);
    section[id] = result;
    log(`${id}: ${JSON.stringify(result)}`);
    return result;
  };
  const reset = async () => {
    const response = await call('/internal/reset');
    if (![200, 204].includes(response.status)) throw new Error(`reset: ${response.status}`);
  };
  const setRules = async (source) => {
    const response = await call('/internal/setRules', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: 'storage.rules', content: source }] } }),
    });
    if (!response.ok) throw new Error(`rules ${response.status}: ${await response.text()}`);
  };
  const seed = async (name, bytes = 'x') => {
    const response = await call(`${v0()}?name=${object(name)}`, { headers: { authorization: 'Bearer owner' }, body: bytes });
    if (!response.ok) throw new Error(`seed ${name}: ${response.status}`);
  };
  const uploadUrlOf = async (response) => {
    const url = response.headers.get('x-goog-upload-url');
    await response.arrayBuffer();
    return url ? new URL(url) : undefined;
  };
  // The start each SDK sends, headers and body as captured from the real SDK.
  const iosStart = (name, { contentType = 'text/plain', metadata = null, length = 5, authorization } = {}) => call(
    `${v0(`/${object(name)}`)}?uploadType=resumable&name=${object(name)}`,
    {
      headers: {
        'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start',
        'x-goog-upload-content-length': String(length), 'x-goog-upload-content-type': contentType,
        'content-type': 'application/json; charset=UTF-8', 'x-firebase-storage-version': 'ios/13.1.1',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ contentType, bucket: '', metadata, name }),
    },
  );
  const androidStart = (name, { contentType = 'application/octet-stream', body, authorization } = {}) => call(
    `${v0()}?name=${object(name)}&uploadType=resumable`,
    {
      headers: {
        'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-type': contentType,
        'x-firebase-storage-version': 'Android/21.0.0',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(authorization ? { authorization } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const webStart = (name, length) => call(`${v0()}?name=${object(name)}`, {
    headers: {
      'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(length), 'x-goog-upload-header-content-type': 'text/plain',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ name, contentType: 'text/plain' }),
  });
  const send = (url, command, bytes, { method = 'POST', offset = 0, contentType } = {}) => call(url.pathname + url.search, {
    method,
    headers: {
      'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': command, 'x-goog-upload-offset': String(offset),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    ...(bytes === undefined ? {} : { body: bytes }),
  });

  const result = { uploads: {}, downloads: {}, tokens: {}, cors: {}, lists: {} };
  const uploads = result.uploads;
  await setRules(startRules);
  await reset();

  // iOS: start on the object path, then finish on the URL it was given.
  const iosStarted = await iosStart('open/hello.txt', { metadata: { k: 'v' } });
  const iosUrl = await uploadUrlOf(iosStarted.clone());
  uploads['ios-start'] = await observed(iosStarted);
  log(`ios-start: ${JSON.stringify(uploads['ios-start'])}`);
  uploads['ios-query'] = await observed(await call(iosUrl.pathname + iosUrl.search, { headers: { 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'query' } }));
  uploads['ios-put-upload'] = await observed(await send(iosUrl, 'upload', 'hel', { method: 'PUT' }));
  uploads['ios-query-after-upload'] = await observed(await call(iosUrl.pathname + iosUrl.search, { headers: { 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'query' } }));
  uploads['ios-put-finalize'] = await observed(await send(iosUrl, 'upload, finalize', 'lo', { method: 'PUT', offset: 3 }));
  log(`ios-put-finalize: ${JSON.stringify(uploads['ios-put-finalize'])}`);
  await seen('ios-read', result.downloads, `${v0('/open%2Fhello.txt')}?alt=media`, { method: 'GET' });

  // An iOS start is not a rules check: a denied name fails on finalize.
  const deniedStart = await iosStart('users/not-me/a.txt', { contentType: 'application/octet-stream', length: 1, authorization: `Firebase ${userToken('someone')}` });
  const deniedUrl = await uploadUrlOf(deniedStart.clone());
  uploads['ios-denied-start'] = await observed(deniedStart);
  uploads['ios-denied-finalize'] = await observed(await send(deniedUrl, 'upload, finalize', 'x', { method: 'POST' }));
  uploads['ios-denied-finalize-again'] = await observed(await send(deniedUrl, 'finalize', undefined, { method: 'POST' }));
  const ownStart = await iosStart('users/someone/a.txt', { contentType: 'application/octet-stream', length: 1, authorization: `Firebase ${userToken('someone')}` });
  const ownUrl = await uploadUrlOf(ownStart);
  uploads['ios-own-finalize'] = await observed(await send(ownUrl, 'upload, finalize', 'x'));

  // The path names the object, whatever the query says.
  const mismatch = await call(`${v0('/open%2Fpath.txt')}?uploadType=resumable&name=open%2Fquery.txt`, {
    headers: { 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'open/body.txt' }),
  });
  const mismatchUrl = await uploadUrlOf(mismatch.clone());
  uploads['path-beats-query-start'] = await observed(mismatch);
  uploads['path-beats-query-finalize'] = await observed(await send(mismatchUrl, 'upload, finalize', 'x'));

  // Cancelling on the object path's session.
  const cancelled = await iosStart('open/cancelled.txt');
  const cancelledUrl = await uploadUrlOf(cancelled);
  uploads['ios-cancel'] = await observed(await send(cancelledUrl, 'cancel'));
  uploads['ios-after-cancel'] = await observed(await send(cancelledUrl, 'upload, finalize', 'x'));

  // Android: start on the bucket path, chunks by POST with the form type its
  // HTTP client adds, then an empty finalize.
  const androidStarted = await androidStart('open/android.bin');
  const androidUrl = await uploadUrlOf(androidStarted.clone());
  uploads['android-start-no-body'] = await observed(androidStarted);
  uploads['android-chunk'] = await observed(await send(androidUrl, 'upload', 'abc', { contentType: 'application/x-www-form-urlencoded' }));
  uploads['android-empty-finalize'] = await observed(await send(androidUrl, 'finalize', undefined, { offset: 3 }));
  await seen('android-read', result.downloads, `${v0('/open%2Fandroid.bin')}?alt=media`, { method: 'GET' });
  const typed = await androidStart('open/typed.png', { contentType: 'image/png', body: { contentType: 'image/png', metadata: { k: 'v' } } });
  uploads['android-typed-finalize'] = await observed(await send(await uploadUrlOf(typed), 'upload, finalize', 'abc', { contentType: 'application/x-www-form-urlencoded' }));
  const untyped = await androidStart('open/untyped.png', { contentType: 'image/png', body: { metadata: { k: 'v' } } });
  uploads['android-untyped-finalize'] = await observed(await send(await uploadUrlOf(untyped), 'upload, finalize', 'abc', { contentType: 'application/x-www-form-urlencoded' }));

  // The web SDK's start, for comparison.
  const web = await webStart('open/web.txt', 3);
  uploads['web-finalize'] = await observed(await send(await uploadUrlOf(web), 'upload, finalize', 'abc'));

  // Other uploads to an object path.
  await seen('object-path-media', uploads, v0('/open%2Fmedia.txt'), { headers: { 'content-type': 'text/plain' }, body: 'media' });
  await seen('object-path-media-put', uploads, v0('/open%2Fmedia-put.txt'), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'media' });
  await seen('bucket-path-media-put', uploads, `${v0()}?name=open%2Fbucket-put.txt`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'media' });
  const boundary = 'native-clients-boundary';
  const related = (name) => [
    `--${boundary}`, 'Content-Type: application/json; charset=utf-8', '', JSON.stringify({ name, contentType: 'text/plain', metadata: { k: 'v' } }),
    `--${boundary}`, 'Content-Type: text/plain', '', 'multipart', `--${boundary}--`, '',
  ].join('\r\n');
  await seen('object-path-multipart', uploads, v0('/open%2Fmulti.txt'), {
    headers: { 'x-goog-upload-protocol': 'multipart', 'content-type': `multipart/related; boundary=${boundary}` }, body: related('open/multi.txt'),
  });
  await seen('object-path-denied-media', uploads, v0('/closed%2Fmedia.txt'), { headers: { 'content-type': 'text/plain' }, body: 'media' });
  await seen('start-without-a-name', uploads, v0(), {
    headers: { 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'content-type': 'application/json' }, body: '{}',
  });
  await seen('command-without-an-id', uploads, v0('/open%2Fhello.txt'), {
    headers: { 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'upload' }, body: 'x',
  });
  await seen('protocol-without-a-command', uploads, v0('/open%2Fhello.txt'), {
    headers: { 'x-goog-upload-protocol': 'resumable' }, body: 'x',
  });
  await seen('put-as-patch', uploads, v0('/open%2Fhello.txt'), {
    method: 'PUT', headers: { 'x-http-method-override': 'PATCH', 'content-type': 'application/json' }, body: JSON.stringify({ metadata: { k: 'patched' } }),
  });

  // Download tokens on the same route stay admin-only.
  await seen('create-token-signed-out', result.tokens, `${v0('/open%2Fhello.txt')}?create_token=true`);
  await seen('delete-token-signed-out', result.tokens, `${v0('/open%2Fhello.txt')}?delete_token=x`);
  await seen('create-token-owner', result.tokens, `${v0('/open%2Fhello.txt')}?create_token=true`, { headers: { authorization: 'Bearer owner' } });
  await seen('create-token-not-true', result.tokens, `${v0('/open%2Fhello.txt')}?create_token=false`, { headers: { authorization: 'Bearer owner' } });

  // What a browser asks before it sends the web SDK's headers, and may read after.
  const preflight = await call(v0(), {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:5000', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-firebase-gmpid,x-firebase-storage-version,x-goog-upload-command,x-goog-upload-header-content-length,x-goog-upload-header-content-type,x-goog-upload-offset,x-goog-upload-protocol,x-made-up-header',
    },
  });
  await preflight.arrayBuffer();
  result.cors.preflight = {
    allowHeaders: headerNames(preflight.headers.get('access-control-allow-headers')),
    allowMethods: headerNames(preflight.headers.get('access-control-allow-methods')),
    ok: preflight.ok,
  };
  const privateNetwork = await call(v0(), {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5000', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
  });
  await privateNetwork.arrayBuffer();
  result.cors.privateNetwork = privateNetwork.headers.get('access-control-allow-private-network');
  const simple = await call(`${v0()}?name=open%2Fcors.txt`, {
    headers: { origin: 'http://localhost:5000', 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'content-type': 'application/json' },
    body: '{}',
  });
  await simple.arrayBuffer();
  result.cors.exposed = headerNames(simple.headers.get('access-control-expose-headers'));
  log(`cors: ${JSON.stringify(result.cors)}`);

  // Listing under each ruleset, signed out.
  await seed('open/a.txt');
  await seed('open/sub/b.txt');
  await seed('open/sub/deep/c.txt');
  await seed('other/d.txt');
  await seed('e.txt');
  for (const [name, body] of Object.entries(listRules)) {
    await setRules(rulesSource(body));
    result.lists[name] = {};
    for (const prefix of prefixes) {
      const response = await call(`${v0()}?prefix=${encodeURIComponent(prefix)}&delimiter=%2F`, { method: 'GET' });
      const answer = await observed(response);
      result.lists[name][prefix || '(root)'] = { status: answer.status, items: answer.body?.items, prefixes: answer.body?.prefixes };
    }
    log(`list ${name}: ${JSON.stringify(Object.fromEntries(Object.entries(result.lists[name]).map(([key, value]) => [key, value.status])))}`);
  }
  return result;
}
