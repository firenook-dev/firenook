#!/usr/bin/env node
// Keeps this repository independent of any consumer, host or private
// repository, and free of its former name. Three layers:
//   1. built-in patterns that never belong in public source: personal machine
//      paths, private server paths and credentials (host addresses belong in the
//      private term list);
//   2. the former project name (the project was published as "Firenook" up to
//      0.1.0-next.9). Frozen corpora, banked results and release history keep
//      the recorded identifiers and the names they were sealed with; every
//      other occurrence is a straggler. The retained places are listed below
//      with their reasons;
//   3. a private term list (`forbiddenTerms`, the same policy shape
//      `packaging/public-artifacts.mjs` scans packages with), loaded from the
//      file named by FIRENOOK_PUBLIC_POLICY or ~/.config/firenook/public-policy.json
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

const FORMER_NAME = [/fireside/i, "former project name"];
// Sealed artifacts keep the name they were recorded and digest-pinned with.
const FORMER_NAME_SEALED = [
  [/^conformance\/fixtures\//, "frozen oracle corpora, digest-pinned by the gates"],
  [/^benchmarks\/results\//, "banked runs with SHA256SUMS"],
  [/^packaging\/CHANGELOG\.md$/, "release history of the versions published under the former name"],
  [/^packaging\/SOURCE-HISTORY\.md$/, "dated maintenance record"],
  [/^packaging\/recoveries\//, "recovery receipts of published releases"],
  [/^benchmarks\/phase-(?:2-webchannel|3-rules|a-developer-tools|b-diagnostics-overhead|e-equivalent-queries|e-native-baseline-repeat|e-storage-profile)\.json$/, "frozen gate manifests whose digests later gates, banked receipts and the harness pin"],
];
// Identifiers the frozen corpora were recorded with (project ids, buckets,
// collections, field names, generator seeds, the recording host's CI path):
// the harness and the gates must keep naming them exactly.
const RECORDED_IDENTIFIERS = [
  /demo-fireside-[A-Za-z0-9_-]*/g,
  /fireside-(?:conformance|auth-oracle|pubsub-oracle|pubsub-other|phase-g-boundary|webchannel-capture(?:-reader)?|synthetic-(?:nonce|unknown-sid)|phase3-rules-java-[A-Za-z0-9]+|phase4-storage-oracle-[A-Za-z0-9]+|phase-(?:[0-9]+|g)-[a-z0-9-]+-v1)/g,
  /fireside_(?:export_fixture|phase2_browser_demo|webchannel_(?:bundle_)?capture[a-z_]*)/g,
  /fireside-export-🔥/g,
  /fireside-owned-admission-with-official-peers/g,
  /_fireside_expires_at/g,
  /dev\.fireside\.synthetic/g,
  /\/home\/runner\/work\/fireside\/fireside\//g,
];
// Tokens that name published history and may appear only where that history is recorded.
const FORMER_PACKAGES = /@fireside-dev\/[a-z0-9-]*(?:@[0-9A-Za-z.-]+)?|fireside-dev-(?:cli|darwin|linux|win32)-[A-Za-z0-9.-]*\.tgz/g;
const FORMER_PACKAGES_ALLOWED = [
  [/^README\.md$/, "the migration note from the former package"],
  [/^packages\/cli\/README\.md$/, "names the former package the migration note refers to"],
  [/^benchmarks\/phase-.*\.json$/, "publication receipts of the former releases"],
  [/^packaging\/fixtures\/npm-publication-readiness\.json$/, "recorded readiness contract of the first publication"],
];
// Paragraphs that explain the rename (from their first line to the next blank line).
const FORMER_NAME_PARAGRAPHS = [
  [/^README\.md$/, /^Firenook \(formerly Fireside\)/, "the rename and migration note"],
  [/^AGENTS\.md$/, /^The same script fails on the project's former name/, "the rule itself"],
];
// Single lines that mention the former name on purpose.
const FORMER_NAME_LINES = [
  [/^crates\/core-store\/src\/disk\.rs$/, /LEGACY_(?:DATABASE|JOURNAL)_FILE: &str = "fireside\./, "adopts store files written before the rename"],
  [/^conformance\/test\/phase2-gate-plan\.test\.ts$/, /const sealedScriptName = \/\\btest:fireside\\b\/gu;/, "maps the sealed Phase 2 manifest's script names onto the renamed scripts"],
  [/^\.github\/workflows\/ci\.yml$/, /@fireside-dev\/linux-x64(?:@0\.1\.0-next\.3|\/bin\/fireside")/, "the previously published engine the native-upgrade check resumes from"],
];

function formerNameHit(file, line, inParagraph) {
  if (FORMER_NAME_SEALED.some(([re]) => re.test(file))) return null;
  if (inParagraph) return null;
  let text = line;
  for (const re of RECORDED_IDENTIFIERS) text = text.replace(re, "");
  if (FORMER_PACKAGES_ALLOWED.some(([re]) => re.test(file))) text = text.replace(FORMER_PACKAGES, "");
  if (FORMER_NAME_LINES.some(([fileRe, lineRe]) => fileRe.test(file) && lineRe.test(line))) return null;
  return FORMER_NAME[0].test(text) ? FORMER_NAME[1] : null;
}

const args = process.argv.slice(2);
const commitRange = args.includes("--commits") ? args[args.indexOf("--commits") + 1] : null;
const summaryOnly = args.includes("--summary");

const policyPath = process.env.FIRENOOK_PUBLIC_POLICY ?? join(homedir(), ".config", "firenook", "public-policy.json");
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
  let inParagraph = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") inParagraph = false;
    else if (FORMER_NAME_PARAGRAPHS.some(([fileRe, startRe]) => fileRe.test(file) && startRe.test(line))) inParagraph = true;
    let matched = false;
    for (const [pattern, label] of patterns) {
      if (pattern.test(line)) {
        hits.push(`${file}:${index + 1}: ${label}`);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const former = formerNameHit(file, line, inParagraph);
    if (former) hits.push(`${file}:${index + 1}: ${former}`);
  }
}
if (commitRange) {
  const log = execFileSync("git", ["log", "--format=%H%x00%B%x01", commitRange], { encoding: "utf8" });
  for (const entry of log.split("\x01").filter((e) => e.trim())) {
    const [sha, body = ""] = entry.split("\0");
    // Commit messages may name the former project name (the rename itself does);
    // only private terms and credentials are refused there.
    for (const [pattern, label] of patterns) {
      if (pattern.test(body)) hits.push(`commit ${sha.trim().slice(0, 12)}: ${label} in the commit message`);
    }
  }
}
const scope = `${files.length} tracked files, ${BUILT_IN.length} built-in patterns, the former name, ${terms.length} private terms${commitRange ? `, commits ${commitRange}` : ""}`;
if (hits.length > 0) {
  console.error(`check-independence: ${hits.length} hit(s) (${scope})` + (summaryOnly ? "" : "\n" + hits.join("\n")));
  process.exit(1);
}
console.log(`check-independence: clean (${scope})`);

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
