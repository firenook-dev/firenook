// Tiny synthetic complete-suite adapter check. Never uses consumer env/data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { packageManager } from './package-manager.mjs';

const [directoryArgument] = process.argv.slice(2);
const directory = resolve(directoryArgument);
const receipt = JSON.parse(readFileSync(join(directory,'npm-smoke.json')));
const root = join(receipt.consumer,'suite-smoke');
mkdirSync(root);
const cli = join(receipt.consumer,'node_modules/firenook/bin/firenook.mjs');
const env = {...process.env};
packageManager('npm',['install','--ignore-scripts','--no-audit','--no-fund','firebase-functions@7.2.5'],{cwd:receipt.consumer,env,stdio:'inherit'});
execFileSync(process.execPath,[cli,'setup'],{env,stdio:'inherit'});
const names = ['firestore','auth','storage','functions','pubsub','hub','ui','logging','eventarc','tasks','websocket'];
const reservations = names.map(()=>createServer());
const ports = {};
for (const [i,server] of reservations.entries()) {server.listen(0,'127.0.0.1'); await once(server,'listening'); ports[names[i]]=server.address().port;}
await Promise.all(reservations.map(server=>new Promise(resolve=>server.close(resolve))));
const project = 'demo-package-suite';
const config = {firestore:{rules:'firestore.rules'},storage:[{target:'default',rules:'storage.rules'}],functions:{source:'functions'},
  emulators:Object.fromEntries(names.filter(name=>name!=='websocket').map(name=>[name,{host:'127.0.0.1',port:ports[name]}]))};
