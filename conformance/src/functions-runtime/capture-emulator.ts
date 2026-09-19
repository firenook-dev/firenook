// Phase H1: record every Functions runtime and Extensions oracle program in
// `plan.ts` against the official emulator suite (firebase-tools 15.22.0:
// Functions, Extensions, Auth, Storage, Pub/Sub, Eventarc and Tasks in
// process plus the Java Firestore emulator), profile by profile.
//
// Requires FIREBASE_TOOLS_15_22_ROOT, FIREBASE_FUNCTIONS_7_2_ROOT (a
// firebase-functions 7.2.5 package whose sibling node_modules holds
// firebase-admin), NODE24, Java on PATH and the cached emulator jars under
// ~/.cache/firebase/emulators. Everything recorded is synthetic. The optional
// `consumer-refs` profile resolves two public registry extensions through the
// developer's Firebase CLI login; it is skipped, with the reason recorded,
// when no login exists.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_SPEC, PROJECT_ID, STATIC_MANIFEST, esmSource, extensionSource, primarySource, primarySourceAfterReload, secondarySource } from "./plan.ts";
import { HOST, PROFILES, reservePorts, writeProject, type Profile } from "./project.ts";
import { finalizeFixture } from "./fixture.ts";
import { fetchRecorded, normalizeForTarget, normalizeLogLine, runProgram, sha256, stripAnsi, type RecordedProgram, type Target } from "./runner.ts";

const FIREBASE_TOOLS_VERSION = "15.22.0";
const FIREBASE_FUNCTIONS_VERSION = "7.2.5";
const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/functions-runtime-v1");

const requestedProfiles = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const programFilter = (process.argv.find((argument) => argument.startsWith("--programs=")) ?? "").slice("--programs=".length).split(",").filter(Boolean);
// `--output=<file>` writes the recording elsewhere (a separate fixture set such
// as `fixtures/tasks-v1`, which holds only the `tasks` profile).
const outputOverride = (process.argv.find((argument) => argument.startsWith("--output=")) ?? "").slice("--output=".length);
const packageRoot = requireEnv("FIREBASE_TOOLS_15_22_ROOT");
const functionsRoot = requireEnv("FIREBASE_FUNCTIONS_7_2_ROOT");
const node24 = requireEnv("NODE24");
const adminRoot = join(dirname(functionsRoot), "firebase-admin");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name: string; version: string };
if (packageJson.name !== "firebase-tools" || packageJson.version !== FIREBASE_TOOLS_VERSION) {
  throw new Error(`expected firebase-tools ${FIREBASE_TOOLS_VERSION}, found ${packageJson.name} ${packageJson.version}`);
}
const functionsPackage = JSON.parse(await readFile(join(functionsRoot, "package.json"), "utf8")) as { name: string; version: string };
if (functionsPackage.name !== "firebase-functions" || functionsPackage.version !== FIREBASE_FUNCTIONS_VERSION) {
  throw new Error(`expected firebase-functions ${FIREBASE_FUNCTIONS_VERSION}`);
}
const adminPackage = JSON.parse(await readFile(join(adminRoot, "package.json"), "utf8")) as { name: string; version: string };
const cacheRoot = join(process.env.HOME ?? "", ".cache/firebase/emulators");
const jarHashes: Record<string, string> = {};
for (const jar of ["cloud-firestore-emulator-v1.21.0.jar", "cloud-storage-rules-runtime-v1.1.3.jar", "pubsub-emulator-0.8.33.zip", "ui-v1.15.0.zip"]) {
  jarHashes[jar] = sha256(await readFile(join(cacheRoot, jar)));
}

const runRoot = await mkdtemp(join(tmpdir(), "fireside-phase-h-"));
const shortTmp = await mkdtemp("/tmp/fsph-");
process.env.TMPDIR = shortTmp;
process.stderr.write(`phase H capture root ${runRoot}\n`);

interface ProfileRecording {
  readonly id: string;
  readonly description: string;
  readonly skipped?: string;
  readonly startupFailure?: { readonly exitCode: number | null; readonly logs: readonly string[] };
  readonly readiness?: { readonly milliseconds: number; readonly logs: readonly string[] };
  readonly inventory?: unknown;
  readonly programs: readonly RecordedProgram[];
  readonly shutdown?: { readonly exitCode: number | null; readonly signal: string | null; readonly logs: readonly string[] };
}

