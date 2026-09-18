// Phase J4: replay the frozen Pub/Sub corpus against Fireside's standalone
// `fireside pubsub` service (one fresh process per program) with the same
// transports, push endpoint and normalization as the capture, and report
// every step that is not parity or a named divergence.
//
//   node --import tsx src/pubsub/replay-fireside.ts --binary ../target/release/fireside \
//     [--programs=a,b] [--report-only] [--output report.json] [--debug]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PushEndpoint, startFireside, type Json } from "./client.ts";
import { PROGRAMS, PROJECT_ID } from "./emulator-plan.ts";
import { canonicalize } from "./normalize.ts";
import { runProgram, type RecordedProgram, type RecordedStep } from "./runner.ts";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/pubsub-v1");

interface Fixture {
  readonly programs: readonly RecordedProgram[];
}

interface Mismatch {
  readonly program: string;
  readonly step: string;
  readonly path: string;
  readonly expected: Json | undefined;
  readonly actual: Json | undefined;
}

/** A step path whose value legitimately differs, with the reason. */
interface Divergence {
  readonly program: RegExp;
  readonly step: RegExp;
  readonly path: RegExp;
  readonly reason: string;
  readonly anyValue?: boolean;
  readonly accept?: (expected: Json | undefined, actual: Json | undefined) => boolean;
}

const DIVERGENCES: readonly Divergence[] = [];

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

const push = new PushEndpoint();
await push.start();
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
    const emulator = await startFireside(binary, PROJECT_ID);
    let actual: RecordedProgram;
    try {
      actual = await runProgram(program, { emulator, push, debug: args.debug });
    } catch (error) {
      console.error(emulator.logs());
      throw error;
    } finally {
      await emulator.stop();
    }
    for (const [index, expectedStep] of recorded.steps.entries()) {
      const actualStep = actual.steps[index];
      steps += 1;
      if (!actualStep) {
        mismatches.push({ program: program.id, step: expectedStep.id, path: "step", expected: "recorded", actual: "missing" });
        continue;
      }
      diff(program.id, expectedStep.id, "", view(expectedStep), view(actualStep));
    }
    const bad = mismatches.filter((mismatch) => mismatch.program === program.id).length;
    console.log(`${bad === 0 ? "ok  " : "FAIL"} ${program.id}: ${String(recorded.steps.length)} steps${bad ? `, ${String(bad)} mismatches` : ""}`);
  }
} finally {
  await push.stop();
}

const report = { binary, programs: programsRun, steps, compared, mismatched: mismatches.length, divergencesObserved, mismatches };
if (args.output) {
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(`\n${String(programsRun)} programs, ${String(steps)} steps, ${String(compared)} values compared, ${String(mismatches.length)} mismatches, ${String(divergencesObserved.length)} named divergences observed`);
for (const mismatch of mismatches.slice(0, args.reportOnly ? 500 : 80)) {
  console.log(`  ${mismatch.program}/${mismatch.step} ${mismatch.path}: expected ${short(mismatch.expected)} got ${short(mismatch.actual)}`);
}
if (mismatches.length > 0 && !args.reportOnly) process.exit(1);

function view(step: RecordedStep): Json {
  return canonicalize({ response: step.response, ...(step.pushes === undefined ? {} : { pushes: step.pushes as Json }) });
}

function diff(program: string, step: string, path: string, expected: Json | undefined, actual: Json | undefined): void {
  if (isObject(expected) && isObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) diff(program, step, path ? `${path}.${key}` : key, expected[key], actual[key]);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) record(program, step, `${path}.length`, expected.length, actual.length);
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
