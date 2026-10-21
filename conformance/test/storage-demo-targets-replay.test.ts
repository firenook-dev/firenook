import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

type Case = { id: string; started: boolean; exitCode: number | null; notices: string[]; error: string | null; uploads: Record<string, number> | null };
const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = new URL("../fixtures/storage-demo-targets-v1/", import.meta.url);

test("Storage targets without buckets start, rule and print as on the official emulator", { timeout: 600_000 }, async (context) => {
  const bytes = await readFile(new URL("fixture.json", fixture));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), (await readFile(new URL("SHA256SUMS", fixture), "utf8")).split(" ")[0]);
  const expected = JSON.parse(bytes.toString("utf8")) as { oracle: { target: string }; cases: Case[] };
  assert.equal(expected.oracle.target, "java");
  await execute("cargo", ["build", "--locked", "-p", "firenook"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const metadata = JSON.parse((await execute("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout) as { target_directory: string };
  const output = join(await mkdtemp(join(tmpdir(), "firenook-storage-demo-targets-replay-")), "capture");
  context.diagnostic(`evidence: ${output}`);
  await execute(process.execPath, ["--import", "tsx", "src/storage-rules/capture-demo-targets.ts", "--target", "firenook", "--binary", join(metadata.target_directory, "debug/firenook"), "--output", output], { cwd: join(root, "conformance"), timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const actual = JSON.parse(await readFile(join(output, "fixture.json"), "utf8")) as { cases: Case[] };
  assert.deepEqual(actual.cases.map(({ id }) => id), expected.cases.map(({ id }) => id));
  for (const [index, want] of expected.cases.entries()) {
    const got = actual.cases[index]!;
    assert.equal(got.started, want.started, want.id);
    assert.equal(got.exitCode === 0, want.exitCode === 0, `${want.id} exit code`);
    assert.deepEqual(got.notices, want.notices, `${want.id} notices`);
    assert.deepEqual(got.uploads, want.uploads, `${want.id} uploads`);
    if (want.error !== null) {
      // The official requireTarget error, naming this CLI's command and its
      // --storage-bucket flag; the jar's CLI prints it after "Error: ".
      const target = /Deploy target (\S+) /.exec(want.error)![1];
      assert.equal(got.error, `${want.error.replace(/^Error: /, "").replace("firebase target:apply", "firenook target:apply")}\n\nor pass --storage-bucket ${target}=<bucket>.`, want.id);
    }
  }
});
