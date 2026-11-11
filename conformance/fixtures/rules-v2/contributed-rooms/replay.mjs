// Records the cases in cases.json against the official Java emulator, or
// replays them against any running Firestore emulator and compares verdicts.
//
//   node replay.mjs --record --jar <cloud-firestore-emulator.jar> --firebase-tools <version>
//   node replay.mjs --origin http://127.0.0.1:8080
//
// The cases run in order against one seed: some of them write, and later
// cases see those writes, exactly as in the run that recorded them.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";

const directory = new URL("./", import.meta.url);
const casesUrl = new URL("cases.json", directory);
const rulesSource = await readFile(new URL("firestore.rules", directory), "utf8");
const fixture = JSON.parse(await readFile(casesUrl, "utf8"));
const projectId = fixture.projectId;
const documents = `projects/${projectId}/databases/(default)/documents`;

const record = process.argv.includes("--record");
let child;
try {
  let origin = argument("--origin");
  let jarSha256;
  if (record) {
    const jar = required("--jar");
    jarSha256 = sha256(await readFile(jar));
    const port = await freePort();
    origin = `http://127.0.0.1:${String(port)}`;
    child = spawn(process.env.JAVA ?? "java", [
      "-jar", jar, "--host", "127.0.0.1", "--port", String(port),
      "--project_id", projectId, "--single_project_mode", "true",
    ], { stdio: "ignore" });
    await waitForReady(origin);
  } else if (origin === undefined) {
    throw new Error("pass --origin <url> or --record --jar <path>");
  }

  await loadRules(origin);
  await send(origin, "DELETE", `/emulator/v1/projects/${projectId}/databases/(default)/documents`);
  await seed(origin);

  const observations = [];
  for (const testCase of fixture.cases) {
    const { status, body } = await run(origin, testCase);
    observations.push({ id: testCase.id, status, body });
  }

  const mismatches = fixture.cases
    .map((testCase, index) => ({ testCase, observed: observations[index] }))
    .filter(({ testCase, observed }) => verdict(observed.status) !== testCase.expected)
    .map(({ testCase, observed }) => ({
      id: testCase.id,
      expected: testCase.expected,
      status: observed.status,
      message: observed.body?.error?.message ?? observed.body?.[0]?.error?.message,
    }));

  if (record) {
    if (mismatches.length > 0) {
      throw new Error(`official emulator disagrees: ${JSON.stringify(mismatches, null, 2)}`);
    }
    const recorded = {
      schemaVersion: fixture.schemaVersion,
      target: "official-java-emulator",
      firebaseToolsVersion: required("--firebase-tools"),
      javaJarSha256: jarSha256,
      capturedAt: new Date().toISOString(),
      credentialsStored: false,
      rulesSourceSha256: sha256(rulesSource),
      projectId,
      allowCases: fixture.cases.filter(({ expected }) => expected === "ALLOW").length,
      denyCases: fixture.cases.filter(({ expected }) => expected === "DENY").length,
      seed: fixture.seed,
      cases: fixture.cases.map(({ observed: _previous, ...testCase }, index) => ({
        ...testCase,
        observed: { status: observations[index].status, body: observations[index].body },
      })),
    };
    await writeFile(casesUrl, `${JSON.stringify(recorded, null, 2)}\n`, "utf8");
    console.log(`recorded ${String(observations.length)} cases`);
  } else {
    const changedStatus = fixture.cases.filter(
      (testCase, index) =>
        testCase.observed !== undefined && testCase.observed.status !== observations[index].status,
    ).length;
    console.log(JSON.stringify({
      cases: observations.length,
      verdictMismatches: mismatches,
      statusDifferences: changedStatus,
    }, null, 2));
    if (mismatches.length > 0) process.exitCode = 1;
  }
} finally {
  child?.kill();
}

async function run(origin, { auth, request }) {
  const body = request.body === undefined ? undefined : expand(request.body);
  return await send(
    origin,
    request.method,
    `/v1/projects/${projectId}/databases/(default)/${request.path}`,
    body,
    auth === null ? undefined : token(auth),
  );
}

async function seed(origin) {
  const writes = fixture.seed.map(({ path, fields }) => ({
    update: { name: `${documents}/${path}`, fields },
  }));
  const { status, body } = await send(
    origin, "POST", `/v1/projects/${projectId}/databases/(default)/documents:commit`, { writes }, "owner",
  );
  if (status !== 200) throw new Error(`seed failed: ${String(status)} ${JSON.stringify(body)}`);
}

async function loadRules(origin) {
  const { status, body } = await send(origin, "PUT", `/emulator/v1/projects/${projectId}:securityRules`, {
    rules: { files: [{ name: "firestore.rules", content: rulesSource }] },
  });
  if (status !== 200) throw new Error(`rules rejected: ${String(status)} ${JSON.stringify(body)}`);
}

async function send(origin, method, path, body, bearer) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : text;
  } catch {
    // Keep the raw body.
  }
  return { status: response.status, body: parsed };
}

function verdict(status) {
  return status >= 200 && status < 300 ? "ALLOW" : "DENY";
}

function expand(value) {
  return JSON.parse(JSON.stringify(value).replaceAll("{documents}", documents));
}

function token({ uid, claims }) {
  const now = Math.floor(Date.now() / 1000) - 60;
  const payload = {
    aud: projectId,
    auth_time: now,
    exp: now + 3600,
    firebase: { sign_in_provider: "custom" },
    iat: now,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: uid,
    user_id: uid,
    ...claims,
  };
  return `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url(payload)}.`;
}

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = argument(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(origin) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(origin);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("emulator did not start within 30 s");
}
