#!/usr/bin/env node
// Firenook Functions worker: one Node process per codebase. The Rust runtime
// starts it with the codebase's environment, forwards every invocation over
// loopback HTTP with `x-firenook-target`, `x-firenook-signature`,
// `x-firenook-service`, `x-firenook-execution` and `x-firenook-function`
// control headers, and reads this process's stdout for the readiness line
// and for log lines. Every `x-firenook-*` header is removed before user code
// runs.
//
// Each invocation runs inside an AsyncLocalStorage context, and the console
// methods are replaced before the user module loads: a call made inside an
// invocation is written as one FIRENOOK_WORKER_LOG record carrying the
// invocation id, the function, the call's true level and the stream Node
// would have written it to; outside an invocation the original methods run
// untouched. Just before an invocation answers, one FIRENOOK_WORKER_ANSWERED
// line follows its records on stdout: the answer travels on the connection,
// so the runtime holds the call's end line until that line is read.
//
// The request handling mirrors firebase-tools 15.22.0
// `functionsEmulatorRuntime.js` (Express with `trust proxy`, JSON / text /
// urlencoded / raw body parsing with a 32 MB limit and `rawBody`, `http`,
// `event` and `cloudevent` signatures) so the firebase-functions SDK observes
// the same request objects. Express and body-parser are resolved from the
// codebase's own firebase-functions dependency tree; nothing is bundled.
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import util from "node:util";

const sourceDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const codebase = process.argv[3] ?? "default";
const require = createRequire(path.join(sourceDir, "package.json"));
// Every header with this prefix is the runtime's, never the handler's.
const CONTROL_PREFIX = "x-firenook-";
const BODY_LIMIT = "32mb";

let functionModule;
let ready = false;

// The runtime stops its workers when it stops. A runtime killed outright
// (SIGKILL, a crash) cannot, so a worker whose parent is gone ends itself
// rather than idling on forever.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) process.exit(0);
}, 1000).unref();

// The invocation the current code runs for: { execution, function }.
const invocation = new AsyncLocalStorage();

function record(fields) {
  process.stdout.write(`FIRENOOK_WORKER_LOG ${JSON.stringify({ ...fields, time: Date.now() })}\n`);
}

function log(level, message, extra = {}) {
  record({ level, message: String(message), ...extra });
}

// The answered line, written once as the response starts to end, before
// any of its last bytes reach the connection.
function announceAnswer(response, execution) {
  const original = response.end;
  let announced = false;
  response.end = function endAfterAnnouncing(...args) {
    if (!announced) {
      announced = true;
      process.stdout.write(`FIRENOOK_WORKER_ANSWERED ${JSON.stringify({ execution })}\n`);
    }
    return original.apply(this, args);
  };
}

// console.* inside an invocation: one attributed record per call, with the
// true level and the stream the call would have used.
const CONSOLE_METHODS = {
  log: ["INFO", "stdout"],
  info: ["INFO", "stdout"],
  debug: ["DEBUG", "stdout"],
  warn: ["WARN", "stderr"],
  error: ["ERROR", "stderr"],
};
for (const [method, [level, stream]] of Object.entries(CONSOLE_METHODS)) {
  const original = console[method];
  console[method] = function attributed(...args) {
    const store = invocation.getStore();
    if (!store) return original.apply(this, args);
    record({ level, message: util.format(...args), function: store.function, execution: store.execution, stream });
  };
}

function stripControlHeaders(request) {
  for (const name of Object.keys(request.headers)) {
    if (name.startsWith(CONTROL_PREFIX)) delete request.headers[name];
  }
  const raw = request.rawHeaders;
  if (Array.isArray(raw)) {
    for (let index = raw.length - 2; index >= 0; index -= 2) {
      if (String(raw[index]).toLowerCase().startsWith(CONTROL_PREFIX)) raw.splice(index, 2);
    }
  }
}

// --- The synthetic credential's token exchange --------------------------------
// The runtime gives every worker a synthetic authorized-user credential
// (client id, secret and refresh token all "demo"): the Admin SDK then never
// falls back to the Compute Engine metadata server, and the developer's own
// gcloud credentials never reach user code. Some Admin SDK clients still ask
// Google's token endpoint for an access token before they call a local
// emulator (Eventarc's publishEvents among them), and Google
// refuses the synthetic refresh token, so such a call failed. That exchange
// is answered here: requests to the token endpoint go to a loopback answerer
// in this process, which answers the synthetic refresh grant with a
// placeholder token (the emulators do not check it) and passes any other
// request (a credential the developer configured) on to Google unchanged.
const TOKEN_HOST = "oauth2.googleapis.com";
const SYNTHETIC_GRANT = { client_id: "demo", client_secret: "demo", refresh_token: "demo" };

/** Whether a token request's body is the synthetic credential's refresh grant. */
function isSyntheticGrant(text, contentType) {
  let fields;
  try {
    fields = String(contentType).includes("json") ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
  } catch {
    return false;
  }
  return (
    fields !== null &&
    typeof fields === "object" &&
    fields.grant_type === "refresh_token" &&
    Object.entries(SYNTHETIC_GRANT).every(([key, value]) => fields[key] === value)
  );
}

