// Phase I1: record every program in `emulator-plan.ts` against the official
// Auth emulator (firebase-tools 15.22.0 `AuthEmulator`, in process) with a
// recording HTTP server registered as the Functions emulator, so that
// lifecycle multicasts and blocking-function calls are observed too.
//
// Requires FIREBASE_TOOLS_15_22_ROOT. Every program runs on a fresh emulator
// instance. Everything recorded is synthetic.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { API_KEY, PROGRAMS, PROJECT_ID, encodeUnsignedJwt, type Json, type Program, type Step, type StubResponse } from "./emulator-plan.ts";
import { Registry, UNORDERED_ARRAYS, canonicalize, finish, normalizeLogLine, normalizeValue, sortUnordered } from "./normalize.ts";
import { operationFor } from "./operations.ts";

const HOST = "127.0.0.1";
const FIREBASE_TOOLS_VERSION = "15.22.0";
const RECORDED_HEADERS = [
  "content-type",
  "location",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-private-network",
  "access-control-expose-headers",
];
const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/auth-v1");

interface LogLine {
  readonly type: string;
  readonly text: string;
}

interface FunctionsCall {
  readonly path: string;
  readonly body: Json;
}

interface RecordedStep {
  readonly id: string;
  readonly note?: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Json | string;
    readonly sleepMs?: number;
  };
  readonly functions?: Step["functions"];
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Json;
  };
  readonly logs: readonly LogLine[];
  readonly functionsCalls: readonly FunctionsCall[];
}

interface RecordedProgram {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly steps: readonly RecordedStep[];
}

interface EmulatorLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const packageRoot = process.env.FIREBASE_TOOLS_15_22_ROOT;
if (!packageRoot) throw new Error("FIREBASE_TOOLS_15_22_ROOT is required");
const packageJsonPath = join(packageRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name: string; version: string };
if (packageJson.name !== "firebase-tools" || packageJson.version !== FIREBASE_TOOLS_VERSION) {
  throw new Error(`expected firebase-tools ${FIREBASE_TOOLS_VERSION}, found ${packageJson.name} ${packageJson.version}`);
}
const require = createRequire(packageJsonPath);
const authModule = require(join(packageRoot, "lib/emulator/auth/index.js")) as {
  readonly AuthEmulator: new (args: { host: string; port: number; projectId: string; singleProjectMode: number }) => EmulatorLike;
  readonly SingleProjectMode: Readonly<Record<string, number>>;
};
const registryModule = require(join(packageRoot, "lib/emulator/registry.js")) as {
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

// ---------------------------------------------------------------- functions stub
const functionsCalls: FunctionsCall[] = [];
let currentStub: Step["functions"] = undefined;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function handleFunctions(request: IncomingMessage, response: ServerResponse): void {
  void (async () => {
    const text = await readBody(request);
    let body: Json;
    try {
      body = JSON.parse(text) as Json;
    } catch {
      body = text;
    }
    const path = request.url ?? "";
    functionsCalls.push({ path, body });
    let stub: StubResponse | undefined;
    if (path.startsWith("/blocking/")) {
      const event = path.slice("/blocking/".length) as "beforeCreate" | "beforeSignIn";
      stub = currentStub?.[event];
    }
    const status = stub?.status ?? 200;
    const payload = stub?.body ?? {};
    if (typeof payload === "string") {
      response.writeHead(status, { "Content-Type": "text/plain" });
      response.end(payload);
    } else {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    }
  })().catch((error: unknown) => {
    response.writeHead(500);
    response.end(String(error));
  });
}

// ---------------------------------------------------------------- helpers
function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function reserveAvailablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to reserve a TCP port");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return port;
}

