// Phase G3 measurement: rules-evaluated Storage cycles (user-token multipart
// upload, metadata GET, media GET, DELETE under a scoped ruleset) and suite
// readiness, for one engine. Run once per engine on the same host and compare
// the receipts; engines before 0.1.0-next.7 take --java-runtime to receive the
// Java rules runtime arguments they require.
// node profile-storage-rules.mjs binary firebase-tools-root firebase-functions-root emulator-cache output.json [--java-runtime]
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import os from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const javaRuntime=process.argv[7]==='--java-runtime';
assert(process.argv.length===7||(process.argv.length===8&&javaRuntime),'binary toolsRoot sdkRoot emulator-cache output.json [--java-runtime]');
const [binary,tools,sdk,cache,outputPath]=process.argv.slice(2,7).map(path=>resolve(path));
const WARMUP=10,MEASURED=200;
const project='demo-fireside-rules-profile';
const bucket=project+'.appspot.com';
const output=await mkdtemp(join(os.tmpdir(),'fireside-rules-profile-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
await mkdir(join(output,'functions/node_modules'),{recursive:true});
await symlink(sdk,join(output,'functions/node_modules/firebase-functions'),'dir');
await json('functions/package.json',{name:'rules-profile',version:'1.0.0',main:'index.js',engines:{node:'24'}});
await writeFile(join(output,'functions/index.js'),"const {onRequest}=require('firebase-functions/v2/https');exports.ping=onRequest((req,res)=>res.json({ok:true}));\n");
await writeFile(join(output,'storage.rules'),"rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /users/{uid}/{allPaths=**} {\n      allow read, write: if request.auth.uid == uid || request.auth.token.admin == true;\n    }\n  }\n}\n");
await json('firebase.json',{storage:[{target:'default',rules:'storage.rules'}],functions:[{source:'functions',codebase:'synthetic'}]});
await json('.firebaserc',{projects:{default:project},targets:{[project]:{storage:{default:[bucket]}}}});
await mkdir(join(output,'gcloud'));
await json('demo-adc.json',{type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'});
const reservations=[],ports={};
for(const service of ['firestore','auth','storage','functions','pubsub','hub','ui','firestore-websocket','logging','eventarc','tasks']){
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  ports[service]=listener.address().port;reservations.push(listener);
}
const env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','TZ','PATH','JAVA_HOME'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{PATH:dirname(process.execPath)+':'+env.PATH,GOOGLE_APPLICATION_CREDENTIALS:join(output,'demo-adc.json'),CLOUDSDK_CONFIG:join(output,'gcloud'),GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project,FIRESIDE_CONTROL_STDIN:'1'});
const args=['suite','--host','127.0.0.1','--project-id',project,'--project-dir',output,'--state-dir',join(output,'state'),
  '--storage-bucket','default='+bucket,'--firebase-tools-root',tools,'--node',process.execPath,'--ui-archive',join(cache,'ui-v1.15.0.zip')];
if(javaRuntime)args.push('--java',process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/java'):'/usr/bin/java','--storage-rules-jar',join(cache,'cloud-storage-rules-runtime-v1.1.3.jar'));
for(const [service,port] of Object.entries(ports))args.push('--'+service+'-port',String(port));
await Promise.all(reservations.map(listener=>new Promise(resolve=>listener.close(resolve))));
const launched=performance.now();
const child=spawn(binary,args,{cwd:output,env,stdio:['pipe','pipe','pipe']});
const exited=once(child,'exit');let log='';
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const origin=`http://127.0.0.1:${ports.storage}`;
const jwt=claims=>{const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');return `${encode({alg:'none',typ:'JWT'})}.${encode({...claims,iat:1700000000,exp:4102444800,aud:project,iss:`https://securetoken.google.com/${project}`})}.`;};
const alice=jwt({sub:'alice',user_id:'alice'}),bob=jwt({sub:'bob',user_id:'bob'});
const boundary='fireside-rules-profile';
const payload=Buffer.from(JSON.stringify({synthetic:true,values:Array.from({length:256},(_,n)=>hash('profile-item-'+n))}));
const multipart=name=>Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({name,contentType:'application/json',metadata:{owner:'alice'}})}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
  payload,Buffer.from(`\r\n--${boundary}--\r\n`)]);
const receipt={passed:false,acceptance:false,syntheticOnly:true,engine:javaRuntime?'java-rules-runtime':'native-rules',
  binarySha256:hash(await readFile(binary)),driverSha256:hash(await readFile(new URL(import.meta.url))),node:process.version,
  host:{platform:os.platform(),release:os.release(),arch:os.arch(),cpus:os.cpus().length,totalMemoryBytes:os.totalmem()},
  payloadBytes:payload.length,warmupCycles:WARMUP,measuredCycles:MEASURED,cycles:[]};
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(p/100*sorted.length)-1)];};
try{
  while(!log.includes('\nAll emulators ready\n')){assert(child.exitCode===null,log);assert(performance.now()-launched<180000,'startup deadline');await delay(50);}
  receipt.readyMilliseconds=performance.now()-launched;
  await delay(500);
  for(let index=0;index<WARMUP+MEASURED;index++){
    const name=`users/alice/profile/${index}.json`;const path=`/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
    const cycle={index,warmup:index<WARMUP,operations:{}};
    let start=performance.now();
    let response=await fetch(`${origin}/v0/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(name)}`,{method:'POST',headers:{authorization:`Bearer ${alice}`,'x-goog-upload-protocol':'multipart','content-type':`multipart/related; boundary=${boundary}`},body:multipart(name)});
    if(response.status!==200)assert.fail(`upload ${response.status}: ${await response.text()}`);
    await response.arrayBuffer();
    cycle.operations.uploadMilliseconds=performance.now()-start;
    start=performance.now();
    response=await fetch(origin+path,{headers:{authorization:`Bearer ${alice}`}});assert.equal(response.status,200);await response.arrayBuffer();
    cycle.operations.metadataMilliseconds=performance.now()-start;
    start=performance.now();
    response=await fetch(origin+path+'?alt=media',{headers:{authorization:`Bearer ${alice}`}});assert.equal(response.status,200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(payload));
    cycle.operations.downloadMilliseconds=performance.now()-start;
    start=performance.now();
    response=await fetch(origin+path,{headers:{authorization:`Bearer ${bob}`}});assert.equal(response.status,403);await response.arrayBuffer();
    cycle.operations.deniedReadMilliseconds=performance.now()-start;
    start=performance.now();
    response=await fetch(origin+path,{method:'DELETE',headers:{authorization:`Bearer ${alice}`}});assert.equal(response.status,204);await response.arrayBuffer();
    cycle.operations.deleteMilliseconds=performance.now()-start;
    receipt.cycles.push(cycle);
  }
  const measured=receipt.cycles.filter(cycle=>!cycle.warmup);
  receipt.summary={};
  for(const operation of ['uploadMilliseconds','metadataMilliseconds','downloadMilliseconds','deniedReadMilliseconds','deleteMilliseconds']){
    const values=measured.map(cycle=>cycle.operations[operation]);
    receipt.summary[operation]={p50:percentile(values,50),p95:percentile(values,95),p99:percentile(values,99),mean:values.reduce((a,b)=>a+b,0)/values.length};
  }
  receipt.passed=true;
}finally{
  if(child.exitCode===null&&child.signalCode===null)child.stdin.end('FIRESIDE_SHUTDOWN\n');
  const result=await Promise.race([exited,delay(30000,null,{ref:false})]);
  receipt.shutdown=result;receipt.finishedAt=new Date().toISOString();
  await writeFile(outputPath,JSON.stringify(receipt,null,2)+'\n');
  await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({engine:receipt.engine,readyMilliseconds:Math.round(receipt.readyMilliseconds),summary:Object.fromEntries(Object.entries(receipt.summary).map(([k,v])=>[k,{p50:+v.p50.toFixed(2),p99:+v.p99.toFixed(2)}]))}));
