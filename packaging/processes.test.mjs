import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { nativeEnvironment, requestNativeStop, resolveExecutable } from '../packages/cli/src/processes.mjs';

const runtime = new URL('../packages/cli/src/runtime.mjs', import.meta.url).href;
// A launcher process: supervise() running `engine` (a Node script) as the
// engine, with no test command.
function launcher(engine) {
  const script = `import {supervise} from ${JSON.stringify(runtime)};
    process.exitCode = await supervise({binary:process.execPath,args:['-e',${JSON.stringify(engine)}],cwd:process.cwd(),env:process.env});`;
  return spawn(process.execPath, ['--input-type=module', '-e', script], {stdio:['ignore','pipe','pipe']});
}
const waitFor = (child, pattern) => new Promise((resolve, reject) => {
  let text = '';
  const on = chunk => { text += chunk; if (pattern.test(text)) resolve(text); };
  child.stdout.on('data', on);
  child.stderr.on('data', on);
  child.once('exit', () => reject(new Error(`exited before ${pattern}:\n${text}`)));
});

test('Windows allocator defaults are before spawn and preserve explicit overrides', () => {
  assert.deepEqual(nativeEnvironment({},'win32'),{MIMALLOC_PURGE_DELAY:'100',MIMALLOC_PURGE_DECOMMITS:'1',FIRENOOK_CONTROL_STDIN:'1'});
  assert.equal(nativeEnvironment({MIMALLOC_PURGE_DELAY:'800'},'win32').MIMALLOC_PURGE_DELAY,'800');
  assert.deepEqual(nativeEnvironment({},'linux'),{FIRENOOK_CONTROL_STDIN:'1'});
});
test('every platform gives the engine the private pipe, whose end tells it the launcher is gone', async () => {
  for (const platform of ['darwin','linux','win32']) assert.equal(nativeEnvironment({},platform).FIRENOOK_CONTROL_STDIN,'1');
  const root = mkdtempSync(join(tmpdir(),'firenook-orphan-'));
  try {
    const marker = join(root,'stopped');
    // Stops (writing the marker) when its stdin ends, as the engine does.
    const engine = `process.stdin.resume(); process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},process.env.FIRENOOK_CONTROL_STDIN||''); process.exit(0);}); console.log('All emulators ready'); setInterval(()=>{},1000);`;
    const parent = launcher(engine);
    await waitFor(parent, /All emulators ready/);
    parent.kill('SIGKILL');
    for (let i = 0; i < 100 && !existsSync(marker); i += 1) await new Promise(done => setTimeout(done, 50));
    assert.ok(existsSync(marker), 'the engine outlived its launcher');
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('an engine that dies without being asked says why, and the launcher exits non-zero', async () => {
  const engine = `console.log('All emulators ready'); setTimeout(()=>process.kill(process.pid,'SIGKILL'),50);`;
  const parent = launcher(engine);
  let text = '';
  parent.stderr.on('data', chunk => { text += chunk; });
  const code = await new Promise(resolve => parent.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(text, /firenook: the engine was ended \(SIGKILL\) while it was running; the next start checks the data first, and repairs it if it needs to/);
  // One that exits on its own once ready is no stop either.
  const ended = launcher(`console.log('All emulators ready'); setTimeout(()=>process.exit(3),50);`);
  let said = '';
  ended.stderr.on('data', chunk => { said += chunk; });
  assert.equal(await new Promise(resolve => ended.once('exit', resolve)), 3);
  assert.match(said, /firenook: the engine stopped on its own \(exit code 3\) while it was running/);
});
test('Windows requests private graceful control, never emulates a Unix signal', () => {
  let message;
  const child = {exitCode:null,signalCode:null,stdin:{end(value){message=value;}},kill(){assert.fail('must not kill');}};
  requestNativeStop(child,'SIGINT','win32');
  assert.equal(message,'FIRENOOK_SHUTDOWN\n');
  assert.throws(()=>requestNativeStop({...child,stdin:undefined},'SIGINT','win32'),/pipe/);
});
test('runtime executable resolution accepts absolute native paths without a shell', () => {
  assert.equal(resolveExecutable(process.execPath),process.execPath);
  assert.throws(()=>resolveExecutable('firenook-missing-executable'),/not found/);
});
test('Windows never chooses an npm-generated extensionless Unix shim', () => {
  const root = mkdtempSync(join(tmpdir(),'firenook-exe-selection-'));
  try {
    const shim = join(root,'bun');
    writeFileSync(shim,'#!/bin/sh\n',{mode:0o755});
    writeFileSync(`${shim}.exe`,'synthetic executable placeholder',{mode:0o755});
    assert.equal(resolveExecutable(shim,{},'win32'),`${shim}.exe`);
  } finally {rmSync(root,{recursive:true});}
});
