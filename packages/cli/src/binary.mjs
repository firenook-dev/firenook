import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
export const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url)));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function platformKey(platform = process.platform, arch = process.arch, report = process.report.getReport()) {
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(release.platforms, key) || (platform === 'linux' && !report.header?.glibcVersionRuntime)) {
    throw new Error(`Unsupported platform ${key}. Supported: ${Object.keys(release.platforms).join(', ')} (Linux requires glibc). No automatic build/download fallback.`);
  }
  return key;
}

// The Node majors the emulators are tested on. Your Functions run on the
// Node that runs Firenook, as the official emulator runs them on its own.
export const NODE_TESTED = [22, 24, 26];

// What this Node means for the emulators. Older than the oldest tested line
// is refused (`problem`): those lines are past their end of life. An odd or
// a newer major starts with a warning (`note`): the official CLI runs on any
// Node from its floor up, and refusing a newer one would stop a start that
// works.
export function nodeCheck(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  const check = {version, major, tested:NODE_TESTED.includes(major)};
  if (check.tested) return check;
  if (!(major > NODE_TESTED[0])) return {...check, problem:`the emulators need Node 22, 24 or 26, since your Functions run on it; this is Node ${version}. Switch to Node 24 (with nvm: nvm install 24) and run it again`};
  return {...check, note:`Node ${version} is not one the emulators are tested on (22, 24 and 26); they start on it, and your Functions run on it. If something behaves differently, switch to Node 24 (with nvm: nvm install 24)`};
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
  return verifyBinary(dirname(file), key);
}
