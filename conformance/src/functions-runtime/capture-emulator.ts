// Phase H1: record every Functions runtime and Extensions oracle program in
// `plan.ts` against the official emulator suite (firebase-tools 15.22.0:
// Functions, Extensions, Auth, Storage, Pub/Sub, Eventarc and Tasks in
// process plus the Java Firestore emulator), profile by profile.
//
// Requires FIREBASE_TOOLS_15_22_ROOT, FIREBASE_FUNCTIONS_7_2_ROOT (a
// firebase-functions 7.2.5 package whose sibling node_modules holds
// firebase-admin), NODE24, Java on PATH and the cached emulator jars under
// ~/.cache/firebase/emulators. Everything recorded is synthetic. The optional
// `twodart-refs` profile resolves two public registry extensions through the
// developer's Firebase CLI login; it is skipped, with the reason recorded,
// when no login exists.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BAD_ENV_FILES,
  CODEBASES,
  DEFAULT_BUCKET,
  EXTENSION_ENV_FILES,
  EXTENSION_INSTANCE,
  EXTENSION_SPEC,
  INSPECT_PROGRAMS,
  MISSING_PARAM_PROGRAMS,
  PRIMARY_ENV_FILES,
  PROGRAMS,
  PROJECT_ID,
  SECONDARY_ENV_FILES,
  SECOND_BUCKET,
  STATIC_MANIFEST,
  TWODART_REFS_ENV_FILES,
  TWODART_REFS_PROGRAMS,
  V1_BLOCKING_PROGRAMS,
  badEnvSource,
  brokenSource,
  esmSource,
  extensionSource,
  primarySource,
  primarySourceAfterReload,
  secondarySource,
  v1BlockingSource,
  yamlSource,
  type Program,
} from "./plan.ts";
import { finalizeFixture } from "./fixture.ts";
import { fetchRecorded, normalizeForTarget, normalizeLogLine, runProgram, sha256, stripAnsi, type RecordedProgram, type Target } from "./runner.ts";

const HOST = "127.0.0.1";
const FIREBASE_TOOLS_VERSION = "15.22.0";
const FIREBASE_FUNCTIONS_VERSION = "7.2.5";
const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/functions-runtime-v1");

interface Profile {
  readonly id: string;
  readonly description: string;
  readonly programs: readonly Program[];
  readonly primary?: () => string;
  readonly extraArgs?: readonly string[];
  readonly extensions?: Readonly<Record<string, string>>;
  readonly extensionEnvFiles?: Readonly<Record<string, string>>;
  readonly optional?: boolean;
  readonly expectStartupFailure?: boolean;
}

const PROFILES: readonly Profile[] = [
  { id: "main", description: "Six user codebases and the local extension; every program in PROGRAMS.", programs: PROGRAMS },
  { id: "v1-blocking", description: "The primary codebase replaced by first-generation blocking functions.", programs: V1_BLOCKING_PROGRAMS, primary: v1BlockingSource },
  { id: "inspect", description: "The main project started with --inspect-functions.", programs: INSPECT_PROGRAMS, extraArgs: ["--inspect-functions"] },
  {
    id: "ext-missing-param",
    description: "The local extension instance without the required secret parameter and without the bucket parameter (its default references an auto-parameter).",
    programs: MISSING_PARAM_PROGRAMS,
    extensionEnvFiles: Object.fromEntries(
      Object.entries(EXTENSION_ENV_FILES)
        .filter(([name]) => !name.endsWith(".secret.local"))
        .map(([name, content]) => [name, content.split("\n").filter((line) => !line.startsWith("BUCKET=")).join("\n")]),
    ),
    expectStartupFailure: true,
  },
  {
    id: "twodart-refs",
    description: "Two public registry extensions (Stripe payments 0.3.12, Algolia search 1.2.10) resolved from the shared cache with synthetic parameters.",
    programs: TWODART_REFS_PROGRAMS,
    extensions: { stripe: "invertase/firestore-stripe-payments@0.3.12", algolia: "algolia/firestore-algolia-search@1.2.10" },
    extensionEnvFiles: TWODART_REFS_ENV_FILES,
    optional: true,
  },
];