writeFileSync(join(root,'firebase.json'),JSON.stringify(config));
writeFileSync(join(root,'.firebaserc'),JSON.stringify({projects:{default:project},targets:{[project]:{storage:{default:[`${project}.appspot.com`]}}}}));
writeFileSync(join(root,'firestore.rules'),"rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }");
writeFileSync(join(root,'storage.rules'),"rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{object=**} { allow read, write: if true; } } }");
mkdirSync(join(root,'functions'));
writeFileSync(join(root,'functions/package.json'),JSON.stringify({name:'firenook-smoke-functions',main:'index.cjs',engines:{node:'24'},dependencies:{'firebase-functions':'7.2.5'}}));
writeFileSync(join(root,'functions/index.cjs'),"const {onRequest}=require('firebase-functions/v2/https'); exports.echo=onRequest((req,res)=>res.json({ok:true}));\n");
writeFileSync(join(root,'check.cjs'),`
const assert = require('node:assert/strict');
const {Firestore} = require('@google-cloud/firestore');
(async()=>{
 const client = new Firestore({projectId:process.env.GCLOUD_PROJECT});
 try {
  const ref = client.doc('packaging/document');
  if(process.argv[2] === 'write') await ref.set({text:'中文 😀 suite'});
  assert.equal((await ref.get()).data().text,'中文 😀 suite');
  const response = await fetch('http://127.0.0.1:${ports.functions}/${project}/us-central1/echo');
  assert.equal(response.status,200); assert.deepEqual(await response.json(),{ok:true});
  const authAction = process.argv[2] === 'write' ? 'signUp' : 'signInWithPassword';
  const auth = await fetch('http://127.0.0.1:${ports.auth}/identitytoolkit.googleapis.com/v1/accounts:'+authAction+'?key=demo-key', {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'package@example.test',password:'synthetic-package-test-123',returnSecureToken:true})});
  assert.equal(auth.status,200,'Auth create/re-import login');
  assert.ok((await auth.json()).idToken);
  const storage = 'http://127.0.0.1:${ports.storage}/v0/b/${project}.appspot.com/o';
  if(process.argv[2] === 'write') {
    const upload = await fetch(storage+'?name=package.json&uploadType=media', {
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'中文 😀 storage'})});
    assert.equal(upload.status,200,'Storage upload through open rules');
  }
  const download = await fetch(storage+'/package.json?alt=media');
  assert.equal(download.status,200,'Storage read/re-import through native rules');
  assert.deepEqual(await download.json(),{text:'中文 😀 storage'});
  const topic = 'http://127.0.0.1:${ports.pubsub}/v1/projects/${project}/topics/package-smoke';
  assert.equal((await fetch(topic,{method:'PUT',headers:{'content-type':'application/json'},body:'{}'})).status,200);
  const publication = await fetch(topic+':publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{data:Buffer.from('package').toString('base64')}]})});
  assert.equal(publication.status,200); assert.equal((await publication.json()).messageIds.length,1);
  assert.equal((await fetch('http://127.0.0.1:${ports.ui}/')).status,200,'UI asset serving');
 } finally {await client.terminate();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
const logs = [];
async function run(mode, imported, exported, state) {
  // --ui: like the official CLI, emulators:exec keeps the Emulator UI off unless asked; the check asserts it.
  const args = [cli,'emulators:exec','--ui','--project',project,'--minimum-functions','1','--firestore-websocket-port',String(ports.websocket),'--state-dir',state,'--export-on-exit',exported];
  if(imported) args.push('--import',imported);
  args.push('--',process.execPath,'check.cjs',mode);
  const child = spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let log = '';
  child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk)});
  child.stderr.on('data',chunk=>{log+=chunk;process.stderr.write(chunk)});
  let timedOut = false;
  const timeout = setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},120000);
  const [code,signal] = await once(child,'close'); clearTimeout(timeout);
  logs.push(log);
  writeFileSync(join(root,`${mode}.log`),log);
  assert.equal(timedOut,false,'Suite smoke exceeded two minutes');
  assert.equal(code,0,`Suite smoke failed (${signal}): ${log}`);
  assert.ok(readFileSync(join(root,exported,'firebase-export-metadata.json')).length);
}
await run('write',undefined,'export','state');
await run('reopen','export','export-after-reopen','state-after-reopen');

// The terminal UI: emulators:start as a terminal runs it, through the
// installed package's own session against the packaged engine, with the
// keyboard and the screen stood in for. It draws the start-up and the
// ready summary, shows a call, and q stops it export-first.
async function terminal() {
  const pkg = join(receipt.consumer,'node_modules/firenook');
  const load = file => import(pathToFileURL(join(pkg,'src',file)).href);
  const [{runInteractive},{diagnose,prepareLaunch},{parseOptions}] = await Promise.all([load('session.mjs'),load('runtime.mjs'),load('options.mjs')]);
  const typed = ['--project',project,'--minimum-functions','1','--firestore-websocket-port',String(ports.websocket),'--state-dir','state-terminal'];
  const {options} = parseOptions(typed);
  const previous = process.env.FIRENOOK_NO_UPDATE_CHECK;
  process.env.FIRENOOK_NO_UPDATE_CHECK = '1';
  const diagnostic = await diagnose(options, root, {quiet:true});
  const launch = prepareLaunch(diagnostic, options, 'start', typed, {quiet:true});
  let screen = '';
  const out = new Writable({write(chunk,_encoding,done) { screen += chunk; done(); }});
  Object.assign(out, {isTTY:true, columns:100, rows:40});
  const input = new EventEmitter();
  Object.assign(input, {isTTY:true, isRaw:false, setRawMode(on) { this.isRaw = on; }, resume() {}, pause() {}});
  const shown = () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;.*?\x1b\\/g,'');
  const session = runInteractive(launch, {version:receipt.version, projectId:project, demo:true, cwd:root, out, input, env:{...process.env, FIRENOOK_NO_UPDATE_CHECK:'1'}});
  const until = async (test, what) => {
    for (let waited = 0; !test(); waited += 100) {
      assert.ok(waited < 120000, `the terminal never showed ${what}:\n${shown()}`);
      await new Promise(done => setTimeout(done, 100));
    }
  };
  try {
    await until(() => shown().includes('All emulators ready'), 'readiness');
    const response = await fetch(`http://127.0.0.1:${ports.functions}/${project}/us-central1/echo`);
    assert.equal(response.status,200);
    await until(() => /echo\s+\d+ ms\s+http/.test(shown()), 'the call');
  } finally {
    input.emit('data', Buffer.from('q'));
  }
  const code = await session;
  if (previous === undefined) delete process.env.FIRENOOK_NO_UPDATE_CHECK; else process.env.FIRENOOK_NO_UPDATE_CHECK = previous;
  writeFileSync(join(root,'terminal.log'),shown());
  assert.equal(code,0,`the terminal session ended with ${code}:\n${shown()}`);
  for (const expected of ['Start-up','Firestore','Functions','All emulators ready',`http://127.0.0.1:${ports.ui}/console`,'stopped']) assert.ok(shown().includes(expected),`${expected} in:\n${shown()}`);
  assert.ok(!shown().includes('FIRENOOK_EVENT'),'no event line reaches the screen');
  assert.equal(input.isRaw,false,'the keyboard is given back');
}
await terminal();
writeFileSync(join(directory,'suite-smoke.json'),JSON.stringify({passed:true,version:receipt.version,engineRevision:receipt.engineRevision,
  checks:['packaged full-profile setup','doctor dependencies via start','exec readiness','Firestore Unicode write/read','Functions HTTP','Auth create and re-import login','Storage rules/upload/download/re-import','PubSub create/publish','UI serving','export-first shutdown','official-format re-import','second export','terminal UI start, call and stop'],root,completedAt:new Date().toISOString()},null,2)+'\n');
console.log(`Complete-suite adapter smoke passed: ${root}`);
