// Phase I4: replay the frozen Auth corpus against Fireside's standalone
// `fireside auth` service (one fresh process per program) with the same
// functions stub and the same normalization as the capture, and report every
// step that is not parity or a named divergence.
//
//   node --import tsx src/auth/replay-fireside.ts --binary ../target/release/fireside \
//     [--programs=a,b] [--report-only] [--output report.json]
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { API_KEY, PROGRAMS, PROJECT_ID, type Json, type Program } from "./emulator-plan.ts";
import { Registry, canonicalize } from "./normalize.ts";
import { FunctionsStub, HOST, type LogLine, type RecordedStep, collectConstants, executeStep, reserveAvailablePort, waitForReady } from "./runner.ts";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/auth-v1");

interface Fixture {
  readonly programs: readonly {
    readonly id: string;
    readonly category: string;
    readonly title: string;
    readonly steps: readonly RecordedStep[];
  }[];
}

interface Mismatch {
  readonly program: string;
  readonly step: string;
  readonly path: string;
  readonly expected: Json | undefined;
  readonly actual: Json | undefined;
}

/**
 * Named divergences: a step path whose value legitimately differs, with the
 * reason. `expected`/`actual` narrow the match; `anyValue` accepts any actual.
 */
interface Divergence {
  readonly program: RegExp;
  readonly step: RegExp;
  readonly path: RegExp;
  readonly reason: string;
  readonly anyValue?: boolean;
  /** Accepts the pair when `anyValue` is too broad. */
  readonly accept?: (expected: Json | undefined, actual: Json | undefined) => boolean;
}

const DIVERGENCES: readonly Divergence[] = [
  {
    program: /.*/u,
    step: /.*/u,
    path: /^response\.body\.\$html\.(sha256|bytes)$/u,
    reason: "Fireside ships its own popup helper page; the accounts it offers are compared",
    anyValue: true,
  },
  {
    program: /.*/u,
    step: /^(malformed-json|body-string)$/u,
    path: /^response\.body\.error\.(message|errors\.0\.message)$/u,
    reason: "the JSON parse error text is V8's; Fireside reports serde's message with the same status and shape",
    anyValue: true,
  },
  {
    program: /.*/u,
    step: /^signin-function-text$/u,
    path: /^response\.body\.error\.errors\.0\.reason$/u,
    reason: "a blocking function's non-JSON body is reported with V8's parse error as the reason; Fireside reports serde's",
    anyValue: true,
  },
  {
    program: /.*/u,
    step: /.*/u,
    path: /^logs\.\d+\.text$/u,
    reason: "the official server logs a 500 with its Node stack trace; Fireside logs the same first line",
    accept: (expected, actual) =>
      typeof expected === "string" && typeof actual === "string" && expected.includes("\n    at ") && expected.split("\n")[0] === actual,
  },
];

function parseArguments(argv: readonly string[]): { binary: string; programs: readonly string[]; reportOnly: boolean; output?: string | undefined; debug: boolean } {
  let binary = "";
  let programs: readonly string[] = [];
  let reportOnly = false;
  let output: string | undefined;
  let debug = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--binary") binary = argv[++index] ?? "";
    else if (argument.startsWith("--programs=")) programs = argument.slice("--programs=".length).split(",").filter(Boolean);
    else if (argument === "--report-only") reportOnly = true;
    else if (argument === "--output") output = argv[++index];
    else if (argument === "--debug") debug = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!binary) throw new Error("--binary is required");
  return { binary, programs, reportOnly, output, debug };
}

const args = parseArguments(process.argv.slice(2));
const binary = resolve(args.binary);
const fixture = JSON.parse(await readFile(join(fixtureRoot, "emulator-programs.json"), "utf8")) as Fixture;
const constants = new Set<string>([PROJECT_ID, API_KEY]);
collectConstants(PROGRAMS, constants);
const runRoot = await mkdtemp(join(tmpdir(), "fireside-auth-replay-"));

const stub = new FunctionsStub();
await stub.start();
const mismatches: Mismatch[] = [];
const divergencesObserved: { program: string; step: string; path: string; reason: string }[] = [];
let compared = 0;
let steps = 0;
let programsRun = 0;
try {
  for (const program of PROGRAMS) {
    if (args.programs.length > 0 && !args.programs.includes(program.id)) continue;
    const recorded = fixture.programs.find((candidate) => candidate.id === program.id);
    if (!recorded) throw new Error(`program ${program.id} is not in the fixture; re-record first`);
    programsRun += 1;
    const actual = await replayProgram(program);
    for (const [index, expectedStep] of recorded.steps.entries()) {
      const actualStep = actual[index];
      steps += 1;
      if (!actualStep) {
        mismatches.push({ program: program.id, step: expectedStep.id, path: "step", expected: "recorded", actual: "missing" });
        continue;
      }
      compareStep(program.id, expectedStep, actualStep);
    }
    const bad = mismatches.filter((mismatch) => mismatch.program === program.id).length;
    console.log(`${bad === 0 ? "ok  " : "FAIL"} ${program.id}: ${recorded.steps.length} steps${bad ? `, ${String(bad)} mismatches` : ""}`);
  }
} finally {
  await stub.stop();
  await rm(runRoot, { recursive: true, force: true });
}

