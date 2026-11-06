// Bundled for the browser by test/listener-cache-browser.test.mjs: the real
// Firebase JS SDK with the cache a device keeps between runs.
import { deleteApp, initializeApp } from 'firebase/app';
import {
  collection, connectFirestoreEmulator, initializeFirestore, onSnapshot,
  persistentLocalCache, persistentSingleTabManager, terminate,
} from 'firebase/firestore';

// Attaches to the collection, and answers with what the server says it holds.
// The app's name keys the kept cache, so every attachment finds the last one's.
window.attach = async (port, project) => {
  const app = initializeApp({ apiKey: 'demo', projectId: project, appId: '1:1:web:1' }, 'kept');
  const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }) });
  connectFirestoreEmulator(db, '127.0.0.1', port);
  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => { unsubscribe(); resolve({ error: 'no answer from the server' }); }, 15_000);
    const unsubscribe = onSnapshot(collection(db, 'kept'), { includeMetadataChanges: true }, (snapshot) => {
      if (snapshot.metadata.fromCache) return;
      clearTimeout(timer);
      unsubscribe();
      resolve({ documents: snapshot.docs.map((document) => document.id).sort() });
    }, (error) => {
      clearTimeout(timer);
      resolve({ error: `${error.code}: ${error.message}` });
    });
  });
  await terminate(db);
  await deleteApp(app);
  return answer;
};
