// What a Firestore emulator answers a listener that resumes with each kind of
// token or read time, as seen by the same raw client on either emulator. Shared
// by the capture and the replay; `restart` restarts the emulator under test.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { v1 } = require('@google-cloud/firestore');
const { credentials } = require('@grpc/grpc-js');

export const project = 'demo-firenook-listen-resume';
const database = `projects/${project}/databases/(default)`;
const headers = { 'google-cloud-resource-prefix': database };

const client = (port) => new v1.FirestoreClient({
  apiEndpoint: '127.0.0.1', port, projectId: project, sslCreds: credentials.createInsecure(),
});

// Frames up to the first checkpoint after CURRENT, or the refusal.
const listen = (firestore, resume) => new Promise((resolve) => {
  const stream = firestore.listen({ otherArgs: { headers } });
  const frames = [];
  const documents = [];
  let token;
  const finish = (ending) => {
    clearTimeout(timer);
    stream.cancel();
    resolve({ frames, documents: documents.sort(), token, ...ending });
  };
  const timer = setTimeout(() => finish({ ending: 'timed out' }), 10_000);
  stream.on('data', (message) => {
    const change = message.targetChange;
    if (change) {
      frames.push(change.targetChangeType);
      if (change.resumeToken?.length) token = Buffer.from(change.resumeToken).toString('hex');
      if (change.targetChangeType === 'REMOVE') finish({ ending: 'removed', code: change.cause?.code, message: change.cause?.message });
      else if (change.targetChangeType === 'NO_CHANGE' && frames.includes('CURRENT')) finish({ ending: 'current' });
    } else {
      frames.push(message.responseType);
      if (message.documentChange) documents.push(message.documentChange.document.name.split('/').at(-1));
    }
  });
  stream.on('error', (error) => { if (error.code !== 1) finish({ ending: 'stream closed', code: error.code, message: error.details }); });
  stream.write({
    database,
    addTarget: {
      targetId: 2,
      ...resume,
      query: { parent: `${database}/documents`, structuredQuery: { from: [{ collectionId: 'resume' }] } },
    },
  });
});

const write = (firestore, id) => firestore.commit({
  database,
  writes: [{ update: { name: `${database}/documents/resume/${id}`, fields: { v: { integerValue: 1 } } } }],
}, { otherArgs: { headers } });

const row = ({ token, ...observed }) => observed;

// `foreign` is a token the other emulator issued, as a device's cache keeps it.
export const observe = async (port, restart, foreign, log = () => {}) => {
  let firestore = client(port);
  const answers = {};
  const record = async (id, resume) => {
    const observed = await listen(firestore, resume);
    log(`${id}: ${observed.frames.join(' ')} [${observed.documents}] ${observed.message ?? ''}`);
    answers[id] = row(observed);
    return observed;
  };
  for (const id of ['a', 'b', 'c']) await write(firestore, id);
  const now = Math.floor(Date.now() / 1000);
  const { token: issued } = await record('no-token', {});
  await record('empty-token', { resumeToken: Buffer.alloc(0) });
  await record('malformed-token', { resumeToken: Buffer.from([1, 2, 3]) });
  await record('text-token', { resumeToken: Buffer.from('not-a-token') });
  await record('token-from-the-other-emulator', { resumeToken: Buffer.from(foreign ?? issued, 'hex') });
  await record('own-token', { resumeToken: Buffer.from(issued, 'hex') });
  await record('read-time-a-day-ago', { readTime: { seconds: now - 86_400 } });
  await record('read-time-a-day-ahead', { readTime: { seconds: now + 86_400 } });
  await record('read-time-with-nanoseconds', { readTime: { seconds: now - 86_400, nanos: 123 } });
  await record('read-time-zero', { readTime: { seconds: 0 } });

  await firestore.close();
  const restarted = await restart();
  firestore = client(restarted);
  await record('own-token-after-a-restart', { resumeToken: Buffer.from(issued, 'hex') });
  await write(firestore, 'after');
  await record('own-token-after-a-restart-and-a-write', { resumeToken: Buffer.from(issued, 'hex') });
  await firestore.close();
  return { issued, answers };
};
