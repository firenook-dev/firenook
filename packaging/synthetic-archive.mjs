// Constructed artifact-verifier models, never executable/platform evidence:
// a gzipped ustar archive of `package/<path>` entries, as npm packs them.
import {gzipSync} from 'node:zlib';

export function syntheticArchive(files) {
  const blocks = [];
  for (const [name, input] of Object.entries(files)) {
    const body = Buffer.from(input), header = Buffer.alloc(512);
    header.write('package/' + name); header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write('0', 156); header.write('ustar\0', 257);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
