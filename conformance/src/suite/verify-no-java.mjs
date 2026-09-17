// Phase G4 gate: the complete native suite starts, enforces Storage rules
// (including firestore.get against the local Firestore) and shuts down with
// `java` shadowed by a failing shim, JAVA_HOME unset and no rules runtime jar
// in the emulator cache.
// node verify-no-java.mjs binary firebase-tools-root firebase-functions-root emulator-cache output
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,symlink,cp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve,dirname,join,delimiter} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.argv.length,7,'binary toolsRoot sdkRoot emulator-cache fresh-output');
const [binary,tools,sdk,cache,output]=process.argv.slice(2,7).map(path=>resolve(path));
assert.equal(JSON.parse(await readFile(join(tools,'package.json'))).version,'15.22.0');
// The id must not contain the word the assertion below scans for: the owned
// Functions runtime prints HTTPS function URLs (with the project id) at startup.
const project='demo-fireside-without-jvm';
const bucket=project+'.appspot.com';
await mkdir(output,{mode:0o700});
const json=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// An emulator cache holding only the UI asset: the rules runtime jar must
// not be needed.
const assets=join(output,'emulators');
await mkdir(assets);
await cp(join(cache,'ui-v1.15.0.zip'),join(assets,'ui-v1.15.0.zip'));

await mkdir(join(output,'functions/node_modules'),{recursive:true});
await symlink(sdk,join(output,'functions/node_modules/firebase-functions'),'dir');
await json('functions/package.json',{name:'without-jvm-fixture',version:'1.0.0',main:'index.js',engines:{node:'24'}});
await writeFile(join(output,'functions/index.js'),"const {onRequest}=require('firebase-functions/v2/https');exports.ping=onRequest((req,res)=>res.json({ok:true}));\n");
await writeFile(join(output,'firestore.rules'),"rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if true; }\n  }\n}\n");
// A single-file Storage ruleset (the common firebase.json shape) with owner
// scoping, an admin claim, and a Firestore-backed allowlist.
await writeFile(join(output,'storage.rules'),`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth.uid == uid || request.auth.token.admin == true;
    }
    match /shared/{name} {
      allow read: if true;
      allow write: if firestore.get(/databases/(default)/documents/uploaders/$(request.auth.uid)).data.allowed == true;
    }
  }
}
`);
await json('firebase.json',{firestore:{rules:'firestore.rules'},storage:{rules:'storage.rules'},functions:[{source:'functions',codebase:'synthetic'}]});
await json('.firebaserc',{projects:{default:project}});
await mkdir(join(output,'gcloud'));
await json('demo-adc.json',{type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'});

// `java` on PATH is a shim that fails loudly and JAVA_HOME is unset, so any
// invocation by the product surfaces in the suite log instead of silently
// using a system runtime. System directories stay on PATH: the coordinator
// spawns `kill` and the Functions host spawns `npm`.
const shims=join(output,'shims');
await mkdir(shims);
await writeFile(join(shims,'java'),'#!/bin/sh\necho "java invoked by the suite: $*" >&2\nexit 127\n',{mode:0o755});
const env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','TZ','PATH'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{PATH:[shims,dirname(process.execPath),env.PATH].join(delimiter),GOOGLE_APPLICATION_CREDENTIALS:join(output,'demo-adc.json'),
  CLOUDSDK_CONFIG:join(output,'gcloud'),GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project,FIRESIDE_CONTROL_STDIN:'1'});
const javaProbe=spawnSync('java',['-version'],{env,encoding:'utf8'});
assert.equal(javaProbe.status,127,`java on the suite PATH must be the failing shim: ${javaProbe.stderr}`);

const reservations=[],ports={};
for(const service of ['firestore','auth','storage','functions','pubsub','hub','ui','firestore-websocket','logging','eventarc','tasks']){
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  ports[service]=listener.address().port;reservations.push(listener);
}
const args=['suite','--host','127.0.0.1','--project-id',project,'--project-dir',output,'--state-dir',join(output,'state'),
  '--firebase-tools-root',tools,'--node',process.execPath,'--ui-archive',join(assets,'ui-v1.15.0.zip')];
