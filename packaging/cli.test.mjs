import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NODE_TESTED, manifest, nodeCheck, platformKey, release, sha256, verifyBinary } from '../packages/cli/src/binary.mjs';
import { canonical, inspectProject, launchContext, loadProject, parseOptions, selectProject } from '../packages/cli/src/options.mjs';
import { DEMO_TOKEN_PATH, diagnose, execEnvironment, prepareLaunch, supervise, vendorExtensions } from '../packages/cli/src/runtime.mjs';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-cli-test-'));
  const config = {firestore:{rules:'firestore.rules'}, storage:[{target:'default',rules:'storage.rules'}], functions:{source:'functions'},
    emulators:Object.fromEntries(['firestore','auth','storage','functions','pubsub'].map(name=>[name,{}]))};
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-fixture', local:'demo-local'}}));
  const save = data => writeFileSync(join(dir, 'firebase.json'), JSON.stringify(data));
  return {dir, config, save, options:{'storage-bucket':[]}};
}
function binaryPackage() {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-bin-test-'));
  mkdirSync(join(dir,'bin'));
  writeFileSync(join(dir,'bin/firenook'), '#!/bin/sh\nexit 0\n', {mode:0o755});
  writeFileSync(join(dir,'package.json'), JSON.stringify({name:'@firenook/cli-darwin-arm64',version:manifest.version}));
  const receipt = {version:manifest.version,platform:'darwin-arm64',target:release.platforms['darwin-arm64'],engineRevision:release.engineRevision,sha256:sha256(readFileSync(join(dir,'bin/firenook')))};
  writeFileSync(join(dir,'receipt.json'), JSON.stringify(receipt));
  return {dir,receipt};
}
// A launch through prepareLaunch with the banner captured instead of printed.
function launchFor(dir, options, mode = 'start', typed = []) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const diagnostic = {project:loadProject(options, dir), binary:'/fake'};
    return {...prepareLaunch(diagnostic, options, mode, typed), stderr:lines.join('\n')};
  } finally { console.error = original; }
}
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test('CLI source oracle pins export conventions', () => {
  const oracle = JSON.parse(readFileSync(new URL('fixtures/firebase-cli-15.22.0.json', import.meta.url)));
  assert.equal(oracle.exportWithoutImportOrDestination,'reject');
});
test('registry-only exact dependencies; no lifecycle scripts or source-build installer', () => {
  assert.equal(manifest.scripts,undefined);
  assert.equal(manifest.name,'firenook');
  for (const version of Object.values({...manifest.dependencies,...manifest.optionalDependencies})) assert.match(version,/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/);
  assert.equal(manifest.bin.firenook,'bin/firenook.mjs');
});
test('npx gets this release on any Node npm runs on; the emulators start on Node 22, 24 and 26', () => {
  // A release whose engines exclude the running Node is skipped for the
  // 0.0.0 placeholder by `npx firenook`, with no word about why.
  assert.equal(manifest.engines.node,'>=20');
  assert.deepEqual(NODE_TESTED,[22,24,26]);
  const major = version => Number(version.split('.')[0]);
  for (const version of ['22.23.3','24.20.0','26.9.0','22.0.0']) assert.deepEqual(nodeCheck(version),{version,major:major(version),tested:true});
  // Older than the oldest tested line: refused, with the way to switch.
  for (const version of ['20.20.2','21.7.3','18.20.8']) {
    assert.deepEqual(nodeCheck(version),{version,major:major(version),tested:false,
      problem:`the emulators need Node 22, 24 or 26, since your Functions run on it; this is Node ${version}. Switch to Node 24 (with nvm: nvm install 24) and run it again`});
  }
  // An odd or a newer major: started with a warning, as the official
  // emulator runs on any Node from its floor up.
  for (const version of ['23.11.1','25.2.1','27.0.0','28.1.0']) {
    assert.deepEqual(nodeCheck(version),{version,major:major(version),tested:false,
      note:`Node ${version} is not one the emulators are tested on (22, 24 and 26); they start on it, and your Functions run on it. If something behaves differently, switch to Node 24 (with nvm: nvm install 24)`});
  }
  assert.match(nodeCheck('unknown').problem,/this is Node unknown\./);
});
test('doctor reports the Node it runs on, a refused one among its problems, instead of stopping at it', async () => {
  const {dir,options} = project();
  const quietly = node => diagnose(options,dir,{report:true,quiet:true,node:nodeCheck(node),locate:()=>'/fake/firenook'});
  for (const version of ['22.23.3','24.20.0','26.9.0']) {
    const report = await quietly(version);
    assert.deepEqual(report.node,{version,major:Number(version.split('.')[0]),tested:true,path:process.execPath});
    assert.deepEqual(report.problems,[]);
    assert.equal(report.binary,'/fake/firenook');
  }
  const refused = await quietly('20.20.2');
  assert.equal(refused.node.tested,false);
  assert.deepEqual(refused.problems,[nodeCheck('20.20.2').problem]);
  assert.equal(refused.project.project,'demo-fixture');
  const newer = await quietly('27.0.0');
  assert.deepEqual(newer.problems,[]);
  assert.equal(newer.node.note,nodeCheck('27.0.0').note);
  assert.equal(newer.warnings[0],`Firenook: ${nodeCheck('27.0.0').note}`);
  // A missing engine is a problem of the report too.
  const missing = await diagnose(options,dir,{report:true,quiet:true,node:nodeCheck('26.9.0'),locate:()=>{ throw new Error('Missing @firenook/cli-darwin-arm64@0.0.0.'); }});
  assert.equal(missing.binary,undefined);
  assert.deepEqual(missing.problems,['Missing @firenook/cli-darwin-arm64@0.0.0.']);
  // A start still stops at a refused Node, and warns on an untested one.
  await assert.rejects(diagnose(options,dir,{quiet:true,node:nodeCheck('20.20.2'),locate:()=>'/fake/firenook'}),/need Node 22, 24 or 26/);
  assert.equal((await diagnose(options,dir,{quiet:true,node:nodeCheck('25.2.1'),locate:()=>'/fake/firenook'})).warnings[0],`Firenook: ${nodeCheck('25.2.1').note}`);
  // The command itself, on the Node running this test: its JSON, whatever
  // else this checkout lacks (it has no platform package).
  const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs',import.meta.url));
  const run = spawnSync(process.execPath,[cli,'doctor'],{cwd:dir,encoding:'utf8'});
  const printed = JSON.parse(run.stdout);
  assert.equal(printed.node.version,process.versions.node);
  assert.equal(printed.node.path,process.execPath);
  assert.equal(run.status,printed.problems.length ? 1 : 0);
  if (NODE_TESTED.includes(Number(process.versions.node.split('.')[0]))) assert.ok(printed.problems.every(problem => !problem.includes('Node')),printed.problems.join('\n'));
});
test('explicit supported platforms; untested architectures and musl rejected', () => {
  assert.equal(platformKey('linux','x64',{header:{glibcVersionRuntime:'2.39'}}),'linux-x64');
  assert.equal(platformKey('darwin','arm64',{}),'darwin-arm64');
  for (const key of Object.keys(release.platforms)) {
    const [os, cpu] = key.split('-');
    assert.equal(platformKey(os,cpu,{header:{glibcVersionRuntime:'2.39'}}),key);
  }
  for (const args of [['win32','ia32',{}],['darwin','ia32',{}]]) assert.throws(()=>platformKey(...args),/Unsupported/);
  for (const args of [['linux','x64',{}],['linux','arm64',{}]]) assert.throws(()=>platformKey(...args),/needs glibc 2\.28 or newer, and this system has no glibc/);
});
test('binary checks identity, target, checksum and executable bit', () => {
  const {dir,receipt} = binaryPackage();
  assert.equal(verifyBinary(dir,'darwin-arm64'),join(dir,'bin/firenook'));
  for (const [key,value] of [['version','9.9.9'],['engineRevision','wrong'],['platform','linux-x64'],['target','wrong'],['sha256','wrong']]) {
    writeFileSync(join(dir,'receipt.json'),JSON.stringify({...receipt,[key]:value}));
    assert.throws(()=>verifyBinary(dir,'darwin-arm64'));
  }
  writeFileSync(join(dir,'receipt.json'),JSON.stringify(receipt));
  chmodSync(join(dir,'bin/firenook'),0o600);
  if (process.platform !== 'win32') assert.throws(()=>verifyBinary(dir,'darwin-arm64'));
});
test('options preserve argv; no ignored flags, duplicate options or shell interpretation', () => {
  const parsed = parseOptions(['--project=demo-a','--import','seed','--export-on-exit','--storage-bucket','default=demo-a','--','echo','hello;touch nope']);
  assert.equal(parsed.options['export-on-exit'],true);
  assert.deepEqual(parsed.command,['echo','hello;touch nope']);
  assert.deepEqual(parsed.positionals,[]);
  assert.equal(parseOptions(['--no-diagnostics']).options['no-diagnostics'], true);
  assert.equal(parseOptions(['--allowed-hosts', 'console.example.test']).options['allowed-hosts'], 'console.example.test');
  assert.throws(() => parseOptions(['--allowed-hosts']));
  assert.throws(() => parseOptions(['--no-diagnostics=false']));
  for (const args of [['--wat'],['-x'],['--project'],['--project=a','--project=b'],['--resume-state=false'],['--durability','eventually'],['--log-verbosity','LOUD'],['-r','--shallow'],['--functions','--no-functions']]) assert.throws(()=>parseOptions(args));
  assert.equal(parseOptions(['--durability=per-commit']).options.durability, 'per-commit');
});
test('official short aliases, compatibility switches and bare positionals are parsed', () => {
  const parsed = parseOptions(['-P','demo-a','-c','other/firebase.json','--non-interactive','--json','--log-verbosity','debug','-r','-f','users','x']);
  assert.equal(parsed.options.project,'demo-a');
  assert.equal(parsed.options.config,'other/firebase.json');
  assert.equal(parsed.options['non-interactive'],true);
  assert.equal(parsed.options['log-verbosity'],'DEBUG');
  assert.equal(parsed.options.recursive,true);
  assert.equal(parsed.options.force,true);
  assert.deepEqual(parsed.positionals,['users','x']);
  assert.deepEqual(parsed.flags,['-P','demo-a','-c','other/firebase.json','--non-interactive','--json','--log-verbosity','debug','-r','-f']);
  // A bare --export-on-exit never swallows a following short flag.
  assert.equal(parseOptions(['--export-on-exit','-f']).options['export-on-exit'],true);
  assert.equal(parseOptions(['-C','x.json']).options.config,'x.json');
  assert.equal(parseOptions(['-h']).options.help,true);
});
test('existing config, project aliases and full or partial --only selection', () => {
  const {dir,options} = project();
  const full = loadProject(options,dir);
  assert.equal(full.project,'demo-fixture');
  assert.equal(full.demo,true);
  assert.deepEqual(full.services,['firestore','auth','storage','functions','pubsub']);
  assert.equal(full.minimumFunctions,'1');
  assert.equal(loadProject({...options,project:'local'},dir).project,'demo-local');
  assert.equal(loadProject({...options,only:'storage,auth,firestore,pubsub,functions'},dir).ports.firestore,8080);
  assert.deepEqual(loadProject({...options,only:'auth,firestore'},dir).services,['firestore','auth']);
  // extensions maps to functions, a codebase suffix is dropped, followers are ignored.
  assert.deepEqual(loadProject({...options,only:'extensions,ui,hub,eventarc,tasks,logging'},dir).services,['functions']);
  assert.deepEqual(loadProject({...options,only:'functions:default,pubsub'},dir).services,['functions','pubsub']);
  assert.throws(()=>loadProject({...options,only:'database'},dir),/not implemented by Firenook/);
  assert.throws(()=>loadProject({...options,only:'wat'},dir),/not a valid emulator name/);
  assert.throws(()=>loadProject({...options,only:''},dir),/comma-separated/);
  // --only naming only unconfigured services leaves nothing to start.
  const {dir:bare,save} = project();
  save({firestore:{rules:'firestore.rules'}});
  assert.throws(()=>loadProject({...options,only:'auth'},bare),/No emulators to start, run firenook init/);
  // The advice is what configures the service, as firebase init writes it.
  const skipped = inspectProject({...options,only:'auth,pubsub,functions'},bare).warnings.join('\n');
  assert.match(skipped,/not starting the auth emulator; firebase\.json does not configure it \(add "auth": \{"port": 9099\} under "emulators" in firebase\.json, as firebase init emulators writes it\)/);
  assert.match(skipped,/not starting the pubsub emulator; firebase\.json does not configure it \(add "pubsub": \{"port": 8085\} under "emulators"/);
  assert.match(skipped,/not starting the functions emulator; firebase\.json has no Functions codebase \(add a "functions" section naming its source, as firebase init functions writes it\)/);
  assert.doesNotMatch(skipped,/init --adopt/, 'adopt adds entries for the services firebase.json configures, never others');
  // Following the advice is enough.
  save({firestore:{rules:'firestore.rules'},emulators:{auth:{port:9099}}});
  assert.deepEqual(loadProject({...options,only:'auth'},bare).services,['auth']);
});
test('the project alias is chosen like the official applyRC and handed to the engine', () => {
  const {dir,options} = project();
  // The fixture's .firebaserc: {default: demo-fixture, local: demo-local}.
  assert.equal(loadProject(options,dir).alias,'default');
  const local = loadProject({...options,project:'local'},dir);
  assert.deepEqual([local.project,local.alias],['demo-local','local']);
  const byId = loadProject({...options,project:'demo-local'},dir);
  assert.deepEqual([byId.project,byId.alias],['demo-local',undefined]);
  assert.equal(flagValue(launchFor(dir,{...options,project:'local'}).args,'--project-alias'),'local');
  assert.ok(!launchFor(dir,{...options,project:'demo-local'}).args.includes('--project-alias'));
  // Without --project, the only alias the file holds, else its default one.
  writeFileSync(join(dir,'.firebaserc'),JSON.stringify({projects:{staging:'demo-staging'}}));
  const only = loadProject(options,dir);
  assert.deepEqual([only.project,only.alias],['demo-staging','staging']);
  assert.deepEqual(selectProject(undefined,{staging:'demo-staging',prod:'demo-prod'}),{project:undefined});
  assert.deepEqual(selectProject(undefined,{default:'demo-a',prod:'demo-p'}),{project:'demo-a',alias:'default'});
  // A default naming another alias still names that alias's project.
  assert.deepEqual(selectProject(undefined,{default:'prod',prod:'demo-p'}),{project:'demo-p',alias:'default'});
  assert.deepEqual(selectProject('prod',{default:'demo-a',prod:'demo-p'}),{project:'demo-p',alias:'prod'});
  assert.deepEqual(selectProject('demo-x',{}),{project:'demo-x'});
});
test('ext:vendor --offline reaches the engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-vendor-test-'));
  const record = join(dir,'args.txt');
  const binary = join(dir,'firenook');
  writeFileSync(binary,`#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`,{mode:0o755});
  const project = {config:join(dir,'firebase.json'),project:'demo-shop',directory:dir};
  const args = () => readFileSync(record,'utf8').trim().split('\n');
  assert.equal(vendorExtensions(binary,project,['stripe'],{offline:true}),0);
  assert.deepEqual(args().slice(0,2),['extensions','vendor']);
  assert.ok(args().includes('--offline'));
  assert.deepEqual(args().slice(args().indexOf('--instance'),args().indexOf('--instance')+2),['--instance','stripe']);
  assert.equal(vendorExtensions(binary,project),0);
  assert.ok(!args().includes('--offline'));
});
test('services are derived from top-level sections and emulators entries like the official CLI', () => {
  const {dir,options,save} = project();
  save({firestore:{rules:'firestore.rules'}, functions:{source:'functions'}});
  assert.deepEqual(loadProject(options,dir).services,['firestore','functions']);
  save({extensions:{}, emulators:{auth:{}, storage:{}}});
  const p = loadProject(options,dir);
  assert.deepEqual(p.services,['auth','storage','functions']);
  assert.equal(p.minimumFunctions,'1');
  save({firestore:{rules:'firestore.rules'}, emulators:{firestore:{}, pubsub:{port:8085}}});
  assert.deepEqual(loadProject(options,dir).services,['firestore','pubsub']);
  save({emulators:{ui:{enabled:true}}});
  assert.throws(()=>loadProject(options,dir),/No emulators to start/);
});
test('storage object form, absent functions and storage are accepted; minimum-functions follows the config', () => {
  const {dir,options,save} = project();
  save({firestore:{rules:'firestore.rules'}, storage:{rules:'storage.rules'}, emulators:{firestore:{}, auth:{}, storage:{}}});
  const p = loadProject(options,dir);
  assert.deepEqual(p.services,['firestore','auth','storage']);
  assert.equal(p.minimumFunctions,'0');
  assert.equal(loadProject({...options,'minimum-functions':'2'},dir).minimumFunctions,'2');
  const args = launchFor(dir,options).args;
  assert.equal(flagValue(args,'--only'),'firestore,auth,storage');
  assert.equal(flagValue(args,'--minimum-functions'),'0');
  save({storage:[{target:'default'}], emulators:{storage:{}}});
  assert.throws(()=>loadProject(options,dir),/target and rules/);
  save({storage:'storage.rules', emulators:{storage:{}}});
  assert.throws(()=>loadProject(options,dir),/storage must be/);
  // Functions selected without a codebase still passes a zero minimum.
  save({emulators:{functions:{}, firestore:{}}});
  assert.equal(loadProject(options,dir).minimumFunctions,'0');
  // The complete profile passes no --only at all.
  const {dir:full} = project();
  assert.ok(!launchFor(full,options).args.includes('--only'));
});
test('multiple Firestore databases pass through; malformed entries are rejected', () => {
  const {dir,options,save} = project();
  save({firestore:[{rules:'a.rules'},{database:'second',rules:'b.rules',indexes:'b.json'}], emulators:{firestore:{}}});
  assert.deepEqual(loadProject(options,dir).services,['firestore']);
  save({firestore:[{rules:'a.rules'},{rules:'b.rules'}], emulators:{firestore:{}}});
  assert.throws(()=>loadProject(options,dir),/At most one/);
  save({firestore:[{database:'',rules:'b.rules'}], emulators:{firestore:{}}});
  assert.throws(()=>loadProject(options,dir),/database must be/);
  save({firestore:'x', emulators:{firestore:{}}});
  assert.throws(()=>loadProject(options,dir),/firestore must be/);
});
test('any lowercase project id is accepted with a safety line; malformed and missing ids fail', () => {
  const {dir,options} = project();
  assert.equal(loadProject({...options,project:'my-app-12345'},dir).demo,false);
  assert.match(launchFor(dir,{...options,project:'my-app-12345'}).stderr,/real project id my-app-12345; every Functions worker is started with the emulator hosts and without Google credentials/);
  assert.match(launchFor(dir,options).stderr,/Demo project demo-fixture/);
  assert.equal(loadProject({...options,project:'demo-x'},dir).project,'demo-x');
  for (const id of ['Real-App','ab','-leading','trailing-','a'.repeat(31),'demo-']) assert.throws(()=>loadProject({...options,project:id},dir),/Invalid project id/);
  writeFileSync(join(dir,'.firebaserc'),'{}');
  assert.throws(()=>loadProject(options,dir),/No project id.*--project.*firenook use --add/);
  assert.equal(readFileSync(join(dir,'.firebaserc'),'utf8'),'{}');
});
test('unimplemented official emulators are skipped with a warning; unknown keys fail before side effects', () => {
  const {dir,config,options,save} = project();
  config.emulators.database = {};
  config.emulators.hosting = {port:5000};
  save(config);
  const p = loadProject(options,dir);
  assert.deepEqual(p.skipped,['database','hosting']);
  assert.match(p.warnings.join('\n'),/configures the database emulator, which Firenook does not implement; skipping it/);
  assert.deepEqual(p.services,['firestore','auth','storage','functions','pubsub']);
  config.emulators.wat = {};
  save(config);
  assert.throws(()=>loadProject(options,dir),/Unsupported configured emulator: wat/);
});
test('ui.enabled, --ui, exec mode and singleProjectMode map to engine flags', () => {
  const {dir,config,options,save} = project();
  assert.ok(!launchFor(dir,options).args.includes('--no-ui'));
  assert.ok(launchFor(dir,options,'exec').args.includes('--no-ui'), 'exec keeps the UI off by default');
  assert.ok(!launchFor(dir,{...options,ui:true},'exec').args.includes('--no-ui'));
  assert.ok(!launchFor(dir,options).args.includes('--single-project-mode'));
  config.emulators.ui = {enabled:true};
  save(config);
  assert.ok(!launchFor(dir,options,'exec').args.includes('--no-ui'), 'an explicit ui.enabled keeps the UI in exec');
  config.emulators.ui = {enabled:false};
  config.emulators.singleProjectMode = false;
  save(config);
  const p = loadProject(options,dir);
  assert.equal(p.ui,false);
  assert.equal(p.singleProjectMode,false);
  const launch = launchFor(dir,options);
  assert.ok(launch.args.includes('--no-ui'));
  assert.equal(flagValue(launch.args,'--single-project-mode'),'false');
  // --ui comes before emulators.ui.enabled, as the official CLI decides.
  const forced = launchFor(dir,{...options,ui:true});
  assert.ok(forced.args.includes('--ui') && !forced.args.includes('--no-ui'), '--ui starts a console firebase.json turns off');
  assert.doesNotMatch(forced.stderr,/--ui cannot/);
  assert.ok(launchFor(dir,{...options,ui:true},'exec').args.includes('--ui'), 'in exec too');
  const receipt = JSON.parse(readFileSync(join(launch.run,'launch.json'),'utf8'));
  assert.deepEqual(receipt.services,['firestore','auth','storage','functions','pubsub']);
  assert.deepEqual(receipt.project,{id:'demo-fixture',demo:true});
  assert.equal(receipt.singleProjectMode,false);
  config.emulators.singleProjectMode = 'no';
  save(config);
  assert.throws(()=>loadProject(options,dir),/singleProjectMode/);
});
test('--debug and --log-verbosity DEBUG add a debug log under the run directory', () => {
  const {dir,options} = project();
  const launch = launchFor(dir,{...options,debug:true});
  const log = flagValue(launch.args,'--debug-log');
  assert.ok(log.startsWith(join(dir,'.firenook','runs','session-')) && log.endsWith('firenook-debug.log'), log);
  assert.match(launch.stderr,/Debug log: .*firenook-debug\.log/);
  assert.equal(launch.debugLog,log);
  assert.ok(launchFor(dir,{...options,'log-verbosity':'DEBUG'}).args.includes('--debug-log'));
  const quiet = launchFor(dir,{...options,'log-verbosity':'QUIET'});
  assert.ok(!quiet.args.includes('--debug-log'));
  assert.match(quiet.stderr,/--log-verbosity QUIET is accepted for compatibility/);
  assert.ok(!launchFor(dir,options).args.includes('--debug-log'));
});
test('the default host is localhost, as officially, and clients are told 127.0.0.1', () => {
  const {dir,options} = project();
  // The engine binds 127.0.0.1 for it, and ::1 as well for the hub and the
  // console; every client address stays 127.0.0.1. Clients learn the
  // addresses from the hub's listing (emulators:exec), whichever host the
  // listing names.
  const listing = host => ({firestore:{host,port:8080}, hub:{host,port:4400}, storage:{host,port:9199}});
  for (const host of [undefined, 'localhost']) {
    const launch = launchFor(dir, {...options, host});
    assert.equal(flagValue(launch.args,'--host'),'localhost');
    for (const listed of ['localhost', '127.0.0.1']) {
      const env = execEnvironment(launch.env, listing(listed));
      assert.equal(env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');
      assert.equal(env.FIREBASE_EMULATOR_HUB,'127.0.0.1:4400');
      assert.equal(env.STORAGE_EMULATOR_HOST,'http://127.0.0.1:9199');
    }
    assert.equal(inspectProject({...options, host},dir).warnings.length,0);
  }
  // An address is that address; IPv6 literals are bracketed for clients.
  assert.equal(flagValue(launchFor(dir,{...options,host:'127.0.0.1'}).args,'--host'),'127.0.0.1');
  for (const host of ['::1','[::1]']) assert.equal(execEnvironment({}, listing(host)).FIRESTORE_EMULATOR_HOST,'[::1]:8080', host);
});
test('host binding accepts any address with a warning; per-service conflicts still fail', () => {
  const {dir,config,options,save} = project();
  const lan = inspectProject({...options,host:'0.0.0.0'},dir);
  assert.equal(lan.errors.length,0);
  assert.match(lan.warnings.join('\n'),/binding 0\.0\.0\.0; the emulators have no authentication/);
  const launch = launchFor(dir,{...options,host:'0.0.0.0'});
  assert.equal(flagValue(launch.args,'--host'),'0.0.0.0');
  assert.equal(launch.hub,'http://127.0.0.1:4400', 'clients connect through the loopback address');
  const tokenUrl = launch => JSON.parse(readFileSync(launch.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8')).token_url;
  assert.equal(tokenUrl(launch),'http://127.0.0.1:4400/firenook/oauth2/token');
  assert.equal(tokenUrl(launchFor(dir,{...options,host:'::'})),'http://[::1]:4400/firenook/oauth2/token');
  assert.equal(inspectProject(options,dir).warnings.length,0);
  config.emulators.auth.host = '192.0.2.10';
  save(config);
  assert.equal(loadProject(options,dir).host,'192.0.2.10');
  config.emulators.firestore.host = '198.51.100.7';
  save(config);
  assert.throws(()=>loadProject(options,dir),/Unsupported host for auth/);
});
test('zero, conflicting and configured WebSocket ports are checked', () => {
  const {dir,config,options} = project();
  config.emulators.firestore.websocketPort=32011;
  writeFileSync(join(dir,'firebase.json'),JSON.stringify(config));
  assert.equal(loadProject(options,dir).ports['firestore-websocket'],32011);
  assert.throws(()=>loadProject({...options,'firestore-websocket-port':'8080'},dir),/distinct/);
  assert.equal(loadProject({...options,'hub-port':'31000'},dir).ports.hub,31000);
  // Official defaults for the auxiliary listeners; every port is passed explicitly.
  const defaults = loadProject(options,dir).ports;
  assert.deepEqual([defaults.logging,defaults.eventarc,defaults.tasks,defaults['firestore-websocket']],[4500,9299,9499,32011]);
  const args = launchFor(dir,options).args;
  for (const name of ['firestore','auth','storage','functions','pubsub','hub','ui','logging','eventarc','tasks','firestore-websocket']) assert.equal(flagValue(args,`--${name}-port`),String(defaults[name]),name);
  config.emulators.logging = {port:4501}; config.emulators.eventarc = {port:9298}; config.emulators.tasks = {port:9498};
  writeFileSync(join(dir,'firebase.json'),JSON.stringify(config));
  const configured = loadProject(options,dir).ports;
  assert.deepEqual([configured.logging,configured.eventarc,configured.tasks],[4501,9298,9498]);
  config.emulators.firestore.port=0;
  writeFileSync(join(dir,'firebase.json'),JSON.stringify(config));
  assert.throws(()=>loadProject(options,dir),/Invalid port/);
});
test('export default, parent/symlink safety and resume isolation', () => {
  const {dir,options} = project();
  assert.throws(()=>loadProject({...options,'export-on-exit':true},dir),/requires/);
  assert.equal(loadProject({...options,import:'seed','export-on-exit':true},dir).exported,canonical(join(dir,'seed')));
  for (const destination of ['.','..']) assert.throws(()=>loadProject({...options,'export-on-exit':destination},dir),/ancestor/);
  symlinkSync(dir,join(dir,'alias'),process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(canonical(join(dir,'alias','new')),canonical(join(dir,'new')));
  assert.throws(()=>loadProject({...options,'export-on-exit':'alias'},dir),/ancestor/);
  assert.throws(()=>loadProject({...options,import:'seed','state-dir':'seed/state'},dir),/separate/);
  // As the official CLI: a seed directory not there yet, exported to at the
  // stop, is no import; the stop creates it.
  const first = loadProject({...options,import:'seed','export-on-exit':true},dir);
  assert.equal(first.imported,undefined);
  assert.equal(first.exported,canonical(join(dir,'seed')));
  assert.equal(loadProject({...options,import:'seed','export-on-exit':'seed'},dir).imported,undefined);
  // Without the export, or once it is there, it is the import.
  assert.equal(loadProject({...options,import:'seed'},dir).imported,canonical(join(dir,'seed')));
  mkdirSync(join(dir,'seed'));
  assert.equal(loadProject({...options,import:'seed','export-on-exit':true},dir).imported,canonical(join(dir,'seed')));
  assert.throws(()=>loadProject({...options,import:'seed','state-dir':'work','resume-state':true,'export-on-exit':true},dir),/immutable seed/);
  assert.throws(()=>loadProject({...options,'resume-state':true},dir),/requires/);
  mkdirSync(join(dir,'existing'));
  writeFileSync(join(dir,'existing','data'),'preserve');
  assert.throws(()=>loadProject({...options,'state-dir':'existing'},dir),/nonempty state/);
  assert.equal(readFileSync(join(dir,'existing','data'),'utf8'),'preserve');
});
test('--keep-data keeps the data in .firenook/state, with or without a seed', () => {
  const {dir,options} = project();
  const kept = loadProject({...options,'keep-data':true},dir);
  assert.equal(kept.state,canonical(join(dir,'.firenook','state')));
  assert.equal(kept.resume,true);
  assert.equal(kept.imported,undefined);
  // No seed is needed to resume any more.
  assert.equal(loadProject({...options,'state-dir':'work','resume-state':true},dir).resume,true);
  assert.equal(loadProject({...options,'keep-data':true,'state-dir':'elsewhere'},dir).state,canonical(join(dir,'elsewhere')));
  assert.equal(loadProject({...options,'keep-data':true,import:'seed'},dir).imported,canonical(join(dir,'seed')));
  mkdirSync(join(dir,'seed'));
  assert.throws(()=>loadProject({...options,'keep-data':true,import:'seed','export-on-exit':true},dir),/immutable seed/);
  assert.throws(()=>loadProject({...options,'resume-state':true},dir),/--resume-state requires --state-dir; --keep-data alone keeps the data in \.firenook\/state/);
  const launch = launchFor(dir,{...options,'keep-data':true});
  assert.equal(flagValue(launch.args,'--state-dir'),canonical(join(dir,'.firenook','state')));
  assert.ok(launch.args.includes('--resume-state'));
  assert.ok(!launch.args.includes('--import'));
  // A second start without --keep-data never silently reimports or resets it.
  mkdirSync(join(dir,'.firenook','state'),{recursive:true});
  writeFileSync(join(dir,'.firenook','state','native-state.json'),'{}');
  assert.throws(()=>loadProject({...options,'state-dir':'.firenook/state'},dir),/requires explicit --resume-state \(or --keep-data\)/);
  assert.throws(()=>parseOptions(['--keep-data=yes']),/does not take a value/);
});
test('state and credential isolation stay outside original config and seed', () => {
  const {dir,options} = project();
  const before = readFileSync(join(dir,'firebase.json'),'utf8');
  const diagnostic = {project:loadProject(options,dir),binary:'/fake',toolsRoot:'/tools'};
  const launch = prepareLaunch(diagnostic,options);
  assert.equal(readFileSync(join(dir,'firebase.json'),'utf8'),before);
  assert.ok(launch.args.includes('--state-dir'));
  assert.ok(!launch.args.includes('--firestore-memory'));
  assert.ok(!launch.args.includes('--no-diagnostics'));
  assert.ok(prepareLaunch(diagnostic, {...options, 'no-diagnostics': true}).args.includes('--no-diagnostics'));
  assert.ok(!launch.args.includes('--allowed-hosts'));
  const named = prepareLaunch(diagnostic, {...options, 'allowed-hosts': 'console.example.test,dev.example.test'}).args;
  assert.equal(named[named.indexOf('--allowed-hosts') + 1], 'console.example.test,dev.example.test');
  assert.ok(!launch.args.includes('--durability'));
  const perCommit = prepareLaunch(diagnostic, {...options, durability: 'per-commit'}).args;
  assert.equal(perCommit[perCommit.indexOf('--durability') + 1], 'per-commit');
  assert.equal(launch.env.GCLOUD_PROJECT,'demo-fixture');
  assert.equal(launch.env.FIREBASE_TOKEN,undefined);
});
test('the demo credentials get their token from the hub, never from Google', () => {
  const {dir,options} = project();
  const launch = launchFor(dir,{...options,'hub-port':'31400'},'exec');
  assert.equal(launch.hub,'http://127.0.0.1:31400');
  // An authorized_user file sends the Node.js SDK to oauth2.googleapis.com
  // for its token whatever it holds; every Admin SDK reads this kind's
  // token_url, which is the hub's.
  assert.deepEqual(JSON.parse(readFileSync(launch.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8')),
    {type:'external_account_authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo',token_url:'http://127.0.0.1:31400/firenook/oauth2/token'});
  assert.equal(DEMO_TOKEN_PATH,'/firenook/oauth2/token');
  assert.equal(launch.env.CLOUDSDK_CONFIG,join(launch.run,'gcloud'));
  // The engine is told its ports by its arguments; the emulators' variables
  // are the command's, from the hub's listing once they run.
  for (const name of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','STORAGE_EMULATOR_HOST','FIREBASE_EMULATOR_HUB','PUBSUB_EMULATOR_HOST'])
    assert.equal(launch.env[name],undefined,name);
});
test('exec gives its command the official emulators:exec variables, for the emulators that run', () => {
  // Captured from the official emulators:exec (setEnvVarsForEmulators over
  // the running emulators, and runScript's GCLOUD_PROJECT and FIREBASE_CONFIG).
  const oracle = JSON.parse(readFileSync(new URL('fixtures/firebase-cli-15.34.0-exec-env.json', import.meta.url)));
  const shown = env => Object.fromEntries(Object.entries(env).filter(([name]) => /EMULATOR|GCLOUD|GOOGLE_CLOUD|FIREBASE_CONFIG|GOOGLE_APPLICATION|CLOUDSDK/.test(name)).sort(([a],[b]) => a.localeCompare(b)));
  assert.deepEqual(oracle.runs.map(run => run.only),['auth,functions','storage,firestore','pubsub']);
  for (const run of oracle.runs) assert.deepEqual(shown(execEnvironment({GCLOUD_PROJECT:'demo-shop',PATH:'/bin'},run.running)),run.env,run.only);
  // A service that is not running gets no variable, whatever its port, and
  // a variable the developer set for it is left as it was.
  const firestoreOnly = execEnvironment({GCLOUD_PROJECT:'demo-shop',PUBSUB_EMULATOR_HOST:'127.0.0.1:1'},{hub:{host:'127.0.0.1',port:4400},firestore:{host:'127.0.0.1',port:8080},'firestore.websocket':{host:'127.0.0.1',port:9150}});
  assert.deepEqual(Object.keys(shown(firestoreOnly)),['FIREBASE_CONFIG','FIREBASE_EMULATOR_HUB','FIREBASE_FIRESTORE_EMULATOR_ADDRESS','FIRESTORE_EMULATOR_HOST','GCLOUD_PROJECT','PUBSUB_EMULATOR_HOST']);
  assert.equal(firestoreOnly.PUBSUB_EMULATOR_HOST,'127.0.0.1:1');
  // The developer's own FIREBASE_CONFIG is kept, as officially; IPv6 is bracketed.
  assert.equal(execEnvironment({GCLOUD_PROJECT:'demo-shop',FIREBASE_CONFIG:'{}'},{}).FIREBASE_CONFIG,'{}');
  assert.equal(execEnvironment({},{}).FIREBASE_CONFIG,undefined);
  assert.equal(execEnvironment({},{storage:{host:'::1',port:9199}}).STORAGE_EMULATOR_HOST,'http://[::1]:9199');
});
test('exec reads what runs from the hub before its command starts', async () => {
  const listing = {hub:{name:'hub',host:'127.0.0.1',port:0},auth:{name:'auth',host:'127.0.0.1',port:9099},functions:{name:'functions',host:'127.0.0.1',port:5001},eventarc:{name:'eventarc',host:'127.0.0.1',port:9299},tasks:{name:'tasks',host:'127.0.0.1',port:9499}};
  const hub = createServer((request, response) => {
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify(request.url === '/emulators' ? listing : {}));
  });
  await new Promise(resolve => hub.listen(0,'127.0.0.1',resolve));
  listing.hub.port = hub.address().port;
  const out = join(mkdtempSync(join(tmpdir(),'firenook-exec-env-')),'env.json');
  const engine = `const stop=()=>setTimeout(()=>process.exit(0),60); process.on('SIGINT',stop); if(process.platform==='win32') process.stdin.on('data',stop); console.log('All emulators ready'); setInterval(()=>{},1000)`;
  const launch = {binary:process.execPath,args:['-e',engine],cwd:process.cwd(),env:{...process.env,GCLOUD_PROJECT:'demo-fixture'},hub:`http://127.0.0.1:${listing.hub.port}`};
  try {
    assert.equal(await supervise(launch,[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`]),0);
    const env = JSON.parse(readFileSync(out,'utf8'));
    assert.equal(env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
    assert.equal(env.CLOUD_TASKS_EMULATOR_HOST,'127.0.0.1:9499');
    assert.equal(env.CLOUD_EVENTARC_EMULATOR_HOST,'http://127.0.0.1:9299');
    assert.equal(env.FIREBASE_EMULATOR_HUB,`127.0.0.1:${listing.hub.port}`);
    for (const name of ['FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','PUBSUB_EMULATOR_HOST']) assert.equal(env[name],process.env[name],name);
  } finally { hub.close(); }
  // No listing, no command: it would run with a guessed environment.
  const ran = join(mkdtempSync(join(tmpdir(),'firenook-exec-env-')),'ran');
  await assert.rejects(supervise({...launch,hub:'http://127.0.0.1:9'},[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(ran)}, '')`]),/did not list the running emulators/);
  assert.throws(() => readFileSync(ran),/ENOENT/);
});
test('the engine is told the release it ships as, since it cannot know it itself', () => {
  const {dir,options} = project();
  const launch = launchFor(dir, options);
  // The binary is built from the pinned engine commit, while this version
  // comes from the packaging checkout; without the handoff the console badge
  // and `firenook --version` would show the placeholder crate version.
  assert.equal(launch.env.FIRENOOK_RELEASE_VERSION,manifest.version);
  assert.equal(launch.env.FIRENOOK_ENGINE_REVISION,release.engineRevision);
  assert.match(launch.env.FIRENOOK_RELEASE_VERSION,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
  assert.match(launch.env.FIRENOOK_ENGINE_REVISION,/^[a-f0-9]{40}$/);
  const receipt = JSON.parse(readFileSync(join(launch.run,'launch.json'),'utf8'));
  assert.equal(receipt.version,launch.env.FIRENOOK_RELEASE_VERSION);
  assert.equal(receipt.engineRevision,launch.env.FIRENOOK_ENGINE_REVISION);
});
test('the launch context says why each service is absent, from what the launcher already decided', () => {
  const {dir,options,save} = project();
  // Storage and Pub/Sub are not configured; Realtime Database is, but is not emulated.
  save({firestore:{rules:'firestore.rules'}, functions:{source:'functions'}, emulators:{firestore:{}, auth:{}, functions:{}, database:{}}});
  const typed = ['--only','firestore','--project','demo-fixture','--import','./seed data'];
  const only = {...options, only:'firestore'};
  const context = launchContext(loadProject(only,dir), {command:'firenook emulators:start', args:typed});
  assert.deepEqual(context, {
    services:{auth:'excluded-by-only', storage:'not-configured', functions:'excluded-by-only', pubsub:'not-configured'},
    skipped:['database'],
    command:'firenook emulators:start',
    args:typed,
  });
  // Every configured service started: no reasons, and the arguments are kept as typed.
  const everything = launchContext(loadProject(options,dir));
  assert.deepEqual(everything.services, {storage:'not-configured', pubsub:'not-configured'});
  assert.deepEqual(everything.args, []);
});
test('the engine receives the launch context, with the command and its arguments as typed', () => {
  const {dir,options} = project();
  const typed = ['--only','firestore,auth','--project','demo-fixture'];
  const start = launchFor(dir, {...options, only:'firestore,auth'}, 'start', typed);
  const context = JSON.parse(flagValue(start.args,'--launch-context'));
  assert.deepEqual(context.services, {storage:'excluded-by-only', functions:'excluded-by-only', pubsub:'excluded-by-only'});
  assert.equal(context.command,'firenook emulators:start');
  assert.deepEqual(context.args, typed);
  assert.deepEqual(context.skipped, []);
  const exec = launchFor(dir, options, 'exec', ['--','npm','test']);
  const execContext = JSON.parse(flagValue(exec.args,'--launch-context'));
  assert.equal(execContext.command,'firenook emulators:exec');
  assert.deepEqual(execContext.services, {});
  assert.deepEqual(execContext.args, ['--','npm','test']);
});
test('start and exec accept --allowed-hosts', () => {
  const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs',import.meta.url));
  const {dir} = project();
  const run = (...args) => spawnSync(process.execPath,[cli,...args],{encoding:'utf8',cwd:dir});
  for (const action of ['emulators:start','emulators:exec']) {
    const refused = run(action,'--allowed-hosts','console.example.test','--recursive');
    assert.equal(refused.status,1);
    assert.match(refused.stderr,new RegExp(`--recursive is not an option of firenook ${action}`), refused.stderr);
  }
});
test('exec waits for child readiness and graceful shutdown, preserves test status', async () => {
  const launch = {binary:process.execPath,args:['-e', `const stop=()=>setTimeout(()=>process.exit(0),60); process.on('SIGINT',stop); if(process.platform==='win32') process.stdin.on('data',stop); console.log('All emulators ready'); setInterval(()=>{},1000)`],cwd:process.cwd(),env:process.env};
  assert.equal(await supervise(launch,[process.execPath,'-e','process.exit(7)']),7);
  // A single script string runs through the platform shell, as the official emulators:exec does.
  assert.equal(await supervise(launch,'exit 3'),3);
  assert.equal(await supervise(launch,process.platform === 'win32' ? 'cd . && exit 5' : 'true && exit 5'),5);
});
test('export failure overrides passing test and unrequested exits fail', async () => {
  const launch = {binary:process.execPath,args:['-e', `const stop=()=>process.exit(9); process.on('SIGINT',stop); if(process.platform==='win32') process.stdin.on('data',stop); console.log('All emulators ready'); setInterval(()=>{},1000)`],cwd:process.cwd(),env:process.env};
  assert.equal(await supervise(launch,[process.execPath,'-e','process.exit(0)']),9);
  await assert.rejects(supervise({...launch,args:['-e','process.exit(0)']}),/unexpectedly/);
});
test('help and version do not need installed binaries; deploy is not intercepted', () => {
  const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs',import.meta.url));
  const run = (...args) => spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
  const help = run('--help');
  assert.equal(help.status,0);
  assert.ok(help.stdout.split('\n').length < 60);
  for (const text of ['emulators:export','firestore:delete','target:apply','init --adopt','functions:shell','--non-interactive','-P/--project']) assert.ok(help.stdout.includes(text), text);
  assert.equal(run('--version').status,0);
  assert.equal(run('deploy').status,1);
  assert.equal(run('functions:shell').status,1);
});
test('state:inspect and state:compact need the saved data before any binary is touched', () => {
  const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs',import.meta.url));
  const run = (...args) => spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
  const help = run('--help').stdout;
  for (const text of ['state:inspect --state-dir DIR','state:compact --state-dir DIR [--no-copy]']) assert.ok(help.includes(text), text);
  for (const action of ['state:inspect','state:compact']) assert.match(run(action).stderr,new RegExp(`${action} needs --state-dir`));
  assert.match(run('state:inspect','--state-dir','x','--no-copy').stderr,/--no-copy is not an option of firenook state:inspect/);
  assert.match(run('state:compact','extra','--state-dir','x').stderr,/Unexpected argument extra/);
});
test('emulators:exec argument forms are decided before any binary is touched', () => {
  const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs',import.meta.url));
  const {dir} = project();
  const run = (...args) => spawnSync(process.execPath,[cli,...args],{encoding:'utf8',cwd:dir});
  // Two bare arguments: refuse with the exact argv rewrite.
  const two = run('emulators:exec','--project','demo-fixture','node','test.mjs');
  assert.equal(two.status,1);
  assert.match(two.stderr,/run: firenook emulators:exec --project demo-fixture -- node test\.mjs/);
  assert.match(run('emulators:exec','--project','demo-fixture').stderr,/requires a script/);
  assert.match(run('emulators:start','--project','demo-fixture','npm','test').stderr,/Unexpected argument npm/);
  assert.match(run('emulators:start','--recursive').stderr,/--recursive is not an option of firenook emulators:start/);
  assert.match(run('doctor','--only','database').stderr,/not implemented by Firenook/);
  // doctor checks every Extension instance; --instance belongs to ext:vendor.
  assert.match(run('doctor','--instance','greeter').stderr,/--instance is not an option of firenook doctor/);
  // One script string is accepted; the shell notice precedes the binary check.
  assert.match(run('emulators:exec','--project','demo-fixture','exit 3').stderr,/running the script through the shell as the official CLI does/);
});
