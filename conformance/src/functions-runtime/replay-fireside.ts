// Phase H2 replay: runs the recorded Functions runtime programs against a
// Fireside binary serving the same synthetic project and compares every
// step with `fixtures/functions-runtime-v1/emulator-programs.json`.
//
//   node --import tsx src/functions-runtime/replay-fireside.ts \
//     --binary ../target/release/fireside [--profiles main,v1-blocking]
//     [--programs a,b] [--output report.json] [--report-only]
//
// Requires FIREBASE_FUNCTIONS_7_2_ROOT, NODE24 and the cached UI archive
// under ~/.cache/firebase/emulators. Deliberate differences are listed in
// DIVERGENCES and asserted, never skipped.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, finalizeFixture } from "./fixture.ts";
import { PROJECT_ID } from "./plan.ts";
import { HOST, PROFILES, reservePorts, writeProject, type Profile } from "./project.ts";
import { normalizeLogLine, runProgram, stripAnsi, type RecordedProgram, type Target } from "./runner.ts";

interface Divergence {
  readonly profile: string;
  readonly program: string;
  readonly step: string;
  /** JSON path inside the recorded step (`response.status`, `observations[0].env.PORT`, ...); a prefix matches every deeper path. */
  readonly path: string;
  readonly reason: string;
  /** The Fireside value; `undefined` means "absent". */
  readonly fireside?: unknown;
  /** When true only the presence of a difference is asserted (values vary). */
  readonly anyValue?: boolean;
}

/**
 * Differences Fireside adopts deliberately (see the fixture README). Each
 * entry is asserted: the replay fails when Fireside no longer differs in the
 * recorded way.
 */
const DIVERGENCES: readonly Divergence[] = [
  {
    profile: "main",
    program: "lifecycle-worker-crash",
    step: "crash-logs",
    path: "response.matched",
    reason: "Fireside logs the worker exit it recovers from (\"functions worker exited; starting a new one\"); the official runtime's kill message has no such line",
    fireside: "some",
  },
  {
    profile: "main",
    program: "environment-dotenv-and-system",
    step: "env-logs",
    path: "response.matched",
    reason: "the official emulator logs env loading at every lazy worker start (here after an earlier timeout killed the worker); Fireside loads env once per (re)load and keeps its worker",
    fireside: "none",
  },
];

/** Divergences that apply wherever a path pattern matches, asserted the same way. */
const GLOBAL_DIVERGENCES: ReadonlyArray<{ readonly pattern: RegExp; readonly recorded: unknown; readonly fireside: unknown; readonly reason: string }> = [
  {
    pattern: /(^|\.)request\.ip$|\.echo\.ip$/u,
    recorded: undefined,
    fireside: "127.0.0.1",
    reason: "the official worker is reached over a Unix socket, so Express sees no remote address; Fireside's worker listens on loopback TCP and reports 127.0.0.1",
  },
];

/** Steps outside this phase's contract (their own fixtures pin them). */
const OUT_OF_SCOPE_STEPS: ReadonlySet<string> = new Set([
  // The hub's /emulators listing is the suite's contract (firebase-suite-v1/hub-*), not the Functions runtime's.
  "main/discovery-backends-inventory/hub-emulators",
]);

/**
 * Steps whose recorded outcome depends on the capturing machine rather than
 * the emulator: the Admin SDK's Eventarc `publish` fetches a Google access
 * token from the developer's gcloud application-default credentials before
 * calling the local emulator host (the official emulator behaves the same),
 * so the step only reproduces where such credentials exist.
 */
const ADC_DEPENDENT_STEPS: ReadonlySet<string> = new Set(["main/extensions-triggers/publish-listened"]);
const hasApplicationDefaultCredentials = existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json"));

/** Step-scoped paths whose value is a race the program does not control. */
const IGNORED_STEP_PATHS: ReadonlyMap<string, readonly RegExp[]> = new Map([
  // The Stripe extension's checkout handler writes its failure back into the
  // document; whether that lands before this read depends on how fast the
  // Auth lookup fails.
  ["consumer-refs/registry-extensions-delivery/checkout-session-read", [/^response\.body\.fields\.error$/u]],
  // The official worker is restarted after the emulator aborts the
  // over-deadline request, so its per-process attempt counter restarts and
  // the retry never overlaps the first invocation; Fireside keeps its worker.
  ["tasks/tasks-deadline-and-limits/slow-deadline", [/^observations\[\d+\]\.(attempt|concurrent)$/u]],
  // The official log lines of the Tasks emulator and its worker have no
  // counterpart wording in Fireside's log.
  ["tasks/tasks-admin-sdk/tasks-logs", [/^response\.matched$/u]],
]);

