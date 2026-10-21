import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLoads, loaderProblem, platformKey } from '../packages/cli/src/binary.mjs';

// What the loaders of amazonlinux:2 (glibc 2.26) and ubuntu:22.04 (2.35)
// printed for the engine built against 2.28 and for 0.2.0-next.8's, built
// against the runner's 2.39.
const tooOld = "/firenook: /lib64/libc.so.6: version `GLIBC_2.27' not found (required by /firenook)\n/firenook: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by /firenook)\n";
const tooNew = "/firenook: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /firenook)\n";
const enoent = Object.assign(new Error('spawnSync /consumer/node_modules/@firenook/cli-linux-x64/bin/firenook ENOENT'), {code: 'ENOENT'});

test('the loader refusing an old glibc reads as what is needed, what is here, and the way out', () => {
  const said = loaderProblem({stderr: tooOld}, {glibc: () => '2.26'});
  assert.equal(said, 'the Linux engine needs glibc 2.28 or newer, and this system has glibc 2.26. Use a newer system or image: RHEL 8, Debian 10, Ubuntu 20.04 or later, or node:24 or node:24-slim');
  // An engine that asks for more than it promises is named for what it asks.
  assert.match(loaderProblem({stderr: tooNew}, {glibc: () => '2.35'}), /^the Linux engine needs glibc 2\.39 or newer, and this system has glibc 2\.35\. Use a newer system or image: one with glibc 2\.39 or newer$/);
  for (const quoted of ["version 'GLIBC_2.28' not found", 'version ‘GLIBC_2.28’ not found']) {
    assert.match(loaderProblem({stderr: `/firenook: /lib64/libc.so.6: ${quoted} (required by /firenook)`}, {glibc: () => '2.17'}), /needs glibc 2\.28 or newer, and this system has glibc 2\.17/);
  }
});
test('no glibc loader at all: musl says Alpine and node:24-slim, a glibc without the usual path says nix-ld', () => {
  assert.equal(loaderProblem({error: enoent}, {glibc: () => undefined}),
    'the Linux engine needs glibc 2.28 or newer, and this system has no glibc: its C library is musl, as on Alpine Linux. Use a glibc system or image instead, such as node:24 or node:24-slim rather than node:24-alpine');
  assert.match(loaderProblem({error: enoent}, {arch: 'arm64', glibc: () => '2.40'}), /needs glibc's loader at \/lib\/ld-linux-aarch64\.so\.1, and this system has none there, though it has glibc 2\.40\. NixOS keeps it elsewhere: enable programs\.nix-ld/);
  assert.match(loaderProblem({stderr: '/firenook: error while loading shared libraries: libgcc_s.so.1: cannot open shared object file: No such file or directory\n'}, {glibc: () => '2.36'}),
    /^the Linux engine needs libgcc_s\.so\.1 from the system, which this system does not have/);
  // Any other failure is the engine's own, and is left to tell itself.
  for (const failure of [{stderr: 'error: unexpected argument'}, {error: Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'})}, {}]) {
    assert.equal(loaderProblem(failure, {glibc: () => '2.36'}), undefined);
  }
});
test('binary-path starts the engine once and throws the plain words for an injected loader refusal', () => {
  const calls = [];
  const run = result => (binary, args, options) => { calls.push({binary, args, options}); return result; };
  assert.throws(() => checkLoads('/x/firenook', {run: run({status: 1, stderr: tooOld}), glibc: () => '2.26'}),
    {message: /^the Linux engine needs glibc 2\.28 or newer, and this system has glibc 2\.26\./});
  assert.deepEqual(calls[0].args, ['--version']);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.throws(() => checkLoads('/x/firenook', {run: run({status: null, error: enoent, stderr: ''}), glibc: () => undefined}), /musl, as on Alpine Linux/);
  assert.equal(checkLoads('/x/firenook', {run: run({status: 0, stdout: 'firenook 0.2.0\n', stderr: ''})}), '/x/firenook');
  assert.equal(checkLoads('/x/firenook', {run: run({status: 2, stderr: 'error: something else'}), glibc: () => '2.36'}), '/x/firenook');
});
test('a Linux without glibc is refused before any engine is looked for, in the same words', () => {
  for (const arch of ['x64', 'arm64']) assert.throws(() => platformKey('linux', arch, {header: {}}), /needs glibc 2\.28 or newer, and this system has no glibc: its C library is musl/);
  assert.equal(platformKey('linux', 'x64', {header: {glibcVersionRuntime: '2.28'}}), 'linux-x64');
});
