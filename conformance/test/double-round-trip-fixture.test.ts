import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { compareDoubleCapture, doubleCases, verifyDoubleCapture, type DoubleCapture } from "../src/serialization/doubles.ts";

const dir = new URL("../fixtures/double-round-trip-v1/java-1.22.0/", import.meta.url);
const manifestSha256 = "0de3340c475b32ea90d2257ec24d51b6d36c5f6746d689d14888453d3181e5c2";
const jarSha256 = "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const sha = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
const capture = async (): Promise<DoubleCapture> => JSON.parse(await readFile(new URL("observations.json", dir), "utf8")) as DoubleCapture;

test("Java 1.22.0 freezes 762 doubles read back unchanged through six write and read pairs", async () => {
  const manifest = await readFile(new URL("SHA256SUMS", dir), "utf8");
  assert.equal(sha(manifest), manifestSha256);
  const lines = manifest.trim().split("\n"); assert.equal(lines.length, 2);
  const names: string[] = [];
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([a-zA-Z0-9.-]+)$/u.exec(line); assert.ok(match);
    names.push(match[2]!); assert.equal(sha(await readFile(new URL(match[2]!, dir))), match[1]);
  }
  assert.deepEqual((await readdir(dir)).sort(), [...names, "SHA256SUMS"].sort());
  const metadata = JSON.parse(await readFile(new URL("metadata.json", dir), "utf8"));
  assert.equal(metadata.javaJarSha256, jarSha256); assert.equal(metadata.version, "1.22.0");
  assert.equal(metadata.syntheticOnly, true); assert.equal(metadata.values, 762);
  assert.equal(metadata.writes, 2); assert.equal(metadata.reads, 3);
  const recorded = await capture();
  verifyDoubleCapture(recorded);
  assert.equal(doubleCases(recorded).length, 6);
});

test("a value read back a unit in the last place off is reported against its write and read", async () => {
  const recorded = await capture();
  const changed = structuredClone(recorded) as unknown as { observations: { write: string; read: string; bits: string[] }[] };
  const observation = changed.observations.find(item => item.write === "browser-set" && item.read === "grpc-get")!;
  observation.bits[0] = (BigInt(`0x${observation.bits[0]}`) - 1n).toString(16).padStart(16, "0");
  assert.deepEqual([...compareDoubleCapture(changed as unknown as DoubleCapture, recorded)], [["browser-set/grpc-get", 1]]);
  assert.throws(() => verifyDoubleCapture(changed as unknown as DoubleCapture));
});
