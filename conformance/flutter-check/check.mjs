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
//     [--runs <n>]             repeat each backend; flaky checks are counted
//     [--cold-boot]            restart the simulator before each run
//     [--out <directory>]      where results go (default: a new temporary one)
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

// Timing on a client, not a contract: reported, and repeated by --runs, but a
// difference here alone does not fail the check.
const FLAKY = new Set(['fs.pending_writes']);

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
const out = resolve(argument('out', await mkdtemp(join(tmpdir(), 'flutter-check-results-'))));
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

// The generated project lives outside the repository; only the app's own files
// and the settings a local emulator needs are put into it.
async function prepareApp(work) {
  const app = join(work, 'app');
  await mkdir(app, { recursive: true });
  const platforms = platform === 'web' ? 'web' : platform;
  log(`creating the ${platforms} project`);
  await execute(flutter, ['create', '--no-pub', '--project-name', 'flutter_check', '--org', organisation, `--platforms=${platforms}`, app], { env: environment, maxBuffer: 16 * 1024 * 1024 });
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

async function stop(child, signal = 'SIGINT') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { return; }
  await Promise.race([once(child, 'exit'), delay(40_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

async function resetDevice(device) {
  if (platform === 'ios') {
    if (coldBoot) {
      log('restarting the simulator');
      await execute('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    }
    await execute('xcrun', ['simctl', 'boot', device]).catch(() => {});
    await execute('xcrun', ['simctl', 'bootstatus', device, '-b'], { maxBuffer: 16 * 1024 * 1024 });
    await execute('xcrun', ['simctl', 'uninstall', device, bundles.ios]).catch(() => {});
  }
  if (platform === 'android') {
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
  const label = `${platform}-${backend}${runs > 1 ? `-${run}` : ''}`;
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
      await resetDevice(device);
      const args = ['run', '-d', device, '--no-pub', '--target', 'lib/main.dart'];
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
      client.stdin.write('q');
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
  const flaky = [];
  for (const name of new Set([...Object.keys(right.results), ...Object.keys(left.results)])) {
    const [a, b] = [left.results[name], right.results[name]];
    if (a && b && a.ok === b.ok && a.detail === b.detail) continue;
    (FLAKY.has(name) ? flaky : differences).push({ name, [left.backend]: a ?? 'missing', [right.backend]: b ?? 'missing' });
  }
  return { differences, flaky };
}

const work = await mkdtemp(join(tmpdir(), `flutter-check-${platform}-`));
const device = await flutterDevice();
log(`platform ${platform}, device ${device}, results in ${out}`);
const app = await prepareApp(work);
const template = await prepareBackend(work);
const reports = {};
for (let run = 1; run <= runs; run += 1) {
  for (const backend of backends) {
    (reports[backend] ??= []).push(await runOnce(backend, run, app, template, device, work));
  }
}

let failed = false;
const summary = { platform, device, runs, backends: {} };
for (const backend of backends) {
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
if (backends.length === 2) {
  const [first, second] = backends;
  summary.differences = [];
  summary.flaky = [];
  for (let index = 0; index < runs; index += 1) {
    const { differences, flaky } = compare(reports[first][index], reports[second][index]);
    summary.differences.push(...differences);
    summary.flaky.push(...flaky);
  }
  for (const difference of summary.differences) {
    failed = true;
    console.log(`DIFFERENT ${JSON.stringify(difference)}`);
  }
  for (const difference of summary.flaky) console.log(`flaky, not failing: ${JSON.stringify(difference)}`);
}
await writeFile(join(out, `${platform}-summary.json`), `${JSON.stringify(summary, null, 1)}\n`);
for (const backend of backends) {
  console.log(`${backend} on ${platform}: ${summary.backends[backend].map((row) => `${row.passed}/${row.checks}`).join(' ')}`);
}
console.log(failed ? `${platform}: FAILED` : `${platform}: same on every check`);
process.exit(failed ? 1 : 0);