async function waitForReady(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Auth emulator did not become ready: ${String(lastError)}`);
}

/** Every string literal in the plan is a program constant that must never be templated. */
function collectConstants(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
    // Query strings and post bodies carry constants in encoded form too.
    for (const part of value.split(/[&=?]/)) {
      if (part.length >= 4) {
        into.add(part);
        try {
          const decoded = decodeURIComponent(part);
          into.add(decoded);
          // Fake IdP claims travel JSON-encoded inside the post body.
          if (decoded.startsWith("{")) collectConstants(JSON.parse(decoded), into);
        } catch {
          // not encoded, or not JSON
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConstants(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectConstants(item, into);
  }
}

function scrubPaths(text: string): string {
  return text
    .split(packageRoot as string)
    .join("{{firebaseTools}}")
    .replace(/\/(?:Users|home|private|tmp)\/[^\s:)'"]+/g, "{{path}}");
}

/** `{ $customToken: payload }` becomes an unsigned JWT once its templates are resolved. */
export function encodeDeferredTokens(value: Json): Json {
  if (Array.isArray(value)) return value.map(encodeDeferredTokens);
  if (value && typeof value === "object") {
    if ("$customToken" in value && Object.keys(value).length === 1) return encodeUnsignedJwt(value.$customToken);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeDeferredTokens(item)]));
  }
  return value;
}

async function settleFunctionsCalls(): Promise<void> {
  let quiet = 0;
  let seen = functionsCalls.length;
  while (quiet < 2) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    if (functionsCalls.length === seen) {
      quiet += 1;
    } else {
      seen = functionsCalls.length;
      quiet = 0;
    }
  }
}

function extractAccounts(html: string): Json[] {
  const accounts: Json[] = [];
  for (const match of html.matchAll(/data-id-token="([^"]*)"/g)) {
    const encoded = match[1] ?? "";
    try {
      accounts.push(JSON.parse(decodeURIComponent(encoded)) as Json);
    } catch {
      accounts.push(encoded);
    }
  }
  return accounts;
}

// ---------------------------------------------------------------- capture
const functionsPort = await reserveAvailablePort();
const functionsServer = createServer(handleFunctions);
await new Promise<void>((resolvePromise, reject) => {
  functionsServer.once("error", reject);
  functionsServer.listen(functionsPort, HOST, () => resolvePromise());
});
const functionsOrigin = `http://${HOST}:${String(functionsPort)}`;
registryModule.EmulatorRegistry.set("functions", {
  getName: () => "functions",
  getInfo: () => ({ name: "functions", host: HOST, port: functionsPort }),
});

const constants = new Set<string>([PROJECT_ID, API_KEY]);
collectConstants(PROGRAMS, constants);

const recordedPrograms: RecordedProgram[] = [];
let totalSteps = 0;
const startedAt = new Date().toISOString();
const onlyPrograms = process.argv.find((argument) => argument.startsWith("--programs="))?.slice("--programs=".length).split(",");
const debug = process.argv.includes("--debug");

try {
  for (const program of PROGRAMS) {
    if (onlyPrograms && !onlyPrograms.includes(program.id)) continue;
    recordedPrograms.push(await runProgram(program));
    console.log(`recorded ${program.id}: ${program.steps.length} steps`);
  }
} finally {
  registryModule.EmulatorRegistry.clear("functions");
  await new Promise<void>((resolvePromise) => functionsServer.close(() => resolvePromise()));
}

async function runProgram(program: Program): Promise<RecordedProgram> {
  const port = await reserveAvailablePort();
  const origin = `http://${HOST}:${String(port)}`;
  const emulator = new authModule.AuthEmulator({
    host: HOST,
    port,
    projectId: PROJECT_ID,
    singleProjectMode: authModule.SingleProjectMode.NO_WARNING ?? 0,
  });
  await emulator.start();
  await waitForReady(origin, 30_000);
  drainLogs();
  functionsCalls.length = 0;

  const registry = new Registry(constants);
  registry.bind("{{origin}}", origin);
  registry.bind("{{functionsOrigin}}", functionsOrigin);
  const steps: RecordedStep[] = [];
  try {
    for (const step of program.steps) {
      steps.push(await runStep(step, origin, registry));
      totalSteps += 1;
    }
  } finally {
    await emulator.stop();
  }
  return { id: program.id, category: program.category, title: program.title, steps };
}

async function runStep(step: Step, origin: string, registry: Registry): Promise<RecordedStep> {
  const path = registry.resolve(step.path);
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(step.query ?? {})) url.searchParams.set(key, registry.resolve(value));
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (step.body !== undefined) {
    if (typeof step.body === "string") {
      body = registry.resolve(step.body);
    } else {
      body = JSON.stringify(encodeDeferredTokens(registry.resolveJson(step.body)));
      headers["Content-Type"] = "application/json";
    }
  }
  for (const [key, value] of Object.entries(step.headers ?? {})) {
    if (value === "") delete headers[key];
    else headers[key] = registry.resolve(value);
  }
  if (headers["Content-Type"] === undefined && body !== undefined && typeof step.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  currentStub = step.functions;
  functionsCalls.length = 0;
  drainLogs();
  if (step.sleepMs) await new Promise((resolvePromise) => setTimeout(resolvePromise, step.sleepMs));
  const response = await fetch(url, { method: step.method, headers, ...(body === undefined ? {} : { body }), redirect: "manual" });
  const text = await response.text();
  // Lifecycle multicasts are fire-and-forget in the official emulator and may
  // land after its HTTP response; wait until the stub has been quiet.
  await settleFunctionsCalls();
  currentStub = undefined;
  const logs = drainLogs();
  const calls = functionsCalls.splice(0, functionsCalls.length);

  const recordedHeaders: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) recordedHeaders[name] = registry.replaceAll(value);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let parsed: Json;
  if (contentType.includes("application/json")) {
    parsed = text.length ? (JSON.parse(text) as Json) : null;
  } else {
    parsed = text;
  }

  // Logs first: they carry the codes that later steps reference. Stack
  // traces name machine paths; those are scrubbed, never recorded.
  const normalizedLogs = logs.map((line) => ({ type: line.type, text: normalizeLogLine(scrubPaths(line.text), step.id, registry) }));
  let normalizedBody: Json;
  if (step.html) {
    normalizedBody = {
      $html: {
        sha256: sha256(text),
        bytes: text.length,
        accounts: normalizeValue(extractAccounts(text), step.id, registry),
      },
    };
  } else if (step.digest) {
    const canonical = JSON.stringify(canonicalize(finish(normalizeValue(parsed, step.id, registry), registry)));
    normalizedBody = { $digest: { sha256: sha256(canonical), bytes: canonical.length } };
  } else {
    normalizedBody = normalizeValue(parsed, step.id, registry);
  }
  const normalizedCalls = calls.map((call) => ({
    path: registry.replaceAll(call.path),
    body: normalizeValue(call.body, step.id, registry),
  }));

  if (debug) console.log(`${step.id}: ${String(response.status)} ${text.slice(0, 400)}`);
  const recorded: RecordedStep = {
    id: step.id,
    ...(step.note === undefined ? {} : { note: step.note }),
    request: {
      method: step.method,
      path: step.path,
      ...(step.query === undefined ? {} : { query: step.query }),
      ...(step.headers === undefined ? {} : { headers: step.headers }),
      ...(step.body === undefined ? {} : { body: step.body }),
      ...(step.sleepMs === undefined ? {} : { sleepMs: step.sleepMs }),
    },
    ...(step.functions === undefined ? {} : { functions: step.functions }),
    response: {
      status: response.status,
      headers: recordedHeaders,
      body: sortUnordered(finish(normalizedBody, registry)),
    },
    logs: normalizedLogs.map((line) => ({ type: line.type, text: registry.replaceAll(line.text) })),
    functionsCalls: normalizedCalls.map((call) => ({ path: call.path, body: finish(call.body, registry) })),
  };
  return recorded;
}

