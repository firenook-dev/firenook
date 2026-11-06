#!/usr/bin/env node
// Runs the same FlutterFire app against Firenook and firebase-tools on one
// platform, each on a fresh backend, and fails on any difference. Results are
// compared within a platform only: web and iOS legitimately differ.
//
//   node conformance/flutter-check/check.mjs --platform web|ios|android
//     [--binary <firenook>]    the engine (default: target/debug/firenook)
//     [--flutter <flutter>]    the SDK's flutter command (default: on PATH)
//     [--device <id>]          the simulator or emulator (default: the first found)
//     [--backends firenook,firebase-tools]
//     [--runs <n>]             repeat each backend
//     [--cold-boot]            restart the simulator before each run
//     [--keep-cache]           native only: keep the app's cache between runs, and
//                              run firebase-tools twice, then Firenook twice, as a
//                              device does moving to Firenook. Each run after the
//                              first is compared with firebase-tools' second.
//     [--out <directory>]      where results go (default: a new temporary one)
//     [--keep]                 keep the generated project for a closer look
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const execute = promisify(execFile);
const project = 'demo-flutter';
const services = 'auth,firestore,storage,functions';
const organisation = 'dev.firenook';
const bundles = { ios: `${organisation}.flutterCheck`, android: `${organisation}.flutter_check` };

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const platform = argument('platform');
if (!['web', 'ios', 'android'].includes(platform)) throw new Error('--platform is web, ios or android');
const flutter = argument('flutter', 'flutter');
const binary = resolve(argument('binary', join(repository, 'target/debug/firenook')));
const backends = argument('backends', 'firenook,firebase-tools').split(',');
const runs = Number(argument('runs', '1'));
const coldBoot = process.argv.includes('--cold-boot');
const keepCache = process.argv.includes('--keep-cache');
if (keepCache && platform === 'web') throw new Error('--keep-cache is for native clients: each web run has a new browser profile');
const out = resolve(argument('out') ?? await mkdtemp(join(tmpdir(), 'flutter-check-results-')));
await mkdir(out, { recursive: true });
const environment = { ...process.env, FLUTTER_SUPPRESS_ANALYTICS: 'true', CI: process.env.CI ?? '1', NO_COLOR: '1', FORCE_COLOR: '0', FIRENOOK_PLAIN: '1' };
const log = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

async function flutterDevice() {
  const given = argument('device');
  if (platform === 'web') return 'chrome';
  if (given) return given;
  const { stdout } = await execute(flutter, ['devices', '--machine'], { env: environment, maxBuffer: 16 * 1024 * 1024 });
  const devices = JSON.parse(stdout.slice(stdout.indexOf('[')));
  const wanted = platform === 'ios' ? 'ios' : 'android';
  const found = devices.find((device) => device.targetPlatform.startsWith(wanted) && device.emulator);
  if (found) return found.id;
  if (platform === 'ios') {
    const { stdout: listed } = await execute('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
    const phones = Object.values(JSON.parse(listed).devices).flat().filter((device) => device.name.startsWith('iPhone'));
    if (phones.length > 0) return phones.at(-1).udid;
  }
  throw new Error(`no ${platform} device: pass --device, or start one`);
}

// `flutter create` adds what is missing and leaves what exists alone.
const generateProject = (app) => execute(flutter, ['create', '--no-pub', '--project-name', 'flutter_check', '--org', organisation, `--platforms=${platform}`, app], { env: environment, maxBuffer: 16 * 1024 * 1024 });

// The generated project lives outside the repository; only the app's own files
// and the settings a local emulator needs are put into it.
async function prepareApp(work) {
  const app = join(work, 'app');
  await mkdir(app, { recursive: true });
  log(`creating the ${platform} project`);
  await generateProject(app);
  await cp(join(here, 'app/lib'), join(app, 'lib'), { recursive: true });
  await cp(join(here, 'app/pubspec.yaml'), join(app, 'pubspec.yaml'));
  await cp(join(here, 'app/pubspec.lock'), join(app, 'pubspec.lock')).catch(() => {});
  if (platform === 'ios') {
    // Swift Package Manager's resolution expects this to exist before pub get.
    await mkdir(join(app, 'build/ios/SourcePackages'), { recursive: true });
    const plist = join(app, 'ios/Runner/Info.plist');
    const text = await readFile(plist, 'utf8');
    await writeFile(plist, text.replace(/<\/dict>\s*<\/plist>\s*$/, '\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t</dict>\n</dict>\n</plist>\n'));
  }
  if (platform === 'android') {
    // Android refuses plain HTTP to the host unless the app asks for it.
    const manifest = join(app, 'android/app/src/main/AndroidManifest.xml');
    const text = await readFile(manifest, 'utf8');
    await writeFile(manifest, text.replace('<application', '<application android:usesCleartextTraffic="true"'));
  }
  log('flutter pub get');
  await execute(flutter, ['pub', 'get'], { cwd: app, env: environment, maxBuffer: 64 * 1024 * 1024 });
  return app;
}

async function prepareBackend(work) {
  const template = join(work, 'backend-template');
  await cp(join(here, 'backend'), template, { recursive: true, filter: (path) => !path.includes('node_modules') });
  log('installing the Functions dependencies');
  await execute('npm', ['ci', '--no-audit', '--no-fund'], { cwd: join(template, 'functions'), env: environment, maxBuffer: 64 * 1024 * 1024 });
  return template;
}

function startBackend(backend, directory) {
  let command;
  let args;
  if (backend === 'firenook') {
    command = binary;
    args = ['suite', '--project-id', project, '--node', process.execPath, '--state-dir', join(directory, '.state'), '--only', services, '--no-ui', '--project-dir', directory];
  } else {
    const require = createRequire(join(repository, 'conformance/package.json'));
    command = process.execPath;
    args = [join(dirname(require.resolve('firebase-tools/package.json')), 'lib/bin/firebase.js'), 'emulators:start', '--project', project, '--only', services];
  }
  return spawn(command, args, { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
}

// Signals the whole process group, which can outlive its leader: `flutter run`
// can exit and leave its debug service behind.
async function stop(child, signal = 'SIGINT') {
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, signal); } catch { /* gone */ }
    await Promise.race([once(child, 'exit'), delay(40_000)]);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ }
}

