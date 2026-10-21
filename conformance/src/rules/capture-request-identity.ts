// Who a Firestore request is from: what the official emulator makes of each
// Authorization header over gRPC and REST, which rules govern a database
// firebase.json does not list, which reads need the owner, and what the SDKs
// send. Synthetic: unsigned demo-project tokens, no documents, no cloud.
//
//   node --import tsx src/rules/capture-request-identity.ts --output <empty dir>
//   node --import tsx src/rules/capture-request-identity.ts --target firenook --binary <firenook> --output <empty dir>
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Stream } from "node:http2";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { deleteApp, initializeApp } from "firebase/app";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, terminate } from "firebase/firestore";
import * as lite from "firebase/firestore/lite";
import { createV1Firestore } from "../target.ts";
import { claimPaths, identities, identityDatabases, identityPaths, identityProject, identityRules, reloadBodies } from "./request-identity-cases.ts";

const JAR_VERSION = "1.22.0";
const JAR_SHA256 = "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const target = argument("--target") ?? "java";
assert.ok(target === "java" || target === "firenook", "--target is java or firenook");
const output = resolve(argument("--output") ?? fail("--output <empty directory> is required"));
await mkdir(output, { recursive: true });
assert.deepEqual(await readdir(output), [], "capture output must be empty; never overwrite recorded oracle evidence");
const temporary = await mkdtemp(join(tmpdir(), "firenook-request-identity-"));
const logs: string[] = [];
const children: ChildProcess[] = [];
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let java: Promise<{ target: string; firestore: string; jarSha256: string; node: string; java: string | undefined; jar: string }> | undefined;

type Outcome = { code: number; message: string };
type HttpOutcome = { status: number; code: string; message: string };

try {
  const rulesFile = join(temporary, "firestore.rules");
  await writeFile(rulesFile, identityRules);
  if (target === "firenook") argument("--binary") ?? fail("--binary is required for firenook");
  const oracle = target === "java"
    ? (({ jar: _jar, ...pinned }) => pinned)(await javaOracle())
    : { target: "firenook", node: process.version };
  const ruled = await start("rules", ["--rules", rulesFile]);
  const open = await start("open", []);
  const enterprise = await start("enterprise", ["--rules", rulesFile, "--database-edition", "enterprise"]);
  const now = Math.floor(Date.now() / 1000);

  const reads = [];
  for (const database of identityDatabases) {
    for (const identity of identities) {
      for (const path of identityPaths) {
        const name = `projects/${identityProject}/databases/${database}/documents/${path}`;
        const header = identity.value(now);
        reads.push({ database, identity: identity.id, path, grpc: await grpcGet(ruled, name, header), rest: await restGet(ruled, name, header) });
      }
    }
  }
  const claims = [];
  for (const identity of identities) {
    for (const path of claimPaths) {
      const name = `projects/${identityProject}/databases/(default)/documents/${path}`;
      claims.push({ identity: identity.id, path, rest: await restGet(ruled, name, identity.value(now)) });
    }
  }
  const user = identities.find(({ id }) => id === "user")!.value(now);
  const denials = {
    twoAllows: { grpc: await grpcGet(ruled, `projects/${identityProject}/databases/(default)/documents/two/x`, user), rest: await restGet(ruled, `projects/${identityProject}/databases/(default)/documents/two/x`, user) },
    noMatchingAllow: { grpc: await grpcGet(ruled, `projects/${identityProject}/databases/(default)/documents/elsewhere/x`, user), rest: await restGet(ruled, `projects/${identityProject}/databases/(default)/documents/elsewhere/x`, user) },
    create: { rest: await restCommit(ruled, user) },
  };
  const metadata = [];
  for (const [mode, origin] of [["rules", ruled], ["open", open]] as const) {
    for (const id of ["absent", "user", "owner"]) {
      const header = identities.find((identity) => identity.id === id)!.value(now);
      metadata.push({ mode, identity: id, grpc: await grpcListCollectionIds(origin, header), rest: await restListCollectionIds(origin, header), partition: await grpcPartitionQuery(origin, header) });
    }
  }
  const pipelines = [];
  for (const id of ["user", "owner"]) {
    pipelines.push({ identity: id, ...await adminPipeline(enterprise, identities.find((identity) => identity.id === id)!.value(now)!) });
  }
  const reload = [];
  for (const body of reloadBodies) {
    const response = await fetch(`${ruled}/emulator/v1/projects/${identityProject}:securityRules`, {
      method: "PUT",
      headers: body.contentType === undefined ? {} : { "content-type": body.contentType },
      body: JSON.stringify({ rules: { files: [{ content: identityRules }] } }),
      signal: AbortSignal.timeout(10_000),
    });
    await response.arrayBuffer();
    reload.push({ body: body.id, status: response.status, governs: (await restGet(ruled, `projects/${identityProject}/databases/(default)/documents/deny/x`, undefined)).status });
  }
  const sdkHeaders = target === "java" ? await recordSdkHeaders() : undefined;

  const fixture = {
    schemaVersion: 1,
    syntheticOnly: true,
    project: identityProject,
    capturedAt: new Date().toISOString(),
    captureSha256: hash(await readFile(new URL(import.meta.url))),
    casesSha256: hash(await readFile(new URL("./request-identity-cases.ts", import.meta.url))),
    oracle,
    rules: identityRules,
    identities: identities.map(({ id, header }) => ({ id, header })),
    reads,
    claims,
    denials,
    metadata,
    pipelines,
    reload,
    ...(sdkHeaders ? { sdkHeaders } : {}),
  };
  const bytes = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(join(output, "fixture.json"), bytes);
  await writeFile(join(output, "SHA256SUMS"), `${hash(bytes)}  fixture.json\n`);
  console.log(`request identity capture (${target}): ${reads.length} reads, ${claims.length} claim reads -> ${output}`);
} catch (error) {
  await writeFile(join(output, "capture.log"), logs.join(""));
  throw error;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
  }
  await rm(temporary, { recursive: true, force: true });
}

