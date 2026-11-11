import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { queryRulesProject } from "../src/rules/query-rules-cases.ts";
import { compareNativeCapture, verifyBrowserCapture, type BrowserCapture, type NativeCapture } from "../src/rules/query-rules-verification.ts";
import * as ledger from "../src/report/ledger.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

// The conformance ledger counts the 1.22.0 recording (cases.mjs); this replay
// compares with the 1.21.0 one. A case is noted only where the two record the
// same compared values. Ids are numbered as cases.mjs numbers them.
const LEDGER_SET = "rules-v2/official-emulator";
type Semantic = { code: number | string; documents?: string[]; count?: string };
const sortedSet = (values: readonly string[] | undefined) => [...new Set(values ?? [])].sort();
const sameSemantic = (left: Semantic, right: Semantic) =>
  left.code === right.code && JSON.stringify(sortedSet(left.documents)) === JSON.stringify(sortedSet(right.documents)) && left.count === right.count;
const recordedIds = () => {
  const used = new Map<string, number>();
  return (id: string) => {
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  };
};
async function ledgerNative(corpus: string, oracle: NativeCapture): Promise<ReturnType<typeof recordedIds>> {
  const unique = recordedIds();
  const counted = JSON.parse(await readFile(new URL(`../fixtures/rules-v2/${corpus}/java-1.22.0/grpc.json`, import.meta.url), "utf8")) as NativeCapture;
  for (const [index, observation] of counted.observations.entries()) {
    const id = unique(`${corpus}/${observation.id}/grpc/${observation.operation}`);
    const compared = oracle.observations[index];
    if (!compared || compared.id !== observation.id || compared.operation !== observation.operation || !sameSemantic(observation, compared)) continue;
    // Codes, documents and counts; a denial's wording is not compared.
    ledger.checked(LEDGER_SET, id, observation.code === 0 ? ledger.COMPARED.answer : ledger.COMPARED.status);
  }
  return unique;
}
async function ledgerBrowser(corpus: string, variant: string, oracle: NativeCapture, unique: ReturnType<typeof recordedIds>): Promise<void> {
  const counted = JSON.parse(await readFile(new URL(`../fixtures/rules-v2/${corpus}/java-1.22.0/${variant}-browser.json`, import.meta.url), "utf8")) as BrowserCapture;
  for (const observation of counted.observations) {
    const id = unique(`${corpus}/${observation.id}/${variant}/${observation.operation}`);
    const result = observation.result;
    if (observation.operation === "ListenChanges") {
      // The snapshots and changes verifyBrowserCapture asserts.
      const changes = result.snapshots?.flatMap((snapshot) => snapshot.changes.map(({ type, data }) => [type, data.updatedAt]));
      if (result.code === 0 && JSON.stringify(result.snapshots?.map((snapshot) => snapshot.documents)) === JSON.stringify([[owned], [owned], []]) &&
        JSON.stringify(changes) === JSON.stringify([["added", 2], ["modified", 3], ["removed", 3]])) {
        ledger.checked(LEDGER_SET, id, ledger.COMPARED.answer);
      }
      continue;
    }
    const native = oracle.observations.find((value) => value.id === observation.id && value.operation === observation.operation);
    if (!native) continue;
    const code = native.code === 0 ? 0 : "permission-denied";
    if (result.code !== code) continue;
    if (code === 0 && observation.operation === "Listen" && JSON.stringify(sortedSet(result.documents)) !== JSON.stringify(sortedSet(native.documents))) continue;
    if (code === 0 && observation.operation === "RunAggregationQuery" && result.count !== native.count) continue;
    ledger.checked(LEDGER_SET, id, code === 0 ? ledger.COMPARED.answer : ledger.COMPARED.status);
  }
}
const owned = `projects/${queryRulesProject}/databases/(default)/documents/records/owned`;

test("query authorization matches native and real browser oracles in memory and disk/WAL", { timeout: 600_000 }, async (context) => {
  await execute("cargo", ["build", "--locked", "-p", "firenook"], { cwd: root });
  const metadata = JSON.parse((await execute("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: root })).stdout) as { target_directory: string };
  const scenarios = ([["constraints", "query-authorization"], ["paths", "query-paths"]] as const)
    .flatMap(([caseSet, corpus]) => ["memory", "disk-wal"].map(mode => ({ caseSet, corpus, mode })));
  for (const { caseSet, corpus, mode } of scenarios) {
    const fixture = new URL(`../fixtures/rules-v2/${corpus}/java-1.21.0/`, import.meta.url);
    const expected = JSON.parse(await readFile(new URL("grpc.json", fixture), "utf8")) as NativeCapture;
    const output = await mkdtemp(join(tmpdir(), `firenook-query-replay-${caseSet}-${mode}-`));
    context.diagnostic(`${caseSet} ${mode} evidence: ${output}`);
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    await new Promise<void>((done) => reservation.close(() => done()));
    const origin = `http://127.0.0.1:${address.port}`;
    const binary = join(metadata.target_directory, "debug/firenook");
    const args = ["--host", "127.0.0.1", "--port", String(address.port), "--project_id", queryRulesProject, "--single_project_mode", "true", "--rules", fileURLToPath(new URL("firestore.rules", fixture))];
    if (mode === "disk-wal") args.push("--data-dir", join(output, "database"));
    const server = spawn(binary, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(server, "exit");
    const log: string[] = [];
    server.stdout.on("data", (data: Buffer) => log.push(data.toString()));
    server.stderr.on("data", (data: Buffer) => log.push(data.toString()));
    try {
      const deadline = Date.now() + 30_000;
      while (true) {
        assert.equal(server.exitCode, null, log.join(""));
        try { await fetch(origin, { signal: AbortSignal.timeout(500) }); break; } catch { /* Startup only. */ }
        assert.ok(Date.now() < deadline, log.join(""));
        await new Promise((done) => setTimeout(done, 50));
      }
      await execute(process.execPath, ["--import", "tsx", "src/rules/capture-query-rules.ts", "--case-set", caseSet, "--origin", origin, "--output", join(output, "capture")], { cwd: join(root, "conformance"), env: { ...process.env, FIRENOOK_CAPTURE_BINARY: binary }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
      const actual = JSON.parse(await readFile(join(output, "capture/grpc.json"), "utf8")) as NativeCapture;
      compareNativeCapture(actual, expected);
      const unique = await ledgerNative(corpus, expected);
      for (const variant of ["long-poll", "streaming"]) {
        verifyBrowserCapture(JSON.parse(await readFile(join(output, `capture/${variant}-browser.json`), "utf8")) as BrowserCapture, expected);
        await ledgerBrowser(corpus, variant, expected, unique);
      }
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
        server.kill("SIGTERM");
        await exited;
        clearTimeout(timer);
      }
      await writeFile(join(output, "server.log"), log.join(""));
    }
  }
});
