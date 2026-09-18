#!/usr/bin/env node
// Keeps this repository independent of any consumer, host or private
// repository. Two layers:
//   1. built-in patterns that never belong in public source: personal machine
//      paths, private server paths and credentials (host addresses belong in the
//      private term list);
//   2. a private term list (`forbiddenTerms`, the same policy shape
//      `packaging/public-artifacts.mjs` scans packages with), loaded from the
//      file named by FIRESIDE_PUBLIC_POLICY or ~/.config/fireside/public-policy.json
//      when present. The terms themselves are never printed: a hit names the
//      file, line and term index only.
// Scans every tracked file and, with `--commits <range>`, the commit messages
// in that range. Exit 1 when anything matches. `--summary` prints counts only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUILT_IN = [
  [/\/Users\/[a-z][a-z0-9._-]*\//, "personal macOS home path"],
  [/\/home\/(?!runner\/)[a-z][a-z0-9._-]*\//, "personal Linux home path"],
  [/\/srv\/[a-z]/, "private server path"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/, "Google OAuth token"],
  [/\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/, "live Stripe key"],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/, "GitHub token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "private key"],
];
// Tracked files that legitimately contain a built-in marker, with the reason.
const ALLOWED = new Map([
  ["scripts/check-independence.mjs", "defines the patterns"],
  ["packaging/public-artifacts.test.mjs", "tests the package scanner with synthetic markers"],
]);

const args = process.argv.slice(2);
const commitRange = args.includes("--commits") ? args[args.indexOf("--commits") + 1] : null;
const summaryOnly = args.includes("--summary");

const policyPath = process.env.FIRESIDE_PUBLIC_POLICY ?? join(homedir(), ".config", "fireside", "public-policy.json");
let terms = [];
if (existsSync(policyPath)) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  terms = (policy.forbiddenTerms ?? []).map((term, index) => [new RegExp(escape(term), "i"), `private term #${index + 1}`]);
}
const patterns = [...BUILT_IN, ...terms];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const hits = [];
for (const file of files) {
  if (ALLOWED.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const [pattern, label] of patterns) {
      if (pattern.test(line)) {
        hits.push(`${file}:${index + 1}: ${label}`);
        break;
      }
    }
  }
}
if (commitRange) {
  const log = execFileSync("git", ["log", "--format=%H%x00%B%x01", commitRange], { encoding: "utf8" });
  for (const entry of log.split("\x01").filter((e) => e.trim())) {
    const [sha, body = ""] = entry.split("\0");
    for (const [pattern, label] of patterns) {
      if (pattern.test(body)) hits.push(`commit ${sha.trim().slice(0, 12)}: ${label} in the commit message`);
    }
  }
}
const scope = `${files.length} tracked files, ${BUILT_IN.length} built-in patterns, ${terms.length} private terms${commitRange ? `, commits ${commitRange}` : ""}`;
if (hits.length > 0) {
  console.error(`check-independence: ${hits.length} hit(s) (${scope})` + (summaryOnly ? "" : "\n" + hits.join("\n")));
  process.exit(1);
}
console.log(`check-independence: clean (${scope})`);

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