function javaOracle() {
  java ??= pinnedJar();
  return java;
}

async function pinnedJar() {
  const jar = process.env.FIRESTORE_EMULATOR_JAR ?? join(process.env.FIREBASE_EMULATORS_PATH ?? join(homedir(), ".cache/firebase/emulators"), `cloud-firestore-emulator-v${JAR_VERSION}.jar`);
  assert.equal(hash(await readFile(jar)), JAR_SHA256, "pinned official Firestore emulator jar");
  return {
    target: "java",
    firestore: JAR_VERSION,
    jarSha256: JAR_SHA256,
    node: process.version,
    java: spawnSync(process.env.JAVA ?? "java", ["-version"], { encoding: "utf8" }).stderr.trim().split("\n")[0],
    jar,
  };
}

async function start(name: string, extra: string[]): Promise<string> {
  const port = await reservePort();
  const common = ["--host", "127.0.0.1", "--port", String(port), "--project_id", identityProject, "--single_project_mode", "true", ...extra];
  const child = target === "java"
    ? spawn(process.env.JAVA ?? "java", ["-jar", (await javaOracle()).jar, ...common], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(resolve(argument("--binary")!), common, { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (data: Buffer) => logs.push(`[${name}] ${data.toString()}`));
  child.stderr?.on("data", (data: Buffer) => logs.push(`[${name}] ${data.toString()}`));
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (true) {
    assert.equal(child.exitCode, null, `${name} emulator exited: ${logs.join("")}`);
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.status < 500) return origin;
    } catch { /* Not listening yet. */ }
    assert.ok(Date.now() < deadline, `${name} emulator did not start: ${logs.join("")}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

function headers(value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { authorization: value };
}

function grpcFailure(error: unknown): Outcome {
  const failure = error as { code?: number; details?: string; message?: string };
  return { code: failure.code ?? -1, message: failure.details ?? failure.message ?? "" };
}

async function grpcGet(origin: string, name: string, header: string | undefined): Promise<Outcome> {
  const client = createV1Firestore({ name: "java", projectId: identityProject, host: new URL(origin).host });
  try {
    await client.getDocument({ name }, { retry: null, timeout: 10_000, otherArgs: { headers: headers(header) } });
    return { code: 0, message: "" };
  } catch (error) {
    return grpcFailure(error);
  } finally {
    await client.close();
  }
}

async function grpcListCollectionIds(origin: string, header: string | undefined): Promise<Outcome> {
  const client = createV1Firestore({ name: "java", projectId: identityProject, host: new URL(origin).host });
  try {
    await client.listCollectionIds({ parent: `projects/${identityProject}/databases/(default)/documents` }, { retry: null, timeout: 10_000, autoPaginate: false, otherArgs: { headers: headers(header) } });
    return { code: 0, message: "" };
  } catch (error) {
    return grpcFailure(error);
  } finally {
    await client.close();
  }
}

async function grpcPartitionQuery(origin: string, header: string | undefined): Promise<Outcome> {
  const client = createV1Firestore({ name: "java", projectId: identityProject, host: new URL(origin).host });
  try {
    await client.partitionQuery({
      parent: `projects/${identityProject}/databases/(default)/documents`,
      structuredQuery: { from: [{ collectionId: "deny", allDescendants: true }], orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }] },
      partitionCount: 2,
    }, { retry: null, timeout: 10_000, autoPaginate: false, otherArgs: { headers: headers(header) } });
    return { code: 0, message: "" };
  } catch (error) {
    return grpcFailure(error);
  } finally {
    await client.close();
  }
}

async function http(response: Response): Promise<HttpOutcome> {
  const text = await response.text();
  let body: { error?: { status?: string; message?: string } } = {};
  try { body = JSON.parse(text) as typeof body; } catch { /* Not JSON. */ }
  return { status: response.status, code: body.error?.status ?? (response.ok ? "OK" : ""), message: body.error?.message ?? (response.ok ? "" : text.slice(0, 200)) };
}

async function restGet(origin: string, name: string, header: string | undefined): Promise<HttpOutcome> {
  return await http(await fetch(`${origin}/v1/${name}`, { headers: headers(header), signal: AbortSignal.timeout(10_000) }));
}

async function restListCollectionIds(origin: string, header: string | undefined): Promise<HttpOutcome> {
  return await http(await fetch(`${origin}/v1/projects/${identityProject}/databases/(default)/documents:listCollectionIds`, {
    method: "POST", headers: { ...headers(header), "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000),
  }));
}

async function restCommit(origin: string, header: string | undefined): Promise<HttpOutcome> {
  const name = `projects/${identityProject}/databases/(default)/documents/writes/small`;
  return await http(await fetch(`${origin}/v1/projects/${identityProject}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: { ...headers(header), "content-type": "application/json" },
    body: JSON.stringify({ writes: [{ update: { name, fields: { n: { integerValue: "0" } } }, currentDocument: { exists: false } }] }),
    signal: AbortSignal.timeout(10_000),
  }));
}

