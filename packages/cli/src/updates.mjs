// The update check. The npm package (never the engine) asks the npm
// registry for firenook's version tags at most once a day, in the
// background, and the answer shows on the next start, so the check never
// slows one. It follows the channel the installed version is from (`next`
// for a preview, `latest` otherwise) and writes the command for the
// project's own package manager. It stays off in CI, in the plain output and
// with FIRENOOK_NO_UPDATE_CHECK=1 or NO_UPDATE_NOTIFIER=1.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { truthy } from './terminal.mjs';

export const REGISTRY = 'https://registry.npmjs.org/-/package/firenook/dist-tags';
const DAY = 24 * 60 * 60 * 1000;

// Off when any of these is set to something other than empty, 0 or false:
// CI=false is no CI.
export function updatesOff(env = process.env) {
  return ['CI', 'FIRENOOK_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'].some(name => truthy(env[name]));
}

// Where the last answer is kept: the platform's cache directory.
export function cacheFile(env = process.env, platform = process.platform) {
  const base = env.XDG_CACHE_HOME
    || (platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
      : platform === 'win32' ? (env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
        : join(homedir(), '.cache'));
  return join(base, 'firenook', 'update-check.json');
}

export const channelOf = version => (/-/.test(version) ? 'next' : 'latest');

// Whether `candidate` is a later version than `installed`: numeric parts
// compared in order, and a release later than any preview of it.
export function newer(candidate, installed) {
  const parse = version => {
    const [core, pre] = String(version).split('-', 2);
    return {core: core.split('.').map(Number), pre: pre === undefined ? undefined : pre.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))};
  };
  const a = parse(candidate);
  const b = parse(installed);
  for (let i = 0; i < 3; i += 1) if ((a.core[i] ?? 0) !== (b.core[i] ?? 0)) return (a.core[i] ?? 0) > (b.core[i] ?? 0);
  if (a.pre === undefined || b.pre === undefined) return a.pre === undefined && b.pre !== undefined;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    return String(x) > String(y);
  }
  return false;
}

// The install command for the project's package manager, from its lockfile.
export function installCommand(directory, tag) {
  const has = name => existsSync(join(directory, name));
  if (has('bun.lock') || has('bun.lockb')) return `bun add -d firenook@${tag}`;
  if (has('pnpm-lock.yaml')) return `pnpm add -D firenook@${tag}`;
  if (has('yarn.lock')) return `yarn add -D firenook@${tag}`;
  return `npm i -D firenook@${tag}`;
}

function readCache(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

// The update the last answer names, or undefined: `{version, command, tag}`.
export function pendingUpdate(installed, directory, {env = process.env, platform = process.platform} = {}) {
  if (updatesOff(env)) return undefined;
  const cached = readCache(cacheFile(env, platform));
  const tag = channelOf(installed);
  const candidate = cached?.tags?.[tag];
  if (typeof candidate !== 'string' || !newer(candidate, installed)) return undefined;
  return {version: candidate, tag, command: installCommand(directory, tag)};
}

// Asks the registry again when the last answer is a day old. Never throws,
// never holds the process open, and writes the answer for the next start.
export function refreshUpdates({env = process.env, platform = process.platform, now = Date.now(), fetcher = globalThis.fetch} = {}) {
  if (updatesOff(env) || typeof fetcher !== 'function') return Promise.resolve(undefined);
  const file = cacheFile(env, platform);
  const cached = readCache(file);
  if (cached && Number.isFinite(cached.checkedAt) && now - cached.checkedAt < DAY) return Promise.resolve(cached);
  return (async () => {
    try {
      const response = await fetcher(REGISTRY, {signal: AbortSignal.timeout(5000), headers: {accept: 'application/json'}});
      if (!response.ok) return undefined;
      const tags = await response.json();
      if (!tags || typeof tags !== 'object') return undefined;
      const answer = {checkedAt: now, tags: Object.fromEntries(Object.entries(tags).filter(([, value]) => typeof value === 'string'))};
      mkdirSync(join(file, '..'), {recursive: true});
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(answer)}\n`);
      renameSync(temporary, file);
      return answer;
    } catch { return undefined; }
  })();
}
