// The Firebase CLI's own store (configstore 5, as firebase-tools keeps it):
// `$XDG_CONFIG_HOME/configstore/firebase-tools.json`, else
// `<os.homedir()>/.config/configstore/firebase-tools.json`. Firenook reads
// only the active projects `firebase use` records there, never writes the
// file, and never reads or prints anything else it holds (the login).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// xdg-basedir 4: XDG_CONFIG_HOME when set (and not empty), else <home>/.config;
// without either, configstore falls back to a fresh temporary directory,
// which holds nothing.
export function configstorePath(env = process.env, home = homedir()) {
  const base = env.XDG_CONFIG_HOME || (home ? join(home, '.config') : undefined);
  return base ? join(base, 'configstore', 'firebase-tools.json') : undefined;
}

// The `activeProjects` map (project directory → alias or project id); empty
// when the file is absent or unreadable, as configstore reads it.
export function activeProjects(path = configstorePath()) {
  if (!path || !existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const map = data?.activeProjects;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch { return {}; }
}

// The official configstoreProject: the entry recorded for the project
// directory or the nearest parent that has one. Keys are matched exactly as
// `firebase use` wrote them (the directory as the process's working
// directory spells it), never through links.
export function activeProject(directory, projects = activeProjects()) {
  let current = resolve(directory);
  for (;;) {
    const entry = Object.hasOwn(projects, current) ? projects[current] : undefined;
    if (typeof entry === 'string' && entry) return entry;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
