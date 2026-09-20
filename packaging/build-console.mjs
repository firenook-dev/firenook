// Build the console (console/dist) that the engine embeds. Every path that
// compiles the `firenook` binary for packaging runs this first, so a packed
// engine never ships without its UI. Uses the pinned lockfile only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageManager } from './package-manager.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const console_ = join(root, 'console');
packageManager('npm', ['ci', '--prefix', console_, '--no-audit', '--no-fund'], {cwd: root, stdio: 'inherit'});
packageManager('npm', ['run', 'build', '--prefix', console_], {cwd: root, stdio: 'inherit'});
for (const required of ['index.html', join('.vite', 'manifest.json')]) {
  if (!existsSync(join(console_, 'dist', required))) throw new Error(`console build did not produce dist/${required}`);
}