// ---------------------------------------------------------------- write
const sourceFiles = [
  "lib/emulator/auth/apiSpec.js",
  "lib/emulator/auth/cloudFunctions.js",
  "lib/emulator/auth/errors.js",
  "lib/emulator/auth/handlers.js",
  "lib/emulator/auth/index.js",
  "lib/emulator/auth/operations.js",
  "lib/emulator/auth/server.js",
  "lib/emulator/auth/state.js",
  "lib/emulator/auth/utils.js",
  "lib/emulator/auth/widget_ui.js",
];
const sourceHashes: Record<string, string> = {};
for (const file of sourceFiles) sourceHashes[file] = sha256(await readFile(join(packageRoot, file)));

const categories: Record<string, number> = {};
for (const program of recordedPrograms) categories[program.category] = (categories[program.category] ?? 0) + 1;

// Operation coverage against the gate's inventory of what the official
// emulator implements.
const gate = JSON.parse(await readFile(resolve(outputRoot, "../../../benchmarks/phase-i-auth.json"), "utf8")) as {
  readonly inventory: { readonly officialImplementedOperations: readonly string[]; readonly officialNotImplementedOperations: readonly string[] };
};
const operations: Record<string, { steps: number; programs: string[]; official: string }> = {};
for (const program of recordedPrograms) {
  for (const step of program.steps) {
    const operation = operationFor(step.request.method, step.request.path);
    const entry = (operations[operation.id] ??= { steps: 0, programs: [], official: operation.official });
    entry.steps += 1;
    if (!entry.programs.includes(program.id)) entry.programs.push(program.id);
  }
}
const officialImplementedMissing = gate.inventory.officialImplementedOperations.filter((id) => operations[id] === undefined);
const officialNotImplementedMissing = gate.inventory.officialNotImplementedOperations.filter((id) => operations[id] === undefined);
const coverage = {
  officialImplemented: gate.inventory.officialImplementedOperations.length,
  officialImplementedCovered: gate.inventory.officialImplementedOperations.length - officialImplementedMissing.length,
  officialImplementedMissing,
  officialNotImplemented: gate.inventory.officialNotImplementedOperations.length,
  officialNotImplementedCovered: gate.inventory.officialNotImplementedOperations.length - officialNotImplementedMissing.length,
  officialNotImplementedMissing,
  pagesCovered: Object.values(operations).filter((entry) => entry.official === "page").length,
  operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
};
if (officialImplementedMissing.length > 0) console.warn(`not covered: ${officialImplementedMissing.join(", ")}`);

