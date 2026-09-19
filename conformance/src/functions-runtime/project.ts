// Phase H1 synthetic project shared by the official-emulator capture and the
// Fireside replay: profiles, port reservation and the on-disk project layout
// (six user codebases, one local extension, dotenv chains, secrets, rules).
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";

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
  TASKS_PROGRAMS,
  CONSUMER_REFS_ENV_FILES,
  CONSUMER_REFS_PROGRAMS,
  V1_BLOCKING_PROGRAMS,
  badEnvSource,
  brokenSource,
  esmSource,
  extensionSource,
  primarySource,
  secondarySource,
  tasksSource,
  v1BlockingSource,
  yamlSource,
  type Program,
} from "./plan.ts";

export const HOST = "127.0.0.1";

export interface SdkRoots {
  readonly functionsRoot: string;
  readonly adminRoot: string;
  readonly functionsVersion: string;
  readonly adminVersion: string;
}

export interface Profile {
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

export const PROFILES: readonly Profile[] = [
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
    id: "tasks",
    description: "Phase K: the primary codebase replaced by task-queue handlers with distinct retry and rate configurations plus Admin SDK enqueue/delete handlers; programs drive the Tasks emulator port directly (fixture tasks-v1).",
    programs: TASKS_PROGRAMS,
    primary: tasksSource,
  },
  {
    id: "consumer-refs",
    description: "Two public registry extensions (Stripe payments 0.3.12, Algolia search 1.2.10) resolved from the shared cache with synthetic parameters.",
    programs: CONSUMER_REFS_PROGRAMS,
    extensions: { stripe: "invertase/firestore-stripe-payments@0.3.12", algolia: "algolia/firestore-algolia-search@1.2.10" },
    extensionEnvFiles: CONSUMER_REFS_ENV_FILES,
    optional: true,
  },
];

export interface Ports {
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

export async function reservePorts(): Promise<Ports> {
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

async function writeCodebase(sdk: SdkRoots, directory: string, files: Readonly<Record<string, string>>, packageJson: Record<string, unknown>): Promise<void> {
  await mkdir(join(directory, "node_modules"), { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await symlink(sdk.functionsRoot, join(directory, "node_modules/firebase-functions"), "dir");
  await symlink(sdk.adminRoot, join(directory, "node_modules/firebase-admin"), "dir");
  await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
  await symlink(join(sdk.functionsRoot, "lib/bin/firebase-functions.js"), join(directory, "node_modules/.bin/firebase-functions"), "file");
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content, "utf8");
}

export async function writeProject(sdk: SdkRoots, projectDir: string, ports: Ports, profile: Profile): Promise<Record<keyof typeof CODEBASES, string>> {
  await mkdir(projectDir, { recursive: true });
  const base = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: `phase-h-${name}`,
    version: "0.0.0",
    private: true,
    main: "index.js",
    engines: { node: "24" },
    dependencies: { "firebase-admin": `^${sdk.adminVersion}`, "firebase-functions": `^${sdk.functionsVersion}` },
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
  await writeCodebase(sdk, directories.primary, { "index.js": (profile.primary ?? primarySource)(), ...PRIMARY_ENV_FILES }, base("primary"));
  await writeCodebase(sdk, directories.secondary, { "index.js": secondarySource(), ...SECONDARY_ENV_FILES }, base("secondary"));
  await writeCodebase(sdk, directories.esm, { "index.js": esmSource() }, base("esm", { type: "module" }));
  await writeCodebase(sdk, directories.yaml, { "index.js": yamlSource(), "functions.yaml": STATIC_MANIFEST }, base("static-manifest"));
  await writeCodebase(sdk, directories.broken, { "index.js": brokenSource() }, base("broken-load"));
  await writeCodebase(sdk, directories.badenv, { "index.js": badEnvSource(), ...BAD_ENV_FILES }, base("invalid-dotenv"));

  const extensionDir = join(projectDir, "extensions-local", EXTENSION_INSTANCE);
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, "extension.yaml"), EXTENSION_SPEC, "utf8");
  await writeFile(join(extensionDir, "POSTINSTALL.md"), "# Synthetic\n\nInstalled.\n", "utf8");
  await writeCodebase(sdk, join(extensionDir, "functions"), { "index.js": extensionSource() }, base("extension", { engines: { node: "22" } }));
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

