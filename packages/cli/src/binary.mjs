import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
export const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url)));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The oldest glibc the Linux engine runs on. It is linked against this one
// (packaging/cargo-glibc.mjs), and packaging/smoke-glibc.mjs fails a build
// whose engine asks for more.
export const GLIBC_REQUIRED = '2.28';
const loaders = {x64: '/lib64/ld-linux-x86-64.so.2', arm64: '/lib/ld-linux-aarch64.so.1'};
const newer = (a, b) => {
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  return (x[0] - y[0] || x[1] - y[1]) > 0 ? a : b;
};
const glibcImages = 'node:24 or node:24-slim';

// What this Linux lacks for the engine, and the way out, in plain words.
function glibcNeeded({needs = GLIBC_REQUIRED, has, loader}) {
  if (!has) return `the Linux engine needs glibc ${needs} or newer, and this system has no glibc: its C library is musl, as on Alpine Linux. Use a glibc system or image instead, such as ${glibcImages} rather than node:24-alpine`;
  if (loader) return `the Linux engine needs glibc's loader at ${loader}, and this system has none there, though it has glibc ${has}. NixOS keeps it elsewhere: enable programs.nix-ld, or use a system or image such as ${glibcImages}`;
  const instead = needs === GLIBC_REQUIRED ? `RHEL 8, Debian 10, Ubuntu 20.04 or later, or ${glibcImages}` : `one with glibc ${needs} or newer`;
  return `the Linux engine needs glibc ${needs} or newer, and this system has glibc ${has}. Use a newer system or image: ${instead}`;
}

export function platformKey(platform = process.platform, arch = process.arch, report = process.report.getReport()) {
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(release.platforms, key)) {
    throw new Error(`Unsupported platform ${key}. Supported: ${Object.keys(release.platforms).join(', ')} (Linux with glibc ${GLIBC_REQUIRED} or newer). No automatic build/download fallback.`);
  }
  if (platform === 'linux' && !report.header?.glibcVersionRuntime) throw new Error(glibcNeeded({}));
  return key;
}

// Recognises the system's dynamic loader refusing the engine, from a run
// that failed: the error the spawn gave and what the run printed to stderr.
// The loader prints a line for each glibc version it lacks ("version
// `GLIBC_2.28' not found"), and a missing loader makes the existing binary
// ENOENT. Returns the plain message, or undefined for any other failure.
export function loaderProblem({error, stderr = ''} = {}, {arch = process.arch, glibc = () => process.report.getReport().header?.glibcVersionRuntime} = {}) {
  const versions = [...stderr.matchAll(/version [`'\u2018]GLIBC_([0-9]+\.[0-9]+)(?:\.[0-9]+)?['\u2019] not found/g)].map(match => match[1]);
  if (versions.length) return glibcNeeded({needs: versions.reduce(newer, GLIBC_REQUIRED), has: glibc()});
  if (error?.code === 'ENOENT') return glibcNeeded({has: glibc(), loader: loaders[arch] ?? 'the path the engine names'});
  const library = /error while loading shared libraries: ([^:\s]+): cannot open shared object file/.exec(stderr);
  if (library) return `the Linux engine needs ${library[1]} from the system, which this system does not have. Install it, or use a fuller system or image, such as ${glibcImages}`;
}

// Starts a Linux engine once, to see the system's loader accept it, so a
// refusal reads as what to do rather than a line of symbol versions.
export function checkLoads(binary, {run = spawnSync, ...context} = {}) {
  const result = run(binary, ['--version'], {encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'], timeout:30_000});
  const problem = result.status === 0 ? undefined : loaderProblem({error:result.error, stderr:result.stderr ?? ''}, context);
  if (problem) throw new Error(problem);
  return binary;
}

export function verifyBinary(directory, key) {
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json')));
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  const binary = join(directory, 'bin', key.startsWith('win32-') ? 'firenook.exe' : 'firenook');
  if (pkg.name !== `@firenook/cli-${key}` || pkg.version !== manifest.version ||
      receipt.engineRevision !== release.engineRevision || receipt.platform !== key ||
      receipt.version !== manifest.version || receipt.target !== release.platforms[key]) {
    throw new Error('Firenook platform package identity mismatch; reinstall the pinned CLI and its optional dependencies.');
  }
  accessSync(binary, constants.X_OK);
  if (sha256(readFileSync(binary)) !== receipt.sha256) throw new Error('Firenook binary checksum mismatch; refusing execution.');
  return binary;
}

export function binaryPath() {
  const key = platformKey();
  let file;
  try { file = require.resolve(`@firenook/cli-${key}/package.json`); }
  catch { throw new Error(`Missing @firenook/cli-${key}@${manifest.version}. Install with optional dependencies enabled. No postinstall script is needed.`); }
  const binary = verifyBinary(dirname(file), key);
  return key.startsWith('linux-') ? checkLoads(binary) : binary;
}