const fixture = {
  schemaVersion: 1,
  target: "official-firebase-tools-auth-emulator",
  targetVersion: FIREBASE_TOOLS_VERSION,
  targetProject: PROJECT_ID,
  apiKey: API_KEY,
  capturedAt: startedAt,
  completedAt: new Date().toISOString(),
  hypothesis:
    "Every operation the official Auth emulator implements, recorded as raw HTTP programs on fresh emulator state with lifecycle multicasts and blocking-function calls observed",
  credentialsStored: false,
  accessTokensStored: false,
  realUserDataStored: false,
  syntheticOnly: true,
  freshEmulatorPerProgram: true,
  sourceHashes,
  templates: {
    origin: "{{origin}}",
    functionsOrigin: "{{functionsOrigin}}",
    kinds: ["localId", "token", "refresh", "cookie", "pending", "oob", "sessionInfo", "code", "temporaryProof", "enrollmentId", "salt", "sessionId", "tenantId", "challenge"],
    time: "{{time}}",
    eventId: "{{eventId}}",
  },
  unorderedArrays: UNORDERED_ARRAYS,
  recordedHeaders: RECORDED_HEADERS,
  programCount: recordedPrograms.length,
  stepCount: totalSteps,
  categories,
  coverage,
  programs: recordedPrograms,
};

await mkdir(outputRoot, { recursive: true });
const fixtureText = `${JSON.stringify(fixture, null, 2)}\n`;
await writeFile(join(outputRoot, "emulator-programs.json"), fixtureText);
console.log(`wrote ${recordedPrograms.length} programs / ${String(totalSteps)} steps (${String(fixtureText.length)} bytes)`);
