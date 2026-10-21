import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

export function envValue(env, name) {
  return env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())];
}

// The engine's environment. FIRENOOK_CONTROL_STDIN: its stdin is a pipe
// only this launcher holds. On Windows the stop is asked on it; everywhere,
// its end means the launcher is gone (killed, or crashed), and the engine
// stops as a stop asked for would, saving the data, instead of running on
// with the ports and the data for nobody. Spawn it with stdin 'pipe'.
export function nativeEnvironment(env = process.env, platform = process.platform) {
  const copy = {...env};
  if (platform === 'win32') {
    // Set before native allocator initialization. Respect deliberate overrides.
    if (envValue(copy,'MIMALLOC_PURGE_DELAY') === undefined) copy.MIMALLOC_PURGE_DELAY = '100';
    if (envValue(copy,'MIMALLOC_PURGE_DECOMMITS') === undefined) copy.MIMALLOC_PURGE_DECOMMITS = '1';
  }
  copy.FIRENOOK_CONTROL_STDIN = '1';
  return copy;
}

export function resolveExecutable(name, env = process.env, platform = process.platform) {
  // npm puts a Unix shell shim beside bun.cmd on Windows. It is a file, but
  // cannot be launched as a native executable by execFile/spawn.
  const names = platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? [`${name}.exe`] : [name];
  const dirs = isAbsolute(name) || /[\\/]/.test(name) ? [''] : (envValue(env,'PATH') || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) for (const entry of names) {
    const path = resolve(dir.replace(/^"|"$/g,''),entry);
    try { if (statSync(path).isFile()) {accessSync(path,constants.X_OK); return path;} } catch { /* try next PATH entry */ }
  }
  throw new Error(`Executable not found: ${name}`);
}

export function requestNativeStop(child, signal = 'SIGINT', platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    if (!child.stdin || child.stdin.destroyed) throw new Error('Native shutdown pipe unavailable; preserve state, do not force-kill');
    if (!child.stdin.writableEnded) child.stdin.end('FIRENOOK_SHUTDOWN\n');
  } else child.kill(signal);
}
