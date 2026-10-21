// `@firebase/rules-unit-testing` against a running Firestore and Storage:
// the official emulator or Firenook, started by
// `src/rules/run-rules-unit-testing.ts`, which also runs the console's
// exported test files. Synthetic rules and data only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
import { deleteObject, getBytes, getMetadata, listAll, ref, uploadBytes } from "firebase/storage";

const fixture = new URL("../fixtures/rules-unit-testing-v1/", import.meta.url);
const projectId = process.env.GCLOUD_PROJECT ?? "demo-firenook-rules-testing";
// The library's default bucket, the one clearStorage() empties.
const bucket = `gs://${projectId}`;
let env: RulesTestEnvironment;

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: await readFile(new URL("firestore.rules", fixture), "utf8") },
    storage: { rules: await readFile(new URL("storage.rules", fixture), "utf8") },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
});

async function seed(path: string, data: Record<string, unknown>): Promise<void> {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), path), data);
  });
}

test("a signed-in user reads and writes only their own profile", async () => {
  const alice = env.authenticatedContext("alice").firestore();
  await assertSucceeds(setDoc(doc(alice, "users/alice"), { name: "Alice" }));
  await assertSucceeds(getDoc(doc(alice, "users/alice")));
  await assertSucceeds(updateDoc(doc(alice, "users/alice"), { name: "Ada" }));
  await assertFails(setDoc(doc(alice, "users/bob"), { name: "Bob" }));
  const bob = env.authenticatedContext("bob").firestore();
  await assertFails(getDoc(doc(bob, "users/alice")));
  await assertSucceeds(deleteDoc(doc(alice, "users/alice")));
});

test("a signed-out client is ruled, not treated as the owner", async () => {
  await seed("users/alice", { name: "Alice" });
  await seed("posts/p1", { author: "alice", title: "Hello" });
  const signedOut = env.unauthenticatedContext().firestore();
  const denied = await assertFails(getDoc(doc(signedOut, "users/alice")));
  assert.equal((denied as { code?: string }).code, "permission-denied");
  await assertFails(setDoc(doc(signedOut, "posts/p2"), { author: "alice" }));
  await assertSucceeds(getDoc(doc(signedOut, "posts/p1")));
  await assertSucceeds(getDocs(collection(signedOut, "posts")));
  await assertFails(getDocs(collection(signedOut, "users")));
});

test("a post is written by its author and edited only by them", async () => {
  const alice = env.authenticatedContext("alice").firestore();
  await assertSucceeds(setDoc(doc(alice, "posts/p1"), { author: "alice", title: "Hello" }));
  await assertFails(setDoc(doc(alice, "posts/p2"), { author: "bob", title: "Hello" }));
  const bob = env.authenticatedContext("bob").firestore();
  await assertFails(updateDoc(doc(bob, "posts/p1"), { title: "Mine" }));
  await assertSucceeds(updateDoc(doc(alice, "posts/p1"), { title: "Hi" }));
  await assertSucceeds(getDocs(query(collection(bob, "posts"), where("author", "==", "alice"))));
});

test("custom claims and get() lookups decide as the rules say", async () => {
  await seed("admin/settings", { open: true });
  await seed("users/dave", { role: "staff" });
  await seed("users/erin", { role: "customer" });
  await seed("orders/o1", { total: 3 });
  await assertSucceeds(getDoc(doc(env.authenticatedContext("carol", { admin: true }).firestore(), "admin/settings")));
  await assertFails(getDoc(doc(env.authenticatedContext("alice").firestore(), "admin/settings")));
  await assertSucceeds(getDoc(doc(env.authenticatedContext("dave").firestore(), "orders/o1")));
  await assertFails(getDoc(doc(env.authenticatedContext("erin").firestore(), "orders/o1")));
});

test("clearFirestore empties the database", async () => {
  await seed("posts/p1", { author: "alice" });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    assert.equal((await getDoc(doc(context.firestore(), "posts/p1"))).exists(), false);
  });
});

test("Storage rules decide uploads, reads and lists by uid", async () => {
  const alice = env.authenticatedContext("alice").storage(bucket);
  await assertSucceeds(uploadBytes(ref(alice, "users/alice/notes.txt"), new TextEncoder().encode("hello"), { contentType: "text/plain" }));
  await assertSucceeds(getMetadata(ref(alice, "users/alice/notes.txt")));
  assert.equal(new TextDecoder().decode(await getBytes(ref(alice, "users/alice/notes.txt"))), "hello");
  await assertSucceeds(listAll(ref(alice, "users/alice")));
  await assertFails(uploadBytes(ref(alice, "users/bob/notes.txt"), new TextEncoder().encode("x")));
  const bob = env.authenticatedContext("bob").storage(bucket);
  await assertFails(getMetadata(ref(bob, "users/alice/notes.txt")));
  const signedOut = env.unauthenticatedContext().storage(bucket);
  await assertFails(getMetadata(ref(signedOut, "users/alice/notes.txt")));
  await assertFails(listAll(ref(signedOut, "users/alice")));
  await assertFails(deleteObject(ref(bob, "users/alice/notes.txt")));
  await assertSucceeds(deleteObject(ref(alice, "users/alice/notes.txt")));
});

test("withSecurityRulesDisabled writes what the rules refuse, and clearStorage removes it", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(ref(context.storage(bucket), "public/logo.png"), new Uint8Array(16), { contentType: "image/png" });
    await uploadBytes(ref(context.storage(bucket), "readme.txt"), new TextEncoder().encode("hi"), { contentType: "text/plain" });
  });
  const signedOut = env.unauthenticatedContext().storage(bucket);
  await assertSucceeds(getMetadata(ref(signedOut, "public/logo.png")));
  await assertFails(uploadBytes(ref(signedOut, "public/other.png"), new Uint8Array(4)));
  await assertFails(getMetadata(ref(signedOut, "readme.txt")));
  // clearStorage() deletes the files at the bucket's root, as it lists them.
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (context) => {
    assert.deepEqual((await listAll(ref(context.storage(bucket)))).items.map((item) => item.fullPath), []);
  });
});