/** The path of a token-endpoint request, from `https.request`'s arguments; undefined for any other request. */
function tokenPath(args) {
  const [first, second] = args;
  const fromUrl = typeof first === "string" || first instanceof URL;
  let url;
  try {
    url = fromUrl ? new URL(String(first)) : undefined;
  } catch {
    return undefined;
  }
  const options = (fromUrl ? second : first) ?? {};
  if (typeof options !== "object") return undefined;
  const host = options.hostname ?? (typeof options.host === "string" ? options.host.replace(/:\d+$/, "") : undefined) ?? url?.hostname;
  if (host !== TOKEN_HOST) return undefined;
  const requested = options.path ?? (url ? `${url.pathname}${url.search}` : "/");
  return requested.startsWith("/token") ? requested : undefined;
}

async function answerSyntheticTokenExchange() {
  const originalRequest = https.request;
  const originalGet = https.get;
  const answerer = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "POST" && isSyntheticGrant(body.toString("utf8"), request.headers["content-type"] ?? "")) {
        const answer = JSON.stringify({ access_token: "owner", expires_in: 3600, token_type: "Bearer" });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(answer) });
        response.end(answer);
        return;
      }
      // The developer's own credential: to Google as it was sent.
      const upstream = originalRequest.call(
        https,
        { hostname: TOKEN_HOST, port: 443, path: request.url, method: request.method, headers: { ...request.headers, host: TOKEN_HOST } },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "unreachable", error_description: String(error && error.message ? error.message : error) }));
      });
      upstream.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    answerer.once("error", reject);
    answerer.listen(0, "127.0.0.1", resolve);
  });
  answerer.unref();
  const port = answerer.address().port;
  const toAnswerer = (args, requested) => {
    const callback = args.find((arg) => typeof arg === "function");
    const fromUrl = typeof args[0] === "string" || args[0] instanceof URL;
    const options = (fromUrl ? (typeof args[1] === "object" ? args[1] : undefined) : args[0]) ?? {};
    // TLS settings and an https agent mean nothing to the loopback hop.
    const { agent: _agent, hostname: _hostname, host: _host, port: _port, protocol: _protocol, path: _path, ...rest } = options;
    return http.request({ ...rest, protocol: "http:", host: "127.0.0.1", port, path: requested }, callback);
  };
  https.request = function request(...args) {
    const requested = tokenPath(args);
    return requested === undefined ? originalRequest.apply(this, args) : toAnswerer(args, requested);
  };
  https.get = function get(...args) {
    const requested = tokenPath(args);
    if (requested === undefined) return originalGet.apply(this, args);
    const outgoing = toAnswerer(args, requested);
    outgoing.end();
    return outgoing;
  };
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function fetch(input, init) {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      let url;
      try {
        url = new URL(href);
      } catch {
        return nativeFetch(input, init);
      }
      if (url.hostname !== TOKEN_HOST || !url.pathname.startsWith("/token")) return nativeFetch(input, init);
      const local = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      return nativeFetch(input instanceof Request ? new Request(local, input) : local, init);
    };
  }
}

function fatal(message) {
  process.stdout.write(`FIRENOOK_WORKER_FATAL ${JSON.stringify({ message: String(message) })}\n`);
  process.exit(1);
}

function findModuleRoot(moduleName, filePath) {
  // `findModuleRoot`: walk up from a resolved file to the package directory.
  let current = path.dirname(filePath);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (pkg.name === moduleName) return current;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveFromSdk(name) {
  // firebase-functions depends on express (which bundles body-parser); resolve
  // from its real location so a codebase without a direct express dependency
  // still gets the versions the SDK was built against. The package's
  // `exports` map hides package.json, so resolve the entry and walk up.
  let sdkRoot;
  try {
    sdkRoot = findModuleRoot("firebase-functions", fs.realpathSync(require.resolve("firebase-functions")));
  } catch {
    sdkRoot = undefined;
  }
  if (sdkRoot) {
    const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
    try {
      return sdkRequire(name);
    } catch {
      // fall through to the codebase's own resolution
    }
  }
  return require(name);
}

async function loadModule() {
  try {
    return require(sourceDir);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code !== "ERR_REQUIRE_ESM" && code !== "ERR_REQUIRE_ASYNC_MODULE") throw error;
  }
  const entry = require.resolve(sourceDir);
  return import(pathToFileURL(entry).href);
}

function resolveTarget(target) {
  return target.split(".").reduce((module, part) => (module ? module[part] : undefined), functionModule);
}

// --- CloudEvent helpers (emulator/events/types.js) ---------------------------
function isBinaryCloudEvent(request) {
  return Boolean(request.header("ce-type") && request.header("ce-specversion") && request.header("ce-source") && request.header("ce-id"));
}

function extractBinaryCloudEventContext(request) {
  const context = {};
  for (const name of Object.keys(request.headers)) {
    if (name.startsWith("ce-")) context[name.slice(3)] = request.headers[name];
  }
  return context;
}

