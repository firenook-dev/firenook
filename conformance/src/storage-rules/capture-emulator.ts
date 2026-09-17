// Phase G1: record every emulator oracle program in `emulator-plan.ts` against
// the official Storage emulator (firebase-tools 15.22.0 in process, exact
// rules runtime jar) with the official Firestore emulator (1.22.0) registered
// so that `firestore.*` callbacks reach real documents.
//
// Requires FIREBASE_TOOLS_15_22_ROOT, Java on PATH, and the two jars under
// ~/.cache/firebase/emulators. Everything recorded is synthetic.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSETS_BUCKET,
  DEFAULT_BUCKET,
  ORACLE_CRASH_EMPTY_SEGMENT,
  PROGRAMS,
  SYNTAX_ERROR_RULES,
  PROJECT_ID,
  TOKEN_PAYLOADS,
  THIRD_BUCKET,
  allowAll,
  type Program,
  type RulesFile,
  type Step,
  type StepBody,
} from "./emulator-plan.ts";

const HOST = "127.0.0.1";
const FIREBASE_TOOLS_VERSION = "15.22.0";
const RULES_RUNTIME_SHA256 =
  "0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900";
const FIRESTORE_VERSION = "1.22.0";
const FIRESTORE_JAR_SHA256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const MULTIPART_BOUNDARY = "fireside-phase-g-boundary";
const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/storage-rules-v1");

interface LogLine {
  readonly type: string;
  readonly text: string;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly resolvedPath: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface RecordedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface Observation {
  readonly id: string;
  readonly note?: string;
  readonly rulesInstall?: { readonly files: readonly RulesFile[]; readonly response: RecordedResponse; readonly logs: readonly LogLine[] };
  readonly firestoreWrite?: {
    readonly path: string;
    readonly fields: Readonly<Record<string, unknown>>;
    readonly status: number;
  };
  readonly request: RecordedRequest;
  readonly response: RecordedResponse;
  readonly logs: readonly LogLine[];
}

interface StorageEmulatorLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  getName(): string;
  getInfo(): { readonly name: string; readonly host: string; readonly port: number };
}

const packageRoot = process.env.FIREBASE_TOOLS_15_22_ROOT;
if (!packageRoot) throw new Error("FIREBASE_TOOLS_15_22_ROOT is required");
const packageJsonPath = join(packageRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name: string; version: string };
if (packageJson.name !== "firebase-tools" || packageJson.version !== FIREBASE_TOOLS_VERSION) {
  throw new Error(`expected firebase-tools ${FIREBASE_TOOLS_VERSION}, found ${packageJson.name} ${packageJson.version}`);
}
const cacheRoot = join(process.env.HOME ?? "", ".cache/firebase/emulators");
const rulesRuntimePath = join(cacheRoot, "cloud-storage-rules-runtime-v1.1.3.jar");
const firestoreJarPath = join(cacheRoot, `cloud-firestore-emulator-v${FIRESTORE_VERSION}.jar`);
assertHash(await readFile(rulesRuntimePath), RULES_RUNTIME_SHA256, "Storage rules runtime jar");
assertHash(await readFile(firestoreJarPath), FIRESTORE_JAR_SHA256, "Firestore emulator jar");

const originalTmpdir = process.env.TMPDIR;
const isolatedTmpdir = await mkdtemp(join(tmpdir(), "fireside-phase-g-storage-rules-"));
process.env.TMPDIR = isolatedTmpdir;

const require = createRequire(packageJsonPath);
const storageModule = require(join(packageRoot, "lib/emulator/storage/index.js")) as {
  readonly StorageEmulator: new (args: unknown) => StorageEmulatorLike;
};
const registry = require(join(packageRoot, "lib/emulator/registry.js")) as {
  readonly EmulatorRegistry: { set(name: string, instance: unknown): void; clear(name: string): void };
};
const loggerModule = require(join(packageRoot, "lib/emulator/emulatorLogger.js")) as {
  readonly EmulatorLogger: { prototype: { log: unknown; logLabeled: unknown } };
};

const collectedLogs: LogLine[] = [];
loggerModule.EmulatorLogger.prototype.log = function log(type: string, text: string) {
  collectedLogs.push({ type, text });
};
loggerModule.EmulatorLogger.prototype.logLabeled = function logLabeled(type: string, labelOrText: string, text?: string) {
  collectedLogs.push({ type, text: text ?? labelOrText });
};
function drainLogs(): LogLine[] {
  const drained = collectedLogs.filter(({ type }) => type !== "DEBUG");
  collectedLogs.length = 0;
  return drained;
}