const requestedProfiles = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const programFilter = (process.argv.find((argument) => argument.startsWith("--programs=")) ?? "").slice("--programs=".length).split(",").filter(Boolean);
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
  name: "functions-runtime-v1/emulator-programs",
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
const outputPath = join(outputRoot, requested ? `emulator-programs.${requestedProfiles.join("+")}.json` : "emulator-programs.json");
await writeFile(outputPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
process.stderr.write(`\nrecorded ${finalized.profileCount} profiles, ${finalized.programCount} programs, ${finalized.stepCount} steps, ${finalized.observationCount} observations → ${outputPath}\n`);
await rm(shortTmp, { recursive: true, force: true });

async function captureProfile(profile: Profile): Promise<ProfileRecording> {
  const projectDir = join(runRoot, profile.id);
  const observationsPath = join(projectDir, "observations.jsonl");
  const ports = await reservePorts();
  const codebaseDirs = await writeProject(projectDir, ports, profile);
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
    pathPlaceholders: { "{{sdkRoot}}": functionsRoot, "{{adminRoot}}": adminRoot, "{{firebaseToolsRoot}}": packageRoot, "{{tmp}}": shortTmp, "{{home}}": process.env.HOME ?? "~" },
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

interface Ports {
  readonly auth: number;
  readonly functions: number;
  readonly firestore: number;
  readonly firestoreWebsocket: number;
  readonly storage: number;
  readonly pubsub: number;
  readonly eventarc: number;
  readonly tasks: number;
  readonly hub: number;
  readonly logging: number;
}

async function reservePorts(): Promise<Ports> {
  const entries = await Promise.all(
    ["auth", "functions", "firestore", "firestoreWebsocket", "storage", "pubsub", "eventarc", "tasks", "hub", "logging"].map(async (name) => [name, await reserveAvailablePort()] as const),
  );
  return Object.fromEntries(entries) as unknown as Ports;
}

function reserveAvailablePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createTcpServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

async function writeCodebase(directory: string, files: Readonly<Record<string, string>>, packageJson: Record<string, unknown>): Promise<void> {
  await mkdir(join(directory, "node_modules"), { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await symlink(functionsRoot, join(directory, "node_modules/firebase-functions"), "dir");
  await symlink(adminRoot, join(directory, "node_modules/firebase-admin"), "dir");
  await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
  await symlink(join(functionsRoot, "lib/bin/firebase-functions.js"), join(directory, "node_modules/.bin/firebase-functions"), "file");
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content, "utf8");
}

async function writeProject(projectDir: string, ports: Ports, profile: Profile): Promise<Record<keyof typeof CODEBASES, string>> {
  await mkdir(projectDir, { recursive: true });
  const base = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: `phase-h-${name}`,
    version: "0.0.0",
    private: true,
    main: "index.js",
    engines: { node: "24" },
    dependencies: { "firebase-admin": `^${adminPackage.version}`, "firebase-functions": `^${FIREBASE_FUNCTIONS_VERSION}` },
    ...extra,
  });
  const directories: Record<keyof typeof CODEBASES, string> = {
    primary: join(projectDir, "functions/primary"),
    secondary: join(projectDir, "functions/secondary"),
    esm: join(projectDir, "functions/esm"),
    yaml: join(projectDir, "functions/static-manifest"),
    broken: join(projectDir, "functions/broken-load"),
    badenv: join(projectDir, "functions/invalid-dotenv"),
  };
  await writeCodebase(directories.primary, { "index.js": (profile.primary ?? primarySource)(), ...PRIMARY_ENV_FILES }, base("primary"));
  await writeCodebase(directories.secondary, { "index.js": secondarySource(), ...SECONDARY_ENV_FILES }, base("secondary"));
  await writeCodebase(directories.esm, { "index.js": esmSource() }, base("esm", { type: "module" }));
  await writeCodebase(directories.yaml, { "index.js": yamlSource(), "functions.yaml": STATIC_MANIFEST }, base("static-manifest"));
  await writeCodebase(directories.broken, { "index.js": brokenSource() }, base("broken-load"));
  await writeCodebase(directories.badenv, { "index.js": badEnvSource(), ...BAD_ENV_FILES }, base("invalid-dotenv"));

  const extensionDir = join(projectDir, "extensions-local", EXTENSION_INSTANCE);
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, "extension.yaml"), EXTENSION_SPEC, "utf8");
  await writeFile(join(extensionDir, "POSTINSTALL.md"), "# Synthetic\n\nInstalled.\n", "utf8");
  await writeCodebase(join(extensionDir, "functions"), { "index.js": extensionSource() }, base("extension", { engines: { node: "22" } }));
  await mkdir(join(projectDir, "extensions"), { recursive: true });
  const extensionEnvFiles = profile.extensionEnvFiles ?? EXTENSION_ENV_FILES;
  for (const [name, content] of Object.entries(extensionEnvFiles)) await writeFile(join(projectDir, "extensions", name), content, "utf8");

  await writeFile(join(projectDir, "firestore.rules"), "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if true; }\n  }\n}\n", "utf8");
  await writeFile(join(projectDir, "storage.rules"), "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} { allow read, write: if true; }\n  }\n}\n", "utf8");
  await writeFile(join(projectDir, ".firebaserc"), `${JSON.stringify({ projects: { default: PROJECT_ID }, targets: { [PROJECT_ID]: { storage: { default: [DEFAULT_BUCKET], second: [SECOND_BUCKET] } } } }, null, 2)}\n`, "utf8");
  const config = {
    functions: [
      { source: "functions/primary", codebase: CODEBASES.primary },
      { source: "functions/secondary", codebase: CODEBASES.secondary },
      { source: "functions/esm", codebase: CODEBASES.esm },
      { source: "functions/static-manifest", codebase: CODEBASES.yaml },
      { source: "functions/broken-load", codebase: CODEBASES.broken },
      { source: "functions/invalid-dotenv", codebase: CODEBASES.badenv, ignore: ["*.local"] },
    ],
    extensions: profile.extensions ?? { [EXTENSION_INSTANCE]: `./extensions-local/${EXTENSION_INSTANCE}` },
    firestore: { rules: "firestore.rules" },
    storage: [
      { target: "default", rules: "storage.rules" },
      { target: "second", rules: "storage.rules" },
    ],
    emulators: {
      auth: { host: HOST, port: ports.auth },
      functions: { host: HOST, port: ports.functions },
      firestore: { host: HOST, port: ports.firestore, websocketPort: ports.firestoreWebsocket },
      storage: { host: HOST, port: ports.storage },
      pubsub: { host: HOST, port: ports.pubsub },
      eventarc: { host: HOST, port: ports.eventarc },
      tasks: { host: HOST, port: ports.tasks },
      hub: { host: HOST, port: ports.hub },
      logging: { host: HOST, port: ports.logging },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  };
  await writeFile(join(projectDir, "firebase.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return directories;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