const report = {
  binary,
  programs: programsRun,
  steps,
  compared,
  mismatched: mismatches.length,
  divergencesObserved,
  mismatches,
};
if (args.output) {
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(`\n${String(programsRun)} programs, ${String(steps)} steps, ${String(compared)} values compared, ${String(mismatches.length)} mismatches, ${String(divergencesObserved.length)} named divergences observed`);
for (const mismatch of mismatches.slice(0, args.reportOnly ? 500 : 80)) {
  console.log(`  ${mismatch.program}/${mismatch.step} ${mismatch.path}: expected ${short(mismatch.expected)} got ${short(mismatch.actual)}`);
}
if (mismatches.length > 0 && !args.reportOnly) process.exit(1);

// ---------------------------------------------------------------- replay

async function replayProgram(program: Program): Promise<RecordedStep[]> {
  const port = await reserveAvailablePort();
  const origin = `http://${HOST}:${String(port)}`;
  const stateFile = join(runRoot, `${program.id}.json`);
  const logs: LogLine[] = [];
  const child: ChildProcess = spawn(
    binary,
    ["auth", "--host", HOST, "--port", String(port), "--project-id", PROJECT_ID, "--state-file", stateFile, "--functions-origin", stub.origin],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let pending = "";
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^([A-Z]+): (.*)$/u.exec(line);
      if (match) logs.push({ type: match[1] ?? "", text: match[2] ?? "" });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const drainLogs = (): LogLine[] => logs.splice(0, logs.length);
  try {
    await waitForReady(origin, 30_000, () => exited);
    drainLogs();
    stub.drain();
    const registry = new Registry(constants);
    registry.bind("{{origin}}", origin);
    registry.bind("{{functionsOrigin}}", stub.origin);
    const results: RecordedStep[] = [];
    for (const step of program.steps) {
      // Log lines land on stdout asynchronously; give them a moment.
      const recorded = await executeStep(step, { origin, registry, stub, drainLogs: () => { return drainLogs(); }, debug: args.debug });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      const late = drainLogs();
      results.push(late.length === 0 ? recorded : { ...recorded, logs: [...recorded.logs, ...late.map((line) => ({ type: line.type, text: registry.replaceAll(line.text) }))] });
    }
    return results;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      if (exited) resolvePromise(undefined);
      else child.once("exit", () => resolvePromise(undefined));
      setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise(undefined);
      }, 3000);
    });
    if (stderr.length > 0 && args.debug) console.error(stderr.join(""));
  }
}

// ---------------------------------------------------------------- compare

function compareStep(program: string, expected: RecordedStep, actual: RecordedStep): void {
  const expectedView = view(expected);
  const actualView = view(actual);
  diff(program, expected.id, "", expectedView, actualView);
}

function view(step: RecordedStep): Json {
  // Blocking calls are ordered (the emulator awaits each); lifecycle
  // multicasts are fire-and-forget and compared as a set.
  const blocking = step.functionsCalls.filter((call) => call.path.startsWith("/blocking/"));
  const multicast = step.functionsCalls
    .filter((call) => !call.path.startsWith("/blocking/"))
    .map((call) => canonicalize(call as unknown as Json))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return {
    response: {
      status: step.response.status,
      headers: step.response.headers as unknown as Json,
      body: canonicalize(step.response.body),
    },
    logs: step.logs.map((line) => ({ type: line.type, text: line.text })) as unknown as Json,
    blockingCalls: canonicalize(blocking as unknown as Json),
    multicastCalls: multicast,
  };
}

function diff(program: string, step: string, path: string, expected: Json | undefined, actual: Json | undefined): void {
  if (isObject(expected) && isObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) diff(program, step, path ? `${path}.${key}` : key, expected[key], actual[key]);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      record(program, step, `${path}.length`, expected.length, actual.length);
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) diff(program, step, `${path}.${String(index)}`, expected[index], actual[index]);
    return;
  }
  compared += 1;
  if (JSON.stringify(expected) !== JSON.stringify(actual)) record(program, step, path, expected, actual);
}

function record(program: string, step: string, path: string, expected: Json | undefined, actual: Json | undefined): void {
  const divergence = DIVERGENCES.find((candidate) => candidate.program.test(program) && candidate.step.test(step) && candidate.path.test(path));
  if (divergence && (divergence.anyValue || divergence.accept?.(expected, actual))) {
    divergencesObserved.push({ program, step, path, reason: divergence.reason });
    return;
  }
  mismatches.push({ program, step, path, expected, actual });
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(value: Json | undefined): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}
