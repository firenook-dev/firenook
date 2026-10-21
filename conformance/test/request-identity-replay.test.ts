import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { compareIdentityCapture, type IdentityCapture } from "../src/rules/request-identity-verification.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("Firenook reads every Authorization header as the official emulator does", { timeout: 600_000 }, async (context) => {
  await execute("cargo", ["build", "--locked", "-p", "firenook"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const metadata = JSON.parse((await execute("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout) as { target_directory: string };
  const output = join(await mkdtemp(join(tmpdir(), "firenook-request-identity-replay-")), "capture");
  context.diagnostic(`evidence: ${output}`);
  await execute(process.execPath, ["--import", "tsx", "src/rules/capture-request-identity.ts", "--target", "firenook", "--binary", join(metadata.target_directory, "debug/firenook"), "--output", output], { cwd: join(root, "conformance"), timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const expected = JSON.parse(await readFile(new URL("../fixtures/request-identity-v1/fixture.json", import.meta.url), "utf8")) as IdentityCapture;
  const actual = JSON.parse(await readFile(join(output, "fixture.json"), "utf8")) as IdentityCapture;
  assert.deepEqual(compareIdentityCapture(actual, expected), []);
});