for(const [service,port] of Object.entries(ports))args.push('--'+service+'-port',String(port));
await Promise.all(reservations.map(listener=>new Promise(resolve=>listener.close(resolve))));
const child=spawn(binary,args,{cwd:output,env,stdio:['pipe','pipe','pipe']});
const exited=once(child,'exit');let log='';
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const origin=service=>`http://127.0.0.1:${ports[service]}`;
const jwt=claims=>{const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');return `${encode({alg:'none',typ:'JWT'})}.${encode({...claims,iat:1700000000,exp:4102444800,aud:project,iss:`https://securetoken.google.com/${project}`})}.`;};
const alice=jwt({sub:'alice',user_id:'alice'}),bob=jwt({sub:'bob',user_id:'bob'}),admin=jwt({sub:'root',user_id:'root',admin:true});
const record={passed:false,acceptance:false,syntheticOnly:true,node:process.version,javaShimmed:true,javaHomeUnset:true,cacheAssets:['ui-v1.15.0.zip'],
  binarySha256:hash(await readFile(binary)),driverSha256:hash(await readFile(new URL(import.meta.url))),storageConfigShape:'single-file',steps:[]};
const step=async(name,method,path,{auth,body,type='text/plain'}={})=>{
  const response=await fetch(origin('storage')+path,{method,headers:{...(auth?{authorization:`Bearer ${auth}`}:{}),...(body===undefined?{}:{'content-type':type})},body});
  const text=await response.text();
  record.steps.push({name,method,path,status:response.status});
  return {status:response.status,text};
};
try{
  const started=performance.now();
  while(!log.includes('\nAll emulators ready\n')){
    assert(child.exitCode===null,log);assert(performance.now()-started<180000,'native suite startup deadline');await delay(100);
  }
  record.readyMilliseconds=performance.now()-started;
  const object=encodeURIComponent('users/alice/deck.png');
  assert.equal((await step('anonymous upload denied','POST',`/v0/b/${bucket}/o?name=${object}`,{body:'png'})).status,403);
  assert.equal((await step('owner upload allowed','POST',`/v0/b/${bucket}/o?name=${object}`,{auth:alice,body:'png'})).status,200);
  assert.equal((await step('owner read allowed','GET',`/v0/b/${bucket}/o/${object}?alt=media`,{auth:alice})).status,200);
  assert.equal((await step('other user denied','GET',`/v0/b/${bucket}/o/${object}?alt=media`,{auth:bob})).status,403);
  assert.equal((await step('admin claim allowed','GET',`/v0/b/${bucket}/o/${object}`,{auth:admin})).status,200);
  assert.equal((await step('owner list allowed','GET',`/v0/b/${bucket}/o?prefix=users%2Falice%2F&delimiter=%2F`,{auth:alice})).status,200);
  assert.equal((await step('other user list denied','GET',`/v0/b/${bucket}/o?prefix=users%2Falice%2F&delimiter=%2F`,{auth:bob})).status,403);
  const shared=encodeURIComponent('shared/notes.txt');
  assert.equal((await step('firestore.get missing document denies','POST',`/v0/b/${bucket}/o?name=${shared}`,{auth:alice,body:'notes'})).status,403);
  const write=await fetch(`${origin('firestore')}/v1/projects/${project}/databases/(default)/documents/uploaders/alice`,{method:'PATCH',headers:{'content-type':'application/json',authorization:'Bearer owner'},body:JSON.stringify({fields:{allowed:{booleanValue:true}}})});
  assert.equal(write.status,200,await write.text());
  assert.equal((await step('firestore.get latest state allows','POST',`/v0/b/${bucket}/o?name=${shared}`,{auth:alice,body:'notes'})).status,200);
  assert.equal((await step('firestore.get other user denies','POST',`/v0/b/${bucket}/o?name=${shared}`,{auth:bob,body:'notes'})).status,403);
  assert.equal((await step('public read of shared object','GET',`/v0/b/${bucket}/o/${shared}?alt=media`)).status,200);
  const reload=await fetch(origin('storage')+'/internal/setRules',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rules:{files:[{name:'storage.rules',content:"rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} { allow read: if false; }\n  }\n}\n"}]}})});
  assert.equal(reload.status,200,await reload.text());
  assert.equal((await step('reloaded ruleset denies owner read','GET',`/v0/b/${bucket}/o/${object}`,{auth:alice})).status,403);
  assert(!log.includes('java invoked by the suite'),'the suite must never invoke java');
  assert(!/\bjava\b/i.test(log),'the suite must not mention Java');
  record.passed=true;
}finally{
  if(child.exitCode===null&&child.signalCode===null)child.stdin.end('FIRESIDE_SHUTDOWN\n');
  const result=await Promise.race([exited,delay(20000,null,{ref:false})]);
  await writeFile(join(output,'suite.log'),log);
  await json('result.json',{...record,shutdown:result});
  await rm(join(output,'functions/node_modules'),{recursive:true,force:true});
  assert(result,'owned suite shutdown deadline; preserve live child for diagnosis');
  assert.equal(result[0],0,`suite exit ${result}`);
}
