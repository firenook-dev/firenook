// The Linux engine is linked against glibc 2.28, RHEL 8's C library, inside
// the manylinux_2_28 image, and not against the newer glibc of the runner
// that builds it. It then starts on every glibc that old or newer: RHEL and
// its rebuilds 8+, Debian 10+, Ubuntu 20.04+, and the node:24 and
// node:24-slim images. Every image is pinned by digest; a new one is a
// reviewed change, like an action's commit.
import { GLIBC_REQUIRED } from '../packages/cli/src/binary.mjs';

export { GLIBC_REQUIRED };

// What the engine is built in, per runner architecture (process.arch).
export const builders = {
  x64: 'quay.io/pypa/manylinux_2_28_x86_64:2026.10.10-1@sha256:4131ddd7acb9c6c966af02fe7e71edc51e078c2d41f475966697676430bfa2ae',
  arm64: 'quay.io/pypa/manylinux_2_28_aarch64:2026.10.10-1@sha256:abd1230aa9e4058a74b89d27cd14ba18c0db036d7bfe6e6f219a29ea63c24eb6',
};

// Systems the packed engine must start on, oldest glibc first. Each is a
// multi-architecture index, so the x64 and arm64 jobs run the same list.
// `node`: the image has its own Node 24; the others borrow the runner's,
// whose official build itself needs glibc 2.28.
export const systems = [
  {image: 'almalinux:8@sha256:8b469a3a78515e8a18ea8fc727e6a3679e1d0c5ba6f58d5b30be3d0d9b86cffe', glibc: '2.28'},
  {image: 'debian:11@sha256:6f519a81440354a85eb592c5f32109ab80605f6b892455983a6f618bf87fabe9', glibc: '2.31'},
  {image: 'ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956', glibc: '2.35'},
  {image: 'node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e', glibc: '2.36', node: true},
];

// Systems it cannot run on, where the launcher must say so in plain words:
// Alpine's musl through the installed launcher, and a glibc just older
// than 2.28, where the system's loader refuses the engine itself.
export const refusals = {
  musl: 'node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf',
  old: {image: 'amazonlinux:2@sha256:f86b99704b49b2fde6bf42b4c5257fcb0b1e0946509da5d6cea08c4227618433', glibc: '2.26'},
};

// The libraries a Linux engine may load: glibc's own and GCC's unwinder,
// which every glibc system carries. Anything else (OpenSSL, libstdc++)
// would be missing from slim images.
export const allowedLibraries = new Set(['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1',
  'libutil.so.1', 'libgcc_s.so.1', 'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1']);

export const compareVersions = (a, b) => {
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

// What a binary asks of the system, from `readelf -d -V -W`: the libraries
// it loads and the glibc symbol versions the loader must find. A weak
// version need never stops the loader, so it does not count.
export function requirements(readelf) {
  const needed = [...readelf.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map(match => match[1]);
  const versions = [...readelf.matchAll(/Name: (GLIBC_[0-9.]+|GLIBC_PRIVATE)\s+Flags: (\S+)/g)]
    .filter(match => !/WEAK/i.test(match[2])).map(match => match[1].slice('GLIBC_'.length));
  const numbered = versions.filter(version => version !== 'PRIVATE');
  if (!needed.length || !numbered.length) throw new Error('readelf printed no libraries or glibc versions; is this a dynamically linked Linux binary?');
  return {needed, glibc: numbered.reduce((high, version) => compareVersions(version, high) > 0 ? version : high),
    private: versions.includes('PRIVATE')};
}

// The reasons a binary would not start on glibc 2.28; empty when it would.
export function problems({needed, glibc, private: usesPrivate}, required = GLIBC_REQUIRED) {
  const found = [];
  if (compareVersions(glibc, required) > 0) found.push(`it needs glibc ${glibc}, above the ${required} it promises`);
  if (usesPrivate) found.push('it uses GLIBC_PRIVATE symbols, which change between glibc releases');
  for (const library of needed) if (!allowedLibraries.has(library)) found.push(`it loads ${library}, which a minimal system may not have`);
  return found;
}
