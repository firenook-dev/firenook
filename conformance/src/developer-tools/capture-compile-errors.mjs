// Tiny compiler-only oracle: rules reloads of sources that do not compile.
// No documents, consumer source or cloud requests; one owned loopback jar.
//
//   node conformance/src/developer-tools/capture-compile-errors.mjs OUTPUT
//
// OUTPUT must not exist. It receives the public `fixture.json` and its
// `SHA256SUMS`, plus `raw.json` (the same record with the process exit) and
// `oracle.log`, which stay outside the public fixture directory.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.versions.node, '24.20.0');
assert.ok(process.argv[2], 'provide a fresh output directory');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const work = await mkdtemp(join(tmpdir(), 'firenook-compile-errors-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// firebase-tools 15.22.0 pins this Firestore emulator.
const jar = join(homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar');
const jarSha256 = hash(await readFile(jar));
assert.equal(jarSha256, 'c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e');
const project = 'demo-firenook-compile-errors';

// One small ruleset that compiles; each input below makes one mistake in it
// (two in `two/*`), or cuts it short.
const BASE = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    function signedIn() {',
  '      return request.auth != null;',
  '    }',
  '    match /items/{item} {',
  '      allow read: if signedIn();',
  '      allow write: if request.auth.uid == resource.data.owner;',
  '    }',
  '  }',
  '}',
  '',
].join('\n');
const only = (text, from) => {
  const at = text.indexOf(from);
  assert.ok(at >= 0 && text.indexOf(from, at + 1) < 0, `exactly one ${JSON.stringify(from)}`);
  return at;
};
// BASE with each [from, to] pair replaced, every `from` occurring once.
const edit = (...pairs) => pairs.reduce((text, [from, to]) => {
  const at = only(text, from);
  return text.slice(0, at) + to + text.slice(at + from.length);
}, BASE);
// BASE cut just after the first `through`.
const cut = through => BASE.slice(0, BASE.indexOf(through) + through.length);
const READ = '      allow read: if signedIn();';
const WRITE = '      allow write: if request.auth.uid == resource.data.owner;';
const RETURN = '      return request.auth != null;';
const read = to => edit([READ, `      ${to}`]);
const write = to => edit([WRITE, `      ${to}`]);

// The production Rules API's recorded refusals (rules-v2
// production-parse-errors.json), sent here unchanged so the two references
// can be compared on the same input.
const production = JSON.parse(await readFile(new URL('../../fixtures/rules-v2/production-parse-errors.json', import.meta.url)));
const productionSource = id => production.observations.find(observation => observation.id === id).source;

const inputs = [
  ['baseline', 'the ruleset every other input changes, which compiles', BASE],
  // A stray or wrong word at the top level.
  ['top/broken', 'one word and nothing else (developer-tools-coverage-v1 invalid-reload)', 'broken'],
  ['top/empty', 'an empty source', ''],
  ['top/whitespace-only', 'only blank lines', '\n  \n'],
  ['top/comment-only', 'a comment and nothing else', '// rules\n'],
  ['top/word-before', 'a stray word before rules_version', `hello\n${BASE}`],
  ['top/word-after', 'a stray word after the service block', `${BASE}extra\n`],
  ['top/word-after-function', 'a stray word after a function before the service block', edit(["rules_version = '2';\n", "rules_version = '2';\nfunction open() { return true; }\nhello\n"])],
  ['top/two-services', 'a second service block', `${BASE}service cloud.firestore {\n  match /databases/{database}/documents {\n  }\n}\n`],
  ['top/service-name-misspelled', 'service cloud.firestor', edit(['service cloud.firestore', 'service cloud.firestor'])],
  ['top/service-name-missing', 'service with no name', edit(['service cloud.firestore {', 'service {'])],
  ['top/match-outside-service', 'a match block before the service block', edit(["rules_version = '2';\n", "rules_version = '2';\nmatch /items/{item} {\n  allow read: if true;\n}\n"])],
  // rules_version gone wrong.
  ['version/number', "rules_version = 2", edit(["rules_version = '2';", 'rules_version = 2;'])],
  ['version/one', "rules_version = '1'", edit(["rules_version = '2';", "rules_version = '1';"])],
  ['version/equals-missing', "rules_version '2'", edit(["rules_version = '2';", "rules_version '2';"])],
  ['version/colon', "rules_version: '2'", edit(["rules_version = '2';", "rules_version: '2';"])],
  ['version/value-missing', 'rules_version = ;', edit(["rules_version = '2';", 'rules_version = ;'])],
  ['version/unterminated', "rules_version = '2; (an unterminated string)", edit(["rules_version = '2';", "rules_version = '2;"])],
  ['version/after-service', 'rules_version after the service block', `${BASE.replace("rules_version = '2';\n", '')}rules_version = '2';\n`],
  // A missing or extra brace.
  ['braces/service-open-missing', 'no { after the service name', edit(['service cloud.firestore {', 'service cloud.firestore'])],
  ['braces/service-body-word', 'a stray word first in the service block', edit(['service cloud.firestore {\n', 'service cloud.firestore {\n  hello\n'])],
  ['braces/service-body-allow', 'an allow in the service block after its match', edit(['  }\n}\n', '  }\n  allow read: if true;\n}\n'])],
  ['braces/match-open-missing', 'no { after a match path', edit(['    match /items/{item} {', '    match /items/{item}'])],
  ['braces/function-open-missing', 'no { before a function body', edit(['    function signedIn() {', '    function signedIn()'])],
  ['braces/function-close-missing', 'no } after a function body', edit([`${RETURN}\n    }\n`, `${RETURN}\n`])],
  ['braces/match-close-missing', 'no } closing the inner match', edit([`${WRITE}\n    }\n`, `${WRITE}\n`])],
  ['braces/service-close-missing', 'no } closing the service block', BASE.slice(0, -2)],
  // A missing or extra ;
  ['semicolons/allow-missing', 'no ; after an allow followed by another', read('allow read: if signedIn()')],
  ['semicolons/last-allow-missing', 'no ; after the last allow of a block', write('allow write: if request.auth.uid == resource.data.owner')],
  ['semicolons/allow-doubled', ';; after an allow', read('allow read: if signedIn();;')],
  ['semicolons/match-close', 'a ; after a match block', edit([`${WRITE}\n    }\n`, `${WRITE}\n    };\n`])],
  ['semicolons/let-missing', 'no ; after a let', edit([RETURN, '      let auth = request.auth\n      return auth != null;'])],
  // A missing or extra parenthesis.
  ['parens/condition-close-missing', 'if (signedIn();', read('allow read: if (signedIn();')],
  ['parens/condition-close-extra', 'if signedIn());', read('allow read: if signedIn());')],
  ['parens/call-close-missing', 'if signedIn(;', read('allow read: if signedIn(;')],
  ['parens/parameters-close-missing', 'function signedIn( {', edit(['function signedIn() {', 'function signedIn( {'])],
  ['parens/parameters-missing', 'function signedIn {', edit(['function signedIn() {', 'function signedIn {'])],
  // An unterminated or broken string.
  ['strings/single-unterminated', "== 'public; (single quote)", read("allow read: if resource.data.kind == 'public;")],
  ['strings/double-unterminated', '== "public; (double quote)', read('allow read: if resource.data.kind == "public;')],
  ['strings/newline-inside', 'a line break inside a string', read("allow read: if resource.data.kind == 'pub\nlic';")],
  ['strings/escaped-close', "== 'public\\'; (the closing quote escaped)", read("allow read: if resource.data.kind == 'public\\';")],
  // A bad token in a match path.
  ['paths/leading-slash-missing', 'match items/{item}', edit(['match /items/{item}', 'match items/{item}'])],
  ['paths/single-star', 'match /items/{item=*}', edit(['match /items/{item}', 'match /items/{item=*}'])],
  ['paths/wildcard-empty', 'match /items/{}', edit(['match /items/{item}', 'match /items/{}'])],
  ['paths/double-slash', 'match /items//{item}', edit(['match /items/{item}', 'match /items//{item}'])],
  ['paths/trailing-slash', 'match /items/{item}/', edit(['match /items/{item}', 'match /items/{item}/'])],
  ['paths/interpolation', 'match /items/$(item)', edit(['match /items/{item}', 'match /items/$(item)'])],
  ['paths/missing', 'match with no path', edit(['match /items/{item} {', 'match {'])],
  // A condition cut short or written in another language's syntax.
  ['conditions/if-space', 'allow read: if ;', read('allow read: if ;')],
  ['conditions/if-at-line-end', 'allow read: if, then the next allow', read('allow read: if')],
  ['conditions/not-equal-cut', 'if request.auth !=;', read('allow read: if request.auth !=;')],
  ['conditions/not-equal-at-close', 'if request.auth != then the closing }', write('allow write: if request.auth !=')],
  ['conditions/not-cut', 'if !;', read('allow read: if !;')],
  ['conditions/group-cut', 'if (;', read('allow read: if (;')],
  ['conditions/single-equals', 'request.auth.uid = resource.data.owner', write('allow write: if request.auth.uid = resource.data.owner;')],
  ['conditions/triple-equals', 'request.auth.uid === resource.data.owner', write('allow write: if request.auth.uid === resource.data.owner;')],
  ['conditions/single-ampersand', 'signedIn() & true', read('allow read: if signedIn() & true;')],
  ['conditions/stray-ampersand', 'a lone & before the ;', read('allow read: if signedIn() &;')],
  ['conditions/single-pipe', 'signedIn() | true', read('allow read: if signedIn() | true;')],
  ['conditions/tilde', 'a ~ before the condition', read('allow read: if ~signedIn();')],
  ['conditions/if-missing', 'allow read: signedIn();', read('allow read: signedIn();')],
  ['conditions/colon-alone', 'allow read: ;', read('allow read: ;')],
  ['conditions/colon-missing', 'allow read if signedIn();', read('allow read if signedIn();')],
  ['conditions/method-comma-missing', 'allow get list:', read('allow get list: if signedIn();')],
  ['conditions/method-unknown', 'allow reads:', read('allow reads: if signedIn();')],
  ['conditions/method-missing', 'allow: if', read('allow: if signedIn();')],
  ['conditions/trailing-dot', '== resource.data.;', write('allow write: if request.auth.uid == resource.data.;')],
  ['conditions/bad-character-at', 'an @ in a condition', read('allow read: if @signedIn();')],
  ['conditions/bad-character-hash', 'a # comment in a condition', read('allow read: if signedIn(); # signed in')],
  ['conditions/is-type-unknown', 'is text', read('allow read: if resource.data.kind is text;')],
  // A bad function header or body.
  ['functions/name-missing', 'function () {', edit(['function signedIn() {', 'function () {'])],
  ['functions/parameter-comma-missing', 'function signedIn(a b)', edit(['function signedIn() {', 'function signedIn(a b) {'])],
  ['functions/return-missing', 'a body with no return', edit([RETURN, '      request.auth != null;'])],
  ['functions/return-value-missing', 'return;', edit([RETURN, '      return;'])],
  ['functions/two-returns', 'two returns', edit([RETURN, `${RETURN}\n      return true;`])],
  ['functions/body-empty', 'function signedIn() {}', edit([`    function signedIn() {\n${RETURN}\n    }`, '    function signedIn() {}'])],
  ['functions/if-statement', 'an if statement in a body', edit([RETURN, '      if (request.auth != null) { return true; }\n      return false;'])],
  // let misuse.
  ['let/name-missing', 'let = request.auth;', edit([RETURN, '      let = request.auth;\n      return true;'])],
  ['let/equals-missing', 'let auth request.auth;', edit([RETURN, '      let auth request.auth;\n      return auth != null;'])],
  ['let/without-return', 'a let and no return', edit([RETURN, '      let auth = request.auth;'])],
  ['let/then-word', 'a word where return belongs after a let', edit([RETURN, '      let auth = request.auth;\n      retrun auth != null;'])],
  ['let/in-match', 'a let in a match block', read('let owner = resource.data.owner;\n      allow read: if signedIn();')],
  // A misspelled keyword.
  ['keywords/servce', 'servce cloud.firestore', edit(['service cloud.firestore', 'servce cloud.firestore'])],
  ['keywords/rules-verison', 'rules_verison', edit(["rules_version = '2';", "rules_verison = '2';"])],
  ['keywords/fucntion', 'fucntion signedIn()', edit(['function signedIn()', 'fucntion signedIn()'])],
  ['keywords/retrun', 'retrun request.auth', edit([RETURN, '      retrun request.auth != null;'])],
  ['keywords/alow', 'alow read', read('alow read: if signedIn();')],
  // The end of the file in each kind of block.
  ['eof/after-rules-version', 'the source ends after rules_version', cut("rules_version = '2';")],
  ['eof/after-service', 'the source ends after service', cut("rules_version = '2';\nservice")],
  ['eof/after-service-name', 'the source ends after the service name', cut('service cloud.firestore')],
  ['eof/in-service', 'the source ends inside the service block', cut('service cloud.firestore {')],
  ['eof/after-match', 'the source ends after match', cut('  match')],
  ['eof/after-match-path', 'the source ends after a match path', cut('  match /databases/{database}/documents')],
  ['eof/in-match', 'the source ends inside a match block', cut('    match /items/{item} {')],
  ['eof/in-parameters', 'the source ends inside a parameter list', cut('    function signedIn(')],
  ['eof/in-function', 'the source ends inside a function body', cut('    function signedIn() {')],
  ['eof/after-return', 'the source ends after return', cut('      return')],
  ['eof/after-allow', 'the source ends after allow', cut('      allow read: if signedIn();\n      allow')],
  ['eof/after-method', 'the source ends after an allow method', cut('      allow read')],
  ['eof/after-if', 'the source ends after if', cut('      allow read: if')],
  ['eof/in-condition', 'the source ends inside a condition', cut('      allow write: if request.auth.uid ==')],
  ['eof/after-condition', 'the source ends after a condition', cut('      allow read: if signedIn()')],
  ['eof/in-arguments', 'the source ends inside call arguments', cut('      allow read: if signedIn(')],
  ['eof/after-declaration', 'the source ends after a complete allow', cut('      allow read: if signedIn();')],
  ['eof/after-inner-match', 'the source ends after a nested match block', cut(`${WRITE}\n    }`)],
  ['eof/in-string', 'the source ends inside a string', `${cut('      allow read: if signedIn();')}\n      allow write: if resource.data.kind == 'pub`],
  ['eof/in-block-comment', 'the source ends inside a block comment', `${BASE}/* unfinished`],
  // Two problems in one source.
  ['two/empty-conditions', 'two allows with no condition', edit([READ, '      allow read: if ;'], [WRITE, '      allow write: if ;'])],
  ['two/semicolon-and-brace', 'a missing ; and a missing final }', edit([READ, '      allow read: if signedIn()']).slice(0, -2)],
  ['two/misspelling-and-string', 'alow and an unterminated string', edit([READ, '      alow read: if signedIn();'], [WRITE, "      allow write: if resource.data.kind == 'owner;"])],
  ['two/method-and-if', 'allow reads and a missing if', edit([READ, '      allow reads: if signedIn();'], [WRITE, '      allow write: request.auth.uid == resource.data.owner;'])],
  ['two/package-and-syntax', 'a package name as a parameter and a cut condition', edit(['function signedIn() {', 'function signedIn(duration) {'], [WRITE, '      allow write: if request.auth.uid ==;'])],
  // Where a position is counted from.
  ['positions/crlf', 'Windows line endings', read('allow read: if ;').replaceAll('\n', '\r\n')],
  ['positions/unicode', 'non-ASCII text before the mistake on its line', read("allow read: if '中文🚀' == ;")],
  ['positions/tab', 'a tab before the mistake', read('allow read: if ;').replace('      allow read: if ;', '\tallow read: if ;')],
  // The production Rules API's refusals, unchanged.
  ...['unexpected-token', 'unclosed-block', 'duplicate-let', 'recursive-function', 'invalid-recursive-wildcard']
    .map(id => [`production/${id}`, `rules-v2 production-parse-errors ${id}, unchanged`, productionSource(id)]),
];
const ids = inputs.map(([id]) => id);
assert.equal(new Set(ids).size, ids.length, 'input ids are unique');
assert.equal(new Set(inputs.map(([, , source]) => source)).size, inputs.length, 'inputs are distinct');

const socket = createServer();
socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', project],
  { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit'), logs = [];
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => logs.push(String(bytes)));
const record = {
  schemaVersion: 1, syntheticOnly: true, capturedAt: new Date().toISOString(), project,
  captureSha256: hash(await readFile(new URL(import.meta.url))),
  oracle: { firestore: '1.21.0', firebaseTools: '15.22.0', jarSha256, node: process.versions.node,
    java: spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.trim() },
  request: { method: 'PUT', path: `/emulator/v1/projects/${project}:securityRules`, file: 'firestore.rules' },
  reloads: [],
};
const origin = `http://127.0.0.1:${port}`;
let failure;
try {
  const deadline = Date.now() + 60000;
  while (true) {
    assert.equal(child.exitCode, null, 'oracle exited during readiness');
    try { const response = await fetch(origin + '/', { signal: AbortSignal.timeout(250) }); await response.arrayBuffer(); if (response.status < 500) break; } catch {}
    assert.ok(Date.now() < deadline, 'oracle readiness deadline'); await delay(50);
  }
  for (const [id, mistake, source] of inputs) {
    const response = await fetch(origin + record.request.path, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: record.request.file, content: source }] } }),
      signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    record.reloads.push({ id, mistake, source, status: response.status, response: data });
  }
} catch (error) { failure = error; }
finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  record.exit = await Promise.race([exited, delay(20000, undefined, { ref: false }).then(() => { throw new Error(`owned oracle ${child.pid} shutdown deadline`); })]);
  await writeFile(join(output, 'oracle.log'), logs.join(''));
  await writeFile(join(output, 'raw.json'), JSON.stringify(record, null, 2) + '\n');
}
if (failure) throw failure;
assert.equal(record.reloads[0].status, 200, 'the baseline compiles');
const { exit, ...publicRecord } = record;
const bytes = (JSON.stringify(publicRecord, null, 2) + '\n').replaceAll(work, '<oracle-workdir>');
assert.ok(!/Bearer |\/Users\/|\/home\/|\/var\/folders\//.test(bytes));
await writeFile(join(output, 'fixture.json'), bytes, { flag: 'wx' });
await writeFile(join(output, 'SHA256SUMS'), hash(bytes) + '  fixture.json\n', { flag: 'wx' });
const statuses = {};
for (const { status } of record.reloads) statuses[status] = (statuses[status] ?? 0) + 1;
console.log(JSON.stringify({ passed: true, output, reloads: record.reloads.length, statuses }));