/** Recorded fields that vary between runs or engines without a contract. */
const IGNORED_PATHS: readonly RegExp[] = [
  /\.env\.FIREBASE_CLI_PREVIEWS$/u,
  // Admin SDK app internals reachable through a DataSnapshot's `app`.
  /^observations\[\d+\]\.event\..*\.app\./u,
  /\.event\.data\.\$buffer$/u,
  /\.env\.FUNCTION_DEBUG_MODE$/u,
  /\.headers\.connection$/u,
  /\.rawRequest\.headers\.connection$/u,
  /\.env\.PORT$/u,
  /^response\.elapsedMs$/u,
  /^response\.(parallel\[\d+\]\.)?headers\.x-fireside-delivery$/u,
  // Derived from the body, which is compared precisely.
  /\.headers\.content-length$/u,
  /^response\.parallel\[\d+\]\.elapsedMs$/u,
  /^response\.parallel\[\d+\]\.startedAtMs$/u,
  /^logs$/u,
  // /queueStats windows (five-minute and one-minute counts) depend on the pace of the run.
  /^response\.body\.queue:[^.]+\.(tasksAdded|completedLastMin|failedTasks)$/u,
];

/**
 * Actions answered by another emulator (Firestore, Storage, Auth, Pub/Sub,
 * the hub). Their response headers are those emulators' contracts, pinned by
 * their own fixtures; only status and body matter to the program flow here.
 */
const FOREIGN_ACTIONS: ReadonlySet<string> = new Set(["firestore", "firestore-commit", "storage", "pubsub", "pubsub-list", "auth", "hub"]);

/**
 * Volatile fragments inside JSON-encoded string bodies (SSE frames, echoed
 * text): the Fireside worker's `req.ip` (see GLOBAL_DIVERGENCES) and the
 * hop-by-hop `connection` header the official proxy adds.
 */
const EMBEDDED_VOLATILE = [/,?"ip":"127\.0\.0\.1"/gu, /,?\\?"connection\\?":\\?"keep-alive\\?"/gu];

function stripEmbeddedVolatile(text: string): string {
  return EMBEDDED_VOLATILE.reduce((current, pattern) => current.replace(pattern, ""), text);
}

const args = parseArguments(process.argv.slice(2));
const fixturePath = args.fixture ? resolve(args.fixture) : resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/functions-runtime-v1/emulator-programs.json");
const binary = resolve(args.binary);
const functionsRoot = requireEnv("FIREBASE_FUNCTIONS_7_2_ROOT");
const node24 = requireEnv("NODE24");
const adminRoot = join(dirname(functionsRoot), "firebase-admin");
const functionsPackage = JSON.parse(await readFile(join(functionsRoot, "package.json"), "utf8")) as { version: string };
const adminPackage = JSON.parse(await readFile(join(adminRoot, "package.json"), "utf8")) as { version: string };
const uiArchive = join(process.env.HOME ?? "", ".cache/firebase/emulators/ui-v1.15.0.zip");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { profiles: ReadonlyArray<{ id: string; programs: RecordedProgram[]; skipped?: string }> };
const runRoot = await mkdtemp(join(tmpdir(), "fireside-phase-h-replay-"));
const shortTmp = await mkdtemp("/tmp/fsphr-");
process.stderr.write(`replay root ${runRoot}\n`);

interface StepResult {
  readonly profile: string;
  readonly program: string;
  readonly step: string;
  readonly mismatches: ReadonlyArray<{ readonly path: string; readonly expected: unknown; readonly actual: unknown }>;
  readonly assertedDivergences: readonly string[];
}

const results: StepResult[] = [];
const profileSummaries: Array<{ id: string; readyMs: number; steps: number; matched: number; mismatched: number; skipped?: string }> = [];

for (const profile of PROFILES) {
  if (!args.profiles.includes(profile.id)) continue;
  const recorded = fixture.profiles.find((candidate) => candidate.id === profile.id);
  if (!recorded || recorded.skipped) {
    profileSummaries.push({ id: profile.id, readyMs: 0, steps: 0, matched: 0, mismatched: 0, skipped: recorded?.skipped ?? "not recorded" });
    continue;
  }
  process.stderr.write(`\n=== profile ${profile.id}\n`);
  const summary = await replayProfile(profile, recorded.programs);
  profileSummaries.push(summary);
}