const tokens = Object.fromEntries(
  Object.entries(TOKEN_PAYLOADS).map(([name, payload]) => {
    const { expOverride, ...claims } = payload as Record<string, unknown> & { expOverride?: number };
    const fullPayload = {
      ...claims,
      iat: 1700000000,
      exp: expOverride ?? 4102444800,
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
    };
    return [name, { payload: fullPayload, jwt: unsignedJwt(fullPayload) }];
  }),
);

const firestorePort = await reserveAvailablePort();
const storagePort = await reserveAvailablePort();
const firestoreOrigin = `http://${HOST}:${String(firestorePort)}`;
const storageOrigin = `http://${HOST}:${String(storagePort)}`;
let firestoreProcess: ChildProcess | undefined;
let emulator: StorageEmulatorLike | undefined;
const firestoreLogs: string[] = [];

try {
  firestoreProcess = spawn(
    process.env.JAVA ?? "java",
    ["-jar", firestoreJarPath, "--host", HOST, "--port", String(firestorePort), "--project_id", PROJECT_ID, "--single_project_mode", "true"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  firestoreProcess.stdout?.on("data", (chunk: Buffer) => firestoreLogs.push(chunk.toString("utf8")));
  firestoreProcess.stderr?.on("data", (chunk: Buffer) => firestoreLogs.push(chunk.toString("utf8")));
  await waitForHttp(`${firestoreOrigin}/`, 60_000, () => firestoreProcess?.exitCode ?? null);
  registry.EmulatorRegistry.set("firestore", {
    getName: () => "firestore",
    getInfo: () => ({ name: "firestore", host: HOST, port: firestorePort }),
  });

  emulator = new storageModule.StorageEmulator({
    host: HOST,
    port: storagePort,
    projectId: PROJECT_ID,
    auto_download: false,
    rules: [
      { resource: DEFAULT_BUCKET, rules: { name: "default.rules", content: allowAll("true") } },
      { resource: ASSETS_BUCKET, rules: { name: "assets.rules", content: allowAll("true") } },
    ],
  });
  registry.EmulatorRegistry.set("storage", emulator);
  await emulator.start();
  await waitForHttp(`${storageOrigin}/v0/`, 30_000, () => null);
  const startupLogs = drainLogs();

  const programs = [];
  for (const program of PROGRAMS) {
    programs.push(await runProgram(program));
    console.log(`recorded ${program.id}: ${program.steps.length} steps`);
  }

  // Startup with a ruleset that does not compile: a separate emulator instance.
  await emulator.stop();
  registry.EmulatorRegistry.clear("storage");
  drainLogs();
  const brokenPort = await reserveAvailablePort();
  const broken = new storageModule.StorageEmulator({
    host: HOST,
    port: brokenPort,
    projectId: PROJECT_ID,
    auto_download: false,
    rules: { name: "broken.rules", content: SYNTAX_ERROR_RULES },
  });
  registry.EmulatorRegistry.set("storage", broken);
  emulator = broken;
  await broken.start();
  await waitForHttp(`http://${HOST}:${String(brokenPort)}/v0/`, 30_000, () => null);
  const brokenStartupLogs = drainLogs();
  const brokenOrigin = `http://${HOST}:${String(brokenPort)}`;
  const brokenObservations: Observation[] = [];
  for (const step of [
    { id: "owner-upload", method: "POST", path: `/v0/b/${DEFAULT_BUCKET}/o?name=broken.txt`, auth: "Bearer owner", body: { kind: "text", text: "x", contentType: "text/plain" } },
    { id: "alice-get", method: "GET", path: `/v0/b/${DEFAULT_BUCKET}/o/broken.txt`, auth: "@alice" },
    { id: "owner-get", method: "GET", path: `/v0/b/${DEFAULT_BUCKET}/o/broken.txt`, auth: "Bearer owner" },
    { id: "json-api-get", method: "GET", path: `/storage/v1/b/${DEFAULT_BUCKET}/o/broken.txt` },
    { id: "set-rules-recovers", method: "PUT", path: "/internal/setRules", body: { kind: "json", json: { rules: { files: [{ name: "storage.rules", content: allowAll("true") }] } } } },
    { id: "alice-get-after-recovery", method: "GET", path: `/v0/b/${DEFAULT_BUCKET}/o/broken.txt`, auth: "@alice" },
  ] as const satisfies readonly Step[]) {
    brokenObservations.push(await runStep(brokenOrigin, step, brokenObservations));
  }

  const fixture = {
    schemaVersion: 1,
    target: "official-firebase-tools-storage-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    rulesRuntimeSha256: RULES_RUNTIME_SHA256,
    firestoreEmulator: { version: FIRESTORE_VERSION, jarSha256: FIRESTORE_JAR_SHA256 },
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    syntheticOnly: true,
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    unsignedSyntheticJwtsStored: true,
    sourceHashes: await hashOracleSources(packageRoot),
    buckets: { default: DEFAULT_BUCKET, assets: ASSETS_BUCKET, unconfigured: THIRD_BUCKET },
    multipartBoundary: MULTIPART_BOUNDARY,
    tokens,
    startupLogs,
    programCount: programs.length,
    stepCount: programs.reduce((total, program) => total + program.observations.length, 0),
    programs,
    oracleCrashNotRecordedLive: ORACLE_CRASH_EMPTY_SEGMENT,
    startupCompileError: {
      rules: { name: "broken.rules", content: SYNTAX_ERROR_RULES },
      startupLogs: brokenStartupLogs,
      observations: brokenObservations,
    },
  };
  await mkdir(outputRoot, { recursive: true });
  const text = `${JSON.stringify(normalize(fixture), null, 2)}\n`;
  await writeFile(join(outputRoot, "emulator-programs.json"), text, "utf8");
  console.log(JSON.stringify({ programs: fixture.programCount, steps: fixture.stepCount, sha256: sha256(text) }));
} finally {
  await emulator?.stop().catch(() => undefined);
  registry.EmulatorRegistry.clear("storage");
  registry.EmulatorRegistry.clear("firestore");
  await stopProcess(firestoreProcess);
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
}

async function runProgram(program: Program): Promise<{
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly rules: readonly RulesFile[];
  readonly rulesInstall: { readonly response: RecordedResponse; readonly logs: readonly LogLine[] };
  readonly firestoreSeed: readonly unknown[];
  readonly observations: readonly Observation[];
}> {
  const reset = await fetch(`${storageOrigin}/internal/reset`, { method: "POST" });
  if (reset.status !== 200) throw new Error(`reset failed for ${program.id}: ${String(reset.status)}`);
  const clear = await fetch(`${firestoreOrigin}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  if (clear.status !== 200) throw new Error(`firestore clear failed for ${program.id}: ${String(clear.status)}`);
  drainLogs();
  const rulesInstall = await installRules(program.rules);
  const firestoreSeed = [];
  for (const document of program.firestoreSeed ?? []) {
    firestoreSeed.push({
      path: document.path,
      fields: document.fields,
      status: await writeFirestore(document.path, document.fields),
    });
  }
  const observations: Observation[] = [];
  for (const step of program.steps) {
    observations.push(await runStep(storageOrigin, step, observations));
  }
  return {
    id: program.id,
    category: program.category,
    description: program.description,
    rules: program.rules,
    rulesInstall,
    firestoreSeed,
    observations,
  };
}

async function installRules(files: readonly RulesFile[]): Promise<{ readonly response: RecordedResponse; readonly logs: readonly LogLine[] }> {
  drainLogs();
  const response = await fetch(`${storageOrigin}/internal/setRules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules: { files } }),
  });
  const body = parseBody(await response.text());
  return { response: { status: response.status, headers: captureHeaders(response.headers), body }, logs: drainLogs() };
}

