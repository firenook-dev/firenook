// Bundled into the page storage-browser.test.mjs opens: the real Firebase JS SDK
// against Storage, from an origin that is not the emulator's, so the browser
// enforces CORS on every request.
import { initializeApp } from 'firebase/app';
import {
  connectStorageEmulator, getBytes, getMetadata, getStorage, listAll, ref, uploadBytes, uploadBytesResumable,
} from 'firebase/storage';

// Bytes that differ at every position, so a read back is a real comparison.
const pattern = (length) => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + (index >> 8)) & 255;
  return bytes;
};
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
// An upload task is awaited for its final snapshot.
const resumable = async (reference, bytes, metadata) => uploadBytesResumable(reference, bytes, metadata);
const names = (list) => ({
  items: list.items.map((item) => item.fullPath).sort(),
  prefixes: list.prefixes.map((prefix) => prefix.fullPath).sort(),
});

window.runStorageScenario = async ({ host, port, bucket }) => {
  const app = initializeApp({ apiKey: 'demo-key', appId: '1:1:web:1', projectId: bucket.split('.')[0], storageBucket: bucket });
  const storage = getStorage(app);
  connectStorageEmulator(storage, host, port);
  // A refused request should fail the step soon, not retry for ten minutes.
  storage.maxUploadRetryTime = 8_000;
  storage.maxOperationRetryTime = 8_000;
  const results = {};
  const step = async (id, run) => {
    try {
      results[id] = { ok: true, ...(await run()) };
    } catch (error) {
      results[id] = { ok: false, code: error.code ?? String(error) };
    }
  };
  for (const [label, length] of [['100 KB', 100 * 1024], ['300 KB', 300 * 1024], ['1 MB', 1024 * 1024]]) {
    const bytes = pattern(length);
    const reference = ref(storage, `open/resumable-${length}.bin`);
    await step(`uploadBytesResumable ${label}`, async () => {
      const snapshot = await resumable(reference, bytes, { contentType: 'application/x-test', customMetadata: { k: 'v' } });
      return { state: snapshot.state, transferred: snapshot.bytesTransferred };
    });
    await step(`read back ${label}`, async () => {
      const read = new Uint8Array(await getBytes(reference));
      const metadata = await getMetadata(reference);
      return { size: read.length, identical: same(read, bytes), contentType: metadata.contentType, custom: metadata.customMetadata };
    });
  }
  const oneShot = pattern(1024 * 1024);
  await step('uploadBytes 1 MB', async () => {
    const { metadata } = await uploadBytes(ref(storage, 'open/one-shot.bin'), oneShot, { contentType: 'application/x-test' });
    return { size: metadata.size, contentType: metadata.contentType };
  });
  await step('read back one-shot', async () => {
    const read = new Uint8Array(await getBytes(ref(storage, 'open/one-shot.bin')));
    return { size: read.length, identical: same(read, oneShot) };
  });

  // A refusal is reported as one, not as an upload that kept retrying.
  await step('uploadBytesResumable refused', async () => {
    await resumable(ref(storage, 'closed/resumable.bin'), pattern(300 * 1024));
    return {};
  });
  await step('uploadBytes refused', async () => {
    await uploadBytes(ref(storage, 'closed/one-shot.bin'), pattern(10));
    return {};
  });

  await step('listAll under a single-segment rule', async () => names(await listAll(ref(storage, 'open'))));
  await step('listAll below a single-segment rule', async () => names(await listAll(ref(storage, 'open/sub'))));
  await step('listAll above a single-segment rule', async () => names(await listAll(ref(storage))));
  await step('listAll under a recursive rule', async () => names(await listAll(ref(storage, 'deep'))));
  await step('listAll deeper under a recursive rule', async () => names(await listAll(ref(storage, 'deep/sub'))));
  return results;
};
