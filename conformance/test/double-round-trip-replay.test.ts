import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { compareDoubleCapture, doubleCases, doublesProject, type DoubleCapture } from "../src/serialization/doubles.ts";
import * as ledger from "../src/report/ledger.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("doubles written over REST and WebChannel read back with the oracle's bits in memory and disk/WAL", { timeout: 240_000 }, async context => {
  await execute("cargo", ["build", "--locked", "-p", "firenook"], { cwd: root });
  const metadata = JSON.parse((await execute("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: root })).stdout) as { target_directory: string };
  const expected = JSON.parse(await readFile(new URL("../fixtures/double-round-trip-v1/java-1.22.0/observations.json", import.meta.url), "utf8")) as DoubleCapture;
  for (const mode of ["memory", "disk-wal"]) {
    const output = await mkdtemp(join(tmpdir(), `firenook-double-replay-${mode}-`));
    context.diagnostic(`${mode} evidence: ${output}`);
    const reservation = createServer();
    await new Promise<void>(done => reservation.listen(0, "127.0.0.1", done));
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    await new Promise<void>(done => reservation.close(() => done()));
    const args = ["--host", "127.0.0.1", "--port", String(address.port), "--project_id", doublesProject];
    if (mode === "disk-wal") args.push("--data-dir", join(output, "database"));
    const server = spawn(join(metadata.target_directory, "debug/firenook"), args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(server, "exit");
    let logs = ""; server.stdout.on("data", data => { logs += String(data); }); server.stderr.on("data", data => { logs += String(data); });
    try {
      await execute(process.execPath, ["--import", "tsx", "src/serialization/capture-doubles.ts", "--origin", `http://127.0.0.1:${address.port}`, "--output", join(output, "capture")], { cwd: join(root, "conformance"), timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
      const actual = JSON.parse(await readFile(join(output, "capture/observations.json"), "utf8")) as DoubleCapture;
      const changed = compareDoubleCapture(actual, expected);
      assert.equal(changed.size, 0, `of ${expected.values.length} doubles, read back changed: ${[...changed].map(([pair, count]) => `${pair} ${count}`).join(", ")}`);
      // Every value's bits, through each write and read.
      for (const pair of doubleCases(expected)) ledger.checked("double-round-trip-v1", pair, ledger.COMPARED.answer);
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const timer = setTimeout(() => server.kill("SIGKILL"), 5_000);
        server.kill("SIGTERM"); await exited; clearTimeout(timer);
      }
      await writeFile(join(output, "server.log"), logs);
    }
  }
});