async function resetDevice(device, firstOfKept) {
  if (platform === 'ios') {
    if (coldBoot) {
      log('restarting the simulator');
      await execute('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    }
    await execute('xcrun', ['simctl', 'boot', device]).catch(() => {});
    await execute('xcrun', ['simctl', 'bootstatus', device, '-b'], { maxBuffer: 16 * 1024 * 1024 });
    if (!keepCache || firstOfKept) await execute('xcrun', ['simctl', 'uninstall', device, bundles.ios]).catch(() => {});
  }
  if (platform === 'android' && (!keepCache || firstOfKept)) {
    await execute('adb', ['-s', device, 'uninstall', bundles.android]).catch(() => {});
  }
}

// `flutter run` can lose its own debug connection on a first launch, which says
// nothing about the backend: a run that ends with no result at all is tried once
// more, on a fresh backend.
async function runOnce(backend, run, app, template, device, work) {
  const first = await attempt(backend, run, app, template, device, work, 1);
  if (first.status === 'finished' || Object.keys(first.results).length > 0) return first;
  log(`${platform}-${backend}: ${first.status} with no result, trying once more`);
  return attempt(backend, run, app, template, device, work, 2);
}

async function attempt(backend, run, app, template, device, work, attemptNumber) {
  // Xcode's workspace file has been seen to vanish between runs of one project,
  // and without it xcodebuild finds no scheme.
  if (platform === 'ios') {
    await access(join(app, 'ios/Runner.xcworkspace/contents.xcworkspacedata')).catch(() => generateProject(app));
  }
  const label = `${platform}-${backend}${runs > 1 || keepCache ? `-${run}` : ''}`;
  const directory = join(work, 'runs', `${label}-${attemptNumber}`);
  await cp(template, directory, { recursive: true, verbatimSymlinks: true });
  const server = startBackend(backend, directory);
  let serverLog = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (bytes) => { serverLog += bytes; });
  const results = {};
  let status = 'backend never ready';
  try {
    const ready = Date.now() + 180_000;
    while (!serverLog.includes('All emulators ready') && server.exitCode === null && Date.now() < ready) await delay(200);
    if (serverLog.includes('All emulators ready')) {
      log(`${label}: backend ready`);
      await resetDevice(device, run === 1);
      const args = ['run', '-d', device, '--no-pub', '--target', 'lib/main.dart'];
      if (keepCache) args.push('--dart-define=KEEP_CACHE=true');
      if (platform === 'web') {
        args.push('--web-browser-flag=--headless=new', '--web-browser-flag=--disable-gpu');
        if (process.platform === 'linux') args.push('--web-browser-flag=--no-sandbox');
      }
      const client = spawn(flutter, args, { cwd: app, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let clientLog = '';
      for (const stream of [client.stdout, client.stderr]) stream.on('data', (bytes) => { clientLog += bytes; });
      const deadline = Date.now() + 25 * 60_000;
      status = 'timed out';
      while (Date.now() < deadline) {
        if (clientLog.includes('CHECK_DONE')) { status = 'finished'; break; }
        if (client.exitCode !== null) { status = `app exited ${client.exitCode}`; break; }
        await delay(500);
      }
      // Let it quit by itself first: it tidies up the project as it goes.
      client.stdin.write('q');
      await Promise.race([once(client, 'exit'), delay(15_000)]);
      await stop(client, 'SIGTERM');
      for (const match of clientLog.matchAll(/CHECK_RESULT (\{.*\})/g)) {
        try {
          const result = JSON.parse(match[1]);
          results[result.name] = { ok: result.ok, detail: result.detail };
        } catch { /* a line the tool broke up */ }
      }
      await writeFile(join(out, `${label}.app.log`), clientLog);
    }
  } finally {
    await stop(server);
    await writeFile(join(out, `${label}.backend.log`), serverLog);
  }
  const passed = Object.values(results).filter((result) => result.ok).length;
  log(`${label}: ${status}, ${passed} of ${Object.keys(results).length} passed`);
  const report = { platform, backend, run, status, results };
  await writeFile(join(out, `${label}.json`), `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

function compare(left, right) {
  const differences = [];
  for (const name of new Set([...Object.keys(right.results), ...Object.keys(left.results)])) {
    const [a, b] = [left.results[name], right.results[name]];
    if (a && b && a.ok === b.ok && a.detail === b.detail) continue;
    differences.push({ name, [left.backend]: a ?? 'missing', [right.backend]: b ?? 'missing' });
  }
  return differences;
}

const work = await mkdtemp(join(tmpdir(), `flutter-check-${platform}-`));
const device = await flutterDevice();
log(`platform ${platform}, device ${device}, results in ${out}`);
const app = await prepareApp(work);
const template = await prepareBackend(work);
const reports = {};
if (keepCache) {
  const [reference, tested] = ['firebase-tools', 'firenook'];
  let run = 0;
  for (const backend of [reference, reference, tested, tested]) {
    run += 1;
    (reports[backend] ??= []).push(await runOnce(backend, run, app, template, device, work));
  }
} else {
  for (let run = 1; run <= runs; run += 1) {
    for (const backend of backends) {
      (reports[backend] ??= []).push(await runOnce(backend, run, app, template, device, work));
    }
  }
}

let failed = false;
const compared = keepCache ? ['firebase-tools', 'firenook'] : backends;
const summary = { platform, device, runs, keepCache, backends: {} };
for (const backend of compared) {
  const rows = reports[backend];
  summary.backends[backend] = rows.map((row) => ({
    status: row.status,
    passed: Object.values(row.results).filter((result) => result.ok).length,
    checks: Object.keys(row.results).length,
    failed: Object.entries(row.results).filter(([, result]) => !result.ok).map(([name, result]) => ({ name, detail: result.detail })),
  }));
  for (const row of rows) {
    if (row.status !== 'finished') { failed = true; console.log(`${backend} run ${row.run}: ${row.status}`); }
  }
}
if (compared.length === 2) {
  const [first, second] = compared;
  summary.differences = [];
  if (keepCache) {
    // The first run had no cache to keep, so it compares with nothing.
    for (const row of reports[second]) summary.differences.push(...compare(reports[first][1], row));
  } else {
    for (let index = 0; index < runs; index += 1) {
      summary.differences.push(...compare(reports[first][index], reports[second][index]));
    }
  }
  for (const difference of summary.differences) {
    failed = true;
    console.log(`DIFFERENT ${JSON.stringify(difference)}`);
  }
}
await writeFile(join(out, `${platform}-summary.json`), `${JSON.stringify(summary, null, 1)}\n`);
for (const backend of compared) {
  console.log(`${backend} on ${platform}: ${summary.backends[backend].map((row) => `${row.passed}/${row.checks}`).join(' ')}`);
}
console.log(failed ? `${platform}: FAILED` : `${platform}: same on every check`);
if (!process.argv.includes('--keep')) await rm(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
