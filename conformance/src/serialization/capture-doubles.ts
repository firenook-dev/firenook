// Records doubles written as JSON numbers and read back. Each value is
// written through REST (a PATCH whose numbers are JavaScript's
// `JSON.stringify` output) and through the real Firebase browser SDK
// (`setDoc` over WebChannel), then read back through REST, gRPC
// GetDocument and the browser SDK; every read keeps the value's bits.
//
//   JAVA=/path/to/java node --import tsx src/serialization/capture-doubles.ts --output DIR
//   node --import tsx src/serialization/capture-doubles.ts --origin http://127.0.0.1:PORT --output DIR
//
// Without --origin it runs the checksum-pinned official Java emulator 1.22.0
// (FIRESTORE_EMULATOR_JAR, or firebase-tools' cache). With it, a loopback
// emulator with open rules. Synthetic documents only; never overwrites.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createV1Firestore } from "../target.ts";
import { doubleBits, doubleValues, doublesPerDocument, doublesProject, type DoubleCapture, type DoubleObservation } from "./doubles.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
};
const version = "1.22.0";
const jarSha256 = "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const external = argument("--origin");
if (external) {
  const url = new URL(external);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "replay is loopback-only");
}
const output = resolve(argument("--output")!);
await mkdir(output, { recursive: true });
assert.deepEqual(await readdir(output), [], "never overwrite a recorded capture");
const temporary = await mkdtemp(join(tmpdir(), "firenook-double-capture-"));
const port = await reservePort();
const origin = external ?? `http://127.0.0.1:${port}`;
const raw = createV1Firestore({ name: external ? "firenook" : "java", projectId: doublesProject, host: new URL(origin).host });
const database = `projects/${doublesProject}/databases/(default)`;
const options = { retry: null, timeout: 10_000, otherArgs: { headers: { authorization: "Bearer owner" } } };
const values = doubleValues();
const chunks: number[][] = [];
for (let start = 0; start < values.length; start += doublesPerDocument) chunks.push(values.slice(start, start + doublesPerDocument));
const observations: DoubleObservation[] = [];
const startedAt = new Date().toISOString();
let child: ChildProcess | undefined;
let logs = "";
let javaVersion: string | null = null;
try {
  if (!external) {
    const jar = process.env.FIRESTORE_EMULATOR_JAR ?? join(process.env.HOME!, `.cache/firebase/emulators/cloud-firestore-emulator-v${version}.jar`);
    assert.equal(sha(await readFile(jar)), jarSha256);
    const java = process.env.JAVA ?? "java";
    javaVersion = await new Promise<string>((done, fail) => {
      const probe = spawn(java, ["-version"]); let text = "";
      probe.stderr.on("data", data => { text += String(data); });
      probe.on("error", fail); probe.on("exit", () => done(/version "([^"]+)"/u.exec(text)?.[1] ?? "unknown"));
    });
    const rules = join(temporary, "firestore.rules");
    await writeFile(rules, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read, write: if true; } } }\n");
    child = spawn(java, ["-jar", jar, "--host", "127.0.0.1", "--port", String(port), "--project_id", doublesProject, "--rules", rules], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", data => { logs += String(data); });
    child.stderr?.on("data", data => { logs += String(data); });
  }
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await fetch(origin); break; } catch {
      assert.ok(Date.now() < deadline, logs); assert.ok(child === undefined || child.exitCode === null, logs);
      await new Promise(done => setTimeout(done, 100));
    }
  }

  // REST: the request body is built from JSON.stringify's numbers.
  for (const [index, chunk] of chunks.entries()) {
    const body = JSON.stringify({ fields: { values: { arrayValue: { values: chunk.map(doubleValue => ({ doubleValue })) } } } });
    const response = await fetch(`${origin}/v1/${database}/documents/doubles/rest-patch-${index}`, {
      method: "PATCH", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 200, await response.text());
  }

  // The browser SDK writes over WebChannel, then reads every document back.
  const bundle = await build({ stdin: { sourcefile: "double-round-trip.js", resolveDir: join(repo, "conformance"), contents: `
    import {initializeApp,deleteApp} from 'firebase/app';
    import {initializeFirestore,connectFirestoreEmulator,doc,setDoc,getDocFromServer,terminate} from 'firebase/firestore';
    window.roundTrip = async (port,chunks,ids) => {
      const app=initializeApp({projectId:${JSON.stringify(doublesProject)},apiKey:'synthetic-double-capture'});
      const db=initializeFirestore(app,{experimentalForceLongPolling:false,experimentalAutoDetectLongPolling:false});
      connectFirestoreEmulator(db,'127.0.0.1',port);
      try {
        for(let i=0;i<chunks.length;i++) await setDoc(doc(db,'doubles','browser-set-'+i),{values:chunks[i]});
        const reads={};
        for(const id of ids) reads[id]=(await getDocFromServer(doc(db,'doubles',id))).data().values;
        return reads;
      } finally {await terminate(db);await deleteApp(app);}
    };` }, bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/app.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/app.js" ? bundle.outputFiles[0]!.text : '<script src="/app.js"></script>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const ids = ["rest-patch", "browser-set"].flatMap(write => chunks.map((_, index) => `${write}-${index}`));
  let browserReads: Record<string, number[]>;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome") });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    browserReads = await page.evaluate(`window.roundTrip(${Number(new URL(origin).port)},${JSON.stringify(chunks)},${JSON.stringify(ids)})`);
    assert.deepEqual(errors, []); await page.close();
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }

  for (const write of ["rest-patch", "browser-set"] as const) {
    for (const index of chunks.keys()) {
      const document = `${write}-${index}`;
      const name = `${database}/documents/doubles/${document}`;
      const response = await fetch(`${origin}/v1/${name}`, { headers: { authorization: "Bearer owner" } });
      assert.equal(response.status, 200);
      const rest = (await response.json() as { fields: { values: { arrayValue: { values: { doubleValue: number }[] } } } }).fields.values.arrayValue.values;
      observations.push({ write, read: "rest-get", document, bits: rest.map(value => doubleBits(value.doubleValue)) });
      const [grpc] = await raw.getDocument({ name }, options);
      const array = grpc.fields!["values"]!.arrayValue!.values!;
      observations.push({ write, read: "grpc-get", document, bits: array.map(value => { assert.equal((value as { valueType?: string }).valueType, "doubleValue"); return doubleBits(value.doubleValue!); }) });
      observations.push({ write, read: "browser-get", document, bits: browserReads[document]!.map(doubleBits) });
    }
  }
  const capture: DoubleCapture = {
    values: values.map(value => ({ bits: doubleBits(value), json: JSON.stringify(value) })),
    documents: chunks.length,
    observations,
  };
  await writeFile(join(output, "observations.json"), JSON.stringify(capture, null, 2) + "\n");
  await writeFile(join(output, "metadata.json"), JSON.stringify({
    schemaVersion: 1, target: external ? "firenook" : "official-java-emulator", version: external ? argument("--candidate-version") ?? null : version,
    javaJarSha256: external ? null : jarSha256, javaVersion, capturedAt: startedAt, syntheticOnly: true,
    values: values.length, documentsPerWrite: chunks.length, writes: 2, reads: 3,
    nodeVersion: process.version, platform: process.platform, nativeSdk: "@google-cloud/firestore@9.0.0", browserSdk: "firebase@12.18.0",
    observationLevel: "each value's IEEE 754 bits as read back; no envelope comparison",
  }, null, 2) + "\n");
} finally {
  await raw.close();
  if (child && child.exitCode === null) { const exited = new Promise(done => child!.once("exit", done)); child.kill("SIGTERM"); await exited; }
  await writeFile(join(temporary, "capture.log"), logs);
  console.log(JSON.stringify({ diagnosticsDirectory: temporary }));
  const files = (await readdir(output)).sort();
  await writeFile(join(output, "SHA256SUMS"), (await Promise.all(files.map(async name => `${sha(await readFile(join(output, name)))}  ${name}\n`))).join(""));
}
function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
async function reservePort(): Promise<number> {
  const server = createNetServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(done => server.close(() => done())); return address.port;
}