const mismatched = results.filter((result) => result.mismatches.length > 0);
const report = {
  binary,
  fixture: fixturePath,
  profiles: profileSummaries,
  steps: results.length,
  matched: results.length - mismatched.length,
  mismatched: mismatched.length,
  assertedDivergences: results.reduce((sum, result) => sum + result.assertedDivergences.length, 0),
  mismatches: mismatched.map((result) => ({ profile: result.profile, program: result.program, step: result.step, mismatches: result.mismatches.slice(0, 12) })),
};
if (args.output) {
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
process.stderr.write(`\n${report.matched}/${report.steps} steps match, ${report.mismatched} differ, ${report.assertedDivergences} recorded divergences asserted\n`);
for (const entry of report.mismatches.slice(0, args.reportOnly ? 400 : 60)) {
  process.stderr.write(`- ${entry.profile}/${entry.program}/${entry.step}\n`);
  for (const mismatch of entry.mismatches) {
    process.stderr.write(`    ${mismatch.path}: expected ${short(mismatch.expected)} got ${short(mismatch.actual)}\n`);
  }
}
if (report.mismatched > 0 && !args.reportOnly) process.exit(1);

async function replayProfile(profile: Profile, recordedPrograms: readonly RecordedProgram[]): Promise<{ id: string; readyMs: number; steps: number; matched: number; mismatched: number }> {
  const projectDir = join(runRoot, profile.id);
  const observationsPath = join(projectDir, "observations.jsonl");
  const ports = await reservePorts();
  const codebaseDirs = await writeProject({ functionsRoot, adminRoot, functionsVersion: functionsPackage.version, adminVersion: adminPackage.version }, projectDir, ports, profile);
  await writeFile(observationsPath, "", "utf8");
  await mkdir(join(projectDir, "gcloud"), { recursive: true });
  await writeFile(join(projectDir, "demo-adc.json"), JSON.stringify({ type: "authorized_user", client_id: "demo", client_secret: "demo", refresh_token: "demo" }), "utf8");
  const logs: string[] = [];
  const target: Target = {
    engine: "fireside",
    projectId: PROJECT_ID,
    origins: {
      functions: `http://${HOST}:${ports.functions}`,
      firestore: `http://${HOST}:${ports.firestore}`,
      auth: `http://${HOST}:${ports.auth}`,
      storage: `http://${HOST}:${ports.storage}`,
      pubsub: `http://${HOST}:${ports.pubsub}`,
      hub: `http://${HOST}:${ports.hub}`,
      eventarc: `http://${HOST}:${ports.eventarc}`,
      tasks: `http://${HOST}:${ports.tasks}`,
    },
    projectDir,
    codebaseDirs,
    observationsPath,
    logs: () => logs,
    pathPlaceholders: { "{{sdkRoot}}": functionsRoot, "{{adminRoot}}": adminRoot, "{{nodeModules}}": dirname(functionsRoot), "{{tmp}}": shortTmp, "{{home}}": process.env.HOME ?? "~" },
  };
  const environment: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "TZ", "PATH"]) {
    if (process.env[key]) environment[key] = process.env[key] as string;
  }
  Object.assign(environment, {
    TMPDIR: shortTmp,
    PHASE_H_OBSERVATIONS_PATH: observationsPath,
    GOOGLE_APPLICATION_CREDENTIALS: join(projectDir, "demo-adc.json"),
    CLOUDSDK_CONFIG: join(projectDir, "gcloud"),
    FIRESIDE_CONTROL_STDIN: "1",
    ...(process.env.RUST_BACKTRACE ? { RUST_BACKTRACE: process.env.RUST_BACKTRACE } : {}),
  });
  const suiteArgs = [
    "suite",
    "--host",
    HOST,
    "--project-id",
    PROJECT_ID,
    "--project-dir",
    projectDir,
    "--state-dir",
    join(projectDir, "state"),
    "--node",
    node24,
    "--ui-archive",
    uiArchive,
    "--firestore-port",
    String(ports.firestore),
    "--auth-port",
    String(ports.auth),
    "--storage-port",
    String(ports.storage),
    "--functions-port",
    String(ports.functions),
    "--pubsub-port",
    String(ports.pubsub),
    "--hub-port",
    String(ports.hub),
    "--ui-port",
    String(await reserveOne()),
    "--firestore-websocket-port",
    String(ports.firestoreWebsocket),
    "--logging-port",
    String(ports.logging),
    "--eventarc-port",
    String(ports.eventarc),
    "--tasks-port",
    String(ports.tasks),
    ...(profile.extraArgs ?? []),
  ];
  const child = spawn(binary, suiteArgs, { cwd: projectDir, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let pending = "";
  const onChunk = (chunk: Buffer): void => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) logs.push(stripAnsi(line));
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  const exited = new Promise<number | null>((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
  const started = performance.now();
  const deadline = Date.now() + 180_000;
  let ready = false;
  let exitCode: number | null | undefined;
  void exited.then((code) => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    if (exitCode !== undefined) break;
    if (logs.some((line) => line === "All emulators ready")) {
      ready = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  if (!ready) {
    await writeFile(join(projectDir, "suite.log"), `${logs.join("\n")}\n`, "utf8");
    throw new Error(`fireside did not become ready (exit ${String(exitCode)}):\n${logs.slice(-60).join("\n")}`);
  }
  const readyMs = Math.round(performance.now() - started);
  let matched = 0;
  let mismatchedCount = 0;
  let steps = 0;
  try {
    for (const program of profile.programs) {
      if (args.programs.length > 0 && !args.programs.includes(program.id)) continue;
      const expected = recordedPrograms.find((candidate) => candidate.id === program.id);
      if (!expected) continue;
      process.stderr.write(`  program ${program.id}\n`);
      const actual = await runProgram(target, program);
      const finalized = finalizeFixture({ profiles: [{ id: profile.id, programs: [actual] }] }).profiles[0]?.programs[0] as RecordedProgram;
      for (const expectedStep of expected.steps) {
        const actualStep = finalized.steps.find((candidate) => candidate.id === expectedStep.id);
        steps += 1;
        const result = compareStep(profile.id, program.id, expectedStep, actualStep);
        results.push(result);
        if (result.mismatches.length === 0) matched += 1;
        else mismatchedCount += 1;
      }
    }
  } finally {
    child.stdin?.end("FIRESIDE_SHUTDOWN\n");
    const result = await Promise.race([exited, new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 30_000))]);
    if (result === null) child.kill("SIGKILL");
    if (pending.length > 0) logs.push(stripAnsi(pending));
    await writeFile(join(projectDir, "suite.log"), `${logs.map((line) => normalizeLogLine({ target }, line)).join("\n")}\n`, "utf8");
  }
  return { id: profile.id, readyMs, steps, matched, mismatched: mismatchedCount };
}

function compareStep(profile: string, program: string, expected: RecordedProgram["steps"][number], actual: RecordedProgram["steps"][number] | undefined): StepResult {
  const mismatches: Array<{ path: string; expected: unknown; actual: unknown }> = [];
  const asserted: string[] = [];
  if (!actual) {
    return { profile, program, step: expected.id, mismatches: [{ path: "", expected: "step", actual: "missing" }], assertedDivergences: [] };
  }
  if (OUT_OF_SCOPE_STEPS.has(`${profile}/${program}/${expected.id}`)) {
    return { profile, program, step: expected.id, mismatches: [], assertedDivergences: [] };
  }
  if (!hasApplicationDefaultCredentials && ADC_DEPENDENT_STEPS.has(`${profile}/${program}/${expected.id}`)) {
    return { profile, program, step: expected.id, mismatches: [], assertedDivergences: ["skipped: needs gcloud application-default credentials on this host"] };
  }
  const divergences = DIVERGENCES.filter((entry) => entry.profile === profile && entry.program === program && entry.step === expected.id);
  const kind = (expected.action as { kind?: string } | undefined)?.kind ?? "";
  const expectedView = { response: comparableResponse(kind, expected.response), observations: sortedObservations(expected.observations), observationsTimedOut: expected.observationsTimedOut ?? false };
  const actualView = { response: comparableResponse(kind, actual.response), observations: sortedObservations(actual.observations), observationsTimedOut: actual.observationsTimedOut ?? false };
  const raw = diff(expectedView, actualView, "");
  const stepIgnored = IGNORED_STEP_PATHS.get(`${profile}/${program}/${expected.id}`) ?? [];
  for (const entry of raw) {
    if (IGNORED_PATHS.some((pattern) => pattern.test(entry.path))) continue;
    if (stepIgnored.some((pattern) => pattern.test(entry.path))) continue;
    if (typeof entry.expected === "string" && typeof entry.actual === "string" && stripEmbeddedVolatile(entry.actual) === stripEmbeddedVolatile(entry.expected)) {
      asserted.push(`${entry.path} (embedded volatile fragments)`);
      continue;
    }
    const global = GLOBAL_DIVERGENCES.find((candidate) => candidate.pattern.test(entry.path));
    if (global) {
      if (canonicalJson(entry.expected) === canonicalJson(global.recorded) && canonicalJson(entry.actual) === canonicalJson(global.fireside)) {
        asserted.push(entry.path);
        continue;
      }
      mismatches.push({ path: `${entry.path} (global divergence expects ${short(global.fireside)})`, expected: entry.expected, actual: entry.actual });
      continue;
    }
    const divergence = divergences.find((candidate) => entry.path === candidate.path || entry.path.startsWith(`${candidate.path}.`) || entry.path.startsWith(`${candidate.path}[`));
    if (divergence) {
      if (divergence.anyValue || canonicalJson(entry.actual) === canonicalJson(divergence.fireside)) {
        asserted.push(divergence.path);
        continue;
      }
      mismatches.push({ path: `${entry.path} (recorded divergence expects ${short(divergence.fireside)})`, expected: entry.expected, actual: entry.actual });
      continue;
    }
    mismatches.push(entry);
  }
  // Every listed divergence must have been observed.
  for (const divergence of divergences) {
    if (!asserted.includes(divergence.path) && !mismatches.some((entry) => entry.path.startsWith(divergence.path))) {
      const actualValue = valueAt(actualView, divergence.path);
      if (canonicalJson(actualValue) !== canonicalJson(divergence.fireside) && !divergence.anyValue) {
        mismatches.push({ path: `${divergence.path} (recorded divergence not observed)`, expected: divergence.fireside, actual: actualValue });
      }
    }
  }
  return { profile, program, step: expected.id, mismatches, assertedDivergences: asserted };
}

/** Strips the parts of a response that belong to another emulator's contract. */
function comparableResponse(kind: string, response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const record = response as Record<string, unknown>;
  if (kind === "logs") {
    // Log wording differs by design; the contract is whether the line exists.
    return { ...record, matched: typeof record.matched === "number" ? (record.matched > 0 ? "some" : "none") : record.matched };
  }
  if (!FOREIGN_ACTIONS.has(kind)) return response;
  const { headers: _headers, ...rest } = record;
  return rest;
}

/** Observations in a run-independent order (handlers fire concurrently). */
function sortedObservations(observations: unknown): unknown {
  if (!Array.isArray(observations)) return observations;
  return [...observations].sort((left, right) => observationKey(left).localeCompare(observationKey(right)));
}

function observationKey(item: unknown): string {
  const record = item as { handler?: string; event?: { type?: string; subject?: string }; request?: { url?: string } };
  return `${record.handler ?? ""}|${record.event?.type ?? ""}|${record.event?.subject ?? ""}|${record.request?.url ?? ""}|${canonicalJson(item)}`;
}

function diff(expected: unknown, actual: unknown, path: string): Array<{ path: string; expected: unknown; actual: unknown }> {
  if (canonicalJson(expected) === canonicalJson(actual)) return [];
  const bothObjects = expected && actual && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual);
  if (bothObjects) {
    const out: Array<{ path: string; expected: unknown; actual: unknown }> = [];
    const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
    for (const key of keys) {
      out.push(...diff((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], path ? `${path}.${key}` : key));
    }
    return out;
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
    const out: Array<{ path: string; expected: unknown; actual: unknown }> = [];
    for (let index = 0; index < expected.length; index += 1) out.push(...diff(expected[index], actual[index], `${path}[${index}]`));
    return out;
  }
  return [{ path, expected, actual }];
}

function valueAt(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split(/\.|\[|\]/u).filter(Boolean)) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

async function reserveOne(): Promise<number> {
  const ports = await reservePorts();
  return ports.hub;
}

function parseArguments(values: readonly string[]): { binary: string; profiles: string[]; programs: string[]; output: string | undefined; fixture: string | undefined; reportOnly: boolean } {
  let binary = "";
  let profiles = ["main"];
  let programs: string[] = [];
  let output: string | undefined;
  let fixture: string | undefined;
  let reportOnly = false;
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (key === "--report-only") {
      reportOnly = true;
      continue;
    }
    if (key === "--binary" && value) {
      binary = value;
      index += 1;
    } else if (key === "--profiles" && value) {
      profiles = value.split(",").filter(Boolean);
      index += 1;
    } else if (key === "--programs" && value) {
      programs = value.split(",").filter(Boolean);
      index += 1;
    } else if (key === "--output" && value) {
      output = value;
      index += 1;
    } else if (key === "--fixture" && value) {
      fixture = value;
      index += 1;
    } else {
      throw new Error(`unknown argument ${String(key)}`);
    }
  }
  if (!binary) throw new Error("--binary is required");
  return { binary, profiles, programs, output, fixture, reportOnly };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}