async function adminPipeline(origin: string, header: string): Promise<{ pipeline: Outcome; query: Outcome }> {
  const firestore = new Firestore({ projectId: identityProject, host: new URL(origin).host, ssl: false, customHeaders: { Authorization: header } });
  const settle = async (operation: () => Promise<unknown>): Promise<Outcome> => {
    try { await operation(); return { code: 0, message: "" }; } catch (error) { return grpcFailure(error); }
  };
  try {
    return {
      pipeline: await settle(() => firestore.pipeline().collection("deny").limit(1).execute()),
      query: await settle(() => firestore.collection("deny").limit(1).get()),
    };
  } finally {
    await firestore.terminate();
  }
}

/** What each SDK sends: listeners that record each request's headers and refuse it. */
async function recordSdkHeaders() {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const grpc = createHttp2Server();
  grpc.on("stream", (stream: ServerHttp2Stream, requestHeaders) => {
    seen.push({ path: String(requestHeaders[":path"]), authorization: requestHeaders.authorization });
    stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "7", "grpc-message": "recorded" }, { endStream: true });
  });
  const rest = createHttpServer((request, response) => {
    seen.push({ path: request.url ?? "", authorization: request.headers.authorization });
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: 403, message: "recorded", status: "PERMISSION_DENIED" } }));
  });
  const ports: number[] = [];
  for (const server of [grpc, rest]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    ports.push(address.port);
  }
  const [grpcPort, restPort] = ports as [number, number];
  const record = async (sdk: string, operation: () => Promise<unknown>) => {
    const before = seen.length;
    await Promise.race([operation().catch(() => undefined), new Promise((done) => setTimeout(done, 5000))]);
    const requests = seen.slice(before);
    assert.ok(requests.length > 0, `${sdk} sent nothing`);
    return {
      sdk,
      paths: [...new Set(requests.map(({ path }) => path.split("?")[0]))],
      authorization: [...new Set(requests.map(({ authorization }) => describeAuthorization(authorization)))],
    };
  };
  const results = [];
  try {
    const admin = new Firestore({ projectId: identityProject, host: `127.0.0.1:${grpcPort}`, ssl: false });
    results.push(await record("@google-cloud/firestore (Admin SDK), gRPC", () => admin.doc("deny/x").get()));
    await admin.terminate();
    for (const [label, mockUserToken] of [["signed out", undefined], ["mockUserToken {sub: alice}", { sub: "alice" }]] as const) {
      const app = initializeApp({ projectId: identityProject, apiKey: "synthetic" }, `identity-${label}`);
      const db = getFirestore(app);
      connectFirestoreEmulator(db, "127.0.0.1", grpcPort, mockUserToken ? { mockUserToken } : {});
      results.push(await record(`firebase/firestore (Node, gRPC), ${label}`, () => getDoc(doc(db, "deny/x"))));
      await terminate(db);
      await deleteApp(app);
      const liteApp = initializeApp({ projectId: identityProject, apiKey: "synthetic" }, `identity-lite-${label}`);
      const liteDb = lite.getFirestore(liteApp);
      lite.connectFirestoreEmulator(liteDb, "127.0.0.1", restPort, mockUserToken ? { mockUserToken } : {});
      results.push(await record(`firebase/firestore/lite (REST), ${label}`, () => lite.getDoc(lite.doc(liteDb, "deny/x"))));
      await lite.terminate(liteDb);
      await deleteApp(liteApp);
    }
  } finally {
    grpc.close();
    rest.close();
  }
  return results;
}

/** An Authorization value without its token: absent, owner, or the shape of an unsigned JWT. */
function describeAuthorization(value: string | undefined): string {
  if (value === undefined) return "absent";
  if (value === "Bearer owner") return "Bearer owner";
  const token = /^Bearer (.+)$/.exec(value)?.[1];
  const [header, payload, signature] = token?.split(".") ?? [];
  if (header === undefined || payload === undefined || signature === undefined) return "other";
  const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  const claims = decode(payload);
  return `Bearer <unsigned JWT: alg ${String(decode(header).alg)}, sub ${String(claims.sub)}, iat ${String(claims.iat)}, exp ${String(claims.exp)}, signature ${signature === "" ? "empty" : "present"}>`;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  throw new Error(message);
}
