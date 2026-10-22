// Runs `@firebase/rules-unit-testing` against Firestore and Storage: the
// handwritten `test/rules-unit-testing.test.ts` and the console's exported
// test files in `fixtures/rules-unit-testing-v1`, under `node --test`.
//
//   node --import tsx src/rules/run-rules-unit-testing.ts --target firenook
//   node --import tsx src/rules/run-rules-unit-testing.ts --target java
//
// `firenook` builds the engine (or takes `--binary <firenook>`) and starts
// its suite with the fixture's rules; `java` runs the same files under the
// official CLI's `emulators:exec`.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const target = argument("--target") ?? "firenook";
assert.ok(target === "firenook" || target === "java", "--target is firenook or java");
const project = "demo-firenook-rules-testing";
const host = "127.0.0.1";
const conformance = fileURLToPath(new URL("../../", import.meta.url));
const root = join(conformance, "..");
const fixture = join(conformance, "fixtures/rules-unit-testing-v1");
const files = ["../../test/rules-unit-testing.test.ts", "console-firestore.test.ts", "console-storage.test.ts"];
const temporary = await mkdtemp(join(tmpdir(), "firenook-rules-unit-testing-"));
const children: ChildProcess[] = [];

try {
  const [firestore, websocket, storage, hub, logging] = await Promise.all([reservePort(), reservePort(), reservePort(), reservePort(), reservePort()]);
  await writeFile(join(temporary, "firebase.json"), `${JSON.stringify({
    firestore: { rules: join(fixture, "firestore.rules") },
    storage: { rules: join(fixture, "storage.rules") },
    emulators: {
      firestore: { host, port: firestore, websocketPort: websocket },
      storage: { host, port: storage },
      hub: { host, port: hub },
      logging: { host, port: logging },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  }, null, 2)}\n`);
  const node = [process.execPath, "--import", "tsx", "--import", "../../src/rules/vitest-as-node-test.mjs", "--test", "--test-concurrency=1", "--test-timeout=120000", ...files];
  if (target === "firenook") {
    const binary = argument("--binary");
    if (binary === undefined) await run("cargo", ["build", "--quiet", "--locked", "-p", "firenook"], { cwd: root });
    const suite = spawn(binary ?? join(root, "target/debug", process.platform === "win32" ? "firenook.exe" : "firenook"), [
      "suite", "--project-id", project, "--node", process.execPath, "--state-dir", join(temporary, "state"),
      "--only", "firestore,storage", "--no-ui", "--project-dir", temporary,
    ], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
    children.push(suite);
    const log: string[] = [];
    suite.stderr.on("data", (data: Buffer) => log.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the suite did not start: ${log.join("")}`)), 60_000);
      suite.stdout.on("data", (data: Buffer) => {
        log.push(data.toString());
        if (log.join("").includes("All emulators ready")) { clearTimeout(timer); resolve(); }
      });
      suite.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the suite exited with ${String(code)}: ${log.join("")}`)); });
    });
    await run(node[0]!, node.slice(1), {
      cwd: fixture,
      env: {
        ...process.env,
        GCLOUD_PROJECT: project,
        FIRESTORE_EMULATOR_HOST: `${host}:${firestore}`,
        FIREBASE_STORAGE_EMULATOR_HOST: `${host}:${storage}`,
        FIREBASE_EMULATOR_HUB: `${host}:${hub}`,
      },
    });
  } else {
    const firebase = join(conformance, "node_modules/.bin", process.platform === "win32" ? "firebase.cmd" : "firebase");
    await run(firebase, [
      "emulators:exec", "--non-interactive", "--only", "firestore,storage", "--project", project,
      "--config", join(temporary, "firebase.json"), node.map((part) => JSON.stringify(part)).join(" "),
    ], { cwd: fixture, env: { ...process.env, GCLOUD_PROJECT: project } });
  }
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(timer);
    }
  }
  await rm(temporary, { recursive: true, force: true });
}

async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: "inherit" });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`${command} exited with code ${String(code)} and signal ${String(signal)}`);
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
