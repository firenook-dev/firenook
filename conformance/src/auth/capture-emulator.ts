// Phase I1: record every program in `emulator-plan.ts` against the official
// Auth emulator (firebase-tools 15.22.0 `AuthEmulator`, in process) with a
// recording HTTP server registered as the Functions emulator, so that
// lifecycle multicasts and blocking-function calls are observed too.
//
// Requires FIREBASE_TOOLS_15_22_ROOT. Every program runs on a fresh emulator
// instance. Everything recorded is synthetic.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { API_KEY, PROGRAMS, PROJECT_ID, type Program } from "./emulator-plan.ts";
import { Registry, UNORDERED_ARRAYS } from "./normalize.ts";
import { operationFor } from "./operations.ts";
import {
  FunctionsStub,
  HOST,
  RECORDED_HEADERS,
  type LogLine,
  type RecordedStep,
  collectConstants,
  executeStep,
  reserveAvailablePort,
  sha256,
  waitForReady,
} from "./runner.ts";

const FIREBASE_TOOLS_VERSION = "15.22.0";
const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/auth-v1");

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

function scrubPaths(text: string): string {
  return text
    .split(packageRoot as string)
    .join("{{firebaseTools}}")
    .replace(/\/(?:Users|home|private|tmp)\/[^\s:)'"]+/g, "{{path}}");
}

// ---------------------------------------------------------------- capture
const stub = new FunctionsStub();
await stub.start();
registryModule.EmulatorRegistry.set("functions", {
  getName: () => "functions",
  getInfo: () => ({ name: "functions", host: HOST, port: stub.port }),
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
  await stub.stop();
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
  stub.drain();

  const registry = new Registry(constants);
  registry.bind("{{origin}}", origin);
  registry.bind("{{functionsOrigin}}", stub.origin);
  const steps: RecordedStep[] = [];
  const trail: string[] = [];
  try {
    for (const step of program.steps) {
      steps.push(
        await executeStep(step, {
          origin,
          registry,
          stub,
          drainLogs,
          scrubLog: scrubPaths,
          debug,
          trail: () => trail.slice(-4),
          remember: (line) => trail.push(line),
        }),
      );
      totalSteps += 1;
    }
  } finally {
    await emulator.stop();
  }
  return { id: program.id, category: program.category, title: program.title, steps };
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
