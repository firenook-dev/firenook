// Phase J1: records the Pub/Sub oracle corpus against the official
// `cloud-pubsub-emulator-0.8.33` (one fresh JVM per program) into
// `conformance/fixtures/pubsub-v1/emulator-programs.json`.
//
//   PUBSUB_EMULATOR_JAR=~/.cache/firebase/emulators/pubsub-emulator-0.8.33/pubsub-emulator/lib/cloud-pubsub-emulator-0.8.33-all.jar \
//     node --import tsx src/pubsub/capture-emulator.ts [--programs=a,b] [--debug] [--output path]
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PushEndpoint, startOfficialEmulator } from "./client.ts";
import { PROGRAMS, PROJECT_ID } from "./emulator-plan.ts";
import { RPCS, grpcOperation, httpOperation, rpcTotal } from "./operations.ts";
import { runProgram, type RecordedProgram } from "./runner.ts";

const EMULATOR_VERSION = "0.8.33";
const DEFAULT_JAR = join(homedir(), ".cache/firebase/emulators", `pubsub-emulator-${EMULATOR_VERSION}`, "pubsub-emulator/lib", `cloud-pubsub-emulator-${EMULATOR_VERSION}-all.jar`);
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/pubsub-v1");

function parseArguments(argv: readonly string[]): { programs: readonly string[]; debug: boolean; output: string } {
  let programs: readonly string[] = [];
  let debug = false;
  let output = join(fixtureRoot, "emulator-programs.json");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument.startsWith("--programs=")) programs = argument.slice("--programs=".length).split(",").filter(Boolean);
    else if (argument === "--debug") debug = true;
    else if (argument === "--output") output = resolve(argv[++index] ?? output);
    else throw new Error(`unknown argument ${argument}`);
  }
  return { programs, debug, output };
}

const args = parseArguments(process.argv.slice(2));
const jar = process.env.PUBSUB_EMULATOR_JAR ?? DEFAULT_JAR;
const java = process.env.PUBSUB_EMULATOR_JAVA ?? "java";
const jarSha256 = createHash("sha256").update(await readFile(jar)).digest("hex");

const capturedAt = new Date().toISOString();
const push = new PushEndpoint();
await push.start();
const programs: RecordedProgram[] = [];
let totalSteps = 0;
try {
  for (const program of PROGRAMS) {
    if (args.programs.length > 0 && !args.programs.includes(program.id)) continue;
    const emulator = await startOfficialEmulator(jar, java);
    try {
      const recorded = await runProgram(program, { emulator, push, debug: args.debug });
      programs.push(recorded);
      totalSteps += recorded.steps.length;
      console.log(`recorded ${program.id}: ${String(recorded.steps.length)} steps`);
    } catch (error) {
      console.error(`program ${program.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error(emulator.logs());
      throw error;
    } finally {
      await emulator.stop();
    }
  }
} finally {
  await push.stop();
}

// Coverage: every RPC over each transport it was exercised on.
const grpcCovered = new Set<string>();
const httpCovered = new Set<string>();
for (const program of programs) {
  for (const step of program.steps) {
    const request = step.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) continue;
    if (request.transport === "grpc" || request.transport === "stream") {
      grpcCovered.add(grpcOperation(request.service as never, String(request.method)));
    } else if (request.transport === "http") {
      const operation = httpOperation(String(request.method), String(request.path));
      if (operation !== undefined) httpCovered.add(operation);
    }
  }
}
const all = Object.entries(RPCS).flatMap(([service, names]) => names.map((name) => `${service}.${name}`));
const coverage = {
  rpcTotal: rpcTotal(),
  grpcCovered: all.filter((name) => grpcCovered.has(name)).length,
  grpcMissing: all.filter((name) => !grpcCovered.has(name)),
  httpCovered: all.filter((name) => httpCovered.has(name)).length,
  httpMissing: all.filter((name) => !httpCovered.has(name)),
  operations: Object.fromEntries(all.map((name) => [name, { grpc: grpcCovered.has(name), http: httpCovered.has(name) }])),
};

const fixture = {
  schemaVersion: 1,
  target: "official-cloud-pubsub-emulator",
  targetVersion: EMULATOR_VERSION,
  jarSha256,
  targetProject: PROJECT_ID,
  capturedAt,
  completedAt: new Date().toISOString(),
  hypothesis:
    "Every RPC of the google.pubsub.v1 Publisher, Subscriber and SchemaService services and the google.iam.v1 IAMPolicy service, recorded as raw programs over gRPC and HTTP/JSON against a fresh official emulator per program, with a recording push endpoint; timestamps, message ids, ack ids and schema revision ids normalized.",
  credentialsStored: false,
  realDataStored: false,
  coverage,
  programs,
};
await mkdir(dirname(args.output), { recursive: true });
const text = `${JSON.stringify(fixture, null, 2)}\n`;
await writeFile(args.output, text, "utf8");
console.log(`wrote ${String(programs.length)} programs / ${String(totalSteps)} steps (${String(text.length)} bytes) to ${args.output}`);
console.log(`coverage: grpc ${String(coverage.grpcCovered)}/${String(coverage.rpcTotal)}, http ${String(coverage.httpCovered)}/${String(coverage.rpcTotal)}`);
if (coverage.grpcMissing.length > 0) console.log(`grpc missing: ${coverage.grpcMissing.join(", ")}`);
if (coverage.httpMissing.length > 0) console.log(`http missing: ${coverage.httpMissing.join(", ")}`);
