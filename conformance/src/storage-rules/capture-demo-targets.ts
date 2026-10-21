// Storage targets `.firebaserc` maps to no bucket: what the official
// emulator starts, which rules govern each bucket, and what it prints, for a
// demo project and a real one. Synthetic: deny-all rules, `demo-*` and a
// made-up project id, no cloud.
//
//   node --import tsx src/storage-rules/capture-demo-targets.ts --output <empty dir>
//   node --import tsx src/storage-rules/capture-demo-targets.ts --target firenook --binary <firenook> --output <empty dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = argument("--target") ?? "java";
assert.ok(target === "java" || target === "firenook", "--target is java or firenook");
const output = resolve(argument("--output") ?? fail("--output <empty directory> is required"));
await mkdir(output, { recursive: true });
assert.deepEqual(await readdir(output), [], "capture output must be empty; never overwrite recorded oracle evidence");
const conformance = fileURLToPath(new URL("../../", import.meta.url));
const host = "127.0.0.1";
const deny = "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{all=**} { allow read, write: if false; }\n  }\n}\n";
const buckets = ["demo-media-images", "demo-media.appspot.com", "anything-else"];
const mapped = { media: ["demo-media-images"] };

/** firebase.json Storage targets, the `.firebaserc` targets, and the project. */
const demoTargetCases = [
  { id: "no-firebaserc", project: "demo-media", targets: ["media"], storage: undefined },
  { id: "mapped-then-unmapped", project: "demo-media", targets: ["media", "other"], storage: mapped },
  { id: "unmapped-then-mapped", project: "demo-media", targets: ["other", "media"], storage: mapped },
  { id: "every-target-mapped", project: "demo-media", targets: ["media"], storage: mapped },
  { id: "real-project-unmapped", project: "real-media-project", targets: ["media"], storage: undefined },
] as const;

const temporary = await mkdtemp(join(tmpdir(), "firenook-storage-demo-targets-"));
try {
  const cases = [];
  for (const testCase of demoTargetCases) {
    const directory = join(temporary, testCase.id);
    await mkdir(directory);
    const [storage, hub, logging] = [await reservePort(), await reservePort(), await reservePort()];
    await writeFile(join(directory, "deny.rules"), deny);
    await writeFile(join(directory, "firebase.json"), `${JSON.stringify({
      storage: testCase.targets.map((name) => ({ target: name, rules: "deny.rules" })),
      emulators: { storage: { host, port: storage }, hub: { host, port: hub }, logging: { host, port: logging }, ui: { enabled: false }, singleProjectMode: true },
    }, null, 2)}\n`);
    if (testCase.storage) {
      await writeFile(join(directory, ".firebaserc"), `${JSON.stringify({ projects: { default: testCase.project }, targets: { [testCase.project]: { storage: testCase.storage } } }, null, 2)}\n`);
    }
    const observed = target === "java" ? await official(directory, testCase.project, storage) : await firenook(directory, testCase.project, storage);
    cases.push({ id: testCase.id, project: testCase.project, targets: testCase.targets, firebaserc: testCase.storage ?? null, ...observed });
    console.log(`${testCase.id}: started ${String(observed.started)} ${JSON.stringify(observed.uploads)}`);
  }
  const record = {
    schemaVersion: 1,
    syntheticOnly: true,
    capturedAt: new Date().toISOString(),
    captureSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
    oracle: target === "java"
      ? { target, firebaseTools: JSON.parse(await readFile(join(conformance, "node_modules/firebase-tools/package.json"), "utf8")).version as string, node: process.version }
      : { target, node: process.version },
    rules: deny,
    cases,
  };
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(join(output, "fixture.json"), bytes);
  await writeFile(join(output, "SHA256SUMS"), `${createHash("sha256").update(bytes).digest("hex")}  fixture.json\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

/** Uploads a small object to each bucket, as an unauthenticated client. */
async function uploads(port: number): Promise<Record<string, number>> {
  const statuses: Record<string, number> = {};
  for (const bucket of buckets) {
    const response = await fetch(`http://${host}:${port}/v0/b/${bucket}/o?name=probe.txt`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "hello", signal: AbortSignal.timeout(10_000),
    });
    await response.arrayBuffer();
    statuses[bucket] = response.status;
  }
  return statuses;
}

async function official(directory: string, project: string, port: number) {
  const firebase = join(conformance, "node_modules/.bin", process.platform === "win32" ? "firebase.cmd" : "firebase");
  const probe = join(directory, "probe.mjs");
  await writeFile(probe, `const statuses = {};\nfor (const bucket of ${JSON.stringify(buckets)}) {\n  const response = await fetch(\`http://${host}:${port}/v0/b/\${bucket}/o?name=probe.txt\`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });\n  statuses[bucket] = response.status;\n}\nconsole.log("UPLOADS " + JSON.stringify(statuses));\n`);
  const child = spawn(firebase, ["emulators:exec", "--non-interactive", "--only", "storage", "--project", project, "--config", join(directory, "firebase.json"), `node ${JSON.stringify(probe)}`], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => { text += data.toString(); });
  const [code] = await once(child, "exit") as [number | null];
  const lines = text.split("\n");
  const started = lines.some((line) => line.startsWith("UPLOADS "));
  return {
    started,
    exitCode: code,
    notices: lines.flatMap((line) => /^i {2}storage: (.*Detected demo project ID.*)$/.exec(line)?.[1] ?? []),
    error: started ? null : text.slice(text.indexOf("Error: ")).trim(),
    uploads: started ? JSON.parse(lines.find((line) => line.startsWith("UPLOADS "))!.slice("UPLOADS ".length)) as Record<string, number> : null,
  };
}

async function firenook(directory: string, project: string, port: number) {
  const binary = resolve(argument("--binary") ?? fail("--binary is required for firenook"));
  const child = spawn(binary, ["suite", "--project-id", project, "--node", process.execPath, "--state-dir", join(directory, "state"), "--only", "storage", "--no-ui", "--project-dir", directory], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  const ready = new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), 60_000);
    const look = (data: Buffer) => { text += data.toString(); if (text.includes("All emulators ready")) { clearTimeout(timer); done(true); } };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.once("exit", () => { clearTimeout(timer); done(false); });
  });
  const started = await ready;
  const statuses = started ? await uploads(port) : null;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    await once(child, "exit");
  }
  const lines = text.split("\n");
  return {
    started,
    exitCode: child.exitCode,
    notices: lines.flatMap((line) => /^firenook storage: (.*Detected demo project ID.*)$/.exec(line)?.[1] ?? []),
    error: started ? null : text.slice(Math.max(0, text.indexOf("Deploy target"))).trim(),
    uploads: statuses,
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, host, done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  throw new Error(message);
}