const recordings: ProfileRecording[] = [];
for (const profile of PROFILES) {
  if (requestedProfiles.length > 0 && !requestedProfiles.includes(profile.id)) continue;
  process.stderr.write(`\n=== profile ${profile.id}\n`);
  recordings.push(await captureProfile(profile));
}

const fixture = {
  schemaVersion: 1,
  name: outputOverride ? outputOverride.replace(/^.*fixtures\//u, "").replace(/\.json$/u, "") : "functions-runtime-v1/emulator-programs",
  target: "official-firebase-tools-functions-and-extensions-emulator",
  targetVersion: FIREBASE_TOOLS_VERSION,
  sdkVersions: { "firebase-functions": functionsPackage.version, "firebase-admin": adminPackage.version },
  node: process.version,
  recordedAt: new Date().toISOString(),
  transport: "http",
  hypothesis:
    "The official Functions emulator's HTTP contract (routes, statuses, bodies, callable envelopes, CORS), the envelopes and environment handlers observe for every supported trigger, its lifecycle behaviour and its Extensions resolution define what the owned Fireside runtime must reproduce; divergences are recorded in the fixture invariants, never adopted silently.",
  projectId: PROJECT_ID,
  cachedEmulatorSha256: jarHashes,
  syntheticSourceSha256: {
    primary: sha256(primarySource()),
    primaryAfterReload: sha256(primarySourceAfterReload()),
    secondary: sha256(secondarySource()),
    esm: sha256(esmSource()),
    staticManifest: sha256(STATIC_MANIFEST),
    extensionSpec: sha256(EXTENSION_SPEC),
    extensionFunctions: sha256(extensionSource()),
  },
  profiles: recordings,
};
const finalized = finalizeFixture(fixture as typeof fixture & { profiles: typeof recordings });
await mkdir(outputRoot, { recursive: true });
const requested = requestedProfiles.length > 0;
const outputPath = outputOverride ? resolve(outputOverride) : join(outputRoot, requested ? `emulator-programs.${requestedProfiles.join("+")}.json` : "emulator-programs.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
process.stderr.write(`\nrecorded ${finalized.profileCount} profiles, ${finalized.programCount} programs, ${finalized.stepCount} steps, ${finalized.observationCount} observations → ${outputPath}\n`);
await rm(shortTmp, { recursive: true, force: true });

async function captureProfile(profile: Profile): Promise<ProfileRecording> {
  const projectDir = join(runRoot, profile.id);
  const observationsPath = join(projectDir, "observations.jsonl");
  const ports = await reservePorts();
  const codebaseDirs = await writeProject({ functionsRoot, adminRoot, functionsVersion: functionsPackage.version, adminVersion: adminPackage.version }, projectDir, ports, profile);
  await writeFile(observationsPath, "", "utf8");
  const logs: string[] = [];
  const target: Target = {
    engine: "official-firebase-tools",
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
    pathPlaceholders: { "{{sdkRoot}}": functionsRoot, "{{adminRoot}}": adminRoot, "{{firebaseToolsRoot}}": packageRoot, "{{nodeModules}}": dirname(functionsRoot), "{{tmp}}": shortTmp, "{{home}}": process.env.HOME ?? "~" },
  };
  const environment: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "TZ", "PATH", "JAVA_HOME", "TMPDIR"]) {
    if (process.env[key]) environment[key] = process.env[key] as string;
  }
  Object.assign(environment, { CI: "1", FIREBASE_CLI_PREVIEWS: "", PHASE_H_OBSERVATIONS_PATH: observationsPath, FIREBASE_EMULATOR_HUB: "" });
  delete environment.FIREBASE_EMULATOR_HUB;
  const child = spawn(
    node24,
    [
      join(packageRoot, "lib/bin/firebase.js"),
      "emulators:start",
      "--project",
      PROJECT_ID,
      "--config",
      join(projectDir, "firebase.json"),
      "--only",
      "auth,functions,firestore,storage,pubsub,eventarc,tasks,extensions",
      "--non-interactive",
      ...(profile.extraArgs ?? []),
    ],
    { cwd: projectDir, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = "";
  const onChunk = (chunk: Buffer): void => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) logs.push(stripAnsi(line));
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
  const started = performance.now();
  const readiness = await waitForReady(child, exited, target, logs, profile.expectStartupFailure ? 60_000 : 180_000);
  if (readiness.kind === "exited") {
    if (pending.length > 0) logs.push(stripAnsi(pending));
    const normalized = logs.map((line) => normalizeLogLine({ target }, line));
    if (profile.optional && !profile.expectStartupFailure) {
      const reason = normalized.find((line) => /not logged in|requires authentication|login|credential|Failed to authenticate|401|403/i.test(line)) ?? `official suite exited ${String(readiness.code)}`;
      process.stderr.write(`profile ${profile.id} skipped: ${reason}\n`);
      return { id: profile.id, description: profile.description, skipped: reason, programs: [] };
    }
    if (!profile.expectStartupFailure) {
      throw new Error(`official suite exited ${String(readiness.code)} before readiness:\n${logs.join("\n")}`);
    }
    return { id: profile.id, description: profile.description, startupFailure: { exitCode: readiness.code, logs: normalized }, programs: [] };
  }
  if (profile.expectStartupFailure) {
    process.stderr.write(`profile ${profile.id}: expected a startup failure but the suite became ready; recording readiness instead\n`);
  }
  const readyMilliseconds = Math.round(performance.now() - started);
  const readinessLogs = logs.map((line) => normalizeLogLine({ target }, line));
  const inventory = await fetchRecorded(`${target.origins.functions}/backends`, { method: "GET", headers: {} });
  const programs: RecordedProgram[] = [];
  try {
    for (const program of profile.programs) {
      if (programFilter.length > 0 && !programFilter.includes(program.id)) continue;
      process.stderr.write(`  program ${program.id}\n`);
      try {
        programs.push(await runProgram(target, program));
      } catch (error) {
        process.stderr.write(`  program ${program.id} failed: ${String((error as Error).stack ?? error)}\n`);
        programs.push({ id: program.id, category: program.category, description: program.description, steps: [], failure: String((error as Error).message ?? error) } as RecordedProgram & { failure: string });
      }
    }
  } finally {
    child.kill("SIGINT");
    const result = await Promise.race([exited, delayResult(30_000)]);
    if (result === undefined) child.kill("SIGKILL");
    if (pending.length > 0) logs.push(stripAnsi(pending));
    await writeFile(join(projectDir, "suite.log"), `${logs.join("\n")}\n`, "utf8");
    const shutdownLogs = logs.slice(readinessLogs.length).filter((line) => /shut|stop|export|clean/i.test(line)).map((line) => normalizeLogLine({ target }, line));
    return {
      id: profile.id,
      description: profile.description,
      readiness: { milliseconds: readyMilliseconds, logs: readinessLogs },
      inventory: normalizeInventory(target, inventory),
      programs,
      shutdown: { exitCode: result?.code ?? null, signal: result?.signal ?? null, logs: shutdownLogs },
    };
  }
}

function normalizeInventory(target: Target, response: unknown): unknown {
  return normalizeForTarget(target, response);
}

async function waitForReady(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  target: Target,
  logs: readonly string[],
  timeoutMs: number,
): Promise<{ kind: "ready" } | { kind: "exited"; code: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let exitCode: { code: number | null } | undefined;
  void exited.then((result) => {
    exitCode = result;
  });
  while (Date.now() < deadline) {
    if (exitCode) return { kind: "exited", code: exitCode.code };
    if (logs.some((line) => line.includes("All emulators ready"))) {
      try {
        const backends = await fetch(`${target.origins.functions}/backends`);
        if (backends.ok) return { kind: "ready" };
      } catch {
        // keep polling
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  child.kill("SIGKILL");
  throw new Error(`official suite did not become ready within ${timeoutMs} ms:\n${logs.join("\n")}`);
}

function delayResult(ms: number): Promise<undefined> {
  return new Promise((resolvePromise) => setTimeout(() => resolvePromise(undefined), ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
