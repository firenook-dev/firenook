// Runs one cargo command inside the manylinux_2_28 image, so what it links
// asks for glibc 2.28 at most, whatever the runner's own glibc is. The
// runner's pinned Rust toolchain is mounted read-only and used as it is
// (its compilers themselves need only glibc 2.17); the image adds glibc
// 2.28 and the GCC that ring and mimalloc's C is compiled with. The
// current directory is mounted at its own path, so --manifest-path and the
// target directory under it mean the same inside and out.
//
//   node packaging/cargo-glibc.mjs TOOLCHAIN CARGO_ARGUMENTS...
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { builders } from './old-glibc.mjs';

const [toolchain, ...cargo] = process.argv.slice(2);
if (!toolchain || !cargo.length) throw new Error('Usage: node packaging/cargo-glibc.mjs TOOLCHAIN CARGO_ARGUMENTS...');
if (process.platform !== 'linux' || !Object.hasOwn(builders, process.arch)) throw new Error(`cargo-glibc builds Linux engines on Linux x64 or arm64, not ${process.platform}-${process.arch}`);
const sysroot = execFileSync('rustup', ['run', toolchain, 'rustc', '--print', 'sysroot'], {encoding: 'utf8'}).trim();
// Crates download into the runner's own cargo home, as a cargo run there would.
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
mkdirSync(cargoHome, {recursive: true});
const cwd = process.cwd();
// Cargo's own settings and the build's flags pass through; nothing else of
// the runner's environment reaches the build.
const passed = Object.keys(process.env).filter(name => (name.startsWith('CARGO_') && name !== 'CARGO_HOME') ||
  ['RUSTFLAGS', 'RUSTDOCFLAGS', 'RUST_BACKTRACE', 'CI'].includes(name));
// A rootful daemon (a CI runner's) is told the user, so the target directory
// stays the runner's; rootless Docker already runs the container's root as
// the invoking user, and a named user there would be a stranger.
const rootless = execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], {encoding: 'utf8'}).includes('rootless');
const args = ['run', '--rm', ...(rootless ? [] : ['--user', `${process.getuid()}:${process.getgid()}`]),
  '-v', `${sysroot}:${sysroot}:ro`, '-v', `${cargoHome}:${cargoHome}`, '-v', `${cwd}:${cwd}`, '-w', cwd,
  '-e', 'HOME=/tmp', '-e', `CARGO_HOME=${cargoHome}`, '-e', `FIRENOOK_SYSROOT=${sysroot}`,
  ...passed.flatMap(name => ['-e', name]),
  builders[process.arch], 'sh', '-c', 'PATH="$FIRENOOK_SYSROOT/bin:$PATH" exec cargo "$@"', 'cargo', ...cargo];
console.error(`cargo ${cargo.join(' ')}  (in ${builders[process.arch].split('@')[0]}, Rust ${toolchain})`);
execFileSync('docker', args, {stdio: 'inherit'});