// --- Invocation ---------------------------------------------------------------
async function runBackground(trigger, body, signature) {
  if (signature === "cloudevent") {
    await trigger(body);
    return;
  }
  const data = body.data;
  delete body.data;
  const context = body.context ? body.context : body;
  if (!body.eventType || !String(body.eventType).startsWith("google.storage")) {
    if (context.resource && context.resource.name) context.resource = context.resource.name;
  }
  await trigger(data, context);
}

function errorMessage(error) {
  if (error && typeof error === "object") return error.stack || error.message || String(error);
  return String(error);
}

async function main() {
  const express = resolveFromSdk("express");
  await answerSyntheticTokenExchange();
  functionModule = await loadModule();
  const app = express();
  app.enable("trust proxy");
  const rawBodySaver = (request, _response, buffer) => {
    request.rawBody = buffer;
  };
  app.use(express.json({ limit: BODY_LIMIT, verify: rawBodySaver }));
  app.use(express.text({ limit: BODY_LIMIT, verify: rawBodySaver }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT, verify: rawBodySaver }));
  app.use(express.raw({ type: "*/*", limit: BODY_LIMIT, verify: rawBodySaver }));
  app.get("/__/health", (_request, response) => {
    response.status(200).send();
  });
  app.post("/__/quit", (_request, response) => {
    response.status(200).send();
    setTimeout(() => process.exit(0), 20);
  });
  // Express 4 (firebase-functions ≤ 7.2) and Express 5 (firebase-functions
  // ≥ 7.3) resolve from the codebase; the official runtime's "/*" and
  // "/favicon.ico|/robots.txt" patterns are path-to-regexp 0.x syntax that
  // Express 5 rejects, so the same routes are declared in the syntax both
  // accept.
  for (const path of ["/favicon.ico", "/robots.txt"]) {
    app.all(path, (_request, response) => {
      response.status(404).send();
    });
  }
  app.all(/.*/, async (request, response) => {
    const target = request.header("x-firenook-target") || process.env.FUNCTION_TARGET || "";
    const signature = request.header("x-firenook-signature") || process.env.FUNCTION_SIGNATURE_TYPE || "http";
    const service = request.header("x-firenook-service") || process.env.K_SERVICE || target;
    const execution = request.header("x-firenook-execution") || undefined;
    const fn = request.header("x-firenook-function") || target;
    stripControlHeaders(request);
    if (!execution) return handle(request, response, target, signature, service, undefined, fn);
    return invocation.run({ execution, function: fn }, () => handle(request, response, target, signature, service, execution, fn));
  });
  const server = app.listen(0, "127.0.0.1", () => {
    ready = true;
    process.stdout.write(`FIRENOOK_WORKER_READY ${JSON.stringify({ port: server.address().port, codebase, pid: process.pid, node: process.versions.node })}\n`);
  });
  server.keepAliveTimeout = 65000;
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

async function handle(request, response, target, signature, service, execution, fn) {
  if (execution) announceAnswer(response, execution);
  // The environment a handler observes for this invocation, set before any
  // user code runs (one worker serves every function of the codebase). The
  // official debug-mode runtime (`--inspect-functions`) serves every
  // function from one process and leaves these unset.
  if (process.env.FUNCTION_DEBUG_MODE !== "true") {
    process.env.FUNCTION_TARGET = target;
    process.env.FUNCTION_SIGNATURE_TYPE = signature;
    process.env.K_SERVICE = service;
  }
  try {
    const trigger = resolveTarget(target);
    if (typeof trigger !== "function") throw new Error(`Failed to find function ${target} in the loaded module`);
    switch (signature) {
      case "event":
      case "cloudevent": {
        let body;
        if (isBinaryCloudEvent(request)) {
          body = extractBinaryCloudEventContext(request);
          body.data = request.body;
        } else {
          body = JSON.parse(request.rawBody ? request.rawBody.toString() : "{}");
        }
        await runBackground(trigger, body, signature);
        response.send({ status: "acknowledged" });
        break;
      }
      default:
        await trigger(request, response);
    }
  } catch (error) {
    // The invocation's error: the runtime keeps this line as its error.
    log("ERROR", errorMessage(error), { kind: "function.error", execution, function: fn });
    if (!response.headersSent) {
      // A background handler failure ends the official worker; the runtime
      // turns this marker into the same dropped-connection answer.
      if (signature === "event" || signature === "cloudevent") response.set("x-firenook-handler-error", "1");
      response.status(500).send(error && typeof error === "object" && error.message ? error.message : String(error));
    } else {
      response.end();
    }
  }
}

function uncaughtFields() {
  const store = invocation.getStore();
  return store ? { kind: "worker.uncaught", execution: store.execution, function: store.function } : { kind: "worker.uncaught" };
}

process.on("uncaughtException", (error) => {
  log("ERROR", `Uncaught exception: ${errorMessage(error)}`, uncaughtFields());
});
process.on("unhandledRejection", (reason) => {
  log("ERROR", `Unhandled rejection: ${errorMessage(reason)}`, uncaughtFields());
});

main().catch((error) => {
  if (!ready) {
    fatal(`Failed to initialize and load triggers: ${errorMessage(error)}`);
  } else {
    log("ERROR", errorMessage(error));
  }
});
