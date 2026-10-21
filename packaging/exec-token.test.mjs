import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXEC_TOKEN_PRELOAD } from '../packages/cli/src/runtime.mjs';

// What a Node.js process emulators:exec starts does with a token request, the
// preload loaded after a recorder that stands in for the network: every
// request that reaches the recorder is one that would have left the process.
const RECORDER = String.raw`
const https = require('node:https');
const { PassThrough } = require('node:stream');
const left = [];
process.on('exit', () => process.stdout.write('LEFT ' + JSON.stringify(left) + '\n'));
https.request = function (first, second) {
  const options = typeof first === 'string' || first instanceof URL ? new URL(first) : first;
  left.push('https ' + (options.hostname || options.host) + (options.pathname || options.path));
  const request = new PassThrough();
  request.setTimeout = () => request;
  request.abort = request.destroy;
  process.nextTick(() => request.emit('error', new Error('no network in this test')));
  return request;
};
globalThis.fetch = async (input) => { left.push('fetch ' + String(input instanceof Request ? input.url : input)); throw new Error('no network in this test'); };
`;
const DEMO = 'client_id=demo&client_secret=demo&refresh_token=demo&grant_type=refresh_token';

function inProcess(script) {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-exec-token-'));
  writeFileSync(join(dir, 'recorder.cjs'), RECORDER);
  writeFileSync(join(dir, 'script.cjs'), script);
  const result = spawnSync(process.execPath, ['--require', join(dir, 'recorder.cjs'), '--require', EXEC_TOKEN_PRELOAD, join(dir, 'script.cjs')], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const out = Object.fromEntries(result.stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf(' ')), JSON.parse(line.slice(line.indexOf(' ') + 1))]));
  return out;
}

const viaHttps = (url, body, type = 'application/x-www-form-urlencoded') => String.raw`
const https = require('node:https');
const request = https.request(${JSON.stringify(url)}, {method:'POST', headers:{'content-type':${JSON.stringify(type)}}}, response => {
  let text = '';
  response.on('data', chunk => text += chunk);
  response.on('end', () => process.stdout.write('ANSWER ' + JSON.stringify({status:response.statusCode, body:JSON.parse(text)}) + '\n'));
});
request.on('error', error => process.stdout.write('ANSWER ' + JSON.stringify({error:error.message}) + '\n'));
request.end(${JSON.stringify(body)});
`;

test('the demo refresh never leaves the process, to either Google token endpoint', () => {
  // The Google auth library's (firebase-admin 13 and later, @google-cloud/*),
  // then firebase-admin's own (12 and earlier).
  for (const url of ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v4/token']) {
    const out = inProcess(viaHttps(url, DEMO));
    assert.deepEqual(out.ANSWER, {status:200, body:{access_token:'owner', expires_in:3600, token_type:'Bearer'}}, url);
    assert.deepEqual(out.LEFT, [], url);
  }
  // As JSON too, and through fetch (the auth library from version 10).
  assert.deepEqual(inProcess(viaHttps('https://oauth2.googleapis.com/token', JSON.stringify({grant_type:'refresh_token', client_id:'demo', client_secret:'demo', refresh_token:'demo'}), 'application/json')).LEFT, []);
  const fetched = inProcess(String.raw`
fetch('https://oauth2.googleapis.com/token', {method:'POST', body:new URLSearchParams(${JSON.stringify(DEMO)})})
  .then(response => response.json().then(body => process.stdout.write('ANSWER ' + JSON.stringify({status:response.status, body}) + '\n')));
`);
  assert.deepEqual(fetched.ANSWER, {status:200, body:{access_token:'owner', expires_in:3600, token_type:'Bearer'}});
  assert.deepEqual(fetched.LEFT, []);
});

test('any other request goes on as it was, a credential of your own included', () => {
  const own = inProcess(viaHttps('https://oauth2.googleapis.com/token', 'client_id=1234.apps&client_secret=s&refresh_token=1%2Freal&grant_type=refresh_token'));
  assert.deepEqual(own.LEFT, ['https oauth2.googleapis.com/token']);
  assert.match(own.ANSWER.error ?? JSON.stringify(own.ANSWER), /no network in this test|502|unreachable/);
  const other = inProcess(viaHttps('https://firestore.googleapis.com/v1/projects/p', DEMO));
  assert.deepEqual(other.LEFT, ['https firestore.googleapis.com/v1/projects/p']);
  const fetched = inProcess(String.raw`
fetch('https://oauth2.googleapis.com/token', {method:'POST', body:'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=x'})
  .catch(error => process.stdout.write('ANSWER ' + JSON.stringify({error:error.message}) + '\n'));
`);
  assert.deepEqual(fetched.LEFT, ['fetch https://oauth2.googleapis.com/token']);
});

test('the preload leaves a process alone when it cannot install itself', () => {
  // Loaded where fetch and https behave as usual, it changes no exit code and prints nothing.
  const result = spawnSync(process.execPath, ['--require', EXEC_TOKEN_PRELOAD, '-e', 'console.log(typeof fetch)'], {encoding:'utf8'});
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'function');
  assert.equal(result.stderr, '');
});