async function writeFirestore(path: string, fields: Readonly<Record<string, unknown>>): Promise<number> {
  const response = await fetch(`${firestoreOrigin}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ fields }),
  });
  await response.text();
  if (response.status !== 200) throw new Error(`firestore write ${path} failed: ${String(response.status)}`);
  return response.status;
}

async function runStep(origin: string, step: Step, previous: readonly Observation[]): Promise<Observation> {
  let rulesInstall: Observation["rulesInstall"];
  if (step.rules) {
    const install = await installRules(step.rules);
    rulesInstall = { files: step.rules, ...install };
  }
  let firestoreWrite: Observation["firestoreWrite"];
  if (step.firestoreWrite) {
    firestoreWrite = {
      path: step.firestoreWrite.path,
      fields: step.firestoreWrite.fields,
      status: await writeFirestore(step.firestoreWrite.path, step.firestoreWrite.fields),
    };
  }
  const resolvedPath = resolveTemplates(step.path, previous);
  const headers: Record<string, string> = { ...(step.headers ?? {}) };
  if (step.auth !== undefined) headers.authorization = resolveAuth(step.auth);
  const encoded = encodeBody(step.body);
  if (encoded !== undefined) headers["content-type"] = encoded.contentType;
  drainLogs();
  if (process.env.STORAGE_RULES_TRACE) console.error(`  ${step.id} ${step.method} ${resolvedPath}`);
  let response: Response;
  try {
    response = await fetch(`${origin}${resolvedPath}`, {
      method: step.method,
      headers,
      ...(encoded === undefined ? {} : { body: new Uint8Array(encoded.bytes) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`step ${step.id} (${step.method} ${resolvedPath}) failed: ${String(error)}; logs: ${JSON.stringify(drainLogs())}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const responseContentType = response.headers.get("content-type") ?? "";
  const body = responseContentType.includes("application/json") || responseContentType.includes("text/plain")
    ? parseBody(bytes.toString("utf8"))
    : bytes.byteLength === 0
      ? null
      : { byteLength: bytes.byteLength, sha256: sha256(bytes), utf8: bytes.toString("utf8") };
  return {
    id: step.id,
    ...(step.note === undefined ? {} : { note: step.note }),
    ...(rulesInstall === undefined ? {} : { rulesInstall }),
    ...(firestoreWrite === undefined ? {} : { firestoreWrite }),
    request: {
      method: step.method,
      path: step.path,
      resolvedPath,
      headers: describeHeaders(headers, step.auth),
      ...(step.body === undefined ? {} : { body: describeBody(step.body, encoded) }),
    },
    response: { status: response.status, headers: captureHeaders(response.headers), body },
    logs: drainLogs(),
  };
}

function resolveTemplates(path: string, previous: readonly Observation[]): string {
  return path.replace(/\{\{(uploadUrl|uploadId|token):([a-z0-9-]+)\}\}/gu, (_match, kind: string, stepId: string) => {
    const source = previous.find((observation) => observation.id === stepId);
    if (!source) throw new Error(`template references unknown step ${stepId}`);
    if (kind === "uploadUrl") {
      const raw = source.response.headers["x-goog-upload-url"] ?? source.response.headers.location;
      if (!raw) throw new Error(`step ${stepId} recorded no upload url`);
      const url = new URL(raw);
      return `${url.pathname}${url.search}`;
    }
    if (kind === "uploadId") {
      const raw = source.response.headers["x-gupload-uploadid"];
      if (!raw) throw new Error(`step ${stepId} recorded no upload id`);
      return raw;
    }
    const body = source.response.body as { downloadTokens?: string } | null;
    const token = body?.downloadTokens?.split(",")[0];
    if (!token) throw new Error(`step ${stepId} recorded no download token: ${JSON.stringify(source.response)} ${JSON.stringify(source.logs)}`);
    return encodeURIComponent(token);
  });
}

function resolveAuth(auth: string): string {
  if (auth.startsWith("@")) return `Bearer ${tokenFor(auth.slice(1))}`;
  if (auth.startsWith("firebase:@")) return `Firebase ${tokenFor(auth.slice("firebase:@".length))}`;
  return auth;
}

function tokenFor(name: string): string {
  const token = tokens[name];
  if (!token) throw new Error(`unknown token ${name}`);
  return token.jwt;
}

function describeHeaders(headers: Readonly<Record<string, string>>, auth: string | undefined): Readonly<Record<string, string>> {
  const described: Record<string, string> = { ...headers };
  if (auth !== undefined) described.authorization = auth;
  return described;
}

function encodeBody(body: StepBody | undefined): { readonly bytes: Buffer; readonly contentType: string } | undefined {
  if (body === undefined) return undefined;
  switch (body.kind) {
    case "json":
      return { bytes: Buffer.from(JSON.stringify(body.json), "utf8"), contentType: "application/json" };
    case "text":
      return { bytes: Buffer.from(body.text, "utf8"), contentType: body.contentType };
    case "multipart": {
      const bytes = Buffer.concat([
        Buffer.from(`--${MULTIPART_BOUNDARY}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(body.metadata)}\r\n`, "utf8"),
        Buffer.from(`--${MULTIPART_BOUNDARY}\r\nContent-Type: ${body.partContentType}\r\n\r\n`, "utf8"),
        Buffer.from(body.text, "utf8"),
        Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--\r\n`, "utf8"),
      ]);
      return { bytes, contentType: `multipart/related; boundary=${MULTIPART_BOUNDARY}` };
    }
    default:
      throw new Error("unknown body kind");
  }
}

function describeBody(body: StepBody, encoded: { readonly bytes: Buffer; readonly contentType: string } | undefined): unknown {
  return {
    ...body,
    contentTypeHeader: encoded?.contentType,
    byteLength: encoded?.bytes.byteLength ?? 0,
    sha256: encoded === undefined ? undefined : sha256(encoded.bytes),
    base64: encoded?.bytes.toString("base64"),
  };
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? normalizeString(value) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "request" && child !== null && typeof child === "object") {
      // The request path is an input a replay sends verbatim (templates
      // included); only the resolved copy is normalized.
      const { path, ...rest } = child as Record<string, unknown>;
      output[key] = { path, ...(normalize(rest) as Record<string, unknown>) };
    } else if ((key === "downloadTokens" || key === "firebaseStorageDownloadTokens") && typeof child === "string") {
      const count = child.length > 0 ? child.split(",").length : 0;
      output[key] = `<${String(count)}-download-token${count === 1 ? "" : "s"}>`;
    } else if (key === "generation" && (typeof child === "string" || typeof child === "number")) {
      output[key] = "<generated-generation>";
    } else if (["timeCreated", "updated", "timeStorageClassUpdated"].includes(key) && typeof child === "string") {
      output[key] = `<generated-${key}>`;
    } else if (key === "etag" && typeof child === "string") {
      output[key] = "<generated-etag>";
    } else if (key === "x-gupload-uploadid" && typeof child === "string") {
      output[key] = "<upload-id>";
    } else {
      output[key] = normalize(child);
    }
  }
  return output;
}

function normalizeString(value: string): string {
  // Request templates (`{{token:step}}`, `{{uploadUrl:step}}`) are resolved
  // by a replay from its own responses and must survive normalization.
  if (value.includes("{{")) return value;
  return value
    .replaceAll(storageOrigin, "<storage-origin>")
    .replaceAll(firestoreOrigin, "<firestore-origin>")
    .replaceAll(isolatedTmpdir, "<tmpdir>")
    .replace(/([?&]upload_id=)[^&]+/gu, "$1<upload-id>")
    .replace(/([?&]token=)[^&]+/gu, "$1<download-token>")
    .replace(/([?&]delete_token=)[^&]+/gu, "$1<download-token>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu, "<uuid>");
}

function captureHeaders(headers: Headers): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const name of [
    "content-type",
    "content-length",
    "content-disposition",
    "cache-control",
    "location",
    "x-goog-upload-status",
    "x-goog-upload-size-received",
    "x-goog-upload-url",
    "x-gupload-uploadid",
    "x-goog-upload-chunk-granularity",
  ]) {
    const value = headers.get(name);
    if (value !== null) captured[name] = value;
  }
  return captured;
}

async function hashOracleSources(root: string): Promise<Readonly<Record<string, string>>> {
  const files = [
    "package.json",
    "lib/emulator/storage/apis/firebase.js",
    "lib/emulator/storage/apis/gcloud.js",
    "lib/emulator/storage/files.js",
    "lib/emulator/storage/metadata.js",
    "lib/emulator/storage/rules/runtime.js",
    "lib/emulator/storage/rules/manager.js",
    "lib/emulator/storage/rules/utils.js",
    "lib/emulator/storage/server.js",
    "lib/emulator/storage/upload.js",
  ];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = sha256(await readFile(join(root, file)));
  return hashes;
}

function unsignedJwt(payload: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertHash(value: Uint8Array, expected: string, label: string): void {
  const actual = sha256(value);
  if (actual !== expected) throw new Error(`${label} hash mismatch: ${actual}`);
}

async function waitForHttp(url: string, timeoutMs: number, exitCode: () => number | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const code = exitCode();
    if (code !== null) throw new Error(`process exited with ${String(code)} before ${url} was ready`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${url} did not become ready: ${String(lastError)}\n${firestoreLogs.join("")}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

async function reserveAvailablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port reservation failed");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
